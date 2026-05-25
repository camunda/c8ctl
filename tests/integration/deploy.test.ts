/**
 * Integration tests for deployment
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 *
 * All assertions drive the CLI via the subprocess helper — no direct
 * imports from `src/commands/**`.
 */

import assert from "node:assert";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
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
});
