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
 * import { select, confirm } from "../prompt.ts";
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
 * ## Plugin authors
 *
 * The `select` and `confirm` functions are importable from the
 * c8ctl source tree. They follow the same TTY-detection pattern
 * used throughout c8ctl and respect JSON output mode.
 */

import type { Key } from "node:readline";
import { createInterface, emitKeypressEvents } from "node:readline";
import { c8ctl } from "../../core/index.ts";

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
}

export interface ConfirmResult {
	interactive: boolean;
	value: boolean;
	/** Hint message suitable for logging in non-interactive mode. */
	hint?: string;
}

// ── TTY detection ─────────────────────────────────────────────────

/**
 * Determine whether the session supports interactive prompts.
 *
 * Checks (in order of precedence):
 * 1. `C8CTL_INTERACTIVE=false` — explicit opt-out (e.g. in CI or scripts)
 * 2. `C8CTL_INTERACTIVE=true`  — explicit opt-in (force prompts even in CI)
 * 3. `CI=true`                 — standard CI signal → non-interactive
 * 4. stdin + stderr must both be TTY
 */
export function isInteractive(): boolean {
	const explicit = process.env.C8CTL_INTERACTIVE?.toLowerCase();
	if (explicit === "false" || explicit === "0") return false;
	if (explicit === "true" || explicit === "1") return true;

	// C8CTL_NON_INTERACTIVE is a convenience alias for scripts
	const nonInteractive = process.env.C8CTL_NON_INTERACTIVE?.toLowerCase();
	if (nonInteractive === "true" || nonInteractive === "1") return false;

	// Standard CI env var — most CI systems set CI=true
	if (process.env.CI?.toLowerCase() === "true") return false;

	return !!process.stdin.isTTY && !!process.stderr.isTTY;
}

// ── select() ──────────────────────────────────────────────────────

/**
 * Present an interactive single-select menu with arrow-key navigation.
 *
 * - **Interactive**: renders a list on stderr. Arrow keys move the
 *   highlight, Enter selects. Returns the chosen value.
 * - **Non-interactive**: returns the first option (or `initialIndex`)
 *   with `interactive: false` and a `hint` string the caller can log.
 */
export async function select<T>(
	config: SelectConfig<T>,
): Promise<SelectResult<T>> {
	const { message, options, initialIndex = 0 } = config;

	if (options.length === 0) {
		throw new Error("select() requires at least one option");
	}

	// ── Non-interactive fallback ────────────────────────────────
	if (!isInteractive()) {
		const fallback = options[initialIndex] ?? options[0];
		const idx = options.indexOf(fallback);

		const hint = formatNonInteractiveHint(message, options, idx);
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
			const out = process.stderr;

			// Pre-compute the number of physical terminal lines the menu
			// occupies. When an option line is wider than the terminal, it
			// wraps to multiple physical lines. CURSOR_UP must move by
			// physical lines, not logical option count, or previous
			// renders bleed through.
			const cols = out.columns || 80;
			const physicalLines = options.reduce((sum, opt) => {
				// Visible width: "  ❯ " (4 chars) + label + optional " " + description
				const visible =
					4 +
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
					const label = selected ? `${BOLD}${opt.label}${RESET}` : opt.label;
					const desc = opt.description
						? ` ${DIM}${opt.description}${RESET}`
						: "";
					out.write(
						`${CLEAR_LINE}${CURSOR_TO_COL(1)}  ${pointer} ${label}${desc}\n`,
					);
				}
			}

			// Print the message header
			out.write(`${BOLD}${CYAN}?${RESET} ${BOLD}${message}${RESET}\n`);
			out.write(HIDE_CURSOR);
			render(true);

			// Enable keypress events BEFORE raw mode so the first
			// keystroke is captured (order matters).
			emitKeypressEvents(process.stdin);
			process.stdin.on("keypress", onKeypress);
			process.stdin.setRawMode(true);
			process.stdin.resume();

			function onKeypress(_chunk: Buffer | string, key: Key) {
				if (!key) return;

				if (key.name === "up" || (key.ctrl && key.name === "p")) {
					cursor = cursor <= 0 ? options.length - 1 : cursor - 1;
					render(false);
				} else if (key.name === "down" || (key.ctrl && key.name === "n")) {
					cursor = cursor >= options.length - 1 ? 0 : cursor + 1;
					render(false);
				} else if (key.name === "return") {
					cleanup();
					const chosen = options[cursor];
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
						index: cursor,
						label: chosen.label,
					});
				} else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
					cleanup();
					// Clear the menu
					out.write(CURSOR_UP(physicalLines));
					for (let i = 0; i < physicalLines; i++) {
						out.write(`${CLEAR_LINE}\n`);
					}
					out.write(CURSOR_UP(physicalLines + 1)); // +1 for the header
					out.write(`${CLEAR_LINE}\n`);
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
				process.stdin.removeListener("keypress", onKeypress);
				process.stdin.setRawMode(false);
				process.stdin.pause();
				out.write(SHOW_CURSOR);
			}
		},
	);
}

// ── confirm() ─────────────────────────────────────────────────────

/**
 * Ask a yes/no question. Returns the answer.
 *
 * - **Interactive**: prompts on stderr with `[y/N]` or `[Y/n]`.
 * - **Non-interactive**: returns `defaultValue` (false if omitted)
 *   with a hint string.
 */
export async function confirm(config: ConfirmConfig): Promise<ConfirmResult> {
	const { message, defaultValue = false } = config;
	const suffix = defaultValue ? "[Y/n]" : "[y/N]";

	if (!isInteractive()) {
		const hint = `${message} — auto-${defaultValue ? "approved" : "declined"} (non-interactive)`;
		if (c8ctl.outputMode === "json") {
			console.error(JSON.stringify({ type: "message", message: hint }));
		} else {
			console.error(hint);
		}
		return { interactive: false, value: defaultValue, hint };
	}

	return new Promise<ConfirmResult>((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stderr,
		});

		rl.question(
			`${BOLD}${CYAN}?${RESET} ${BOLD}${message}${RESET} ${DIM}${suffix}${RESET} `,
			(answer: string) => {
				rl.close();
				const normalized = answer.trim().toLowerCase();
				let value: boolean;
				if (normalized === "") {
					value = defaultValue;
				} else {
					value = normalized === "y" || normalized === "yes";
				}
				resolve({ interactive: true, value });
			},
		);
	});
}

// ── Helpers ───────────────────────────────────────────────────────

function formatNonInteractiveHint<T>(
	message: string,
	options: ReadonlyArray<SelectOption<T>>,
	selectedIndex: number,
): string {
	const lines: string[] = [`${message} (non-interactive, using default)`];
	for (let i = 0; i < options.length; i++) {
		const opt = options[i];
		const marker = i === selectedIndex ? "→" : " ";
		const desc = opt.description ? ` — ${opt.description}` : "";
		lines.push(`  ${marker} ${opt.label}${desc}`);
	}
	lines.push("");
	lines.push(
		"Hint: run interactively to choose, or use --profile=<name> to specify.",
	);
	return lines.join("\n");
}
