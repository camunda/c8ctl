/**
 * Unit tests for the interactive prompt helpers.
 *
 * The prompts read keystrokes from a TTY, which test subprocesses
 * never have. These tests drive the prompts in-process through the
 * `io` option with fake TTY streams, and send the same byte
 * sequences a terminal would.
 */

import assert from "node:assert";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
	confirm,
	createPromptSession,
	isInteractive,
	multiSelect,
	PromptCancelledError,
	type PromptIO,
	PromptNotInteractiveError,
	select,
} from "../../src/framework/index.ts";
import { asyncSpawn } from "../utils/spawn.ts";

const ENTER = "\r";
const TAB = "\t";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ESCAPE = "\x1b";

function fakeTTY(): PromptIO & {
	input: PassThrough;
	output: PassThrough;
	text: () => string;
	rawModes: boolean[];
} {
	const rawModes: boolean[] = [];
	const input = Object.assign(new PassThrough(), {
		isTTY: true,
		setRawMode: (mode: boolean) => {
			rawModes.push(mode);
			return true;
		},
	});
	const output = Object.assign(new PassThrough(), {
		isTTY: true,
		columns: 80,
	});
	let written = "";
	output.on("data", (chunk: Buffer) => {
		written += chunk.toString();
	});
	return { input, output, text: () => written, rawModes };
}

const SHOW_CURSOR = "\x1b[?25h";

/** Raw mode was switched on while prompting and is off again afterwards. */
function assertTerminalRestored(io: ReturnType<typeof fakeTTY>): void {
	assert.ok(io.rawModes.includes(true), "raw mode was never enabled");
	assert.strictEqual(io.rawModes.at(-1), false, "raw mode left enabled");
}

function fakePipe(): PromptIO {
	return { input: new PassThrough(), output: new PassThrough() };
}

/** Type keystrokes one at a time, the way a terminal delivers them. */
function type(io: { input: PassThrough }, ...keys: string[]): void {
	setImmediate(() => {
		for (const key of keys) io.input.write(key);
	});
}

/**
 * Replay prompt output onto a virtual screen, emulating line wrap at
 * `cols`. Lets tests assert what the terminal actually shows after the
 * last repaint — in particular that no stale fragments survive when a
 * render is shorter than the one before it.
 */
function renderScreen(
	text: string,
	{
		cols = 80,
		rows = 100,
		state,
	}: {
		cols?: number;
		rows?: number;
		/** Carries the screen and cursor across calls, so a byte stream
		 * can be replayed in segments at different widths (a resize). */
		state?: {
			screen?: string[];
			line?: number;
			col?: number;
			pendingWrap?: boolean;
		};
	} = {},
): string[] {
	const screen: string[] =
		state?.screen ?? Array.from({ length: rows }, () => "");
	let line = state?.line ?? 0;
	let col = state?.col ?? 0;
	// Delayed autowrap: a character written into the last column leaves
	// the cursor on that cell; the wrap happens when the next printable
	// character arrives. erase-to-EOL there erases the last character.
	let pendingWrap = state?.pendingWrap ?? false;
	// ANSI introducer as a string: biome's noControlCharactersInRegex
	// keeps control characters out of regex literals.
	const CSI = "\x1b\\[";
	// Cursor-up, clear-line, clear-to-EOL, erase-to-end-of-screen,
	// cursor-to-col-1, visibility, styles.
	const tokens = text.split(
		new RegExp(`(${CSI}(?:\\d+A|2K|0K|0J|1G|\\?25[hl]|[0-9;]*m))`),
	);
	for (const token of tokens) {
		const up = new RegExp(`^${CSI}(\\d+)A$`).exec(token);
		if (up) {
			line = Math.max(0, line - Number(up[1]));
			pendingWrap = false;
			continue;
		}
		if (token === "\x1b[2K") {
			screen[line] = "";
			pendingWrap = false;
			continue;
		}
		if (token === "\x1b[0J") {
			// Erase from the cursor position to the end of the screen.
			screen[line] = screen[line].slice(0, col);
			for (let r = line + 1; r < rows; r++) screen[r] = "";
			pendingWrap = false;
			continue;
		}
		if (token === "\x1b[0K") {
			screen[line] = screen[line].slice(0, pendingWrap ? col - 1 : col);
			continue;
		}
		if (token === "\x1b[1G") {
			col = 0;
			pendingWrap = false;
			continue;
		}
		// SGR styles and cursor-visibility escapes neither print nor
		// move the cursor — a pending wrap survives them.
		if (token === "" || token.startsWith("\x1b[")) continue;
		for (const ch of token) {
			if (ch === "\n") {
				line = Math.min(rows - 1, line + 1);
				col = 0;
				pendingWrap = false;
				continue;
			}
			if (pendingWrap) {
				line = Math.min(rows - 1, line + 1);
				col = 0;
				pendingWrap = false;
			}
			// Terminals overwrite at the cursor column, they don't append.
			const existing = screen[line];
			screen[line] =
				col < existing.length
					? existing.slice(0, col) + ch + existing.slice(col + 1)
					: existing + " ".repeat(col - existing.length) + ch;
			col += 1;
			if (col === cols) pendingWrap = true;
		}
	}
	if (state) {
		state.screen = screen;
		state.line = line;
		state.col = col;
		state.pendingWrap = pendingWrap;
	}
	return screen;
}

interface ScreenState {
	screen?: string[];
	line?: number;
	col?: number;
	pendingWrap?: boolean;
}

/**
 * Rewrap every row of the virtual screen at a new width, the way
 * terminals reflow their content on resize, and move the cursor down
 * with the content. Assumes the cursor sits below the content (true
 * for the prompt fixtures here, which always end a render with a
 * newline).
 */
function rewrapScreen(state: ScreenState, cols: number): void {
	const screen = state.screen ?? [];
	const wrapRow = (row: string): string[] => {
		const lines: string[] = [];
		for (let i = 0; i < row.length; i += cols)
			lines.push(row.slice(i, i + cols));
		return lines.length === 0 ? [""] : lines;
	};
	const beforeCursor = screen.slice(0, state.line ?? 0);
	state.line = beforeCursor.reduce((sum, row) => sum + wrapRow(row).length, 0);
	state.screen = screen.flatMap(wrapRow);
	state.col = 0;
	state.pendingWrap = false;
}

const ENV_KEYS = ["C8CTL_INTERACTIVE", "C8CTL_NON_INTERACTIVE", "CI"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

const OPTIONS = [
	{ label: "Alpha", value: "a" },
	{ label: "Bravo", value: "b" },
	{ label: "Charlie", value: "c" },
];

describe("isInteractive() with injected streams", () => {
	test("is true when both injected streams are TTYs", () => {
		assert.strictEqual(isInteractive(fakeTTY()), true);
	});

	test("is false when the injected streams are pipes", () => {
		assert.strictEqual(isInteractive(fakePipe()), false);
	});

	test("CI still forces non-interactive on a TTY", () => {
		process.env.CI = "true";
		assert.strictEqual(isInteractive(fakeTTY()), false);
	});
});

describe("select()", () => {
	test("Enter picks the highlighted option", async () => {
		const io = fakeTTY();
		type(io, ENTER);
		const result = await select({ message: "Pick", options: OPTIONS, io });
		assert.ok(result.interactive && !result.cancelled);
		assert.strictEqual(result.value, "a");
	});

	test("Enter with initialIndex picks the default option", async () => {
		const io = fakeTTY();
		type(io, ENTER);
		const result = await select({
			message: "Pick",
			options: OPTIONS,
			initialIndex: 2,
			io,
		});
		assert.ok(result.interactive && !result.cancelled);
		assert.strictEqual(result.value, "c");
	});

	test("arrow keys move the highlight", async () => {
		const io = fakeTTY();
		type(io, DOWN, ENTER);
		const result = await select({ message: "Pick", options: OPTIONS, io });
		assert.ok(result.interactive && !result.cancelled);
		assert.strictEqual(result.value, "b");
	});

	test("a number key answers immediately", async () => {
		const io = fakeTTY();
		type(io, "3");
		const result = await select({ message: "Pick", options: OPTIONS, io });
		assert.ok(result.interactive && !result.cancelled);
		assert.strictEqual(result.value, "c");
		assert.strictEqual(result.index, 2);
	});

	test("a number key beyond the option count is ignored", async () => {
		const io = fakeTTY();
		type(io, "9", ENTER);
		const result = await select({ message: "Pick", options: OPTIONS, io });
		assert.ok(result.interactive && !result.cancelled);
		assert.strictEqual(result.value, "a");
	});

	test("options are numbered in the rendered menu", async () => {
		const io = fakeTTY();
		type(io, ENTER);
		await select({ message: "Pick", options: OPTIONS, io });
		const plain = stripVTControlCharacters(io.text());
		assert.match(plain, /1\. Alpha/);
		assert.match(plain, /2\. Bravo/);
		assert.match(plain, /3\. Charlie/);
	});

	test("Escape cancels", async () => {
		const io = fakeTTY();
		type(io, ESCAPE);
		const result = await select({ message: "Pick", options: OPTIONS, io });
		assert.deepStrictEqual(result, { interactive: true, cancelled: true });
	});

	for (const [name, keys] of [
		["Enter", [ENTER]],
		["a number key", ["2"]],
		["Escape", [ESCAPE]],
	] as const) {
		test(`restores raw mode and the cursor after ${name}`, async () => {
			const io = fakeTTY();
			type(io, ...keys);
			await select({ message: "Pick", options: OPTIONS, io });
			assertTerminalRestored(io);
			assert.ok(io.text().includes(SHOW_CURSOR), "cursor left hidden");
		});
	}

	test("a terminal resize mid-prompt re-anchors the menu instead of duplicating rows", async () => {
		const io = fakeTTY(); // starts at 80 columns
		const done = select({
			message: "Pick",
			options: [
				// Alpha's row wraps to two physical lines at 80 columns but
				// fits on one at 149.
				{ label: "Alpha", value: "a", description: "x".repeat(100) },
				{ label: "Bravo", value: "b" },
			],
			io,
		});
		// The terminal grows while the menu is open (SIGWINCH updates
		// `columns`). The next repaint must not trust the stale physical
		// line count — rows no longer wrap, so the cursor rewind would
		// overshoot and leave stale fragments behind.
		io.output.columns = 149;
		type(io, DOWN, UP, DOWN);
		// Wait for the initial render plus all three repaints.
		for (let i = 0; i < 1000; i++) {
			if (io.text().split("Bravo").length - 1 >= 4) break;
			await new Promise((resolveSpin) => setImmediate(resolveSpin));
		}
		const visible = renderScreen(io.text(), { cols: 149 }).filter(
			(l) => l !== "",
		);
		const bravoRows = visible.filter((l) => l.includes("Bravo"));
		assert.strictEqual(
			bravoRows.length,
			1,
			`menu rows duplicated after resize: ${JSON.stringify(visible)}`,
		);
		setImmediate(() => io.input.write(ENTER));
		const result = await done;
		assert.ok(result.interactive && !result.cancelled);
		assert.strictEqual(result.value, "b");
	});

	test("cancel after a terminal resize clears only the prompt", async () => {
		const io = fakeTTY(); // starts at 80 columns
		io.output.write("previous output line\n");
		// Wraps to two header lines at 80 columns, fits on one at 149.
		const message = `Pick ${"a very important thing ".repeat(4)}`.trim();
		const done = select({ message, options: OPTIONS, io });
		io.output.columns = 149;
		type(io, DOWN, UP);
		// Wait for the initial render plus both repaints.
		for (let i = 0; i < 1000; i++) {
			if (io.text().split("Bravo").length - 1 >= 3) break;
			await new Promise((resolveSpin) => setImmediate(resolveSpin));
		}
		setImmediate(() => io.input.write(ESCAPE));
		const result = await done;
		assert.ok(result.interactive && result.cancelled);
		// The prompt is cleared exactly — the output above it survives,
		// no menu fragment is left behind.
		const visible = renderScreen(io.text(), { cols: 149 }).filter(
			(l) => l !== "",
		);
		assert.deepStrictEqual(visible, ["previous output line"]);
	});

	test("cancel right after a resize, before any repaint, clears only the prompt", async () => {
		const io = fakeTTY(); // starts at 80 columns
		io.output.write("previous output line\n");
		const done = select({
			message: "Pick",
			options: [
				// Alpha's row wraps to two physical lines at 80 columns but
				// fits on one at 149.
				{ label: "Alpha", value: "a", description: "x".repeat(100) },
				{ label: "Bravo", value: "b" },
			],
			io,
		});
		// The terminal grows while the menu is open and no keypress
		// follows before the cancel: the terminal rewrapped the menu, so
		// the line counts from render time no longer match the screen.
		io.output.columns = 149;
		type(io, ESCAPE);
		const result = await done;
		assert.ok(result.interactive && result.cancelled);
		const visible = renderScreen(io.text(), { cols: 149 }).filter(
			(l) => l !== "",
		);
		assert.deepStrictEqual(visible, ["previous output line"]);
	});

	test("non-TTY returns the default with a hint", async () => {
		const result = await select({
			message: "Pick",
			options: OPTIONS,
			initialIndex: 1,
			io: fakePipe(),
		});
		assert.ok(!result.interactive);
		assert.strictEqual(result.value, "b");
		assert.match(result.hint, /non-interactive/);
	});
});

describe("confirm()", () => {
	for (const [answer, expected] of [
		["y", true],
		["yes", true],
		["Y", true],
		["n", false],
		["no", false],
		["NO", false],
	] as const) {
		test(`"${answer}" answers ${expected}`, async () => {
			const io = fakeTTY();
			type(io, `${answer}\r`);
			const result = await confirm({ message: "Continue?", io });
			assert.deepStrictEqual(result, { interactive: true, value: expected });
		});
	}

	test("Enter accepts a true default", async () => {
		const io = fakeTTY();
		type(io, ENTER);
		const result = await confirm({
			message: "Continue?",
			defaultValue: true,
			io,
		});
		assert.strictEqual(result.value, true);
		assert.match(io.text(), /\[Y\/n\]/);
	});

	test("Enter accepts a false default", async () => {
		const io = fakeTTY();
		type(io, ENTER);
		const result = await confirm({ message: "Continue?", io });
		assert.strictEqual(result.value, false);
		assert.match(io.text(), /\[y\/N\]/);
	});

	test("an unrecognised answer asks again instead of meaning no", async () => {
		const io = fakeTTY();
		type(io, "maybe\r", "y\r");
		const result = await confirm({ message: "Continue?", io });
		assert.strictEqual(result.value, true);
		assert.match(io.text(), /Please answer y or n/);
	});

	for (const defaultValue of [true, false]) {
		test(`Escape cancels instead of answering (default ${defaultValue})`, async () => {
			const io = fakeTTY();
			type(io, ESCAPE);
			const result = await confirm({ message: "Continue?", defaultValue, io });
			assert.deepStrictEqual(result, {
				interactive: true,
				value: false,
				cancelled: true,
			});
			assertTerminalRestored(io);
		});
	}

	test("Enter after Escape does not answer the cancelled question", async () => {
		const io = fakeTTY();
		type(io, ESCAPE);
		const result = await confirm({
			message: "Continue?",
			defaultValue: true,
			io,
		});
		io.input.write(ENTER);
		assert.strictEqual(result.value, false);
		assert.strictEqual(result.cancelled, true);
	});

	test("restores raw mode after an answer", async () => {
		const io = fakeTTY();
		type(io, "y\r");
		await confirm({ message: "Continue?", io });
		assertTerminalRestored(io);
	});

	test("non-TTY returns the default with a hint", async () => {
		const result = await confirm({
			message: "Continue?",
			defaultValue: true,
			io: fakePipe(),
		});
		assert.strictEqual(result.interactive, false);
		assert.strictEqual(result.value, true);
		assert.match(result.hint ?? "", /non-interactive/);
	});
});

describe("multiSelect()", () => {
	const CHECKED_OPTIONS = [
		{ label: "Alpha", value: "a", checked: true },
		{ label: "Bravo", value: "b" },
		{ label: "Charlie", value: "c", checked: true },
	];

	test("Enter on the submit button keeps the pre-checked options", async () => {
		const io = fakeTTY();
		type(io, TAB, ENTER);
		const result = await multiSelect({
			message: "Pick",
			options: CHECKED_OPTIONS,
			io,
		});
		assert.ok(result.interactive && !result.cancelled);
		assert.deepStrictEqual(result.values, ["a", "c"]);
	});

	test("Space toggles the highlighted option off", async () => {
		const io = fakeTTY();
		type(io, " ", TAB, ENTER);
		const result = await multiSelect({
			message: "Pick",
			options: CHECKED_OPTIONS,
			io,
		});
		assert.ok(result.interactive && !result.cancelled);
		assert.deepStrictEqual(result.values, ["c"]);
	});

	test("Space on an unchecked option adds it", async () => {
		const io = fakeTTY();
		type(io, DOWN, " ", TAB, ENTER);
		const result = await multiSelect({
			message: "Pick",
			options: CHECKED_OPTIONS,
			io,
		});
		assert.ok(result.interactive && !result.cancelled);
		assert.deepStrictEqual(result.values, ["a", "b", "c"]);
	});

	test("values come back in option order, not toggle order", async () => {
		const io = fakeTTY();
		// Toggle Charlie off first, then Bravo on.
		type(io, DOWN, DOWN, " ", UP, " ", TAB, ENTER);
		const result = await multiSelect({
			message: "Pick",
			options: CHECKED_OPTIONS,
			io,
		});
		assert.ok(result.interactive && !result.cancelled);
		assert.deepStrictEqual(result.values, ["a", "b"]);
	});

	test("'a' checks every option, a second 'a' clears all", async () => {
		const io = fakeTTY();
		type(io, "a", TAB, ENTER);
		const result = await multiSelect({
			message: "Pick",
			options: CHECKED_OPTIONS,
			io,
		});
		assert.ok(result.interactive && !result.cancelled);
		assert.deepStrictEqual(result.values, ["a", "b", "c"]);

		const io2 = fakeTTY();
		type(io2, "a", "a", TAB, ENTER);
		const result2 = await multiSelect({
			message: "Pick",
			options: CHECKED_OPTIONS,
			io: io2,
		});
		assert.ok(result2.interactive && !result2.cancelled);
		assert.deepStrictEqual(result2.values, []);
	});

	test("an empty selection is allowed", async () => {
		const io = fakeTTY();
		// Alpha and Charlie start checked; toggle both off.
		type(io, " ", DOWN, DOWN, " ", TAB, ENTER);
		const result = await multiSelect({
			message: "Pick",
			options: CHECKED_OPTIONS,
			io,
		});
		assert.ok(result.interactive && !result.cancelled);
		assert.deepStrictEqual(result.values, []);
	});

	test("arrow keys wrap around at the ends", async () => {
		const io = fakeTTY();
		// Up from the first option lands on the submit button, up again
		// wraps to the last option (Charlie, checked).
		type(io, UP, UP, " ", TAB, ENTER);
		const result = await multiSelect({
			message: "Pick",
			options: CHECKED_OPTIONS,
			io,
		});
		assert.ok(result.interactive && !result.cancelled);
		assert.deepStrictEqual(result.values, ["a"]);
	});

	test("a number key toggles the matching option", async () => {
		const io = fakeTTY();
		type(io, "2", TAB, ENTER);
		const result = await multiSelect({
			message: "Pick",
			options: CHECKED_OPTIONS,
			io,
		});
		assert.ok(result.interactive && !result.cancelled);
		assert.deepStrictEqual(result.values, ["a", "b", "c"]);
	});

	test("renders checked and unchecked markers per option", async () => {
		const io = fakeTTY();
		type(io, TAB, ENTER);
		await multiSelect({ message: "Pick", options: CHECKED_OPTIONS, io });
		const plain = stripVTControlCharacters(io.text());
		assert.match(plain, /\[x\] Alpha/);
		assert.match(plain, /\[ \] Bravo/);
		assert.match(plain, /\[x\] Charlie/);
	});

	test("uses inverse video for checked markers on either terminal theme", async () => {
		const io = fakeTTY();
		type(io, TAB, ENTER);
		await multiSelect({ message: "Pick", options: CHECKED_OPTIONS, io });
		assert.ok(io.text().includes("\x1b[7m[x]\x1b[0m"));
		assert.ok(io.text().includes("[ ] Bravo"));
	});

	test("renders the key hint below the message", async () => {
		const io = fakeTTY();
		type(io, TAB, ENTER);
		await multiSelect({ message: "Pick", options: CHECKED_OPTIONS, io });
		const plain = stripVTControlCharacters(io.text());
		assert.match(plain, /space/);
		assert.match(plain, /enter/);
		assert.match(plain, /tab/);
	});

	test("the summary line lists the chosen labels", async () => {
		const io = fakeTTY();
		type(io, DOWN, " ", TAB, ENTER);
		await multiSelect({ message: "Pick", options: CHECKED_OPTIONS, io });
		const plain = stripVTControlCharacters(io.text());
		assert.match(plain, /Alpha, Bravo, Charlie/);
	});

	test("the summary line reports an empty selection", async () => {
		const io = fakeTTY();
		type(io, "a", "a", TAB, ENTER);
		await multiSelect({ message: "Pick", options: CHECKED_OPTIONS, io });
		const plain = stripVTControlCharacters(io.text());
		assert.match(plain, /none selected/i);
	});

	test("Escape cancels", async () => {
		const io = fakeTTY();
		type(io, ESCAPE);
		const result = await multiSelect({
			message: "Pick",
			options: CHECKED_OPTIONS,
			io,
		});
		assert.deepStrictEqual(result, { interactive: true, cancelled: true });
	});

	for (const [name, keys] of [
		["Enter on the submit button", [TAB, ENTER]],
		["Escape", [ESCAPE]],
	] as const) {
		test(`restores raw mode and the cursor after ${name}`, async () => {
			const io = fakeTTY();
			type(io, ...keys);
			await multiSelect({ message: "Pick", options: CHECKED_OPTIONS, io });
			assertTerminalRestored(io);
			assert.ok(io.text().includes(SHOW_CURSOR), "cursor left hidden");
		});
	}

	test("non-TTY returns the pre-checked values with a hint", async () => {
		const result = await multiSelect({
			message: "Pick",
			options: CHECKED_OPTIONS,
			io: fakePipe(),
		});
		assert.ok(!result.interactive);
		assert.deepStrictEqual(result.values, ["a", "c"]);
		assert.match(result.hint, /non-interactive/);
	});

	test("requires at least one option", async () => {
		await assert.rejects(
			multiSelect({ message: "Pick", options: [], io: fakeTTY() }),
			/at least one option/,
		);
	});

	describe("option dependencies (requires)", () => {
		const DEPENDENT_OPTIONS = [
			{ label: "Cluster", value: "cluster", checked: true },
			{
				label: "Blueprint",
				value: "blueprint",
				checked: true,
				requires: [{ value: "cluster", reason: "needs the local cluster" }],
			},
		];

		test("select all checks options enabled by selecting their requirements", async () => {
			const io = fakeTTY();
			type(io, "a", TAB, ENTER);
			const result = await multiSelect({
				message: "Pick",
				options: [
					{ label: "Cluster", value: "cluster" },
					{
						label: "Blueprint",
						value: "blueprint",
						requires: [{ value: "cluster", reason: "needs the local cluster" }],
					},
				],
				io,
			});
			assert.ok(result.interactive && !result.cancelled);
			assert.deepStrictEqual(result.values, ["cluster", "blueprint"]);
		});

		test("unchecking the requirement forces the dependent off and shows why", async () => {
			const io = fakeTTY();
			// Space on the highlighted "Cluster" row unchecks it.
			type(io, " ", TAB, ENTER);
			const result = await multiSelect({
				message: "Pick",
				options: DEPENDENT_OPTIONS,
				io,
			});
			assert.ok(result.interactive && !result.cancelled);
			assert.deepStrictEqual(result.values, []);
			assert.match(
				stripVTControlCharacters(io.text()),
				/Blueprint.*⚠ needs the local cluster/,
			);
		});

		test("a blocked row is dimmed and its reason rendered in warning yellow", async () => {
			const io = fakeTTY();
			// Space on the highlighted "Cluster" row unchecks it.
			type(io, " ", TAB, ENTER);
			await multiSelect({
				message: "Pick",
				options: DEPENDENT_OPTIONS,
				io,
			});
			const text = io.text();
			// The whole blocked row is dimmed…
			assert.ok(text.includes("\x1b[2mBlueprint\x1b[0m"));
			// …and the reason stands out in yellow with a warning marker.
			assert.ok(text.includes("\x1b[33m⚠ needs the local cluster\x1b[0m"));
		});

		test("the status line under the list explains the focused blocked row", async () => {
			const io = fakeTTY();
			// Cluster off, then move onto the blocked Blueprint row.
			type(io, " ", DOWN, TAB, ENTER);
			await multiSelect({
				message: "Pick",
				options: DEPENDENT_OPTIONS,
				io,
			});
			assert.match(
				stripVTControlCharacters(io.text()),
				/⚠ Blueprint needs the local cluster — enable it to unlock this option/,
			);
		});

		test("the status line is blank when the focused row is not blocked", async () => {
			const io = fakeTTY();
			type(io, TAB, ENTER);
			await multiSelect({
				message: "Pick",
				options: DEPENDENT_OPTIONS,
				io,
			});
			assert.doesNotMatch(
				stripVTControlCharacters(io.text()),
				/enable it to unlock this option/,
			);
		});

		test("an unblocked wrapped row leaves no stale reason on its continuation line", async () => {
			const io = fakeTTY();
			// The grouped blueprint row wraps to two physical lines in both
			// states (112 chars blocked, 83 unblocked), so the render never
			// shrinks and the leftover-tail erasure must happen where the
			// row is rewritten.
			type(io, " ", " ");
			const done = multiSelect({
				message: "Pick",
				options: [
					{
						label: "Local cluster",
						value: "cluster",
						checked: true,
						group: "Essentials",
					},
					{
						label: "Starter blueprint",
						value: "blueprint",
						checked: true,
						description:
							"A working example project, deployed and started for you",
						group: "Essentials",
						requires: [
							{ value: "cluster", reason: "requires the local cluster" },
						],
					},
				],
				io,
			});
			// Snapshot the screen after the third render (initial + both
			// toggles), before confirming.
			for (let i = 0; i < 1000; i++) {
				if (io.text().split("Starter blueprint").length - 1 >= 3) break;
				await new Promise((resolveSpin) => setImmediate(resolveSpin));
			}
			const visible = renderScreen(io.text()).filter((l) => l !== "");
			assert.ok(
				visible.every((l) => !l.includes("requires the local cluster")),
				`stale reason survived the repaint: ${JSON.stringify(visible)}`,
			);
			setImmediate(() => {
				io.input.write(TAB);
				io.input.write(ENTER);
			});
			const result = await done;
			assert.ok(result.interactive && !result.cancelled);
			// The blueprint stays off: re-enabling the requirement does
			// not bring back a hidden checkmark.
			assert.deepStrictEqual(result.values, ["cluster"]);
		});

		test("an exact-width row keeps its final character (delayed autowrap)", async () => {
			const io = fakeTTY();
			// 8 (pointer + checkbox) + 72 = exactly 80 columns. Under
			// delayed autowrap the cursor sits on the final character, and
			// a trailing erase-to-EOL would delete it. The first render
			// happens synchronously, so the screen can be checked before
			// any keypress.
			const exactLabel = "A".repeat(72);
			const done = multiSelect({
				message: "Pick",
				options: [{ label: exactLabel, value: "a", checked: true }],
				io,
			});
			const visible = renderScreen(io.text()).filter((l) => l !== "");
			assert.ok(
				visible.some((l) => l.includes(exactLabel)),
				`exact-width row lost its final character: ${JSON.stringify(visible)}`,
			);
			setImmediate(() => {
				io.input.write(TAB);
				io.input.write(ENTER);
			});
			const result = await done;
			assert.ok(result.interactive && !result.cancelled);
			assert.deepStrictEqual(result.values, ["a"]);
		});

		test("a repaint that shrinks the menu erases stale wrapped lines", async () => {
			const io = fakeTTY();
			// Cluster off blocks the blueprint; moving onto its row shows
			// the status line, which wraps past 80 columns; moving off
			// collapses it to a blank line. The wrapped remainder of the
			// old status line must not survive below the menu.
			type(io, " ", DOWN, UP, DOWN, DOWN, ENTER);
			await multiSelect({
				message: "Pick",
				options: [
					{ label: "Local cluster", value: "cluster", checked: true },
					{
						label: "Starter blueprint",
						value: "blueprint",
						requires: [
							{ value: "cluster", reason: "requires the local cluster" },
						],
					},
				],
				io,
			});
			const visible = renderScreen(io.text()).filter((l) => l !== "");
			assert.deepStrictEqual(visible, [
				"? Pick",
				"  ↑/↓ move · space/enter toggle · a all · tab to Submit · esc cancel",
				"  (none selected)",
			]);
		});

		test("a blocked option cannot be toggled until its requirement is back", async () => {
			const io = fakeTTY();
			// Cluster off; Blueprint toggle attempt (blocked); Cluster on;
			// Blueprint toggle (works now).
			type(io, " ", DOWN, " ", UP, " ", DOWN, " ", TAB, ENTER);
			const result = await multiSelect({
				message: "Pick",
				options: [
					{ label: "Cluster", value: "cluster", checked: true },
					{
						label: "Blueprint",
						value: "blueprint",
						requires: [{ value: "cluster", reason: "needs the local cluster" }],
					},
				],
				io,
			});
			assert.ok(result.interactive && !result.cancelled);
			assert.deepStrictEqual(result.values, ["cluster", "blueprint"]);
		});

		test("a re-enabled row stays unchecked — disabling clears the checkmark", async () => {
			const io = fakeTTY();
			// Cluster off (Blueprint force-unchecked), Cluster back on, Enter.
			type(io, " ", " ", TAB, ENTER);
			const result = await multiSelect({
				message: "Pick",
				options: DEPENDENT_OPTIONS,
				io,
			});
			assert.ok(result.interactive && !result.cancelled);
			assert.deepStrictEqual(result.values, ["cluster"]);
		});

		test("non-interactive drops options whose requirement is not pre-checked", async () => {
			const result = await multiSelect({
				message: "Pick",
				options: [
					{ label: "Cluster", value: "cluster" },
					{
						label: "Blueprint",
						value: "blueprint",
						checked: true,
						requires: [{ value: "cluster", reason: "needs the local cluster" }],
					},
				],
				io: fakePipe(),
			});
			assert.ok(!result.interactive);
			assert.deepStrictEqual(result.values, []);
			assert.match(result.hint, /Blueprint.*needs the local cluster/);
		});
	});

	test("a terminal resize mid-prompt re-anchors the menu instead of piling up rows", async () => {
		const io = fakeTTY(); // starts at 80 columns
		io.output.write("previous output line\n");
		// Wraps to two header lines at 80 columns, fits on one at 149 —
		// so cancel-after-resize must also re-count the header.
		const message = `Pick ${"a very important thing ".repeat(4)}`.trim();
		const done = multiSelect({
			message,
			submitLabel: "Start setup",
			options: [
				{
					label: "Local cluster",
					value: "cluster",
					checked: true,
					group: "Essentials",
					description: "Download and run Camunda 8 Run on this machine",
				},
				{
					label: "Desktop Modeler",
					value: "modeler",
					checked: true,
					group: "Essentials",
					description:
						"Install the desktop app to edit BPMN, DMN, and forms visually",
				},
				{
					label: "Example project",
					value: "blueprint",
					checked: true,
					group: "Essentials",
					description:
						"Create an example project, then deploy and start it on your local cluster",
				},
				{
					label: "Docs MCP server",
					value: "docs",
					group: "AI-assisted development",
					description:
						"Search current Camunda 8 docs from your AI assistant (browser sign-in on first use)",
				},
			],
			io,
		});
		// The terminal grows from 80 to 149 columns while the menu is
		// open (SIGWINCH updates `columns`). Three rows no longer wrap,
		// so a repaint trusting the stale line count rewinds too far and
		// leaves the menu's tail rows behind — on a full screen this
		// piles up a copy of the tail on every keypress.
		io.output.columns = 149;
		type(io, DOWN, UP, DOWN, UP);
		// Wait for the initial render plus all four repaints.
		for (let i = 0; i < 1000; i++) {
			if (io.text().split("Start setup —").length - 1 >= 5) break;
			await new Promise((resolveSpin) => setImmediate(resolveSpin));
		}
		const visible = renderScreen(io.text(), { cols: 149 }).filter(
			(l) => l !== "",
		);
		const buttons = visible.filter((l) => l.includes("Start setup —"));
		assert.strictEqual(
			buttons.length,
			1,
			`menu fragments piled up after resize: ${JSON.stringify(visible)}`,
		);
		// The resize recovery repaints from the menu's top — the header
		// (question and key hint) above it stays intact.
		assert.ok(
			visible.some((l) => l.startsWith(`? ${message}`)),
			`question header lost after resize: ${JSON.stringify(visible)}`,
		);
		assert.ok(
			visible.some((l) => l.includes("↑/↓ move")),
			`key hint lost after resize: ${JSON.stringify(visible)}`,
		);
		// The resize recovery erased everything below the fresh anchor, so
		// no stray "clear an empty line" writes may follow the repaint —
		// each would append a blank line and scroll the prompt upward.
		assert.ok(
			!io.text().includes("\x1b[2K\n"),
			"resize repaint left stray line erases that scroll the screen",
		);
		setImmediate(() => io.input.write(ESCAPE));
		const result = await done;
		assert.ok(result.interactive && result.cancelled);
		// Cancel after the resize clears exactly the prompt — the output
		// that was above it survives.
		const after = renderScreen(io.text(), { cols: 149 }).filter(
			(l) => l !== "",
		);
		assert.deepStrictEqual(after, ["previous output line"]);
	});

	test("a resize on the same keypress as a state change rewinds the previous render", async () => {
		const io = fakeTTY();
		io.output.columns = 149;
		io.output.write("previous output line\n");
		// 90 chars: the blocked row and its footer fit on one line at 149
		// columns but wrap to two at 100.
		const reason = "r".repeat(90);
		const done = multiSelect({
			message: "Pick",
			options: [
				{ label: "Alpha", value: "alpha", checked: true },
				{
					label: "Bravo",
					value: "bravo",
					checked: true,
					requires: [{ value: "alpha", reason }],
				},
			],
			io,
		});
		// At 149 columns: uncheck Alpha (Bravo becomes blocked), then
		// focus Bravo so the footer shows the long reason.
		type(io, " ", DOWN);
		for (let i = 0; i < 1000; i++) {
			if (io.text().split("Submit —").length - 1 >= 3) break;
			await new Promise((resolveSpin) => setImmediate(resolveSpin));
		}
		// Replay what the terminal shows, then shrink it to 100 columns:
		// the terminal reflows every row and the cursor follows.
		const term: ScreenState = {};
		renderScreen(io.text(), { cols: 149, state: term });
		const splitAt = io.text().length;
		rewrapScreen(term, 100);
		io.output.columns = 100;
		// The same keypress that first renders at the new width also
		// changes the state: moving off the blocked row hides the footer.
		// The rewind must measure the PREVIOUS render (footer visible,
		// one line taller after reflow), not the state being painted.
		type(io, UP);
		for (let i = 0; i < 1000; i++) {
			if (io.text().split("Submit —").length - 1 >= 4) break;
			await new Promise((resolveSpin) => setImmediate(resolveSpin));
		}
		const during = renderScreen(io.text().slice(splitAt), {
			cols: 100,
			state: term,
		}).filter((l) => l !== "");
		assert.strictEqual(
			during.filter((l) => l.includes("Alpha")).length,
			1,
			`stale row survived the resize: ${JSON.stringify(during)}`,
		);
		assert.strictEqual(
			during.filter((l) => l.includes("Submit —")).length,
			1,
			`menu fragments piled up after resize: ${JSON.stringify(during)}`,
		);
		const splitAt2 = io.text().length;
		setImmediate(() => io.input.write(ESCAPE));
		const result = await done;
		assert.ok(result.interactive && result.cancelled);
		const after = renderScreen(io.text().slice(splitAt2), {
			cols: 100,
			state: term,
		}).filter((l) => l !== "");
		assert.deepStrictEqual(after, ["previous output line"]);
	});

	test("cancel right after a resize, before any repaint, clears only the prompt", async () => {
		const io = fakeTTY(); // starts at 80 columns
		io.output.write("previous output line\n");
		const done = multiSelect({
			message: "Pick",
			submitLabel: "Start setup",
			options: [
				{
					label: "Desktop Modeler",
					value: "modeler",
					checked: true,
					group: "Essentials",
					description:
						"Install the desktop app to edit BPMN, DMN, and forms visually",
				},
				{
					label: "Docs MCP server",
					value: "docs",
					group: "AI-assisted development",
					description:
						"Search current Camunda 8 docs from your AI assistant (browser sign-in on first use)",
				},
			],
			io,
		});
		// The terminal grows while the menu is open and no keypress
		// follows before the cancel: the terminal rewrapped the menu, so
		// the line counts from render time no longer match the screen.
		io.output.columns = 149;
		type(io, ESCAPE);
		const result = await done;
		assert.ok(result.interactive && result.cancelled);
		const visible = renderScreen(io.text(), { cols: 149 }).filter(
			(l) => l !== "",
		);
		assert.deepStrictEqual(visible, ["previous output line"]);
	});

	describe("groups", () => {
		const GROUPED_OPTIONS = [
			{
				label: "Cluster",
				value: "cluster",
				checked: true,
				group: "Essentials",
			},
			{
				label: "Modeler",
				value: "modeler",
				checked: true,
				group: "Essentials",
			},
			{ label: "Skills", value: "skills", group: "AI-assisted development" },
		];

		test("renders a header above each group and indents its options", async () => {
			const io = fakeTTY();
			type(io, TAB, ENTER);
			await multiSelect({ message: "Pick", options: GROUPED_OPTIONS, io });
			const plain = stripVTControlCharacters(io.text());
			assert.match(plain, /^ {2}Essentials$/m);
			assert.match(plain, /^ {2}AI-assisted development$/m);
			// Grouped options sit two spaces deeper than their header.
			assert.match(plain, / {4}❯ \[x\] Cluster/);
			assert.match(plain, / {6}\[x\] Modeler/);
			assert.match(plain, / {6}\[ \] Skills/);
		});

		test("headers are not focusable: the cursor moves option to option", async () => {
			const io = fakeTTY();
			// Cluster → Modeler → Skills; the header rows are skipped.
			// Space on Skills checks it.
			type(io, DOWN, DOWN, " ", TAB, ENTER);
			const result = await multiSelect({
				message: "Pick",
				options: GROUPED_OPTIONS,
				io,
			});
			assert.ok(result.interactive && !result.cancelled);
			assert.deepStrictEqual(result.values, ["cluster", "modeler", "skills"]);
		});

		test("a number key still toggles the matching option", async () => {
			const io = fakeTTY();
			type(io, "3", TAB, ENTER);
			const result = await multiSelect({
				message: "Pick",
				options: GROUPED_OPTIONS,
				io,
			});
			assert.ok(result.interactive && !result.cancelled);
			assert.deepStrictEqual(result.values, ["cluster", "modeler", "skills"]);
		});

		test("non-interactive hint lists groups with indented options", async () => {
			const result = await multiSelect({
				message: "Pick",
				options: GROUPED_OPTIONS,
				io: fakePipe(),
			});
			assert.ok(!result.interactive);
			assert.match(result.hint, / {2}Essentials\n/);
			assert.match(result.hint, / {4}\[x\] Cluster/);
			assert.match(
				result.hint,
				/ {2}AI-assisted development\n {4}\[ \] Skills/,
			);
		});
	});
	describe("submit button", () => {
		test("Enter on an option row toggles it instead of confirming", async () => {
			const io = fakeTTY();
			// Alpha starts checked; Enter unchecks it. Only the submit
			// button confirms.
			type(io, ENTER, TAB, ENTER);
			const result = await multiSelect({
				message: "Pick",
				options: CHECKED_OPTIONS,
				io,
			});
			assert.ok(result.interactive && !result.cancelled);
			assert.deepStrictEqual(result.values, ["c"]);
		});

		test("Tab focuses the submit button; Enter there confirms", async () => {
			const io = fakeTTY();
			type(io, TAB, ENTER);
			const result = await multiSelect({
				message: "Pick",
				options: CHECKED_OPTIONS,
				io,
			});
			assert.ok(result.interactive && !result.cancelled);
			assert.deepStrictEqual(result.values, ["a", "c"]);
		});

		test("arrow down past the last option lands on the submit button", async () => {
			const io = fakeTTY();
			type(io, DOWN, DOWN, DOWN, ENTER);
			const result = await multiSelect({
				message: "Pick",
				options: CHECKED_OPTIONS,
				io,
			});
			assert.ok(result.interactive && !result.cancelled);
			assert.deepStrictEqual(result.values, ["a", "c"]);
		});

		test("arrow up from the first option wraps onto the submit button", async () => {
			const io = fakeTTY();
			// Up lands on the button; Space there is a no-op, so the
			// selection is unchanged when Enter confirms.
			type(io, UP, " ", ENTER);
			const result = await multiSelect({
				message: "Pick",
				options: CHECKED_OPTIONS,
				io,
			});
			assert.ok(result.interactive && !result.cancelled);
			assert.deepStrictEqual(result.values, ["a", "c"]);
		});

		test("Space on the submit button does not confirm", async () => {
			const io = fakeTTY();
			let resolved = false;
			const done = multiSelect({
				message: "Pick",
				options: CHECKED_OPTIONS,
				io,
			}).then((r) => {
				resolved = true;
				return r;
			});
			type(io, TAB, " ");
			for (let i = 0; i < 100 && !resolved; i++) {
				await new Promise((resolveSpin) => setImmediate(resolveSpin));
			}
			assert.strictEqual(resolved, false, "Space on the button confirmed");
			setImmediate(() => io.input.write(ENTER));
			const result = await done;
			assert.ok(result.interactive && !result.cancelled);
			assert.deepStrictEqual(result.values, ["a", "c"]);
		});

		test("number keys toggle options while the button is focused", async () => {
			const io = fakeTTY();
			type(io, TAB, "2", ENTER);
			const result = await multiSelect({
				message: "Pick",
				options: CHECKED_OPTIONS,
				io,
			});
			assert.ok(result.interactive && !result.cancelled);
			assert.deepStrictEqual(result.values, ["a", "b", "c"]);
		});

		test("Escape on the submit button cancels", async () => {
			const io = fakeTTY();
			type(io, TAB, ESCAPE);
			const result = await multiSelect({
				message: "Pick",
				options: CHECKED_OPTIONS,
				io,
			});
			assert.deepStrictEqual(result, { interactive: true, cancelled: true });
		});

		test("the submit button is drawn as a bordered box", async () => {
			const io = fakeTTY();
			type(io, TAB, ENTER);
			await multiSelect({ message: "Pick", options: CHECKED_OPTIONS, io });
			const plain = stripVTControlCharacters(io.text());
			assert.match(
				plain,
				/╭─+╮\n {2}│ {2}Submit — 2 of 3 selected ➜ {2}│\n {2}╰─+╯/,
			);
		});

		test("the unfocused submit button border is solid white, not dimmed", async () => {
			const io = fakeTTY();
			type(io, TAB, ENTER);
			await multiSelect({ message: "Pick", options: CHECKED_OPTIONS, io });
			assert.ok(
				!io.text().includes("\x1b[2m╭"),
				"unfocused button border is dimmed",
			);
			assert.match(
				stripVTControlCharacters(io.text()),
				/╭─+╮\n {2}│ {2}Submit — 2 of 3 selected ➜ {2}│\n {2}╰─+╯/,
			);
		});

		test("the button shows the selection count", async () => {
			const io = fakeTTY();
			type(io, TAB, ENTER);
			await multiSelect({ message: "Pick", options: CHECKED_OPTIONS, io });
			assert.match(
				stripVTControlCharacters(io.text()),
				/Submit — 2 of 3 selected/,
			);
		});

		test("the focused submit button inverts its content, not its border", async () => {
			const io = fakeTTY();
			const done = multiSelect({
				message: "Pick",
				options: CHECKED_OPTIONS,
				io,
			});
			type(io, TAB);
			for (
				let i = 0;
				i < 1000 && !io.text().includes("│\x1b[7m"); // focused content
				i++
			) {
				await new Promise((resolveSpin) => setImmediate(resolveSpin));
			}
			assert.ok(
				io
					.text()
					.includes("│\x1b[7m\x1b[1m  Submit — 2 of 3 selected ➜  \x1b[0m│"),
				"focused button content is not inverse and bold",
			);
			assert.ok(
				!io.text().includes("\x1b[7m╭"),
				"focused button border is inverse",
			);
			setImmediate(() => io.input.write(ENTER));
			await done;
		});

		test("a custom submitLabel is used on the button", async () => {
			const io = fakeTTY();
			type(io, TAB, ENTER);
			await multiSelect({
				message: "Pick",
				options: CHECKED_OPTIONS,
				submitLabel: "Start setup",
				io,
			});
			assert.match(
				stripVTControlCharacters(io.text()),
				/Start setup — 2 of 3 selected/,
			);
		});

		test("a non-ASCII submitLabel keeps the box borders aligned", async () => {
			const io = fakeTTY();
			type(io, TAB, ENTER);
			await multiSelect({
				message: "Pick",
				options: CHECKED_OPTIONS,
				submitLabel: "确认",
				io,
			});
			const plain = stripVTControlCharacters(io.text());
			// 确认 occupies four terminal cells, so the borders are two
			// cells wider than the label row's code-unit length.
			const inner = "  确认 — 2 of 3 selected ➜  ";
			const border = "─".repeat(28);
			assert.ok(
				plain.includes(`╭${border}╮\n  │${inner}│\n  ╰${border}╯`),
				`box borders are misaligned for a wide label:\n${plain}`,
			);
		});
		test("an emoji submitLabel keeps the box borders aligned", async () => {
			const io = fakeTTY();
			type(io, TAB, ENTER);
			await multiSelect({
				message: "Pick",
				options: CHECKED_OPTIONS,
				submitLabel: "🚀",
				io,
			});
			const plain = stripVTControlCharacters(io.text());
			// 🚀 has default emoji presentation: two terminal cells.
			const inner = "  🚀 — 2 of 3 selected ➜  ";
			const border = "─".repeat(26);
			assert.ok(
				plain.includes(`╭${border}╮\n  │${inner}│\n  ╰${border}╯`),
				`box borders are misaligned for an emoji label:\n${plain}`,
			);
		});
	});
});

describe("createPromptSession()", () => {
	describe("with yes: true", () => {
		test("confirm returns the default without reading input", async () => {
			const io = fakeTTY();
			const prompts = createPromptSession({ yes: true, io });
			assert.strictEqual(
				await prompts.confirm({ message: "Install?", defaultValue: true }),
				true,
			);
			assert.strictEqual(
				await prompts.confirm({ message: "Docs MCP?", defaultValue: false }),
				false,
			);
			assert.strictEqual(io.text(), "");
		});

		test("select returns the default option without reading input", async () => {
			const io = fakeTTY();
			const prompts = createPromptSession({ yes: true, io });
			const value = await prompts.select({
				message: "Pick",
				options: OPTIONS,
				initialIndex: 1,
			});
			assert.strictEqual(value, "b");
			assert.strictEqual(io.text(), "");
		});

		test("accepts defaults even when the terminal is not interactive", async () => {
			const prompts = createPromptSession({ yes: true, io: fakePipe() });
			assert.strictEqual(
				await prompts.confirm({ message: "Install?", defaultValue: true }),
				true,
			);
		});
	});

	describe("with yes: false", () => {
		test("prompts on a TTY", async () => {
			const io = fakeTTY();
			const prompts = createPromptSession({ yes: false, io });
			type(io, "2");
			assert.strictEqual(
				await prompts.select({ message: "Pick", options: OPTIONS }),
				"b",
			);
		});

		test("confirm fails fast on a non-TTY, naming the question and --yes", async () => {
			const prompts = createPromptSession({ yes: false, io: fakePipe() });
			await assert.rejects(
				prompts.confirm({ message: "Install skills?" }),
				(error: unknown) => {
					assert.ok(error instanceof PromptNotInteractiveError);
					assert.match(error.message, /Install skills\?/);
					assert.match(error.message, /--yes/);
					return true;
				},
			);
		});

		test("select fails fast on a non-TTY", async () => {
			const prompts = createPromptSession({ yes: false, io: fakePipe() });
			await assert.rejects(
				prompts.select({ message: "Pick", options: OPTIONS }),
				PromptNotInteractiveError,
			);
		});

		test("the session hint is included in the non-TTY error", async () => {
			const prompts = createPromptSession({
				yes: false,
				io: fakePipe(),
				nonInteractiveHint: "Or pass --skills to choose explicitly.",
			});
			await assert.rejects(
				prompts.confirm({ message: "Install skills?" }),
				/Or pass --skills to choose explicitly\./,
			);
		});

		test("a per-question hint overrides the session hint", async () => {
			const prompts = createPromptSession({
				yes: false,
				io: fakePipe(),
				nonInteractiveHint: "session hint",
			});
			await assert.rejects(
				prompts.confirm({
					message: "Install skills?",
					nonInteractiveHint: "question hint",
				}),
				(error: unknown) => {
					assert.ok(error instanceof Error);
					assert.match(error.message, /question hint/);
					assert.doesNotMatch(error.message, /session hint/);
					return true;
				},
			);
		});

		test("Escape in confirm rejects with PromptCancelledError", async () => {
			const io = fakeTTY();
			const prompts = createPromptSession({ yes: false, io });
			type(io, ESCAPE);
			await assert.rejects(
				prompts.confirm({ message: "Install?", defaultValue: true }),
				PromptCancelledError,
			);
			assertTerminalRestored(io);
		});

		test("Escape in select rejects with PromptCancelledError", async () => {
			const io = fakeTTY();
			const prompts = createPromptSession({ yes: false, io });
			type(io, ESCAPE);
			await assert.rejects(
				prompts.select({ message: "Pick", options: OPTIONS }),
				PromptCancelledError,
			);
		});
	});
});

/**
 * Ctrl+C re-raises SIGINT, which would kill the test runner, so each
 * prompt runs in its own child process. The child reports raw-mode and
 * cursor changes with synchronous writes as they happen, then dies from
 * the re-raised SIGINT under the default disposition.
 */
describe("Ctrl+C", () => {
	const FRAMEWORK = pathToFileURL(
		resolve(import.meta.dirname, "..", "..", "src", "framework", "index.ts"),
	).href;

	const childScript = (call: string) =>
		[
			`import { writeSync } from "node:fs";`,
			`import { PassThrough, Writable } from "node:stream";`,
			`import { confirm, multiSelect, select } from ${JSON.stringify(FRAMEWORK)};`,
			`const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (m) => { writeSync(1, "raw:" + m + ";"); return true; } });`,
			`const output = Object.assign(new Writable({ write(chunk, _enc, cb) { if (String(chunk).includes("\\x1b[?25h")) writeSync(1, "cursor:shown;"); cb(); } }), { isTTY: true, columns: 80 });`,
			`const io = { input, output };`,
			`setImmediate(() => input.write("\\x03"));`,
			`await ${call};`,
			`writeSync(1, "resolved;");`,
		].join("\n");

	const run = (call: string) =>
		asyncSpawn(
			"node",
			[
				"--experimental-strip-types",
				"--input-type=module",
				"-e",
				childScript(call),
			],
			{
				env: {
					...process.env,
					CI: "",
					C8CTL_INTERACTIVE: "",
					C8CTL_NON_INTERACTIVE: "",
				},
				timeout: 15_000,
			},
		);

	// Windows has no POSIX signal dispositions: process.kill(pid, "SIGINT")
	// terminates unconditionally and the exit is not reported as a signal.
	const skip =
		process.platform === "win32" && "POSIX signal semantics required";

	test("select restores the terminal and re-raises SIGINT", {
		skip,
	}, async () => {
		const result = await run(
			`select({ message: "Pick", options: [{ label: "A", value: "a" }], io })`,
		);
		assert.strictEqual(result.signal, "SIGINT", result.stderr);
		assert.strictEqual(result.stdout, "raw:true;raw:false;cursor:shown;");
	});

	test("confirm restores the terminal and re-raises SIGINT", {
		skip,
	}, async () => {
		const result = await run(`confirm({ message: "OK?", io })`);
		assert.strictEqual(result.signal, "SIGINT", result.stderr);
		assert.match(result.stdout, /^raw:true;.*raw:false;$/);
	});

	test("multiSelect restores the terminal and re-raises SIGINT", {
		skip,
	}, async () => {
		const result = await run(
			`multiSelect({ message: "Pick", options: [{ label: "A", value: "a" }], io })`,
		);
		assert.strictEqual(result.signal, "SIGINT", result.stderr);
		assert.strictEqual(result.stdout, "raw:true;raw:false;cursor:shown;");
	});
});
