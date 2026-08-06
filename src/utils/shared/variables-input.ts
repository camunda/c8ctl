/**
 * Shared parser for `--variables` JSON input (#528).
 *
 * Passing inline JSON through a shell is quoting-hostile — PowerShell in
 * particular strips or re-splits the double quotes of a native command
 * argument before the process ever sees it, so `{"a":"b"}` arrives as
 * `{a:b}` and larger payloads arrive with the braces or quotes mangled.
 * Rather than guess at a repair, accept a quoting-proof `@file` / `@-`
 * (stdin) reference and turn any remaining parse failure into an
 * actionable hint.
 */

import { readFileSync } from "node:fs";
import { isRecord } from "../../core/index.ts";

const QUOTING_HINT =
	"Hint: read the JSON from a file instead of quoting it inline: " +
	"--variables @vars.json (or --variables @- to read stdin). " +
	"Some shells (notably PowerShell) strip or re-split the quotes of inline JSON.";

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
		const msg = error instanceof Error ? error.message : String(error);
		throw new Error(
			origin
				? `Invalid JSON for ${label}${from}: ${msg}`
				: `Invalid JSON for ${label}: ${msg}. ${QUOTING_HINT}`,
		);
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
