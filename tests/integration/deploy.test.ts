/**
 * Integration tests for deployment
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 *
 * All assertions drive the CLI via the subprocess helper — no direct
 * imports from `src/commands/**`.
 */

import assert from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { makeTestEnv } from "../utils/mocks.ts";
import { asyncSpawn } from "../utils/spawn.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(PROJECT_ROOT, "src", "index.ts");

function cli(dataDir: string, ...args: string[]) {
	return asyncSpawn("node", ["--experimental-strip-types", CLI, ...args], {
		cwd: PROJECT_ROOT,
		env: makeTestEnv({ C8CTL_DATA_DIR: dataDir }),
	});
}

describe("Deployment Integration Tests (requires Camunda 8 at localhost:8080)", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "c8ctl-deploy-test-"));
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("deploy simple BPMN creates deployment", async () => {
		const { status } = await cli(
			testDir,
			"deploy",
			"tests/fixtures/simple.bpmn",
		);
		assert.strictEqual(status, 0, "Deployment should succeed with exit code 0");
	});

	test("deploy prioritizes building block folders", async () => {
		const { status } = await cli(
			testDir,
			"deploy",
			"tests/fixtures/_bb-building-block",
		);
		assert.strictEqual(
			status,
			0,
			"Building block deployment should succeed with exit code 0",
		);
	});

	test("redeploying Markdown from separate paths under one governed ID creates a new version", async () => {
		const resourceId = `c8ctl-governed-markdown-${process.pid}-${Date.now()}.md`;
		const frontmatter = [
			"---",
			"camunda:",
			`  resourceId: ${resourceId}`,
			"---",
		].join("\n");
		const v1 = join(testDir, "claims-review-v1.md");
		const v2 = join(testDir, "claims-review-v2.md");
		writeFileSync(v1, `${frontmatter}\nVersion one\n`);
		writeFileSync(v2, `${frontmatter}\nVersion two\n`);

		const first = await cli(
			testDir,
			"deploy",
			v1,
			"--force",
			"--yes",
			"--json",
		);
		const second = await cli(
			testDir,
			"deploy",
			v2,
			"--force",
			"--yes",
			"--json",
		);

		assert.strictEqual(first.status, 0, first.stderr);
		assert.strictEqual(second.status, 0, second.stderr);
		assert.match(
			first.stdout,
			new RegExp(`"ID":\\s*"${resourceId}"[\\s\\S]*"Version":\\s*1`),
		);
		assert.match(
			second.stdout,
			new RegExp(`"ID":\\s*"${resourceId}"[\\s\\S]*"Version":\\s*2`),
		);
	});
});
