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
const CURSOR_UP = (n: number) => `${ESC}${n}A`;
const CURSOR_TO_COL = (n: number) => `${ESC}${n}G`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;
const CYAN = `${ESC}36m`;
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
