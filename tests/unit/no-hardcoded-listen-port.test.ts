/**
 * Class-of-defect guard for issue #316.
 *
 * Every integration test that stands up a mock HTTP server must
 * call `.listen(0, ...)` and read the kernel-assigned port off
 * `server.address()`. Picking a port any other way (hardcoded
 * constant, environment variable, or `Math.random()` over a
 * numeric range) is unsafe for two reasons documented in
 * `tests/utils/no-hardcoded-listen-port.ts`:
 *
 *   1. The chosen port may collide with another listener and the
 *      test will silently hang on the resolve callback that never
 *      fires.
 *   2. The chosen port may land on undici's restricted-ports list
 *      (inherited from Chromium's "bad ports") — e.g. 10080,
 *      6666–6669 — and `fetch()` will reject with
 *      `TypeError: fetch failed` / `cause: Error: bad port`.
 *
 * Issue #316: `mcp-proxy-mock.test.ts` originally used
 * `9876 + Math.floor(Math.random() * 1000)`, a range that includes
 * 10080. This guard prevents the same defect class from being
 * reintroduced in any sibling integration test.
 *
 * AST-based (see `no-hardcoded-listen-port.ts` for rationale).
 */

import assert from "node:assert";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { findHardcodedListenPortCalls } from "../utils/no-hardcoded-listen-port.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const INTEGRATION_DIR = join(PROJECT_ROOT, "tests", "integration");

function listIntegrationTestFiles(): string[] {
	return readdirSync(INTEGRATION_DIR)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => join(INTEGRATION_DIR, name));
}

function toRelative(absPath: string): string {
	const rel = absPath.slice(PROJECT_ROOT.length + 1);
	return rel.split(/[\\/]/).join("/");
}

describe("architectural guard: integration tests must use kernel-assigned ports (#316)", () => {
	const files = listIntegrationTestFiles();

	test("no integration test calls `.listen(<non-zero>, ...)`", () => {
		const violations: {
			file: string;
			line: number;
			firstArgText: string;
			text: string;
		}[] = [];
		for (const abs of files) {
			for (const call of findHardcodedListenPortCalls(abs)) {
				violations.push({
					file: toRelative(abs),
					line: call.line,
					firstArgText: call.firstArgText,
					text: call.text,
				});
			}
		}
		assert.strictEqual(
			violations.length,
			0,
			`Integration tests must call \`.listen(0, ...)\` and read the assigned port off ` +
				`\`server.address()\`. Found ${violations.length} violation(s):\n` +
				violations
					.map(
						(v) => `  - ${v.file}:${v.line} — first arg: \`${v.firstArgText}\``,
					)
					.join("\n") +
				`\n\nA non-zero port can collide with an in-use port (silent hang) or ` +
				`land on undici's restricted-ports list (e.g. 10080) and fail with ` +
				`\`fetch failed: bad port\`. See \`tests/integration/watch-cancellation.test.ts\` ` +
				`for the canonical pattern.`,
		);
	});
});
