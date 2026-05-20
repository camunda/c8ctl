/**
 * Tests for deploy confirmation guard (#393).
 *
 * Verifies that `c8 deploy` prompts for confirmation when multiple
 * profiles are configured and the user did not explicitly pass
 * --profile or --yes. Since test subprocesses are not a TTY, the
 * confirmation auto-approves but logs the target to stderr.
 *
 * Most tests run without --dry-run so the confirmation guard is
 * actually exercised (it runs after the dry-run exit). The deploy
 * will fail (no real cluster / unreachable address), but the
 * confirmation message in stderr is what we assert on.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { asyncSpawn, type SpawnResult } from "../utils/spawn.ts";

const CLI = resolve(import.meta.dirname, "..", "..", "src", "index.ts");

const MINIMAL_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="test-process" isExecutable="true">
    <bpmn:startEvent id="start"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="test-process">
      <bpmndi:BPMNShape id="start_di" bpmnElement="start">
        <dc:Bounds x="173" y="102" width="36" height="36"/>
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

let tempDir: string;

/**
 * Spawn the CLI with a custom data dir containing the given profiles.
 * extraArgs are appended after `deploy <dir>`.
 */
async function c8Deploy(
	cwd: string,
	profiles: Array<{ name: string; baseUrl: string }>,
	extraArgs: string[] = [],
	sessionOverrides: Record<string, unknown> = {},
): Promise<SpawnResult> {
	const dir = mkdtempSync(join(tempDir, ".c8ctl-data-"));
	writeFileSync(
		join(dir, "session.json"),
		JSON.stringify({ outputMode: "json", ...sessionOverrides }),
	);
	writeFileSync(join(dir, "profiles.json"), JSON.stringify({ profiles }));

	return asyncSpawn(
		"node",
		["--experimental-strip-types", CLI, "deploy", cwd, ...extraArgs],
		{
			env: {
				PATH: process.env.PATH,
				HOME: "/tmp/c8ctl-test-nonexistent-home",
				C8CTL_DATA_DIR: dir,
			},
		},
	);
}

describe("deploy confirmation guard (#393)", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "c8ctl-confirm-"));
		writeFileSync(join(tempDir, "test.bpmn"), MINIMAL_BPMN);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("single profile: no confirmation message in stderr", async () => {
		// With only one profile, deploy should proceed without confirmation.
		// Uses --dry-run for a clean exit (confirmation never fires either way).
		const result = await c8Deploy(
			tempDir,
			[{ name: "local", baseUrl: "http://127.0.0.1:1/v2" }],
			["--dry-run"],
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			!result.stderr.includes("Deploying to profile"),
			`should not show confirmation for single profile, got: ${result.stderr}`,
		);
	});

	test("multiple profiles without --yes: shows target in stderr (non-TTY auto-approve)", async () => {
		// No --dry-run: the confirmation guard runs, then deploy fails (no cluster).
		// We only assert on the confirmation message in stderr.
		const result = await c8Deploy(tempDir, [
			{ name: "local", baseUrl: "http://127.0.0.1:1/v2" },
			{ name: "production", baseUrl: "http://127.0.0.1:2/v2" },
		]);

		// Deploy will fail (no real cluster) — that's expected.
		assert.ok(
			result.stderr.includes("Deploying to profile"),
			`should show deploy target when multiple profiles exist, got: ${result.stderr}`,
		);
	});

	test("multiple profiles with --yes: no confirmation message", async () => {
		// --yes skips confirmation. Deploy will fail (no cluster) but
		// the confirmation guard is exercised before the failure.
		const result = await c8Deploy(
			tempDir,
			[
				{ name: "local", baseUrl: "http://127.0.0.1:1/v2" },
				{ name: "production", baseUrl: "http://127.0.0.1:2/v2" },
			],
			["--yes"],
		);

		assert.ok(
			!result.stderr.includes("Deploying to profile"),
			`--yes should skip confirmation, got: ${result.stderr}`,
		);
	});

	test("multiple profiles with -y: no confirmation message", async () => {
		const result = await c8Deploy(
			tempDir,
			[
				{ name: "local", baseUrl: "http://127.0.0.1:1/v2" },
				{ name: "production", baseUrl: "http://127.0.0.1:2/v2" },
			],
			["-y"],
		);

		assert.ok(
			!result.stderr.includes("Deploying to profile"),
			`-y should skip confirmation, got: ${result.stderr}`,
		);
	});

	test("multiple profiles with explicit --profile: no confirmation message", async () => {
		// Explicit --profile means the user knows the target.
		const result = await c8Deploy(
			tempDir,
			[
				{ name: "local", baseUrl: "http://127.0.0.1:1/v2" },
				{ name: "production", baseUrl: "http://127.0.0.1:2/v2" },
			],
			["--profile=local"],
		);

		assert.ok(
			!result.stderr.includes("Deploying to profile"),
			`explicit --profile should skip confirmation, got: ${result.stderr}`,
		);
	});

	test("multiple profiles with active session profile: shows profile name in confirmation", async () => {
		// No --dry-run: confirmation runs and shows the active profile name.
		const result = await c8Deploy(
			tempDir,
			[
				{ name: "local", baseUrl: "http://127.0.0.1:1/v2" },
				{ name: "staging", baseUrl: "http://127.0.0.1:2/v2" },
			],
			[],
			{ activeProfile: "staging", outputMode: "text" },
		);

		assert.ok(
			result.stderr.includes('"staging"'),
			`should show active profile name in confirmation, got: ${result.stderr}`,
		);
	});
});
