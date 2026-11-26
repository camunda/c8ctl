import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
	buildSkillInstallArgs,
	detectInstalledHarnesses,
	normalizeSkillHarness,
	runSkillInstall,
} from "../../src/utils/command-local/skills-install-helpers.ts";
import { c8, c8WithOptions } from "../utils/cli.ts";

const SETUP_STUB = pathToFileURL(
	resolve(import.meta.dirname, "../utils/setup-stub.ts"),
).href;
const EMPTY_SKILL_INSTALL_OPTIONS = {
	env: {},
	home: join(tmpdir(), `c8ctl-skills-test-home-${process.pid}`),
};

function createSkillFixture() {
	const root = mkdtempSync(join(tmpdir(), "c8ctl-skills-command-"));
	const home = join(root, "home");
	const bin = join(root, "bin");
	const skillRoot = join(home, ".claude", "skills");
	const skillDirectory = join(skillRoot, "camunda-c8ctl");
	mkdirSync(bin);
	mkdirSync(skillDirectory, { recursive: true });
	writeFileSync(join(skillRoot, ".c8ctl-installed"), "camunda-c8ctl\n");
	writeFileSync(join(skillDirectory, "SKILL.md"), "# Camunda c8ctl\n");

	return {
		root,
		home,
		skillRoot,
		skillDirectory,
		options: {
			nodeArgs: ["--import", SETUP_STUB],
			env: {
				C8CTL_OUTPUT_MODE: "text",
				PATH: bin,
				HOME: home,
				USERPROFILE: home,
				CLAUDE_CONFIG_DIR: join(home, ".claude"),
			},
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

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

test("installs all Camunda skills when none are installed or colliding", async () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	await runSkillInstall(
		"claude-code",
		async (command, args) => {
			calls.push({ command, args });
			if (args[1] === "install" && args.length === 3) {
				return {
					status: 0,
					stdout: "camunda-c8ctl\tCamunda skill",
					stderr: "",
				};
			}
			return { status: 0, stdout: "[]", stderr: "" };
		},
		EMPTY_SKILL_INSTALL_OPTIONS,
	);
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
		{ command: "gh", args: ["skill", "install", "camunda/skills"] },
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
	await runSkillInstall(
		"claude-code",
		async (command, args) => {
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
		},
		EMPTY_SKILL_INSTALL_OPTIONS,
	);
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

	await runSkillInstall(
		"claude-code",
		async (command, args) => {
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
		},
		EMPTY_SKILL_INSTALL_OPTIONS,
	);

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

test("skips unmanaged Camunda skill name collisions and installs remaining skills", async () => {
	const skillRoot = join(EMPTY_SKILL_INSTALL_OPTIONS.home, ".claude", "skills");
	const unmanagedSkillName = "Camunda-AI-Agents";
	const availableSkills = ["camunda-ai-agents", "camunda-bpmn"];
	const attemptedInstalls: string[][] = [];
	const skipped = await runSkillInstall(
		"claude-code",
		async (_command, args) => {
			if (args[1] === "list") {
				return {
					status: 0,
					stdout: JSON.stringify([
						{
							skillName: `other/${unmanagedSkillName}`,
							path: join(skillRoot, "camunda-ai-agents"),
						},
					]),
					stderr: "",
				};
			}
			if (args[1] === "install" && args.length === 3) {
				return {
					status: 0,
					stdout: availableSkills
						.map((skill) => `${skill}\tCamunda skill`)
						.join("\n"),
					stderr: "",
				};
			}

			attemptedInstalls.push(args);
			if (
				args.includes("--all") ||
				args[3]?.toLowerCase() === unmanagedSkillName.toLowerCase()
			) {
				return {
					status: 1,
					stdout: "",
					stderr: `skill directory already exists for ${unmanagedSkillName}`,
				};
			}
			return { status: 0, stdout: "", stderr: "" };
		},
		EMPTY_SKILL_INSTALL_OPTIONS,
	);

	assert.deepEqual(skipped, ["camunda-ai-agents"]);
	assert.deepEqual(
		attemptedInstalls.map((args) => args[3]),
		["camunda-bpmn"],
	);
});

test("does not skip a flat install for a nested unmanaged skill with the same basename", async () => {
	const root = mkdtempSync(join(tmpdir(), "c8ctl-skills-nested-"));
	const home = join(root, "home");
	const skillRoot = join(home, ".claude", "skills");
	const unmanagedDirectory = join(skillRoot, "other", "camunda-bpmn");
	const userFile = join(unmanagedDirectory, "SKILL.md");
	mkdirSync(unmanagedDirectory, { recursive: true });
	writeFileSync(userFile, "# User-owned nested skill\n");
	const calls: string[][] = [];

	try {
		const skipped = await runSkillInstall(
			"claude-code",
			async (_command, args) => {
				calls.push(args);
				if (args[1] === "list") {
					return {
						status: 0,
						stdout: JSON.stringify([
							{
								skillName: "other/camunda-bpmn",
								path: unmanagedDirectory,
							},
						]),
						stderr: "",
					};
				}
				if (args[1] === "install" && args.length === 3) {
					return {
						status: 0,
						stdout: "camunda-bpmn\tCamunda skill",
						stderr: "",
					};
				}
				return { status: 0, stdout: "", stderr: "" };
			},
			{ env: {}, home },
		);

		assert.deepEqual(skipped, []);
		assert.deepEqual(calls.at(-1), buildSkillInstallArgs("claude-code"));
		assert.equal(readFileSync(userFile, "utf8"), "# User-owned nested skill\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
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
		runSkillInstall(
			"claude-code",
			(_command, args) =>
				Promise.resolve({
					status: 0,
					stdout: args[1] === "list" ? JSON.stringify(installedSkills) : "",
					stderr: "",
				}),
			EMPTY_SKILL_INSTALL_OPTIONS,
		),
		/no available Camunda skills/i,
	);
});

for (const [missing, stderr] of [
	["the skill command", 'unknown command "skill" for "gh"'],
	["a skill subcommand", 'unknown command "list" for "gh skill"'],
	["a flag", "unknown flag: --agent\n\nUsage:  gh skill <command> [flags]"],
]) {
	test(`reports an outdated GitHub CLI when gh lacks ${missing}`, async () => {
		await assert.rejects(
			runSkillInstall(
				"claude-code",
				() => Promise.resolve({ status: 1, stdout: "", stderr }),
				EMPTY_SKILL_INSTALL_OPTIONS,
			),
			/requires GitHub CLI 2\.95 or later/,
		);
	});
}

test("surfaces GitHub CLI skill install failures", async () => {
	let install = false;

	await assert.rejects(
		runSkillInstall(
			"claude-code",
			(_command, args) => {
				if (args[1] === "list") {
					return Promise.resolve({ status: 0, stdout: "[]", stderr: "" });
				}
				if (args[1] === "install" && args.length === 3) {
					return Promise.resolve({
						status: 0,
						stdout: "camunda-c8ctl\tCamunda skill",
						stderr: "",
					});
				}
				install = true;
				return Promise.resolve({
					status: 1,
					stdout: "",
					stderr: "network denied",
				});
			},
			EMPTY_SKILL_INSTALL_OPTIONS,
		),
		/network denied/,
	);
	assert.equal(install, true);
});

test("skills install skips directories omitted from the list and preserves user files", async () => {
	const fixture = createSkillFixture();
	const unmanagedSkillName = "camunda-ai-agents";
	const unmanagedSkillDirectory = join(fixture.skillRoot, unmanagedSkillName);
	const userFile = join(unmanagedSkillDirectory, "local.md");
	mkdirSync(unmanagedSkillDirectory, { recursive: true });
	writeFileSync(userFile, "user-owned content\n");

	try {
		const result = await c8WithOptions(
			{
				...fixture.options,
				env: {
					...fixture.options.env,
					C8CTL_SETUP_STUB_UNMANAGED_SKILL: unmanagedSkillName,
					C8CTL_SETUP_STUB_EXTRA_SKILLS: "camunda-ai-agents,camunda-bpmn",
				},
			},
			"skills",
			"install",
			"--harness",
			"claude-code",
		);
		const output = stripVTControlCharacters(result.stdout + result.stderr);

		assert.equal(result.status, 0, output);
		assert.match(output, /Skipped Camunda skill.*camunda-ai-agents/i);
		assert.match(output, /move or rename/i);
		assert.equal(readFileSync(userFile, "utf8"), "user-owned content\n");
		assert.ok(
			existsSync(join(fixture.skillRoot, "camunda-bpmn")),
			"non-colliding Camunda skills should still be installed",
		);
	} finally {
		fixture.cleanup();
	}
});

test("skills install retains its success message when no skills are skipped", async () => {
	const fixture = createSkillFixture();

	try {
		const result = await c8WithOptions(
			fixture.options,
			"skills",
			"install",
			"--harness",
			"claude-code",
		);
		const output = stripVTControlCharacters(result.stdout + result.stderr);

		assert.equal(result.status, 0, output);
		assert.match(
			output,
			/Installed or updated Camunda skills for Claude Code/i,
		);
	} finally {
		fixture.cleanup();
	}
});

test("skills install reports a neutral result when every skill name collides", async () => {
	const fixture = createSkillFixture();
	rmSync(fixture.skillDirectory, { recursive: true, force: true });
	mkdirSync(fixture.skillDirectory, { recursive: true });
	const userFile = join(fixture.skillDirectory, "local.md");
	writeFileSync(userFile, "user-owned content\n");
	writeFileSync(join(fixture.skillRoot, ".c8ctl-installed"), "");

	try {
		const result = await c8WithOptions(
			{
				...fixture.options,
				env: {
					...fixture.options.env,
					C8CTL_SETUP_STUB_UNMANAGED_SKILL: "camunda-c8ctl",
				},
			},
			"skills",
			"install",
			"--harness",
			"claude-code",
		);
		const output = stripVTControlCharacters(result.stdout + result.stderr);

		assert.equal(result.status, 0, output);
		assert.match(output, /Skipped Camunda skill.*camunda-c8ctl/i);
		assert.match(output, /installation check completed/i);
		assert.doesNotMatch(output, /Installed or updated Camunda skills/i);
		assert.equal(readFileSync(userFile, "utf8"), "user-owned content\n");
	} finally {
		fixture.cleanup();
	}
});

test("skills help documents lifecycle actions and removal selectors", async () => {
	const result = await c8("help", "skills");

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /"verb":"skills"/);
	assert.match(result.stdout, /"kind":"plugin"/);
	assert.match(result.stdout, /"name":"install"/);
	assert.match(result.stdout, /"name":"list"/);
	assert.match(result.stdout, /"name":"uninstall"/);
	// `remove` stays a supported compatibility alias for `uninstall`.
	assert.match(result.stdout, /"name":"remove"/);
	assert.match(result.stdout, /--harness/i);
	assert.match(result.stdout, /--skill-path/i);
	assert.match(result.stdout, /--dry-run/i);
});

test("skills completion includes the exact path removal selector", async () => {
	const result = await c8("completion", "bash");

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /--skill-path/);
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

test("skills list reports installed Camunda skills for a selected harness", async () => {
	const fixture = createSkillFixture();
	try {
		const result = await c8WithOptions(
			{
				...fixture.options,
				env: { ...fixture.options.env, C8CTL_OUTPUT_MODE: "json" },
			},
			"skills",
			"list",
			"--harness",
			"claude-code",
		);

		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), {
			command: "skills list",
			harnesses: ["claude-code"],
			skills: [
				{
					name: "camunda-c8ctl",
					harness: "claude-code",
					path: fixture.skillDirectory,
				},
			],
		});
	} finally {
		fixture.cleanup();
	}
});

test("skills uninstall previews first, requires confirmation, and removes only Camunda skills", async () => {
	const fixture = createSkillFixture();
	const unrelatedSkillDirectory = join(fixture.skillRoot, "local-only");
	mkdirSync(unrelatedSkillDirectory);
	try {
		const preview = await c8WithOptions(
			fixture.options,
			"skills",
			"uninstall",
			"--dry-run",
		);

		assert.equal(preview.status, 0, preview.stderr);
		assert.deepEqual(JSON.parse(preview.stdout), {
			dryRun: true,
			command: "skills uninstall",
			action: "remove",
			preview: true,
			items: [
				{
					type: "skill",
					harness: "claude-code",
					name: "camunda-c8ctl",
					path: fixture.skillDirectory,
				},
			],
		});
		assert.ok(existsSync(fixture.skillDirectory));

		const unconfirmed = await c8WithOptions(
			fixture.options,
			"skills",
			"uninstall",
		);
		assert.equal(unconfirmed.status, 0, unconfirmed.stderr);
		assert.match(unconfirmed.stdout, /Nothing was removed/);
		assert.match(unconfirmed.stdout, /c8ctl skills uninstall --yes/);
		assert.ok(existsSync(fixture.skillDirectory));

		const removed = await c8WithOptions(
			fixture.options,
			"skills",
			"uninstall",
			"--yes",
		);
		assert.equal(removed.status, 0, removed.stderr);
		assert.match(removed.stdout, /Removed Camunda skill "camunda-c8ctl"/);
		assert.ok(!existsSync(fixture.skillDirectory));
		assert.ok(existsSync(unrelatedSkillDirectory));
	} finally {
		fixture.cleanup();
	}
});

test("skills remove remains a compatibility alias for uninstall", async () => {
	const fixture = createSkillFixture();
	try {
		const preview = await c8WithOptions(
			fixture.options,
			"skills",
			"remove",
			"--dry-run",
		);

		assert.equal(preview.status, 0, preview.stderr);
		// The payload reports the canonical command regardless of the alias.
		assert.equal(JSON.parse(preview.stdout).command, "skills uninstall");
		assert.ok(existsSync(fixture.skillDirectory));

		const removed = await c8WithOptions(
			fixture.options,
			"skills",
			"remove",
			"--yes",
		);
		assert.equal(removed.status, 0, removed.stderr);
		assert.match(removed.stdout, /Removed Camunda skill "camunda-c8ctl"/);
		assert.ok(!existsSync(fixture.skillDirectory));
	} finally {
		fixture.cleanup();
	}
});

test("skills uninstall rejects selectors hidden by repeated or pre-verb string flags", async () => {
	for (const args of [
		[
			"skills",
			"uninstall",
			"--fields",
			"--harnes=cursor",
			"--fields",
			"name",
			"--yes",
		],
		[
			"skills",
			"uninstall",
			"--fields",
			"-harness=cursor",
			"--fields",
			"name",
			"--yes",
		],
		["--fields", "--harnes=cursor", "skills", "uninstall", "--yes"],
	]) {
		const fixture = createSkillFixture();
		const ghCapture = join(fixture.root, "gh-calls.jsonl");
		try {
			const result = await c8WithOptions(
				{
					...fixture.options,
					env: {
						...fixture.options.env,
						C8CTL_SETUP_STUB_GH_CAPTURE: ghCapture,
					},
				},
				...args,
			);

			assert.equal(result.status, 1, `args: ${args.join(" ")}`);
			assert.match(result.stderr, /-harnes?s=cursor/);
			assert.ok(existsSync(fixture.skillDirectory));
			assert.ok(
				!existsSync(ghCapture),
				"GitHub CLI discovery must not run before flag validation",
			);
		} finally {
			fixture.cleanup();
		}
	}
});

test("skills uninstall refuses to delete when the inventory changed after listing", async () => {
	const fixture = createSkillFixture();
	const listState = join(fixture.root, "list-state");
	try {
		const result = await c8WithOptions(
			{
				...fixture.options,
				env: {
					...fixture.options.env,
					C8CTL_SETUP_STUB_SKILL_UNLIST_AFTER_FIRST: listState,
				},
			},
			"skills",
			"uninstall",
			"--yes",
		);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /inventory changed/);
		assert.ok(existsSync(fixture.skillDirectory));
	} finally {
		fixture.cleanup();
	}
});

test("skills uninstall accepts a declared harness after a valueless global flag", async () => {
	const fixture = createSkillFixture();
	const cursorSkillDirectory = join(
		fixture.home,
		".cursor",
		"skills",
		"camunda-c8ctl",
	);
	mkdirSync(cursorSkillDirectory, { recursive: true });
	writeFileSync(join(cursorSkillDirectory, "SKILL.md"), "# Camunda c8ctl\n");
	try {
		const result = await c8WithOptions(
			{
				...fixture.options,
				env: {
					...fixture.options.env,
					C8CTL_SETUP_STUB_SKILL_PATH: cursorSkillDirectory,
				},
			},
			"skills",
			"uninstall",
			"--fields",
			"--harness",
			"cursor",
			"--fields",
			"name",
			"--yes",
		);

		assert.equal(result.status, 0, result.stderr);
		assert.ok(!existsSync(cursorSkillDirectory));
		assert.ok(existsSync(fixture.skillDirectory));
	} finally {
		fixture.cleanup();
	}
});

test("skills uninstall applies --fields to preview and result rows in JSON mode", async () => {
	const fixture = createSkillFixture();
	try {
		const preview = await c8WithOptions(
			fixture.options,
			"skills",
			"uninstall",
			"--dry-run",
			"--json",
			"--fields",
			"name,path",
		);
		assert.equal(preview.status, 0, preview.stderr);
		assert.deepEqual(JSON.parse(preview.stdout), [
			{ name: "camunda-c8ctl", path: fixture.skillDirectory },
		]);
		assert.ok(existsSync(fixture.skillDirectory));

		const removed = await c8WithOptions(
			fixture.options,
			"skills",
			"uninstall",
			"--yes",
			"--json",
			"--fields",
			"name",
		);
		assert.equal(removed.status, 0, removed.stderr);
		assert.deepEqual(JSON.parse(removed.stdout), [{ name: "camunda-c8ctl" }]);
		assert.ok(!existsSync(fixture.skillDirectory));
	} finally {
		fixture.cleanup();
	}
});

test("skills uninstall leaves installations untouched when discovery fails", async () => {
	const fixture = createSkillFixture();
	try {
		const result = await c8WithOptions(
			{
				...fixture.options,
				env: {
					...fixture.options.env,
					C8CTL_SETUP_STUB_FAIL: "list-skills",
				},
			},
			"skills",
			"uninstall",
			"--yes",
		);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /GitHub CLI 2\.95 or later/);
		assert.ok(existsSync(fixture.skillDirectory));
	} finally {
		fixture.cleanup();
	}
});

test("skills uninstall rejects unknown skill names, deleting nothing", async () => {
	const fixture = createSkillFixture();
	try {
		// "cursor" is a harness id, not an installed skill — a likely slip
		// for `--harness cursor`; "bogus" names nothing at all.
		for (const positional of ["cursor", "bogus"]) {
			const result = await c8WithOptions(
				fixture.options,
				"skills",
				"uninstall",
				positional,
				"--yes",
			);

			assert.equal(result.status, 1);
			assert.match(
				result.stderr,
				new RegExp(`Unknown Camunda skill "${positional}"`),
			);
			assert.match(result.stderr, /nothing was removed/);
			assert.ok(existsSync(fixture.skillDirectory));
		}
	} finally {
		fixture.cleanup();
	}
});

test("skills uninstall constrains deletion to the named skills", async () => {
	const fixture = createSkillFixture();
	const otherSkillDirectory = join(fixture.skillRoot, "camunda-bpmn");
	mkdirSync(otherSkillDirectory);
	writeFileSync(join(otherSkillDirectory, "SKILL.md"), "# Camunda BPMN\n");
	writeFileSync(
		join(fixture.skillRoot, ".c8ctl-installed"),
		"camunda-c8ctl\ncamunda-bpmn\n",
	);
	try {
		const preview = await c8WithOptions(
			fixture.options,
			"skills",
			"uninstall",
			"camunda-bpmn",
			"--dry-run",
		);
		assert.equal(preview.status, 0, preview.stderr);
		const payload = JSON.parse(preview.stdout);
		assert.deepEqual(
			payload.items.map((item: { name: string }) => item.name),
			["camunda-bpmn"],
		);

		const removed = await c8WithOptions(
			fixture.options,
			"skills",
			"uninstall",
			"camunda-bpmn",
			"--yes",
		);
		assert.equal(removed.status, 0, removed.stderr);
		assert.match(removed.stdout, /Removed Camunda skill "camunda-bpmn"/);
		assert.doesNotMatch(removed.stdout, /camunda-c8ctl/);
		assert.ok(!existsSync(otherSkillDirectory));
		assert.ok(existsSync(fixture.skillDirectory));
	} finally {
		fixture.cleanup();
	}
});

test("skills uninstall validates each requested name and exact path pair", async () => {
	const fixture = createSkillFixture();
	try {
		const unlistedPath = join(
			fixture.home,
			".claude-alt",
			"skills",
			"camunda-c8ctl",
		);
		const rejected = await c8WithOptions(
			fixture.options,
			"skills",
			"uninstall",
			"camunda-c8ctl",
			"--skill-path",
			unlistedPath,
			"--yes",
		);
		assert.equal(rejected.status, 1);
		assert.match(rejected.stderr, /not installed/);
		assert.ok(existsSync(fixture.skillDirectory));

		const removed = await c8WithOptions(
			fixture.options,
			"skills",
			"uninstall",
			"camunda-c8ctl",
			"--skill-path",
			fixture.skillDirectory,
			"--yes",
		);
		assert.equal(removed.status, 0, removed.stderr);
		assert.ok(!existsSync(fixture.skillDirectory));
	} finally {
		fixture.cleanup();
	}
});

test("skills uninstall refuses to delete a path whose skill identity changed", async () => {
	const fixture = createSkillFixture();
	try {
		const result = await c8WithOptions(
			{
				...fixture.options,
				env: {
					...fixture.options.env,
					C8CTL_SETUP_STUB_SKILL_NAME_AFTER_FIRST_LIST: "camunda-bpmn",
					C8CTL_SETUP_STUB_SKILL_NAME_STATE: join(
						fixture.root,
						"name-change-state",
					),
				},
			},
			"skills",
			"uninstall",
			"camunda-c8ctl",
			"--skill-path",
			fixture.skillDirectory,
			"--yes",
		);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /inventory changed/);
		assert.ok(existsSync(fixture.skillDirectory));
	} finally {
		fixture.cleanup();
	}
});

test("skills path selector is rejected by non-removal subcommands", async () => {
	const fixture = createSkillFixture();
	try {
		for (const subcommand of ["install", "list"]) {
			const result = await c8WithOptions(
				fixture.options,
				"skills",
				subcommand,
				"--skill-path",
				fixture.skillDirectory,
			);
			assert.equal(result.status, 1);
			assert.match(result.stderr, /--skill-path can only be used/);
			assert.ok(existsSync(fixture.skillDirectory));
		}
	} finally {
		fixture.cleanup();
	}
});

test("skills uninstall rejects a mistyped harness flag before discovery", async () => {
	const fixture = createSkillFixture();
	const ghCapture = join(fixture.root, "gh-calls.jsonl");
	try {
		const result = await c8WithOptions(
			{
				...fixture.options,
				env: {
					...fixture.options.env,
					C8CTL_SETUP_STUB_GH_CAPTURE: ghCapture,
				},
			},
			"skills",
			"uninstall",
			"--harnes=cursor",
			"--yes",
		);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /Unknown flag --harnes/);
		assert.ok(existsSync(fixture.skillDirectory));
		assert.ok(
			!existsSync(ghCapture),
			"GitHub CLI discovery must not run before flag validation",
		);
	} finally {
		fixture.cleanup();
	}
});

test("skills uninstall rejects an option-like value swallowed by a string flag", async () => {
	const fixture = createSkillFixture();
	const ghCapture = join(fixture.root, "gh-calls.jsonl");
	try {
		const result = await c8WithOptions(
			{
				...fixture.options,
				env: {
					...fixture.options.env,
					C8CTL_SETUP_STUB_GH_CAPTURE: ghCapture,
				},
			},
			"skills",
			"uninstall",
			"--fields",
			"--harnes=cursor",
			"--yes",
		);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /--harnes=cursor/);
		assert.ok(existsSync(fixture.skillDirectory));
		assert.ok(
			!existsSync(ghCapture),
			"GitHub CLI discovery must not run before flag validation",
		);
	} finally {
		fixture.cleanup();
	}
});

test("skills list applies --fields to skill rows in JSON mode", async () => {
	const fixture = createSkillFixture();
	try {
		const result = await c8WithOptions(
			fixture.options,
			"skills",
			"list",
			"--json",
			"--fields",
			"name,path",
		);

		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), [
			{ name: "camunda-c8ctl", path: fixture.skillDirectory },
		]);
	} finally {
		fixture.cleanup();
	}
});

test("skills uninstall supports explicit agent IDs with user-scope skills directories", async () => {
	const fixture = createSkillFixture();
	const cursorSkillDirectory = join(
		fixture.home,
		".cursor",
		"skills",
		"camunda-c8ctl",
	);
	const ghCapture = join(fixture.root, "gh-calls.jsonl");
	mkdirSync(cursorSkillDirectory, { recursive: true });
	writeFileSync(join(cursorSkillDirectory, "SKILL.md"), "# Camunda c8ctl\n");
	try {
		const result = await c8WithOptions(
			{
				...fixture.options,
				env: {
					...fixture.options.env,
					C8CTL_SETUP_STUB_SKILL_PATH: cursorSkillDirectory,
					C8CTL_SETUP_STUB_GH_CAPTURE: ghCapture,
				},
			},
			"skills",
			"uninstall",
			"--harness",
			"cursor",
			"--yes",
		);

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Removed Camunda skill "camunda-c8ctl"/);
		assert.ok(!existsSync(cursorSkillDirectory));
		assert.ok(existsSync(fixture.skillDirectory));
		const listCall = [
			"skill",
			"list",
			"--agent",
			"cursor",
			"--scope",
			"user",
			"--json",
			"skillName,sourceURL,path",
		];
		// Removal re-lists immediately before deleting, so the preview and the
		// revalidation both appear.
		assert.deepEqual(
			readFileSync(ghCapture, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
			[listCall, listCall],
		);
	} finally {
		fixture.cleanup();
	}
});

test("skills uninstall rejects paths outside trusted harness user-scope roots", async () => {
	const fixture = createSkillFixture();
	const unrelatedSkillDirectory = join(
		fixture.home,
		"project",
		"skills",
		"camunda-c8ctl",
	);
	mkdirSync(unrelatedSkillDirectory, { recursive: true });
	writeFileSync(join(unrelatedSkillDirectory, "SKILL.md"), "# Camunda c8ctl\n");
	try {
		for (const harness of ["claude-code", "unmapped-agent"]) {
			const result = await c8WithOptions(
				{
					...fixture.options,
					env: {
						...fixture.options.env,
						C8CTL_SETUP_STUB_SKILL_PATH: unrelatedSkillDirectory,
					},
				},
				"skills",
				"uninstall",
				"--harness",
				harness,
				"--yes",
			);

			assert.equal(result.status, 1);
			assert.match(result.stderr, /Cannot safely remove Camunda skill/);
			assert.ok(existsSync(unrelatedSkillDirectory));
		}
	} finally {
		fixture.cleanup();
	}
});

test("skills uninstall rejects a mapped user-scope root that resolves outside home", async () => {
	const fixture = createSkillFixture();
	const cursorDirectory = join(fixture.home, ".cursor");
	const cursorSkillsRoot = join(cursorDirectory, "skills");
	const outsideSkillsRoot = join(fixture.root, "outside-skills");
	const cursorSkillDirectory = join(cursorSkillsRoot, "camunda-c8ctl");
	mkdirSync(join(outsideSkillsRoot, "camunda-c8ctl"), { recursive: true });
	writeFileSync(
		join(outsideSkillsRoot, "camunda-c8ctl", "SKILL.md"),
		"# Camunda c8ctl\n",
	);
	mkdirSync(cursorDirectory);
	symlinkSync(
		outsideSkillsRoot,
		cursorSkillsRoot,
		process.platform === "win32" ? "junction" : "dir",
	);
	try {
		const result = await c8WithOptions(
			{
				...fixture.options,
				env: {
					...fixture.options.env,
					C8CTL_SETUP_STUB_SKILL_PATH: cursorSkillDirectory,
				},
			},
			"skills",
			"uninstall",
			"--harness",
			"cursor",
			"--yes",
		);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /Cannot safely remove Camunda skill/);
		assert.ok(existsSync(join(outsideSkillsRoot, "camunda-c8ctl")));
	} finally {
		fixture.cleanup();
	}
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
