/**
 * Filesystem helpers for `c8ctl mcp install` (#293).
 *
 * Atomic write so a partial failure (out-of-space, permission flip
 * mid-write, process kill) cannot leave the user's MCP client config in
 * a half-written state. The client would silently fail to load the
 * server otherwise — the exact "docs hand-edit" defect class #293 was
 * filed to eliminate.
 */

import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Read a JSON file as `unknown`. Returns `null` if the file is absent
 * or empty (treated as "no prior config"); throws if it exists but
 * fails to parse, so a corrupt file is surfaced rather than silently
 * overwritten.
 */
export function readJsonFileOrNull(path: string): unknown {
	if (!existsSync(path)) return null;
	const raw = readFileSync(path, "utf8");
	if (raw.trim().length === 0) return null;
	try {
		// biome-ignore lint/plugin: runtime contract boundary for parsed JSON
		return JSON.parse(raw) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Failed to parse existing MCP config at ${path}: ${message}. ` +
				"Refusing to overwrite — fix the JSON manually or delete the file and re-run.",
		);
	}
}

/**
 * Write JSON to `path` atomically: serialise to a sibling temp file
 * with a unique per-invocation suffix (`<path>.c8ctl-tmp.<pid>.<rand>`),
 * then `renameSync`. POSIX guarantees rename is atomic on the same
 * filesystem, so a crash mid-write either leaves the original intact
 * or replaces it with the fully-written successor.
 *
 * The unique suffix means two concurrent installers targeting the same
 * config file (e.g. two terminals racing `c8ctl mcp install claude-desktop`)
 * each write to a distinct temp file. The renames serialise; whichever
 * lands second wins — but neither corrupts the other's intermediate state.
 *
 * Restricts file mode to 0o600 (owner read/write only) because the
 * written JSON contains OAuth client secrets in its `env` block. On
 * Windows `chmod` is a no-op; the underlying ACLs already restrict
 * the user profile directory.
 */
export function writeJsonAtomic(
	path: string,
	value: unknown,
	opts?: { pretty?: boolean },
): void {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const json =
		(opts?.pretty ?? true)
			? JSON.stringify(value, null, 2)
			: JSON.stringify(value);
	const tmpPath = `${path}.c8ctl-tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
	writeFileSync(tmpPath, `${json}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		renameSync(tmpPath, path);
	} catch (error) {
		// Best-effort: delete the orphaned temp file (it contains OAuth
		// client secrets, so leaving a `.failed` sentinel on disk would
		// expand the secret-exposure surface). The original error is what
		// matters; cleanup errors are intentionally swallowed.
		try {
			if (existsSync(tmpPath)) {
				unlinkSync(tmpPath);
			}
		} catch {
			// Cleanup errors are non-fatal.
		}
		throw error;
	}
	try {
		chmodSync(path, 0o600);
	} catch {
		// chmod is unsupported on some Windows filesystems; the rename
		// already inherited 0o600 from the tmp file's mode on POSIX, and
		// on Windows the user profile directory ACLs are sufficient.
	}
}
