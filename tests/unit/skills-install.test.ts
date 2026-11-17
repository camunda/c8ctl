import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import {
	buildSkillInstallArgs,
	detectInstalledHarnesses,
	normalizeSkillHarness,
	runSkillInstall,
} from "../../src/utils/command-local/skills-install-helpers.ts";
import { c8 } from "../utils/cli.ts";

test("normalizes common harness aliases and rejects empty values", () => {
	assert.equal(normalizeSkillHarness("Claude"), "claude-code");
	assert.equal(normalizeSkillHarness("copilot"), "github-copilot");
	assert.equal(normalizeSkillHarness("cursor"), "cursor");
	assert.throws(() => normalizeSkillHarness(" "), /non-empty/i);
});

test("detects installed harnesses from their executable or user config", () => {
	const root = mkdtempSync(join(tmpdir(), "c8ctl-skills-detect-"));
	const home = join(root, "home");
	const bin = join(root, "bin");
	mkdirSync(join(home, ".claude"), { recursive: true });
	mkdirSync(bin, { recursive: true });
	const copilotExecutable = join(
		bin,
		process.platform === "win32" ? "copilot.exe" : "copilot",
	);
	writeFileSync(copilotExecutable, "");
	if (process.platform !== "win32") chmodSync(copilotExecutable, 0o755);

	try {
		assert.deepEqual(
			detectInstalledHarnesses({
				env: {
					HOME: home,
					PATH: `${bin}${delimiter}${join(root, "empty-bin")}`,
				},
				home,
				platform: process.platform,
			}),
			["claude-code", "github-copilot"],
		);
		assert.deepEqual(
			detectInstalledHarnesses({
				env: { HOME: join(root, "empty-home"), PATH: join(root, "empty-bin") },
				home: join(root, "empty-home"),
				platform: process.platform,
			}),
			[],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("builds a user-scoped install that refreshes the same Camunda skills", () => {
	assert.deepEqual(buildSkillInstallArgs("claude-code"), [
		"skill",
		"install",
		"camunda/skills",
		"--all",
		"--agent",
		"claude-code",
		"--scope",
		"user",
		"--force",
	]);
});

test("runs the GitHub CLI skill installer and surfaces failures", () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	runSkillInstall("claude-code", (command, args) => {
		calls.push({ command, args });
		return { status: 0, stdout: "", stderr: "" };
	});
	assert.deepEqual(calls, [
		{ command: "gh", args: buildSkillInstallArgs("claude-code") },
	]);

	assert.throws(
		() =>
			runSkillInstall("claude-code", () => ({
				status: 1,
				stdout: "",
				stderr: "network denied",
			})),
		/network denied/,
	);
});

test("skills help documents the install action and harness selector", async () => {
	const result = await c8("help", "skills");

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /"verb":"skills"/);
	assert.match(result.stdout, /"resource":"install"/);
	assert.match(result.stdout, /--harness/i);
});

test("skills install dry-run reports the source and selected harness", async () => {
	const result = await c8(
		"skills",
		"install",
		"--harness",
		"claude-code",
		"--dry-run",
	);

	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		dryRun: true,
		command: "skills install",
		source: "camunda/skills",
		harnesses: ["claude-code"],
	});
});
