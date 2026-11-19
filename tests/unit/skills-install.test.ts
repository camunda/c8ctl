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
	]);
});

test("installs Camunda skills only when none are installed", async () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	await runSkillInstall("claude-code", async (command, args) => {
		calls.push({ command, args });
		return { status: 0, stdout: "[]", stderr: "" };
	});
	assert.deepEqual(calls, [
		{
			command: "gh",
			args: [
				"skill",
				"list",
				"--agent",
				"claude-code",
				"--scope",
				"user",
				"--json",
				"skillName,sourceURL,path",
			],
		},
		{ command: "gh", args: buildSkillInstallArgs("claude-code") },
	]);
});

test("updates only installed Camunda skills through their existing directories", async () => {
	const skillRoot = join(tmpdir(), "home", ".claude", "skills");
	const calls: Array<{ command: string; args: string[] }> = [];
	const skills = [
		{
			skillName: "camunda-ai-agents",
			sourceURL: "https://github.com/camunda/skills",
			path: join(skillRoot, "camunda-ai-agents"),
		},
		{
			skillName: "camunda-bpmn",
			sourceURL: "https://github.com/camunda/skills",
			path: join(skillRoot, "camunda-bpmn"),
		},
		{
			skillName: "unrelated",
			sourceURL: "https://github.com/other/skills",
			path: join(skillRoot, "unrelated"),
		},
	];
	await runSkillInstall("claude-code", async (command, args) => {
		calls.push({ command, args });
		if (args[1] === "install" && args.length === 3) {
			return {
				status: 0,
				stdout: [
					"camunda-ai-agents\tCamunda skill",
					"camunda-bpmn\tCamunda skill",
				].join("\n"),
				stderr: "",
			};
		}
		return {
			status: 0,
			stdout: args[1] === "list" ? JSON.stringify(skills) : "",
			stderr: "",
		};
	});
	assert.deepEqual(calls, [
		{
			command: "gh",
			args: [
				"skill",
				"list",
				"--agent",
				"claude-code",
				"--scope",
				"user",
				"--json",
				"skillName,sourceURL,path",
			],
		},
		{
			command: "gh",
			args: ["skill", "install", "camunda/skills"],
		},
		{
			command: "gh",
			args: [
				"skill",
				"update",
				"--all",
				"--dir",
				skillRoot,
				"camunda-ai-agents",
				"camunda-bpmn",
			],
		},
	]);
});

test("installs missing Camunda skills despite multiline catalog descriptions", async () => {
	const skillRoot = join(tmpdir(), "home", ".claude", "skills");
	const availableSkills = [
		"camunda-ai-agents",
		"camunda-bpmn",
		"camunda-c8ctl",
	];
	const installedSkills = [
		{
			skillName: availableSkills[0],
			sourceURL: "https://github.com/camunda/skills",
			path: join(skillRoot, availableSkills[0]),
		},
		{
			skillName: "unrelated",
			sourceURL: "https://github.com/other/skills",
			path: join(skillRoot, "unrelated"),
		},
	];
	const calls: Array<{ command: string; args: string[] }> = [];

	await runSkillInstall("claude-code", async (command, args) => {
		calls.push({ command, args });
		if (args[1] === "list") {
			return {
				status: 0,
				stdout: JSON.stringify(installedSkills),
				stderr: "",
			};
		}
		if (args[1] === "install" && args.length === 3) {
			return {
				status: 0,
				stdout: [
					"camunda-ai-agents\tCamunda 8 AI Agent sub-processes",
					"Also covers v1/v2 element-template selection and upgrading v1 elements to v2.",
					"camunda-bpmn\tReliable multi-step workflows",
					"Designs, edits, and lints executable BPMN processes for Camunda 8.",
					"camunda-c8ctl\tRun or configure c8ctl",
					"Installs and configures c8ctl, the Camunda 8 CLI.",
				].join("\n"),
				stderr: "",
			};
		}
		return { status: 0, stdout: "", stderr: "" };
	});

	assert.deepEqual(calls, [
		{
			command: "gh",
			args: [
				"skill",
				"list",
				"--agent",
				"claude-code",
				"--scope",
				"user",
				"--json",
				"skillName,sourceURL,path",
			],
		},
		{
			command: "gh",
			args: ["skill", "install", "camunda/skills"],
		},
		{
			command: "gh",
			args: [
				"skill",
				"update",
				"--all",
				"--dir",
				skillRoot,
				"camunda-ai-agents",
			],
		},
		{
			command: "gh",
			args: [
				"skill",
				"install",
				"camunda/skills",
				"camunda-bpmn",
				"--agent",
				"claude-code",
				"--scope",
				"user",
			],
		},
		{
			command: "gh",
			args: [
				"skill",
				"install",
				"camunda/skills",
				"camunda-c8ctl",
				"--agent",
				"claude-code",
				"--scope",
				"user",
			],
		},
	]);
});

test("fails when available Camunda skills cannot be listed", async () => {
	const skillRoot = join(tmpdir(), "home", ".claude", "skills");
	const installedSkills = [
		{
			skillName: "camunda-ai-agents",
			sourceURL: "https://github.com/camunda/skills",
			path: join(skillRoot, "camunda-ai-agents"),
		},
	];

	await assert.rejects(
		runSkillInstall("claude-code", (_command, args) =>
			Promise.resolve({
				status: 0,
				stdout: args[1] === "list" ? JSON.stringify(installedSkills) : "",
				stderr: "",
			}),
		),
		/no available Camunda skills/i,
	);
});

test("surfaces GitHub CLI skill install failures", async () => {
	let install = false;

	await assert.rejects(
		runSkillInstall("claude-code", (_command, args) => {
			if (args[1] === "list") {
				return Promise.resolve({ status: 0, stdout: "[]", stderr: "" });
			}
			install = true;
			return Promise.resolve({
				status: 1,
				stdout: "",
				stderr: "network denied",
			});
		}),
		/network denied/,
	);
	assert.equal(install, true);
});

test("skills help documents the install action and harness selector", async () => {
	const result = await c8("help", "skills");

	assert.equal(result.status, 0, result.stderr);
	// skills is a default plugin: the help payload carries the plugin
	// discriminator, and the install action is a plugin subcommand.
	assert.match(result.stdout, /"verb":"skills"/);
	assert.match(result.stdout, /"kind":"plugin"/);
	assert.match(result.stdout, /"name":"install"/);
	assert.match(result.stdout, /--harness/i);
});

test("skills help explains local-edit preservation and explicit restoration", async () => {
	const result = await c8("help", "skills");

	assert.equal(result.status, 0, result.stderr);
	assert.match(
		result.stdout,
		/local edits to up-to-date skills are preserved/i,
	);
	assert.match(
		result.stdout,
		/gh skill update --force --dir <skills-root> <skill-name>/i,
	);
	assert.match(result.stdout, /parent skills directory/i);
	assert.match(result.stdout, /not the listed skill directory/i);
	assert.doesNotMatch(
		result.stdout,
		/local edits to Camunda skills are overwritten/i,
	);
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

// Plugin flag parsing has no rejectEmpty enforcement, so the handler
// itself must refuse an empty or valueless --harness — a silent fallback
// to auto-detection would install into every detected harness on a typo.
for (const invocation of [
	["skills", "install", "--harness="],
	["skills", "install", "--harness", ""],
	["skills", "install", "--harness"],
]) {
	test(`skills install rejects an empty harness (${invocation.slice(2).join(" ")})`, async () => {
		const result = await c8(...invocation);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /Invalid --harness: value must not be empty/);
	});
}
