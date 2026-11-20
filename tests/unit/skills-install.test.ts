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

test("skills help documents the lifecycle actions and harness selector", async () => {
	const result = await c8("help", "skills");

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /"verb":"skills"/);
	assert.match(result.stdout, /"kind":"plugin"/);
	assert.match(result.stdout, /"name":"install"/);
	assert.match(result.stdout, /"name":"list"/);
	assert.match(result.stdout, /"name":"remove"/);
	assert.match(result.stdout, /--harness/i);
	assert.match(result.stdout, /--dry-run/i);
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

test("skills remove previews first, requires confirmation, and removes only Camunda skills", async () => {
	const fixture = createSkillFixture();
	const unrelatedSkillDirectory = join(fixture.skillRoot, "local-only");
	mkdirSync(unrelatedSkillDirectory);
	try {
		const preview = await c8WithOptions(
			fixture.options,
			"skills",
			"remove",
			"--dry-run",
		);

		assert.equal(preview.status, 0, preview.stderr);
		assert.deepEqual(JSON.parse(preview.stdout), {
			dryRun: true,
			command: "skills remove",
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
			"remove",
		);
		assert.equal(unconfirmed.status, 0, unconfirmed.stderr);
		assert.match(unconfirmed.stdout, /Nothing was removed/);
		assert.match(unconfirmed.stdout, /c8ctl skills remove --yes/);
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
		assert.ok(existsSync(unrelatedSkillDirectory));
	} finally {
		fixture.cleanup();
	}
});

test("skills remove rejects selectors hidden by repeated or pre-verb string flags", async () => {
	for (const args of [
		[
			"skills",
			"remove",
			"--fields",
			"--harnes=cursor",
			"--fields",
			"name",
			"--yes",
		],
		[
			"skills",
			"remove",
			"--fields",
			"-harness=cursor",
			"--fields",
			"name",
			"--yes",
		],
		["--fields", "--harnes=cursor", "skills", "remove", "--yes"],
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

test("skills remove refuses to delete when the inventory changed after listing", async () => {
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
			"remove",
			"--yes",
		);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /inventory changed/);
		assert.ok(existsSync(fixture.skillDirectory));
	} finally {
		fixture.cleanup();
	}
});

test("skills remove accepts a declared harness after a valueless global flag", async () => {
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
			"remove",
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

test("skills remove applies --fields to preview and result rows in JSON mode", async () => {
	const fixture = createSkillFixture();
	try {
		const preview = await c8WithOptions(
			fixture.options,
			"skills",
			"remove",
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
			"remove",
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

test("skills remove leaves installations untouched when discovery fails", async () => {
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
			"remove",
			"--yes",
		);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /GitHub CLI 2\.90 or later/);
		assert.ok(existsSync(fixture.skillDirectory));
	} finally {
		fixture.cleanup();
	}
});

test("skills remove rejects unknown skill names, deleting nothing", async () => {
	const fixture = createSkillFixture();
	try {
		// "cursor" is a harness id, not an installed skill — a likely slip
		// for `--harness cursor`; "bogus" names nothing at all.
		for (const positional of ["cursor", "bogus"]) {
			const result = await c8WithOptions(
				fixture.options,
				"skills",
				"remove",
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

test("skills remove constrains deletion to the named skills", async () => {
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
			"remove",
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
			"remove",
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

test("skills remove rejects a mistyped harness flag before discovery", async () => {
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
			"remove",
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

test("skills remove rejects an option-like value swallowed by a string flag", async () => {
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
			"remove",
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

test("skills remove supports explicit agent IDs with user-scope skills directories", async () => {
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
			"remove",
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

test("skills remove rejects paths outside trusted harness user-scope roots", async () => {
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
				"remove",
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

test("skills remove rejects a mapped user-scope root that resolves outside home", async () => {
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
			"remove",
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
