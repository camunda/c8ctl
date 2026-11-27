/**
 * The CLI side of the error contract: in JSON mode, a classified error
 * carries its stable `code` (and the input `field`), so scripts and agents
 * branch on the code instead of the message text.
 */

import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { c8 } from "../utils/cli.ts";

/** The `{"status":"error",…}` line the CLI writes to stderr. */
function errorOutput(stderr: string): Record<string, unknown> {
	for (const line of stderr.split("\n")) {
		try {
			const parsed: unknown = JSON.parse(line);
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				"status" in parsed &&
				parsed.status === "error"
			) {
				return Object.fromEntries(Object.entries(parsed));
			}
		} catch {
			// Not a JSON line.
		}
	}
	throw new Error(`No JSON error line on stderr:\n${stderr}`);
}

describe("JSON errors carry a stable code", () => {
	test("an unknown --profile fails with profile-not-found", async () => {
		const dir = mkdtempSync(join(tmpdir(), "c8ctl-json-error-code-"));

		const result = await c8("deploy", dir, "--profile", "missing", "--json");

		assert.strictEqual(result.status, 1, result.stderr);
		const error = errorOutput(result.stderr);
		assert.strictEqual(error.code, "profile-not-found");
		assert.strictEqual(error.field, "profile");
	});

	test("a directory without deployable files fails with no-deployable-files", async () => {
		const dir = mkdtempSync(join(tmpdir(), "c8ctl-json-error-code-"));

		const result = await c8("deploy", dir, "--force", "--json");

		assert.strictEqual(result.status, 1, result.stderr);
		assert.strictEqual(errorOutput(result.stderr).code, "no-deployable-files");
	});
});
