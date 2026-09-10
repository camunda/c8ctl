/**
 * Class-of-defect guard for the CI Camunda version matrix (issue #566).
 *
 * The integration jobs in `.github/workflows/{test,release}.yml` run
 * `docker compose up` inside `assets/c8/${{ matrix.camunda }}`, so every
 * entry in a `camunda:` matrix needs a matching asset directory with a
 * `docker-compose.yml` and a `.env` pinning `CAMUNDA_VERSION`. A matrix
 * entry without those files only fails once the workflow runs on CI —
 * long after the change merges.
 *
 * The guard also pins the two matrices to each other: `test.yml` gates
 * pull requests and `release.yml` gates publishing, so a version tested
 * on PRs but not on release (or the reverse) means the released artifact
 * was never verified against the version it claims to support.
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const WORKFLOWS_DIR = join(PROJECT_ROOT, ".github", "workflows");
const ASSETS_DIR = join(PROJECT_ROOT, "assets", "c8");

/**
 * Extract the `camunda: ['8.8', '8.9', ...]` matrix entries from a
 * workflow file. Kept to a single-line inline-sequence match because that
 * is the shape both workflows use, and adding a YAML parser dependency
 * for one line is not worth it — a matrix reformatted into a block
 * sequence trips the "matrix not found" assertion below rather than
 * silently reporting an empty list.
 */
function readCamundaMatrix(workflow: string): string[] {
	const contents = readFileSync(join(WORKFLOWS_DIR, workflow), "utf8");
	const match = contents.match(/^\s*camunda:\s*\[(.+)\]\s*$/m);
	assert.ok(
		match,
		`${workflow} must declare a single-line 'camunda:' matrix (inline sequence)`,
	);
	return match[1]
		.split(",")
		.map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
		.filter((entry) => entry.length > 0);
}

describe("CI Camunda version matrix (#566)", () => {
	const testMatrix = readCamundaMatrix("test.yml");
	const releaseMatrix = readCamundaMatrix("release.yml");

	test("test.yml and release.yml cover the same Camunda versions", () => {
		assert.deepStrictEqual(
			[...testMatrix].sort(),
			[...releaseMatrix].sort(),
			"the PR test matrix and the release test matrix must not drift apart",
		);
	});

	test("every matrix version has docker compose assets", () => {
		for (const version of testMatrix) {
			const composePath = join(ASSETS_DIR, version, "docker-compose.yml");
			assert.doesNotThrow(
				() => readFileSync(composePath, "utf8"),
				`assets/c8/${version}/docker-compose.yml is missing — the CI job runs 'docker compose up' in that directory`,
			);
		}
	});

	test("every matrix version pins CAMUNDA_VERSION to its own minor line", () => {
		for (const version of testMatrix) {
			const env = readFileSync(join(ASSETS_DIR, version, ".env"), "utf8");
			const pin = env.match(/^CAMUNDA_VERSION=(.+)$/m);
			assert.ok(pin, `assets/c8/${version}/.env must pin CAMUNDA_VERSION`);

			const pinned = pin[1].trim();
			assert.ok(
				pinned === version || pinned.startsWith(`${version}.`),
				`assets/c8/${version}/.env pins CAMUNDA_VERSION=${pinned}, which is not on the ${version} line`,
			);
		}
	});
});
