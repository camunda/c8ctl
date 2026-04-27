/**
 * Architectural class-of-defect guard for issue #316.
 *
 * Integration tests under `tests/integration/**.ts` must not bind their
 * mock HTTP servers to a hardcoded numeric port (e.g.
 * `server.listen(8080, ...)`) or to a port derived from `Math.random()`
 * (e.g. `9876 + Math.floor(Math.random() * 1000)`). Both shapes are
 * vulnerable to:
 *
 *   - undici's "bad port" rejection (Chromium's restricted-ports list,
 *     e.g. 10080 = Sun RPC), which causes `fetch()` to throw
 *     `Error: bad port` before any network I/O — observed on PR #313 CI.
 *   - EADDRINUSE collisions across parallel test runs.
 *
 * The fix is to use `listen(0, ...)` (kernel-assigned port) and read
 * the actual port back from `server.address()`. The kernel never
 * returns a bad port and never collides.
 *
 * AST-based (not regex) so that string literals containing `.listen(8080`,
 * comments mentioning the pattern, and commented-out code cannot
 * produce false positives or false negatives. See
 * `tests/utils/no-hardcoded-listen-ports.ts`.
 */

import assert from "node:assert";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { findHardcodedListenPorts } from "../utils/no-hardcoded-listen-ports.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const INTEGRATION_DIR = join(PROJECT_ROOT, "tests", "integration");

function listIntegrationTestFiles(dir: string = INTEGRATION_DIR): string[] {
	// Recursive `.ts` scan rather than `readdirSync` + `*.test.ts`. The
	// guard's intent is to cover every TS file under tests/integration —
	// not just the top-level `*.test.ts` files. A hardcoded port in a
	// helper module like `tests/integration/helpers/mock-server.ts`
	// would be the same defect class, and a flat top-level scan would
	// silently let it through.
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const absPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...listIntegrationTestFiles(absPath));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".ts")) {
			files.push(absPath);
		}
	}
	return files;
}

function toRelative(absPath: string): string {
	const rel = absPath.slice(PROJECT_ROOT.length + 1);
	return rel.split(/[\\/]/).join("/");
}

describe("architectural guard: integration mocks must bind to port 0 (#316)", () => {
	const files = listIntegrationTestFiles();

	test("no integration test calls .listen(<hardcoded-or-random-port>, ...)", () => {
		const violations: {
			file: string;
			line: number;
			text: string;
			reason: string;
		}[] = [];
		for (const abs of files) {
			for (const call of findHardcodedListenPorts(abs)) {
				violations.push({
					file: toRelative(abs),
					line: call.line,
					text: call.text,
					reason: call.reason,
				});
			}
		}
		assert.strictEqual(
			violations.length,
			0,
			`Integration tests must bind mock servers to port 0 (kernel-assigned). ` +
				`Hardcoded numeric ports and Math.random()-derived ports trigger ` +
				`undici "bad port" rejections (e.g. 10080 = Sun RPC) and EADDRINUSE ` +
				`collisions across parallel runs. Found ${violations.length}:\n` +
				violations
					.map((v) => `  - ${v.file}:${v.line} [${v.reason}] — ${v.text}`)
					.join("\n") +
				`\n\nFix: replace \`server.listen(<port>, cb)\` with ` +
				`\`server.listen(0, "127.0.0.1", cb)\` and read the actual port ` +
				`back from \`server.address()\`. See ` +
				`\`tests/integration/watch-cancellation.test.ts\` for the pattern.`,
		);
	});
});
