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

	test("Enter keeps the pre-checked options", async () => {
		const io = fakeTTY();
		type(io, ENTER);
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
		type(io, " ", ENTER);
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
		type(io, DOWN, " ", ENTER);
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
		type(io, UP, " ", DOWN, DOWN, " ", ENTER);
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
		type(io, "a", ENTER);
		const result = await multiSelect({
			message: "Pick",
			options: CHECKED_OPTIONS,
			io,
		});
		assert.ok(result.interactive && !result.cancelled);
		assert.deepStrictEqual(result.values, ["a", "b", "c"]);

		const io2 = fakeTTY();
		type(io2, "a", "a", ENTER);
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
		type(io, " ", DOWN, DOWN, " ", ENTER);
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
		// Up from the first option lands on the last (Charlie, checked).
		type(io, UP, " ", ENTER);
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
		type(io, "2", ENTER);
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
		type(io, ENTER);
		await multiSelect({ message: "Pick", options: CHECKED_OPTIONS, io });
		const plain = stripVTControlCharacters(io.text());
		assert.match(plain, /\[x\] Alpha/);
		assert.match(plain, /\[ \] Bravo/);
		assert.match(plain, /\[x\] Charlie/);
	});

	test("uses inverse video for checked markers on either terminal theme", async () => {
		const io = fakeTTY();
		type(io, ENTER);
		await multiSelect({ message: "Pick", options: CHECKED_OPTIONS, io });
		assert.ok(io.text().includes("\x1b[7m[x]\x1b[0m"));
		assert.ok(io.text().includes("[ ] Bravo"));
	});

	test("renders the key hint below the message", async () => {
		const io = fakeTTY();
		type(io, ENTER);
		await multiSelect({ message: "Pick", options: CHECKED_OPTIONS, io });
		const plain = stripVTControlCharacters(io.text());
		assert.match(plain, /space/);
		assert.match(plain, /enter/);
	});

	test("the summary line lists the chosen labels", async () => {
		const io = fakeTTY();
		type(io, DOWN, " ", ENTER);
		await multiSelect({ message: "Pick", options: CHECKED_OPTIONS, io });
		const plain = stripVTControlCharacters(io.text());
		assert.match(plain, /Alpha, Bravo, Charlie/);
	});

	test("the summary line reports an empty selection", async () => {
		const io = fakeTTY();
		type(io, "a", "a", ENTER);
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
		["Enter", [ENTER]],
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
			type(io, "a", ENTER);
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
			type(io, " ", ENTER);
			const result = await multiSelect({
				message: "Pick",
				options: DEPENDENT_OPTIONS,
				io,
			});
			assert.ok(result.interactive && !result.cancelled);
			assert.deepStrictEqual(result.values, []);
			assert.match(
				stripVTControlCharacters(io.text()),
				/Blueprint.*— needs the local cluster/,
			);
		});

		test("a blocked option cannot be toggled until its requirement is back", async () => {
			const io = fakeTTY();
			// Cluster off; Blueprint toggle attempt (blocked); Cluster on;
			// Blueprint toggle (works now).
			type(io, " ", DOWN, " ", UP, " ", DOWN, " ", ENTER);
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
			type(io, " ", " ", ENTER);
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
