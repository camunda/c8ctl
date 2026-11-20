/**
 * Interactive terminal prompts for c8ctl.
 *
 * Zero external dependencies — uses Node's built-in `readline` and
 * ANSI escape codes for cursor movement and styling.
 *
 * All prompts write to **stderr** and read from **stdin**, keeping
 * stdout clean for data output (JSON, tables, piped results).
 *
 * Non-interactive fallback: when stdin or stderr is not a TTY,
 * prompts return a non-interactive result that the caller can
 * use to emit hint text instead of blocking.
 *
 * ## Usage in command handlers
 *
 * ```ts
 * import { select, confirm } from "../framework/index.ts";
 *
 * // Single selection — arrow keys + enter
 * const result = await select({
 *   message: "Which profile to deploy to?",
 *   options: profiles.map(p => ({
 *     label: p.name,
 *     description: p.baseUrl,
 *     value: p.name,
 *   })),
 * });
 * if (result.cancelled) {
 *   // User pressed Escape — handle cancellation
 *   return;
 * }
 * if (!result.interactive) {
 *   // Non-TTY: emit hint and proceed with default
 *   logger.info(result.hint);
 * }
 * const chosen = result.value; // first option if non-interactive
 *
 * // Yes/no confirmation
 * const ok = await confirm({ message: "Deploy to production?" });
 * ```
 *
 * ## Multi-step flows that honour `--yes`
 *
 * `createPromptSession()` wraps both prompts with a fixed policy and
 * returns plain values:
 *
 * - `--yes` accepts every default without prompting.
 * - A non-interactive session without `--yes` throws
 *   `PromptNotInteractiveError` instead of silently picking a default.
 * - Escape throws `PromptCancelledError`.
 *
 * ```ts
 * const prompts = createPromptSession({ yes: ctx.yes });
 * if (await prompts.confirm({ message: "Install skills?", defaultValue: true })) {
 *   // …
 * }
 * ```
 *
 * ## Plugin authors
 *
 * The `select` and `confirm` functions are importable from the
 * c8ctl source tree. They follow the same TTY-detection pattern
 * used throughout c8ctl and respect JSON output mode.
 */

import type { Key } from "node:readline";
import { createInterface, emitKeypressEvents } from "node:readline";

// ── ANSI helpers ──────────────────────────────────────────────────

const ESC = "\x1b[";
const CLEAR_LINE = `${ESC}2K`;
/** Erase from the cursor to end of line: clears the stale tail of a
 * wrapped row whose new content is shorter than the previous render's. */
const CLEAR_TO_EOL = `${ESC}0K`;
const CURSOR_UP = (n: number) => `${ESC}${n}A`;
const CURSOR_TO_COL = (n: number) => `${ESC}${n}G`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;
const CYAN = `${ESC}36m`;
const YELLOW = `${ESC}33m`;
const INVERSE = `${ESC}7m`;
const RESET = `${ESC}0m`;

// ── Types ─────────────────────────────────────────────────────────

export interface PromptInput extends NodeJS.ReadableStream {
	isTTY?: boolean;
	setRawMode?(mode: boolean): unknown;
}

export interface PromptOutput extends NodeJS.WritableStream {
	isTTY?: boolean;
	columns?: number;
}

/**
 * Streams a prompt reads from and renders to. Defaults to
 * `process.stdin` / `process.stderr`; override to embed or test.
 */
export interface PromptIO {
	input: PromptInput;
	output: PromptOutput;
}

const defaultIO = (): PromptIO => ({
	input: process.stdin,
	output: process.stderr,
});

export interface SelectOption<T> {
	/** Display label shown in the menu. */
	label: string;
	/** Optional secondary text (dimmed, after the label). */
	description?: string;
	/** Value returned when this option is selected. */
	value: T;
}

export interface SelectConfig<T> {
	/** Prompt message shown above the options. */
	message: string;
	/** List of selectable options. At least one required. */
	options: ReadonlyArray<SelectOption<T>>;
	/** Index of the initially highlighted option (default: 0). */
	initialIndex?: number;
	/**
	 * Hint appended to non-interactive fallback output.
	 * Defaults to "Hint: run interactively to choose."
	 */
	nonInteractiveHint?: string;
	/** Streams to use instead of stdin/stderr. */
	io?: PromptIO;
}

export interface SelectResultInteractive<T> {
	interactive: true;
	cancelled: false;
	value: T;
	index: number;
	label: string;
}

export interface SelectResultCancelled {
	interactive: true;
	cancelled: true;
}

export interface SelectResultNonInteractive<T> {
	interactive: false;
	cancelled: false;
	value: T;
	index: number;
	label: string;
	/** Hint message suitable for logging in non-interactive mode. */
	hint: string;
}

export type SelectResult<T> =
	| SelectResultInteractive<T>
	| SelectResultCancelled
	| SelectResultNonInteractive<T>;

export interface ConfirmConfig {
	/** Prompt message. */
	message: string;
	/** Default value when the user presses Enter without typing (default: false). */
	defaultValue?: boolean;
	/**
	 * Hint used by `createPromptSession()` when the question cannot be
	 * asked because the session is not interactive.
	 */
	nonInteractiveHint?: string;
	/** Streams to use instead of stdin/stderr. */
	io?: PromptIO;
}

export interface ConfirmResult {
	interactive: boolean;
	/** The answer. Always `false` when cancelled, whatever the default. */
	value: boolean;
	/** True when the user pressed Escape instead of answering. */
	cancelled?: boolean;
	/** Hint message suitable for logging in non-interactive mode. */
	hint?: string;
}

// ── TTY detection ─────────────────────────────────────────────────

/**
 * Determine whether the session supports interactive prompts.
 *
 * Checks (in order of precedence):
 * 1. `C8CTL_INTERACTIVE=false` — explicit opt-out (e.g. in CI or scripts)
 * 2. `C8CTL_NON_INTERACTIVE=true` — convenience alias for scripts
 * 3. `CI` set to any non-empty value — standard CI signal → non-interactive
 * 4. stdin + stderr (or the injected `io` streams) must both be TTY
 *
 * `C8CTL_INTERACTIVE=true` overrides CI detection but still requires
 * real TTY capabilities — it cannot force raw-mode on a pipe.
 */
export function isInteractive(io: PromptIO = defaultIO()): boolean {
	const hasTTY = !!io.input.isTTY && !!io.output.isTTY;

	const explicit = process.env.C8CTL_INTERACTIVE?.toLowerCase();
	if (explicit === "false" || explicit === "0") return false;
	if (explicit === "true" || explicit === "1") return hasTTY;

	// C8CTL_NON_INTERACTIVE is a convenience alias for scripts
	const nonInteractive = process.env.C8CTL_NON_INTERACTIVE?.toLowerCase();
	if (nonInteractive === "true" || nonInteractive === "1") return false;

	// Standard CI env var — most CI systems set CI to "true", "1",
	// or any non-empty value. Treat any non-empty CI as non-interactive.
	if (process.env.CI) return false;

	return hasTTY;
}

// ── select() ──────────────────────────────────────────────────────

/** Number keys 1–9 pick the matching option directly. */
const MAX_NUMBERED_OPTIONS = 9;

const numberPrefix = (index: number): string =>
	index < MAX_NUMBERED_OPTIONS ? `${index + 1}. ` : "   ";

/**
 * Present an interactive single-select menu.
 *
 * - **Interactive**: renders a numbered list on stderr. Arrow keys move
 *   the highlight and Enter selects; pressing an option's number (1–9)
 *   selects it immediately. Escape cancels. Returns the chosen value.
 * - **Non-interactive**: returns the first option (or `initialIndex`)
 *   with `interactive: false` and a `hint` string the caller can log.
 */
export async function select<T>(
	config: SelectConfig<T>,
): Promise<SelectResult<T>> {
	const { message, options, nonInteractiveHint } = config;
	const { input, output: out } = config.io ?? defaultIO();
	// Clamp initialIndex to valid range so out-of-bounds values
	// (e.g. stale index after filtering) don't cause crashes.
	const initialIndex = Math.max(
		0,
		Math.min(config.initialIndex ?? 0, options.length - 1),
	);

	if (options.length === 0) {
		throw new Error("select() requires at least one option");
	}

	// ── Non-interactive fallback ────────────────────────────────
	if (!isInteractive({ input, output: out })) {
		const fallback = options[initialIndex] ?? options[0];
		const idx = options.indexOf(fallback);

		const hint = formatNonInteractiveHint(
			message,
			options,
			idx,
			nonInteractiveHint,
		);
		return {
			interactive: false,
			cancelled: false,
			value: fallback.value,
			index: idx,
			label: fallback.label,
			hint,
		};
	}

	// ── Interactive mode ────────────────────────────────────────
	return new Promise<SelectResultInteractive<T> | SelectResultCancelled>(
		(resolve) => {
			let cursor = initialIndex;

			// Pre-compute the number of physical terminal lines the menu
			// occupies. When an option line is wider than the terminal, it
			// wraps to multiple physical lines. CURSOR_UP must move by
			// physical lines, not logical option count, or previous
			// renders bleed through.
			const cols = out.columns || 80;
			const headerLines = Math.max(1, Math.ceil((2 + message.length) / cols));
			const physicalLines = options.reduce((sum, opt, i) => {
				// Visible width: "  ❯ " (4 chars) + "N. " + label + optional " " + description
				const visible =
					4 +
					numberPrefix(i).length +
					opt.label.length +
					(opt.description ? 1 + opt.description.length : 0);
				return sum + Math.max(1, Math.ceil(visible / cols));
			}, 0);

			// Render the menu
			function render(firstRender: boolean) {
				if (!firstRender) {
					// Move cursor back up to overwrite previous render
					out.write(CURSOR_UP(physicalLines));
				}
				for (let i = 0; i < options.length; i++) {
					const opt = options[i];
					const selected = i === cursor;
					const pointer = selected ? `${CYAN}❯${RESET}` : " ";
					const number = `${DIM}${numberPrefix(i)}${RESET}`;
					const label = selected ? `${BOLD}${opt.label}${RESET}` : opt.label;
					const desc = opt.description
						? ` ${DIM}${opt.description}${RESET}`
						: "";
					out.write(
						`${CLEAR_LINE}${CURSOR_TO_COL(1)}  ${pointer} ${number}${label}${desc}\n`,
					);
				}
			}

			// Print the message header
			out.write(`${BOLD}${CYAN}?${RESET} ${BOLD}${message}${RESET}\n`);
			out.write(HIDE_CURSOR);
			render(true);

			// Enable keypress events BEFORE raw mode so the first
			// keystroke is captured (order matters).
			emitKeypressEvents(input);
			input.on("keypress", onKeypress);
			input.setRawMode?.(true);
			input.resume();

			function choose(index: number) {
				cleanup();
				const chosen = options[index];
				// Replace the menu with the final selection line
				out.write(CURSOR_UP(physicalLines));
				for (let i = 0; i < physicalLines; i++) {
					out.write(`${CLEAR_LINE}\n`);
				}
				out.write(CURSOR_UP(physicalLines));
				out.write(
					`${CLEAR_LINE}${CURSOR_TO_COL(1)}  ${CYAN}${chosen.label}${RESET}`,
				);
				if (chosen.description) {
					out.write(` ${DIM}${chosen.description}${RESET}`);
				}
				out.write("\n");
				resolve({
					interactive: true,
					cancelled: false,
					value: chosen.value,
					index,
					label: chosen.label,
				});
			}

			function onKeypress(_chunk: Buffer | string, key: Key) {
				if (!key) return;

				const digit = Number(key.sequence);
				if (
					key.sequence?.length === 1 &&
					Number.isInteger(digit) &&
					digit >= 1 &&
					digit <= Math.min(options.length, MAX_NUMBERED_OPTIONS)
				) {
					choose(digit - 1);
				} else if (key.name === "up" || (key.ctrl && key.name === "p")) {
					cursor = cursor <= 0 ? options.length - 1 : cursor - 1;
					render(false);
				} else if (key.name === "down" || (key.ctrl && key.name === "n")) {
					cursor = cursor >= options.length - 1 ? 0 : cursor + 1;
					render(false);
				} else if (key.name === "return") {
					choose(cursor);
				} else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
					cleanup();
					// Clear the menu and header
					out.write(CURSOR_UP(physicalLines));
					for (let i = 0; i < physicalLines; i++) {
						out.write(`${CLEAR_LINE}\n`);
					}
					out.write(CURSOR_UP(physicalLines + headerLines));
					for (let i = 0; i < headerLines; i++) {
						out.write(`${CLEAR_LINE}\n`);
					}
					out.write(CURSOR_UP(headerLines));
					// Ctrl+C: re-raise so the process exits naturally
					if (key.ctrl && key.name === "c") {
						process.kill(process.pid, "SIGINT");
					}
					// Escape: resolve as cancelled
					resolve({
						interactive: true,
						cancelled: true,
					});
				}
			}

			function cleanup() {
				input.removeListener("keypress", onKeypress);
				input.setRawMode?.(false);
				input.pause();
				out.write(SHOW_CURSOR);
			}
		},
	);
}

// ── multiSelect() ───────────────────────────────────────────────────

export interface MultiSelectOption<T> {
	/** Display label shown in the list. */
	label: string;
	/** Optional secondary text (dimmed, after the label). */
	description?: string;
	/** Value returned when this option is checked. */
	value: T;
	/** Initially checked (default: false). Also the non-interactive default. */
	checked?: boolean;
	/**
	 * This option depends on other options: while any listed value is
	 * unchecked, this row is forced off, greyed out with the reason, and
	 * cannot be toggled. Values are compared with Object.is. Re-checking
	 * the requirement re-enables the row (still unchecked).
	 */
	requires?: readonly { value: T; reason: string }[];
	/**
	 * Section heading this option belongs to. Consecutive options with
	 * the same group label render together under a non-interactive
	 * header row and are indented beneath it. Headers are display-only:
	 * the cursor and number keys address options, never headers.
	 */
	group?: string;
}

export interface MultiSelectConfig<T> {
	/** Prompt message shown above the options. */
	message: string;
	/** List of checkable options. At least one required. */
	options: ReadonlyArray<MultiSelectOption<T>>;
	/**
	 * Key hint rendered dimmed below the message.
	 * Defaults to the built-in key summary.
	 */
	keyHint?: string;
	/**
	 * Hint appended to non-interactive fallback output.
	 * Defaults to "Hint: run interactively to choose."
	 */
	nonInteractiveHint?: string;
	/** Streams to use instead of stdin/stderr. */
	io?: PromptIO;
}

export interface MultiSelectResultInteractive<T> {
	interactive: true;
	cancelled: false;
	/** Values of the checked options, in option order. May be empty. */
	values: T[];
}

export interface MultiSelectResultCancelled {
	interactive: true;
	cancelled: true;
}

export interface MultiSelectResultNonInteractive<T> {
	interactive: false;
	cancelled: false;
	/** Values of the options marked `checked`, in option order. */
	values: T[];
	/** Hint message suitable for logging in non-interactive mode. */
	hint: string;
}

export type MultiSelectResult<T> =
	| MultiSelectResultInteractive<T>
	| MultiSelectResultCancelled
	| MultiSelectResultNonInteractive<T>;

const DEFAULT_MULTISELECT_KEY_HINT =
	"↑/↓ move · space toggle · a all · enter confirm · esc cancel";

/**
 * Evaluate a checkbox list with dependencies: an option counts as
 * checked only when every option it requires is itself effectively
 * checked. Passes only ever uncheck options, so the fixpoint settles
 * within options.length iterations even for chains (a needs b, b
 * needs c).
 */
function evaluateChecked<T>(
	options: ReadonlyArray<MultiSelectOption<T>>,
	checked: boolean[],
): { effective: boolean[]; reasons: (string | undefined)[] } {
	let effective = [...checked];
	let reasons: (string | undefined)[] = options.map(() => undefined);
	for (let pass = 0; pass < options.length; pass++) {
		reasons = options.map((opt) => {
			const unmet = opt.requires?.find((req) => {
				const reqIndex = options.findIndex((o) =>
					Object.is(o.value, req.value),
				);
				return reqIndex === -1 || !effective[reqIndex];
			});
			return unmet?.reason;
		});
		const next = options.map(
			(_, i) => checked[i] === true && reasons[i] === undefined,
		);
		if (next.every((v, i) => v === effective[i])) {
			effective = next;
			break;
		}
		effective = next;
	}
	return { effective, reasons };
}

/** A renderable line: a group header, or one of the options. */
type MultiSelectRow =
	| { kind: "header"; label: string }
	| { kind: "option"; index: number };

/**
 * Interleave group headers between options. A header is emitted when an
 * option's group differs from the previous option's, so groups are
 * contiguous runs — same-named sections are not merged.
 */
function buildRows<T>(
	options: ReadonlyArray<MultiSelectOption<T>>,
): MultiSelectRow[] {
	const rows: MultiSelectRow[] = [];
	let lastGroup: string | undefined;
	for (const [index, opt] of options.entries()) {
		if (opt.group !== undefined && opt.group !== lastGroup) {
			rows.push({ kind: "header", label: opt.group });
		}
		lastGroup = opt.group;
		rows.push({ kind: "option", index });
	}
	return rows;
}

/**
 * Present an interactive checkbox list.
 *
 * - **Interactive**: renders one row per option on stderr, grouped
 *   under non-interactive header rows when options carry a `group`.
 *   Arrow keys move the highlight, Space (or the row's number) toggles
 *   it, `a` toggles all, Enter confirms — possibly with nothing
 *   checked — and Escape cancels. Options blocked by `requires` are
 *   dimmed with their reason highlighted, and the line under the list
 *   explains the focused blocked row. Returns the checked values in
 *   option order.
 * - **Non-interactive**: returns the values of options marked
 *   `checked` with `interactive: false` and a `hint` string the caller
 *   can log.
 */
export async function multiSelect<T>(
	config: MultiSelectConfig<T>,
): Promise<MultiSelectResult<T>> {
	const { message, options, nonInteractiveHint } = config;
	const { input, output: out } = config.io ?? defaultIO();
	const keyHint = config.keyHint ?? DEFAULT_MULTISELECT_KEY_HINT;

	if (options.length === 0) {
		throw new Error("multiSelect() requires at least one option");
	}

	// ── Non-interactive fallback ────────────────────────────────
	if (!isInteractive({ input, output: out })) {
		const initial = options.map((opt) => opt.checked === true);
		const { effective, reasons } = evaluateChecked(options, initial);
		const values = options
			.filter((_opt, i) => effective[i])
			.map((opt) => opt.value);
		const lines: string[] = [`${message} (non-interactive, using defaults)`];
		for (const row of buildRows(options)) {
			if (row.kind === "header") {
				lines.push(`  ${row.label}`);
				continue;
			}
			const opt = options[row.index];
			const indent = opt.group === undefined ? "  " : "    ";
			const desc = opt.description ? ` — ${opt.description}` : "";
			const reason =
				reasons[row.index] !== undefined ? ` — ⚠ ${reasons[row.index]}` : "";
			lines.push(
				`${indent}${effective[row.index] ? "[x]" : "[ ]"} ${opt.label}${desc}${reason}`,
			);
		}
		lines.push("");
		lines.push(nonInteractiveHint ?? "Hint: run interactively to choose.");
		return {
			interactive: false,
			cancelled: false,
			values,
			hint: lines.join("\n"),
		};
	}

	// ── Interactive mode ────────────────────────────────────────
	return new Promise<MultiSelectResult<T>>((resolve) => {
		let cursor = 0;
		const checked = options.map((opt) => opt.checked === true);
		let state = evaluateChecked(options, checked);

		/**
		 * Re-evaluate dependencies and persist the result: a disabled row is
		 * actually cleared, so re-enabling it later does not silently bring
		 * back a hidden checkmark — not for the initial state, not after a
		 * toggle, not after select-all.
		 */
		function reevaluate(): void {
			state = evaluateChecked(options, checked);
			for (let i = 0; i < options.length; i++) {
				checked[i] = state.effective[i];
			}
		}
		reevaluate();

		// Display rows interleave group headers with options. Group
		// membership is fixed for the lifetime of the prompt, so the row
		// list is built once; only the per-row state changes.
		const rows = buildRows(options);

		// Same wrap accounting as select(): rows wider than the terminal
		// occupy extra physical lines that CURSOR_UP must traverse.
		const cols = out.columns || 80;
		const headerLines =
			Math.max(1, Math.ceil((2 + message.length) / cols)) +
			Math.max(1, Math.ceil((2 + keyHint.length) / cols));
		const rowVisibleLength = (row: MultiSelectRow): number => {
			if (row.kind === "header") return 2 + row.label.length;
			const opt = options[row.index];
			const reason = state.reasons[row.index];
			// "  ❯ " (4) + "[x] " (4) + group indent (2 when grouped) + label
			// + optional " " + description + optional " ⚠ " + reason
			return (
				8 +
				(opt.group === undefined ? 0 : 2) +
				opt.label.length +
				(opt.description ? 1 + opt.description.length : 0) +
				(reason !== undefined ? 3 + reason.length : 0)
			);
		};
		/**
		 * The line under the list names the focused row's unmet
		 * requirement — the prominent explanation for a greyed-out
		 * option. Blank when the focused row is not blocked. Always
		 * rendered so the physical line count stays stable.
		 */
		const footerText = (): string | undefined => {
			const reason = state.reasons[cursor];
			if (reason === undefined) return undefined;
			return `⚠ ${options[cursor].label} ${reason} — enable it to unlock this option`;
		};
		const footerVisibleLength = (): number => {
			const text = footerText();
			return text === undefined ? 0 : 2 + text.length;
		};
		// Recomputed per render: dependency reasons appear and disappear
		// as options are toggled, changing how rows wrap.
		const physicalLineCount = (): number =>
			rows.reduce(
				(sum, row) =>
					sum + Math.max(1, Math.ceil(rowVisibleLength(row) / cols)),
				0,
			) + Math.max(1, Math.ceil(footerVisibleLength() / cols));
		// Cursor rewinds must traverse the *previous* render's line count.
		let lastRenderedLines = 0;

		/**
		 * Erase the stale tail of a wrapped row whose new content is
		 * shorter than the previous render's — but only when the
		 * content does not exactly fill its last physical line: under
		 * delayed autowrap the cursor then sits on the final character,
		 * and erase-to-EOL would delete it. An exactly-full line was
		 * fully overwritten, so no stale tail can remain.
		 */
		const eraseTail = (visibleLength: number): string =>
			visibleLength % cols === 0 ? "" : CLEAR_TO_EOL;

		function render(firstRender: boolean) {
			if (!firstRender) {
				out.write(CURSOR_UP(lastRenderedLines));
			}
			for (const row of rows) {
				if (row.kind === "header") {
					out.write(
						`${CLEAR_LINE}${CURSOR_TO_COL(1)}  ${BOLD}${row.label}${RESET}${eraseTail(2 + row.label.length)}\n`,
					);
					continue;
				}
				const i = row.index;
				const opt = options[i];
				const highlighted = i === cursor;
				const reason = state.reasons[i];
				const indent = opt.group === undefined ? "  " : "    ";
				const pointer = highlighted ? `${CYAN}❯${RESET}` : " ";
				const box =
					state.effective[i] && reason === undefined
						? `${INVERSE}[x]${RESET}`
						: "[ ]";
				// A blocked row dims label and description, and the reason
				// stands out in warning yellow instead of blending into the
				// dimmed row.
				let label = opt.label;
				if (reason !== undefined) label = `${DIM}${opt.label}${RESET}`;
				else if (highlighted) label = `${BOLD}${opt.label}${RESET}`;
				const desc = opt.description ? ` ${DIM}${opt.description}${RESET}` : "";
				const why = reason !== undefined ? ` ${YELLOW}⚠ ${reason}${RESET}` : "";
				out.write(
					`${CLEAR_LINE}${CURSOR_TO_COL(1)}${indent}${pointer} ${box} ${label}${desc}${why}${eraseTail(rowVisibleLength(row))}\n`,
				);
			}
			const footer = footerText();
			out.write(
				`${CLEAR_LINE}${CURSOR_TO_COL(1)}${footer === undefined ? "" : `  ${YELLOW}${footer}${RESET}`}${eraseTail(footerVisibleLength())}\n`,
			);
			// A repaint can be shorter than the previous render (a reason
			// or the footer collapsed to fewer wrapped lines). Erase the
			// leftover lines — otherwise their stale text survives below
			// the menu, out of reach of the final clearMenu().
			const painted = physicalLineCount();
			for (let i = painted; i < lastRenderedLines; i++) {
				out.write(`${CLEAR_LINE}\n`);
			}
			if (painted < lastRenderedLines) {
				out.write(CURSOR_UP(lastRenderedLines - painted));
			}
			lastRenderedLines = painted;
		}

		/** Re-evaluate dependencies after a toggle, then repaint. */
		function retoggle(index: number, value?: boolean) {
			if (state.reasons[index] !== undefined) return;
			checked[index] = value ?? !checked[index];
			reevaluate();
			render(false);
		}

		function clearMenu() {
			out.write(CURSOR_UP(lastRenderedLines));
			for (let i = 0; i < lastRenderedLines; i++) {
				out.write(`${CLEAR_LINE}\n`);
			}
			out.write(CURSOR_UP(lastRenderedLines));
		}

		// Print the message header and key hint
		out.write(`${BOLD}${CYAN}?${RESET} ${BOLD}${message}${RESET}\n`);
		out.write(`  ${DIM}${keyHint}${RESET}\n`);
		out.write(HIDE_CURSOR);
		render(true);

		// Enable keypress events BEFORE raw mode so the first
		// keystroke is captured (order matters).
		emitKeypressEvents(input);
		input.on("keypress", onKeypress);
		input.setRawMode?.(true);
		input.resume();

		function confirmSelection() {
			cleanup();
			clearMenu();
			const chosen = options.filter((_opt, i) => state.effective[i]);
			const summary =
				chosen.length > 0
					? `${CYAN}${chosen.map((opt) => opt.label).join(", ")}${RESET}`
					: `${DIM}(none selected)${RESET}`;
			out.write(`${CLEAR_LINE}${CURSOR_TO_COL(1)}  ${summary}\n`);
			resolve({
				interactive: true,
				cancelled: false,
				values: chosen.map((opt) => opt.value),
			});
		}

		function onKeypress(_chunk: Buffer | string, key: Key) {
			if (!key) return;

			const digit = Number(key.sequence);
			if (
				key.sequence?.length === 1 &&
				Number.isInteger(digit) &&
				digit >= 1 &&
				digit <= Math.min(options.length, MAX_NUMBERED_OPTIONS)
			) {
				retoggle(digit - 1);
			} else if (key.name === "up" || (key.ctrl && key.name === "p")) {
				cursor = cursor <= 0 ? options.length - 1 : cursor - 1;
				render(false);
			} else if (key.name === "down" || (key.ctrl && key.name === "n")) {
				cursor = cursor >= options.length - 1 ? 0 : cursor + 1;
				render(false);
			} else if (key.name === "space") {
				retoggle(cursor);
			} else if (key.sequence === "a") {
				// Set every option together so dependencies enabled by this
				// selection are included in the same all-toggle.
				const checkAll = state.effective.some((isChecked) => !isChecked);
				checked.fill(checkAll);
				reevaluate();
				render(false);
			} else if (key.name === "return") {
				confirmSelection();
			} else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
				cleanup();
				clearMenu();
				out.write(CURSOR_UP(headerLines));
				for (let i = 0; i < headerLines; i++) {
					out.write(`${CLEAR_LINE}\n`);
				}
				out.write(CURSOR_UP(headerLines));
				// Ctrl+C: re-raise so the process exits naturally
				if (key.ctrl && key.name === "c") {
					process.kill(process.pid, "SIGINT");
				}
				// Escape: resolve as cancelled
				resolve({ interactive: true, cancelled: true });
			}
		}

		function cleanup() {
			input.removeListener("keypress", onKeypress);
			input.setRawMode?.(false);
			input.pause();
			out.write(SHOW_CURSOR);
		}
	});
}

// ── confirm() ─────────────────────────────────────────────────────

/** Parse a yes/no answer; `undefined` means the answer was not recognised. */
function parseYesNo(
	answer: string,
	defaultValue: boolean,
): boolean | undefined {
	const normalized = answer.trim().toLowerCase();
	if (normalized === "") return defaultValue;
	if (normalized === "y" || normalized === "yes") return true;
	if (normalized === "n" || normalized === "no") return false;
	return undefined;
}

/**
 * Ask a yes/no question. Returns the answer.
 *
 * - **Interactive**: prompts on stderr with `[y/N]` or `[Y/n]`. Enter
 *   accepts the default; an unrecognised answer asks again. Escape
 *   cancels with `cancelled: true` and `value: false`.
 * - **Non-interactive**: returns `defaultValue` (false if omitted)
 *   with a hint string.
 */
export async function confirm(config: ConfirmConfig): Promise<ConfirmResult> {
	const { message, defaultValue = false } = config;
	const io = config.io ?? defaultIO();
	const suffix = defaultValue ? "[Y/n]" : "[y/N]";

	if (!isInteractive(io)) {
		const hint = `${message} — auto-${defaultValue ? "approved" : "declined"} (non-interactive)`;
		return { interactive: false, value: defaultValue, hint };
	}

	return new Promise<ConfirmResult>((resolve) => {
		const rl = createInterface({
			input: io.input,
			output: io.output,
		});

		let settled = false;
		let sigint = false;

		// Track Ctrl+C so the close handler can re-raise SIGINT
		// instead of silently treating it as "no".
		rl.on("SIGINT", () => {
			sigint = true;
			rl.close();
		});

		// If the readline closes without the question callback firing
		// (Ctrl+C, stream end), settle the promise so the command
		// doesn't hang.
		rl.on("close", () => {
			io.input.removeListener("keypress", onKeypress);
			if (!settled) {
				settled = true;
				if (sigint) {
					process.kill(process.pid, "SIGINT");
				}
				resolve({ interactive: true, value: defaultValue });
			}
		});

		// readline ignores a lone Escape, so watch for it directly. A
		// cancelled question answers "no" so a caller that only checks
		// `value` never proceeds on a default of "yes".
		function onKeypress(_chunk: Buffer | string, key?: Key) {
			if (key?.name !== "escape" || settled) return;
			settled = true;
			io.output.write("\n");
			rl.close();
			resolve({ interactive: true, value: false, cancelled: true });
		}
		io.input.on("keypress", onKeypress);

		const ask = () =>
			rl.question(
				`${BOLD}${CYAN}?${RESET} ${BOLD}${message}${RESET} ${DIM}${suffix}${RESET} `,
				(answer: string) => {
					const value = parseYesNo(answer, defaultValue);
					if (value === undefined) {
						io.output.write(`  ${DIM}Please answer y or n.${RESET}\n`);
						ask();
						return;
					}
					settled = true;
					rl.close();
					resolve({ interactive: true, value });
				},
			);
		ask();
	});
}

// ── createPromptSession() ─────────────────────────────────────────

/** Thrown when a prompt is needed but the session cannot ask it. */
export class PromptNotInteractiveError extends Error {
	override name = "PromptNotInteractiveError";
}

/** Thrown when the user cancels a prompt with Escape. */
export class PromptCancelledError extends Error {
	override name = "PromptCancelledError";
}

export interface PromptSessionConfig {
	/** True when `--yes` was passed: accept every default without asking. */
	yes: boolean;
	/**
	 * Extra guidance appended to the error raised when a question
	 * cannot be asked, e.g. the per-step flags that answer it.
	 * A question's own `nonInteractiveHint` takes precedence.
	 */
	nonInteractiveHint?: string;
	/** Streams to use instead of stdin/stderr. */
	io?: PromptIO;
}

export interface PromptSession {
	/** Ask a yes/no question and return the answer. */
	confirm(config: Omit<ConfirmConfig, "io">): Promise<boolean>;
	/** Ask a single-choice question and return the chosen value. */
	select<T>(config: Omit<SelectConfig<T>, "io">): Promise<T>;
}

/**
 * Create prompts for a multi-step flow with a consistent policy:
 *
 * - `yes: true` returns each question's default without prompting,
 *   even on a non-interactive session.
 * - Otherwise a non-interactive session throws
 *   `PromptNotInteractiveError` naming the question and suggesting
 *   `--yes`, so scripts fail fast instead of guessing.
 * - Escape throws `PromptCancelledError`. Ctrl+C re-raises SIGINT, as
 *   the underlying prompts do.
 */
export function createPromptSession(
	config: PromptSessionConfig,
): PromptSession {
	const io = config.io ?? defaultIO();

	const notInteractive = (message: string, hint?: string) =>
		new PromptNotInteractiveError(
			[
				`Cannot ask "${message}" because this session is not interactive.`,
				"Re-run with --yes to accept the defaults.",
				hint ?? config.nonInteractiveHint,
			]
				.filter(Boolean)
				.join("\n"),
		);

	return {
		async confirm(question) {
			const { defaultValue = false } = question;
			if (config.yes) return defaultValue;
			if (!isInteractive(io)) {
				throw notInteractive(question.message, question.nonInteractiveHint);
			}
			const result = await confirm({ ...question, io });
			if (result.cancelled) {
				throw new PromptCancelledError(`Cancelled: ${question.message}`);
			}
			return result.value;
		},

		async select<T>(question: Omit<SelectConfig<T>, "io">) {
			if (question.options.length === 0) {
				throw new Error("select() requires at least one option");
			}
			if (config.yes || !isInteractive(io)) {
				if (!config.yes) {
					throw notInteractive(question.message, question.nonInteractiveHint);
				}
				const index = Math.max(
					0,
					Math.min(question.initialIndex ?? 0, question.options.length - 1),
				);
				return question.options[index].value;
			}
			const result = await select({ ...question, io });
			if (result.cancelled) {
				throw new PromptCancelledError(`Cancelled: ${question.message}`);
			}
			return result.value;
		},
	};
}

// ── Helpers ───────────────────────────────────────────────────────

function formatNonInteractiveHint<T>(
	message: string,
	options: ReadonlyArray<SelectOption<T>>,
	selectedIndex: number,
	customHint?: string,
): string {
	const lines: string[] = [`${message} (non-interactive, using default)`];
	for (let i = 0; i < options.length; i++) {
		const opt = options[i];
		const marker = i === selectedIndex ? "→" : " ";
		const desc = opt.description ? ` — ${opt.description}` : "";
		lines.push(`  ${marker} ${opt.label}${desc}`);
	}
	lines.push("");
	lines.push(customHint ?? "Hint: run interactively to choose.");
	return lines.join("\n");
}
