/**
 * Preload for CLI subprocesses spawned by the test helpers.
 *
 * Node's type stripper can fail with ERR_INVALID_TYPESCRIPT_SYNTAX and print
 * `undefined:undefined` instead of the file and line, so the failing module
 * is unknown. This preload remembers the source of the most recently loaded
 * TypeScript modules (a cheap in-thread load hook) and, only when that error
 * escapes, writes a report to stderr:
 *
 * - each remembered module, with the length and hash of the source Node got;
 * - whether the file on disk still has that content (a concurrent write);
 * - whether stripping the same source again in this process fails too
 *   (deterministic) or now succeeds (the stripper itself is nondeterministic).
 *
 * On success it prints nothing, so tests asserting a clean stderr still hold.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import module from "node:module";
import { fileURLToPath } from "node:url";

const RECENT_LIMIT = 64;
const recent: { url: string; source: string }[] = [];
let failing: string | undefined;

const hash = (text: string) =>
	createHash("sha256").update(text).digest("hex").slice(0, 12);

const sourceText = (source: unknown): string | undefined =>
	typeof source === "string"
		? source
		: source instanceof Uint8Array
			? Buffer.from(source).toString("utf8")
			: undefined;

module.registerHooks?.({
	load(url, context, nextLoad) {
		let result: ReturnType<typeof nextLoad>;
		try {
			result = nextLoad(url, context);
		} catch (error) {
			// The default loader strips types inside nextLoad, so the
			// failing module never returns a source: record it here.
			failing ??= url;
			throw error;
		}
		const source = sourceText(result.source);
		if (source !== undefined && /\.[cm]?ts$/.test(new URL(url).pathname)) {
			recent.push({ url, source });
			if (recent.length > RECENT_LIMIT) recent.shift();
		}
		return result;
	},
});

const restrip = (source: string): string => {
	try {
		module.stripTypeScriptTypes(source);
		return "strips cleanly now";
	} catch (error) {
		return `fails again: ${error instanceof Error ? error.message : String(error)}`;
	}
};

const onDisk = (url: string, source: string): string => {
	try {
		const now = readFileSync(fileURLToPath(url), "utf8");
		return now === source
			? "unchanged on disk"
			: `CHANGED on disk (now ${now.length} chars, ${hash(now)})`;
	} catch (error) {
		return `unreadable now: ${error instanceof Error ? error.message : String(error)}`;
	}
};

/** The failing module's current file content: size, hash, and whether it strips. */
const failingNow = (url: string): string => {
	try {
		const now = readFileSync(fileURLToPath(url), "utf8");
		return `now ${now.length} chars, ${hash(now)} on disk; ${restrip(now)}`;
	} catch (error) {
		return `unreadable now: ${error instanceof Error ? error.message : String(error)}`;
	}
};

process.on("uncaughtExceptionMonitor", (error) => {
	if (
		!(error instanceof Error) ||
		!("code" in error) ||
		error.code !== "ERR_INVALID_TYPESCRIPT_SYNTAX"
	) {
		return;
	}
	const lines = recent.map(
		({ url, source }) =>
			`  ${url} (${source.length} chars, ${hash(source)}): ${onDisk(url, source)}; ${restrip(source)}`,
	);
	process.stderr.write(
		`[ts-strip-diagnostics] ${error.message}\n[ts-strip-diagnostics] failing module: ${failing === undefined ? "unknown" : `${failing}: ${failingNow(failing)}`}\n[ts-strip-diagnostics] last ${recent.length} TypeScript modules loaded, newest last:\n${lines.join("\n")}\n`,
	);
});
