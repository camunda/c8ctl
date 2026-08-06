/**
 * Shared parser for `--variables` JSON input (#528).
 *
 * Passing inline JSON through a shell is quoting-hostile — PowerShell in
 * particular strips the double quotes of a native command argument before
 * the process ever sees it, so `{"a":"b"}` arrives as `{a:b}`.
 *
 * Three defences, in order:
 *  1. Valid JSON is parsed as-is, however large or deeply nested.
 *  2. Inline input that arrived with *every* quote stripped is re-quoted
 *     and re-parsed, with a warning naming the repaired payload.
 *  3. Anything still unparseable — e.g. a payload the shell also split on
 *     spaces — fails with a hint pointing at the quoting-proof `@file` /
 *     `@-` (stdin) forms.
 */

import { readFileSync } from "node:fs";
import { getLogger, isRecord } from "../../core/index.ts";

const QUOTING_HINT =
	"Hint: read the JSON from a file instead of quoting it inline: " +
	"--variables @vars.json (or --variables @- to read stdin). " +
	"Some shells (notably PowerShell) strip or re-split the quotes of inline JSON.";

/**
 * Bare tokens that must stay unquoted when re-quoting a stripped payload:
 * JSON numbers and the three literals.
 */
const JSON_LITERAL =
	/^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/;

const STRUCTURAL = new Set(["{", "}", "[", "]", ":", ","]);

/**
 * Does this look like a JSON object whose double quotes the shell removed?
 * Requires the object braces to have survived — anything else is a typo or
 * a payload the shell also split on spaces, neither of which is repairable.
 */
function looksQuoteStripped(text: string): boolean {
	const value = text.trim();
	return !value.includes('"') && value.startsWith("{") && value.endsWith("}");
}

/**
 * Re-quote a payload whose double quotes were stripped by the shell, e.g.
 * PowerShell turning `{"a":"b"}` into `{a:b}`.
 *
 * Only attempted for an object payload that contains no `"` at all — a
 * payload that kept some of its quotes was mangled some other way, and
 * guessing would be unsafe. Structural characters delimit bare tokens;
 * every token that is not a JSON number/`true`/`false`/`null` is
 * re-quoted. Ambiguous input (a stripped string that itself contained `:`
 * or `,`) reassembles into invalid JSON and is rejected by the caller's
 * re-parse.
 *
 * Returns the repaired text, or `null` when no repair is applicable.
 */
function requoteStrippedJson(text: string): string | null {
	if (!looksQuoteStripped(text)) return null;

	let out = "";
	let token = "";
	const flushToken = () => {
		const value = token.trim();
		token = "";
		if (!value) return;
		out += JSON_LITERAL.test(value) ? value : JSON.stringify(value);
	};

	for (const char of text) {
		if (STRUCTURAL.has(char)) {
			flushToken();
			out += char;
		} else {
			token += char;
		}
	}
	flushToken();

	return out === text ? null : out;
}

/**
 * Resolve the raw flag value to JSON text, following an `@file` / `@-`
 * reference when present.
 */
function readVariablesSource(raw: string): { text: string; origin?: string } {
	const value = raw.trim();
	if (!value.startsWith("@")) return { text: value };

	const ref = value.slice(1);
	if (ref === "-") {
		if (process.stdin.isTTY) {
			throw new Error(
				"--variables @- expects JSON on stdin, but stdin is a terminal",
			);
		}
		// Blocking read of fd 0 until EOF, the same contract as `cat -`:
		// the producer of the pipe is expected to close it. Reading stdin
		// synchronously here is safe because `--variables` is parsed once
		// per invocation, before any other stdin consumer runs.
		return { text: readFileSync(0, "utf-8"), origin: "stdin" };
	}
	if (!ref) {
		throw new Error("--variables @ requires a file path (e.g. @vars.json)");
	}
	try {
		return { text: readFileSync(ref, "utf-8"), origin: `'${ref}'` };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot read variables file '${ref}': ${msg}`);
	}
}

/**
 * Parse a `--variables` flag value into a JSON object.
 *
 * Accepts inline JSON, `@path/to/file.json`, or `@-` for stdin. Throws an
 * `Error` (never exits) so the framework's error handler owns the exit code.
 */
export function parseVariablesFlag({
	raw,
	label = "variables",
}: {
	raw: string;
	label?: string;
}): Record<string, unknown> {
	const { text, origin } = readVariablesSource(raw);
	// Name the input source so a bad file or piped payload is not mistaken
	// for a bad inline argument.
	const from = origin ? ` (read from ${origin})` : "";

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		// Inline input only: an `@file` / `@-` payload never went through
		// shell quoting, so a repair there would be guesswork.
		const repair = origin ? null : tryRequote(text);
		if (!repair) {
			const msg = error instanceof Error ? error.message : String(error);
			if (origin) {
				throw new Error(`Invalid JSON for ${label}${from}: ${msg}`);
			}
			// A payload with no quotes left at all reached us stripped; say so
			// rather than leaving the user to decode a parser position.
			const stripped = looksQuoteStripped(text)
				? " The value lost its quotes on the way in and could not be " +
					"restored unambiguously."
				: "";
			throw new Error(
				`Invalid JSON for ${label}: ${msg}.${stripped} ${QUOTING_HINT}`,
			);
		}
		// Announce the repair: re-quoting cannot recover the original
		// string/number distinction (`{a:1}` could have been `{"a":1}` or
		// `{"a":"1"}`), so the user gets to see what was sent.
		getLogger().warn(
			`--variables: restored quotes stripped by the shell -> ${repair.json}. ` +
				"Use --variables @file.json or @- to pass JSON verbatim.",
		);
		parsed = repair.value;
	}

	if (!isRecord(parsed)) {
		throw new Error(
			Array.isArray(parsed)
				? `--variables must be a JSON object (not an array)${from}`
				: `--variables must be a JSON object${from}`,
		);
	}
	return parsed;
}

/**
 * Attempt the quote-stripping repair and parse the result.
 *
 * Pure: returns both the repaired JSON text (for the caller's warning) and
 * the value it parsed to, or `null` when the input is not repairable. The
 * wrapper object keeps the "not repairable" sentinel distinct from a
 * payload that legitimately parsed to `null`.
 */
function tryRequote(text: string): { json: string; value: unknown } | null {
	const json = requoteStrippedJson(text);
	if (json === null) return null;

	try {
		return { json, value: JSON.parse(json) };
	} catch {
		return null;
	}
}
