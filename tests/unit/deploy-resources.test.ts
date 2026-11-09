/**
 * `deployResources` in camunda.json — `c8 deploy` and `c8 deploy --dry-run`.
 *
 * Every `describe` block names a section of the specification and every
 * test quotes (or paraphrases with a quoted prefix) the bullet or
 * acceptance criterion it enforces, so the suite doubles as a spec →
 * test traceability map. The tool-agnostic matching cases live in the
 * shared parity fixtures (deploy-resources-parity.test.ts); this file
 * covers the c8ctl-specific behaviour around them.
 *
 * Tests drive the real CLI (`--dry-run`, or a real deploy against a local
 * mock cluster) except where a bullet is about the pattern evaluator
 * itself, which is exercised through the public utils barrel.
 */

import assert from "node:assert";
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
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	compileDeployResources,
	DeployResourcesError,
	parseCamundaJson,
	parseDeployResources,
} from "../../src/utils/index.ts";
import {
	CLI_ERROR_SIGNATURE,
	createProject,
	deployDryRun,
	deployInteractively,
	deployTo,
	KEY,
	type MockCluster,
	startMockCluster,
	writeProjectFile,
} from "../utils/deploy-resources.ts";

const BPMN = (id: string) => `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="http://test" id="defs-${id}">
  <process id="${id}" isExecutable="true"><startEvent id="start"/></process>
</definitions>`;

const WORKED_EXAMPLE = [
	"resources/**",
	"target/classes/**",
	"!target/classes/drafts/**",
	"target/classes/drafts/keep.bpmn",
	"resources/.prompt.md",
];

let tempDir: string;
let mock: MockCluster | undefined;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "c8ctl-deploy-resources-"));
});

afterEach(async () => {
	await mock?.close();
	mock = undefined;
	rmSync(tempDir, { recursive: true, force: true });
});

const project = (
	descriptor: unknown,
	files: Record<string, string> | string[],
) => createProject(join(tempDir, "project"), descriptor, files);

function assertFailsWith(
	result: { status: number | null; stdout: string; stderr: string },
	signature: RegExp,
) {
	assert.notStrictEqual(
		result.status,
		0,
		`expected failure, stdout:\n${result.stdout}`,
	);
	assert.match(result.stderr, signature);
	assert.doesNotMatch(result.stdout, /"dryRun"/, "nothing must be previewed");
}

// ─── Acceptance criterion: the worked example ───────────────────────────────

describe('AC: "The example above includes a Markdown prompt and generated resources, excludes drafts except the re-included file, and excludes dotfiles, node_modules/, .git/, and a project-root README"', () => {
	test("c8 deploy --dry-run on the worked example submits exactly the selected set", async () => {
		const root = project({ deployResources: WORKED_EXAMPLE }, [
			"README.md",
			"resources/order-process.bpmn",
			"resources/agent-task-prompt.md",
			"resources/.prompt.md",
			"resources/.env",
			"target/classes/generated.bpmn",
			"target/classes/drafts/draft.bpmn",
			"target/classes/drafts/keep.bpmn",
			"target/build.log",
			"node_modules/some-pkg/vendored.bpmn",
			".git/HEAD",
		]);
		const result = await deployDryRun([root]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(result.names, [
			".prompt.md",
			"agent-task-prompt.md",
			"generated.bpmn",
			"keep.bpmn",
			"order-process.bpmn",
		]);
	});

	test("the worked example selects resources/** and target/classes/**, drops drafts but keeps keep.bpmn, and includes resources/.prompt.md (evaluator)", () => {
		const s = compileDeployResources(WORKED_EXAMPLE);
		for (const selected of [
			"resources/order-process.bpmn",
			"resources/agent-task-prompt.md",
			"resources/nested/deep.dmn",
			"resources/.prompt.md",
			"target/classes/generated.bpmn",
			"target/classes/drafts/keep.bpmn",
		]) {
			assert.ok(s.selects(selected), `${selected} must be selected`);
		}
		for (const excluded of [
			"resources/.env",
			"target/classes/drafts/draft.bpmn",
			"target/build.log",
			"node_modules/some-pkg/vendored.bpmn",
			".git/HEAD",
			"README.md",
			"camunda.json",
		]) {
			assert.ok(!s.selects(excluded), `${excluded} must not be selected`);
		}
	});
});

// ─── Specification: Resource selection and matching ─────────────────────────

describe("Spec: Resource selection and matching", () => {
	test('"deployResources is an optional top-level array of glob strings in camunda.json" — the descriptor parser keeps the field when present and omits it when absent', () => {
		assert.deepStrictEqual(
			parseCamundaJson('{"deployResources":["resources/**"]}').deployResources,
			["resources/**"],
		);
		assert.ok(!Object.hasOwn(parseCamundaJson("{}"), "deployResources"));
		// Present-but-wrong values are kept verbatim for strict validation.
		assert.strictEqual(
			parseCamundaJson('{"deployResources":null}').deployResources,
			null,
		);
	});

	test('"Allowlist: when present, selection starts empty" — only matched files deploy, regardless of extension', async () => {
		const root = project(
			{ deployResources: ["prompts/**"] },
			{
				"process.bpmn": BPMN("p"),
				"prompts/agent-task.md": "# prompt",
			},
		);
		const result = await deployDryRun([root]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(result.names, ["agent-task.md"]);
	});

	test('"Positive patterns include, ! patterns exclude; the last matching pattern wins per file"', () => {
		const s = compileDeployResources([
			"!a.bpmn",
			"a.bpmn",
			"b.bpmn",
			"!b.bpmn",
		]);
		assert.ok(s.selects("a.bpmn"), "a later positive pattern wins");
		assert.ok(!s.selects("b.bpmn"), "a later ! pattern wins");
	});

	test('"The default extension scan and .c8ignore do not apply" — a .md is selected without --extensions and .c8ignore cannot remove it', async () => {
		const root = project(
			{ deployResources: ["resources/**"] },
			{
				"resources/main.bpmn": BPMN("main"),
				"resources/prompt.md": "# prompt",
				".c8ignore": "resources/main.bpmn\n*.md\n",
			},
		);
		const result = await deployDryRun([root]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(result.names, ["main.bpmn", "prompt.md"]);
	});

	test('"Defaults: node_modules/, target/, .git/, and the project-root camunda.json remain excluded unless a matching positive pattern overrides them"', async () => {
		const files = [
			"src/main.bpmn",
			"node_modules/pkg/vendored.bpmn",
			"target/generated.bpmn",
		];
		const excluded = await deployDryRun([
			project({ deployResources: ["src/**"] }, files),
		]);
		assert.deepStrictEqual(excluded.names, ["main.bpmn"]);

		const s = compileDeployResources([
			"src/**",
			"node_modules/pkg/vendored.bpmn",
			"target/**",
			"camunda.json",
		]);
		assert.ok(s.selects("node_modules/pkg/vendored.bpmn"));
		assert.ok(s.selects("target/generated.bpmn"));
		assert.ok(s.selects("camunda.json"));
		assert.ok(!compileDeployResources(["src/**"]).selects("camunda.json"));
	});

	test('"the project-root camunda.json" default is root-only — a nested camunda.json is an ordinary file', () => {
		assert.ok(
			compileDeployResources(["**/*.json"]).selects("camunda.json"),
			"a matching positive pattern overrides the root default",
		);
		assert.ok(compileDeployResources(["sub/**"]).selects("sub/camunda.json"));
	});

	test('"Other control files (.c8ignore, .process-application) are dot-prefixed and covered by the hidden-file rule"', () => {
		const s = compileDeployResources(["**/*"]);
		assert.ok(!s.selects(".c8ignore"));
		assert.ok(!s.selects(".process-application"));
	});

	test('"Hidden files: wildcard patterns never select files whose name starts with `.`. A pattern naming the dot-prefixed file explicitly selects it"', async () => {
		const root = project(
			{ deployResources: ["resources/**", "resources/.prompt.md"] },
			{
				"resources/main.bpmn": BPMN("main"),
				"resources/.prompt.md": "# hidden prompt",
				"resources/.env": "SECRET=1",
			},
		);
		const result = await deployDryRun([root]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(result.names, [".prompt.md", "main.bpmn"]);
	});

	test('"Hidden directories are traversed normally" — a pattern naming a hidden directory reaches files inside it', async () => {
		const root = project(
			{ deployResources: [".camunda/**"] },
			{
				".camunda/extra.bpmn": BPMN("extra"),
			},
		);
		const result = await deployDryRun([root]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(result.names, ["extra.bpmn"]);
	});

	test('"Descendant re-inclusion: positive patterns select descendants directly, without parent-unignore ceremony, and a later positive pattern restores a file below an earlier excluded directory"', async () => {
		const root = project(
			{
				deployResources: [
					"src/",
					"!src/generated/",
					"src/generated/kept/important.bpmn",
				],
			},
			{
				"src/a.bpmn": BPMN("a"),
				"src/sub/b.bpmn": BPMN("b"),
				"src/generated/x.bpmn": BPMN("x"),
				"src/generated/kept/important.bpmn": BPMN("important"),
			},
		);
		const result = await deployDryRun([root]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(result.names, [
			"a.bpmn",
			"b.bpmn",
			"important.bpmn",
		]);
	});

	test('"Discovery must not prune directories in a way that defeats this" — files deep inside default-excluded directories are reachable', async () => {
		const root = project(
			{
				deployResources: [
					"node_modules/@scope/pkg/resources/shared.bpmn",
					"target/generated-resources/gen.form",
				],
			},
			{
				"node_modules/@scope/pkg/resources/shared.bpmn": BPMN("shared"),
				"node_modules/@scope/pkg/index.js": "",
				"target/generated-resources/gen.form": "{}",
			},
		);
		const result = await deployDryRun([root]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(result.names, ["gen.form", "shared.bpmn"]);
	});

	test("the walker only skips directories that no positive pattern can reach (never because of a ! pattern)", () => {
		const s = compileDeployResources(["**/*", "!node_modules/"]);
		assert.ok(!s.couldSelectUnder(".git"), "wildcards never reach .git/");
		assert.ok(s.couldSelectUnder("node_modules/pkg"));
		const explicit = compileDeployResources(["!vendor/", "vendor/a/b.bpmn"]);
		assert.ok(explicit.couldSelectUnder("vendor"));
		assert.ok(explicit.couldSelectUnder("vendor/a"));
		assert.ok(!explicit.couldSelectUnder("vendor/c"));
		assert.ok(!explicit.couldSelectUnder("other"));
	});

	for (const [label, pattern] of [
		["a UNC path", "//server/share/**"],
		["a Windows drive path", "C:/project/**"],
		["a Windows backslash path", "C:\\project\\**"],
		["a negated drive path", "!C:/project/drafts/**"],
		["a leading ..", "../shared/**"],
		["an embedded ..", "resources/../../shared/**"],
		["a .. hidden by trailing whitespace", "resources/.. "],
	] as const) {
		test(`"Containment: patterns are project-root-relative; absolute paths and .. are invalid" — ${label} fails without deploying`, async () => {
			const root = project(
				{ deployResources: ["resources/**", pattern] },
				{
					"resources/main.bpmn": BPMN("main"),
				},
			);
			assertFailsWith(
				await deployDryRun([root]),
				CLI_ERROR_SIGNATURE["invalid-config"],
			);
		});
	}

	test('"anchoring … inherited from that engine" — a leading / anchors the pattern to the project root, as in .c8ignore', async () => {
		const root = project(
			{ deployResources: ["/process.bpmn"] },
			{
				"process.bpmn": BPMN("root-process"),
				"sub/process.bpmn": BPMN("sub-process"),
			},
		);
		const result = await deployDryRun([root]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(result.names, ["process.bpmn"]);
		const s = compileDeployResources(["/process.bpmn"]);
		assert.ok(s.selects("process.bpmn"));
		assert.ok(!s.selects("sub/process.bpmn"));
		const unanchored = compileDeployResources(["process.bpmn"]);
		assert.ok(unanchored.selects("sub/process.bpmn"), "no slash: any depth");
	});

	test('"anchoring … inherited from that engine" — a negated leading / deselects only at the project root', () => {
		const s = compileDeployResources(["**/*.bpmn", "!/process.bpmn"]);
		assert.ok(!s.selects("process.bpmn"));
		assert.ok(s.selects("sub/process.bpmn"));
	});

	test('"A pattern matching no files: silently ignored" — an absolute-looking /Users/... pattern is root-anchored and simply matches nothing', async () => {
		const root = project(
			{ deployResources: ["/Users/me/project/**", "resources/**"] },
			{ "resources/main.bpmn": BPMN("main") },
		);
		const result = await deployDryRun([root]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(result.names, ["main.bpmn"]);
	});

	test('"Symlink handling and duplicate detection follow c8ctl\'s existing discovery (realpath-based)" — a symlinked duplicate deploys once and a symlink loop terminates', {
		skip:
			process.platform === "win32" &&
			"symlinks need elevated rights on Windows",
	}, async () => {
		const root = project(
			{ deployResources: ["**/*.bpmn"] },
			{
				"resources/main.bpmn": BPMN("main"),
			},
		);
		mkdirSync(join(root, "linked"));
		symlinkSync(
			join(root, "resources", "main.bpmn"),
			join(root, "linked", "alias.bpmn"),
		);
		symlinkSync(root, join(root, "resources", "loop"));
		const result = await deployDryRun([root]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.strictEqual(result.names?.length, 1, `got ${result.names}`);
	});

	test('"Symlink handling … follow c8ctl\'s existing discovery" — a directory reached through an alias and through its real path is evaluated under both project-relative paths', {
		skip:
			process.platform === "win32" &&
			"symlinks need elevated rights on Windows",
	}, async () => {
		const root = project(
			{ deployResources: ["alias/a.bpmn", "resources/b.bpmn"] },
			{
				"resources/a.bpmn": BPMN("a"),
				"resources/b.bpmn": BPMN("b"),
			},
		);
		symlinkSync(join(root, "resources"), join(root, "alias"));
		const result = await deployDryRun([root]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(result.names, ["a.bpmn", "b.bpmn"]);
	});

	test('"The default extension scan and .c8ignore do not apply" — .c8ignore is not even read: a directory named .c8ignore does not abort a descriptor-only deploy', async () => {
		const root = project(
			{ deployResources: ["resources/**"] },
			{
				"resources/main.bpmn": BPMN("main"),
				"resources/notes.md": "# notes",
				".c8ignore/placeholder.txt": "",
			},
		);
		const projectOnly = await deployDryRun([root]);
		assert.strictEqual(projectOnly.status, 0, projectOnly.stderr);
		assert.deepStrictEqual(projectOnly.names, ["main.bpmn", "notes.md"]);

		const withExplicitFile = await deployDryRun([
			root,
			join(root, "resources", "notes.md"),
		]);
		assert.strictEqual(withExplicitFile.status, 0, withExplicitFile.stderr);
		assert.deepStrictEqual(withExplicitFile.names, ["main.bpmn", "notes.md"]);
	});

	test('"same pattern engine" — directory pruning agrees with the matcher for "." segments', async () => {
		const s = compileDeployResources(["resources/./sub/*.bpmn"]);
		assert.ok(s.selects("resources/sub/main.bpmn"));
		assert.ok(s.couldSelectUnder("resources/sub"));
		const root = project(
			{ deployResources: ["resources/./sub/*.bpmn"] },
			{
				"resources/sub/main.bpmn": BPMN("main"),
			},
		);
		const result = await deployDryRun([root]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(result.names, ["main.bpmn"]);
	});

	test('"same pattern engine" — directory pruning agrees with the matcher for repeated separators', async () => {
		const s = compileDeployResources(["resources//sub/*.bpmn"]);
		assert.ok(s.selects("resources/sub/main.bpmn"));
		assert.ok(s.couldSelectUnder("resources/sub"));
		const root = project(
			{ deployResources: ["resources//sub/*.bpmn"] },
			{
				"resources/sub/main.bpmn": BPMN("main"),
			},
		);
		const result = await deployDryRun([root]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(result.names, ["main.bpmn"]);
	});

	test('"When deployResources is absent, the existing scan rules apply, filtered by .c8ignore"', async () => {
		const root = project(
			{},
			{
				"main.bpmn": BPMN("main"),
				"old.bpmn": BPMN("old"),
				"notes.md": "# notes",
				".c8ignore": "old.bpmn\n",
			},
		);
		const result = await deployDryRun([root]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(result.names, ["main.bpmn"]);
	});

	test('"c8ctl: explicitly named command-line files deploy regardless of deployResources"', async () => {
		const root = project(
			{ deployResources: ["resources/**"] },
			{
				"resources/main.bpmn": BPMN("main"),
				"notes/standalone.md": "# not selected",
				".c8ignore": "notes/\n",
			},
		);
		const explicitOnly = await deployDryRun([
			join(root, "notes", "standalone.md"),
		]);
		assert.strictEqual(explicitOnly.status, 0, explicitOnly.stderr);
		assert.deepStrictEqual(explicitOnly.names, ["standalone.md"]);

		const withProject = await deployDryRun([
			root,
			join(root, "notes", "standalone.md"),
		]);
		assert.strictEqual(withProject.status, 0, withProject.stderr);
		assert.deepStrictEqual(withProject.names, ["main.bpmn", "standalone.md"]);
	});

	test("an explicitly named file still deploys when the project's deployResources is invalid", async () => {
		const root = project(
			{ deployResources: "not-an-array" },
			{
				"main.bpmn": BPMN("main"),
			},
		);
		const result = await deployDryRun([join(root, "main.bpmn")]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(result.names, ["main.bpmn"]);
	});
});

// ─── Specification: Project membership ──────────────────────────────────────

describe("Spec: Project membership", () => {
	test('"An excluded file must not contribute project resources merely because it exists under the project root" — deploying a subdirectory expands to the project and keeps excluded files out', async () => {
		const root = project(
			{ deployResources: ["**/*.bpmn", "!drafts/"] },
			{
				"main.bpmn": BPMN("main"),
				"drafts/wip.bpmn": BPMN("wip"),
			},
		);
		const result = await deployDryRun([join(root, "drafts")]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(result.names, ["main.bpmn"]);
	});
});

// ─── Specification: Descriptor precedence (c8ctl) ───────────────────────────

describe("Spec: Descriptor precedence (c8ctl)", () => {
	for (const flag of ["--extensions=.md", "--all-extensions", "--force"]) {
		test(`"When deployResources is present, c8ctl rejects conflicting selection flags … with an actionable message" — ${flag}`, async () => {
			const root = project(
				{ deployResources: ["**/*.bpmn"] },
				{
					"main.bpmn": BPMN("main"),
				},
			);
			const result = await deployDryRun([root, flag]);
			assert.notStrictEqual(result.status, 0);
			assert.match(result.stderr, new RegExp(flag.split("=")[0]));
			assert.match(
				result.stderr,
				/cannot be used with a project that selects its resources/,
			);
			assert.match(result.stderr, /deployResources/);
			assert.match(result.stderr, /name files explicitly on the command line/);
			assert.doesNotMatch(result.stdout, /"dryRun"/);
		});
	}

	test("the flags are rejected when a subdirectory path expands to a project with deployResources", async () => {
		const root = project(
			{ deployResources: ["**/*.bpmn"] },
			{
				"sub/main.bpmn": BPMN("main"),
			},
		);
		const result = await deployDryRun([join(root, "sub"), "--all-extensions"]);
		assert.notStrictEqual(result.status, 0);
		assert.match(result.stderr, /--all-extensions cannot be used/);
	});

	test("the flags keep working when deployResources is absent", async () => {
		const root = project(
			{},
			{
				"main.bpmn": BPMN("main"),
				"notes.md": "# notes",
			},
		);
		const result = await deployDryRun([root, "--extensions=.md"]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(result.names, ["main.bpmn", "notes.md"]);
	});

	test("the flags keep working with explicitly named files inside a deployResources project", async () => {
		const root = project(
			{ deployResources: ["**/*.bpmn"] },
			{
				"main.bpmn": BPMN("main"),
			},
		);
		const result = await deployDryRun([join(root, "main.bpmn"), "--force"]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(result.names, ["main.bpmn"]);
	});
	test('mixed deploy: "Deploy them always" writes .c8ignore where the default scan reads it, not at the common parent with the deployResources project', async () => {
		mock = await startMockCluster({ gatewayVersion: "8.10.0" });
		const descriptorProject = project(
			{ deployResources: ["**/*.bpmn"] },
			{
				"main.bpmn": BPMN("main"),
			},
		);
		const plainDir = join(tempDir, "plain");
		writeProjectFile(plainDir, "plain.bpmn", BPMN("plain"));
		writeProjectFile(plainDir, "notes.md", "# notes");

		const result = await deployInteractively(
			mock.baseUrl,
			[descriptorProject, plainDir],
			{
				promptText: "What do you want to do about these files?",
				keys: KEY.down + KEY.down + KEY.enter,
			},
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.ok(!result.timedOut);
		assert.strictEqual(
			readFileSync(join(plainDir, ".c8ignore"), "utf-8").includes("!/notes.md"),
			true,
		);
		assert.ok(
			!existsSync(join(tempDir, ".c8ignore")),
			"must not write to the common parent of both paths",
		);
		assert.deepStrictEqual(mock.deployments, [
			["main.bpmn", "notes.md", "plain.bpmn"],
		]);

		// The persisted rule is read back by the next (non-interactive) deploy.
		const again = await deployTo(mock.baseUrl, [descriptorProject, plainDir]);
		assert.strictEqual(again.status, 0, again.stderr);
		assert.deepStrictEqual(mock.deployments[1], [
			"main.bpmn",
			"notes.md",
			"plain.bpmn",
		]);
	});
});

// ─── Specification: Nested projects ─────────────────────────────────────────

describe("Spec: Nested projects", () => {
	test('"a nested camunda.json does not exclude that folder from the parent\'s selection — exclude it explicitly if needed"', async () => {
		const root = project(
			{ deployResources: ["**/*.bpmn", "!excluded-child/"] },
			{
				"main.bpmn": BPMN("main"),
				"child/camunda.json": "{}",
				"child/inner.bpmn": BPMN("inner"),
				"excluded-child/camunda.json": "{}",
				"excluded-child/other.bpmn": BPMN("other"),
			},
		);
		const result = await deployDryRun([root]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(result.names, ["inner.bpmn", "main.bpmn"]);
	});

	test('"Tools are not required to detect or reject nesting" — an unparseable nested camunda.json does not break the parent selection', async () => {
		const root = project(
			{ deployResources: ["**/*.bpmn"] },
			{
				"main.bpmn": BPMN("main"),
				"child/camunda.json": "{ broken",
				"child/inner.bpmn": BPMN("inner"),
			},
		);
		const result = await deployDryRun([root]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(result.names, ["inner.bpmn", "main.bpmn"]);
	});
});

// ─── Specification: Validation and feedback ─────────────────────────────────

describe("Spec: Validation and feedback", () => {
	for (const [label, descriptor] of [
		["a string", '{"deployResources":"resources/**"}'],
		["null", '{"deployResources":null}'],
		["an object", '{"deployResources":{"include":["resources/**"]}}'],
		["a non-string entry", '{"deployResources":["resources/**",42]}'],
		["an empty pattern", '{"deployResources":["resources/**",""]}'],
		["a bare !", '{"deployResources":["!"]}'],
		["a # comment entry", '{"deployResources":["# all"]}'],
	] as const) {
		test(`"Invalid field type or entries, and invalid patterns: error, no deployment" — ${label}`, async () => {
			const root = project(descriptor, { "resources/main.bpmn": BPMN("main") });
			assertFailsWith(
				await deployDryRun([root]),
				CLI_ERROR_SIGNATURE["invalid-config"],
			);
		});
	}

	test("validation errors are typed with the tool-agnostic invalid-config code and name the offending entry", () => {
		assert.throws(
			() => parseDeployResources(["ok/**", 7], "camunda.json"),
			(e: unknown) =>
				e instanceof DeployResourcesError &&
				e.code === "invalid-config" &&
				/entry 1 must be a string/.test(e.message),
		);
	});

	test('"Empty final selection: error, no deployment (mirrors today\'s \\"No deployable files found\\")"', async () => {
		for (const patterns of [[], ["resources/**", "!resources/**"]]) {
			const root = createProject(
				join(tempDir, `empty-${patterns.length}`),
				{ deployResources: patterns },
				{ "resources/main.bpmn": BPMN("main") },
			);
			assertFailsWith(
				await deployDryRun([root]),
				CLI_ERROR_SIGNATURE["empty-selection"],
			);
		}
	});

	test('"A pattern matching no files: silently ignored"', async () => {
		const root = project(
			{
				deployResources: ["resources/**", "does-not-exist/**", "!missing.bpmn"],
			},
			{ "resources/main.bpmn": BPMN("main") },
		);
		const result = await deployDryRun([root]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(result.names, ["main.bpmn"]);
		assert.doesNotMatch(result.stderr, /does-not-exist|missing\.bpmn/);
	});
});

// ─── Validation: the descriptor itself ──────────────────────────────────────

describe('Spec: Validation and feedback — "Invalid field type or entries … error, no deployment" applies to a descriptor that cannot be read', () => {
	const readFailure = /Failed to read [^\n]*camunda\.json/;

	test("a directory named camunda.json fails instead of falling back to the default scan", async () => {
		const root = join(tempDir, "project");
		mkdirSync(join(root, "camunda.json"), { recursive: true });
		writeProjectFile(root, "main.bpmn", BPMN("main"));
		assertFailsWith(await deployDryRun([root]), readFailure);
	});

	test("an unreadable camunda.json (no permission) fails instead of falling back to the default scan", {
		skip:
			(process.platform === "win32" && "POSIX permissions only") ||
			(process.getuid?.() === 0 && "root can read any file"),
	}, async () => {
		const root = project(
			{ deployResources: ["*.md"] },
			{
				"main.bpmn": BPMN("main"),
				"notes.md": "# notes",
			},
		);
		chmodSync(join(root, "camunda.json"), 0o000);
		try {
			assertFailsWith(await deployDryRun([root]), readFailure);
		} finally {
			chmodSync(join(root, "camunda.json"), 0o644);
		}
	});

	for (const [label, bytes] of [
		[
			"UTF-8 BOM",
			Buffer.concat([
				Buffer.from([0xef, 0xbb, 0xbf]),
				Buffer.from('{"deployResources":["*.md"]}', "utf-8"),
			]),
		],
		[
			"UTF-16LE BOM",
			Buffer.concat([
				Buffer.from([0xff, 0xfe]),
				Buffer.from('{"deployResources":["*.md"]}', "utf16le"),
			]),
		],
	] as const) {
		test(`a camunda.json with a ${label} is parsed and its deployResources applied`, async () => {
			const root = project(
				{},
				{ "main.bpmn": BPMN("main"), "notes.md": "# notes" },
			);
			writeFileSync(join(root, "camunda.json"), bytes);
			const result = await deployDryRun([root]);
			assert.strictEqual(result.status, 0, result.stderr);
			assert.deepStrictEqual(result.names, ["notes.md"]);
		});
	}
});

// ─── A broken or changing descriptor never falls back to the default scan ──

describe('"no surprise": a broken or changing camunda.json never falls back to the default scan', () => {
	const descriptorError = /Failed to read [^\n]*camunda\.json/;
	const symlinks = {
		skip:
			process.platform === "win32" &&
			"symlinks need elevated rights on Windows",
	};

	test(
		"a dangling camunda.json symlink is invalid-config, in the deployed folder or above it",
		symlinks,
		async () => {
			const root = join(tempDir, "dangling");
			writeProjectFile(root, "sub/main.bpmn", BPMN("main"));
			writeProjectFile(root, "notes.md", "# notes");
			symlinkSync(join(tempDir, "missing.json"), join(root, "camunda.json"));
			for (const target of [root, join(root, "sub")]) {
				const result = await deployDryRun([target]);
				assertFailsWith(result, descriptorError);
				assert.match(result.stderr, /dangling symlink/);
			}
		},
	);

	test("a camunda.json symlink whose target cannot be read is invalid-config", {
		skip:
			(process.platform === "win32" && "POSIX permissions only") ||
			(process.getuid?.() === 0 && "root can read any file"),
	}, async () => {
		const root = join(tempDir, "locked-target");
		writeProjectFile(root, "main.bpmn", BPMN("main"));
		const target = writeProjectFile(
			tempDir,
			"real-camunda.json",
			'{"deployResources":["*.md"]}',
		);
		symlinkSync(target, join(root, "camunda.json"));
		chmodSync(target, 0o000);
		try {
			assertFailsWith(await deployDryRun([root]), descriptorError);
		} finally {
			chmodSync(target, 0o644);
		}
	});

	// The descriptor is read twice to resolve the plan (marker check, then
	// the field); the mutation lands right after, before any later step.
	for (const [label, action] of [
		["removed", "delete"],
		["replaced by {} (field gone)", "{}"],
		["half written (empty)", ""],
	] as const) {
		test(`a camunda.json ${label} after the selection was resolved: --dry-run still previews the selection`, async () => {
			const root = project(
				{ deployResources: ["*.md"] },
				{
					"main.bpmn": BPMN("main"),
					"notes.md": "# notes",
				},
			);
			const result = await deployDryRun([root], {
				mutateAfterReads: `${join(root, "camunda.json")}|2|${action}`,
			});
			assert.strictEqual(result.status, 0, result.stderr);
			assert.deepStrictEqual(result.names, ["notes.md"]);
		});

		test(`a camunda.json ${label} after the selection was resolved: deploy still submits the selection`, async () => {
			mock = await startMockCluster({ gatewayVersion: "8.10.0" });
			const root = project(
				{ deployResources: ["*.md"] },
				{
					"main.bpmn": BPMN("main"),
					"notes.md": "# notes",
				},
			);
			const result = await deployTo(mock.baseUrl, [root], {
				mutateAfterReads: `${join(root, "camunda.json")}|2|${action}`,
			});
			assert.strictEqual(result.status, 0, result.stderr);
			assert.deepStrictEqual(mock.deployments, [["notes.md"]]);
		});
	}
});

// ─── Read errors never silently shrink a selection ───────────────────────────

describe('"no surprise": a path that a deployResources pattern can select but that cannot be read fails the deploy instead of being skipped', () => {
	const posixOnly = {
		skip:
			(process.platform === "win32" && "POSIX permissions only") ||
			(process.getuid?.() === 0 && "root can read any file"),
	};
	const readError = /Cannot read [^\n]*(locked|secret\.bpmn|missing|vanishing)/;

	test(
		"a selected directory whose entries cannot be inspected (no execute permission)",
		posixOnly,
		async () => {
			const root = project(
				{ deployResources: ["resources/**"] },
				{
					"resources/main.bpmn": BPMN("main"),
					"resources/locked/a.bpmn": BPMN("a"),
				},
			);
			chmodSync(join(root, "resources", "locked"), 0o600);
			try {
				assertFailsWith(await deployDryRun([root]), readError);
			} finally {
				chmodSync(join(root, "resources", "locked"), 0o755);
			}
		},
	);

	test(
		"a selected directory that cannot be listed (no permission)",
		posixOnly,
		async () => {
			const root = project(
				{ deployResources: ["resources/**"] },
				{
					"resources/main.bpmn": BPMN("main"),
					"resources/locked/a.bpmn": BPMN("a"),
				},
			);
			chmodSync(join(root, "resources", "locked"), 0o000);
			try {
				assertFailsWith(await deployDryRun([root]), readError);
			} finally {
				chmodSync(join(root, "resources", "locked"), 0o755);
			}
		},
	);

	test(
		"an unreadable directory that no pattern can reach is not an error",
		posixOnly,
		async () => {
			const root = project(
				{ deployResources: ["resources/**"] },
				{
					"resources/main.bpmn": BPMN("main"),
					"other/locked/a.bpmn": BPMN("a"),
				},
			);
			chmodSync(join(root, "other", "locked"), 0o000);
			try {
				const result = await deployDryRun([root]);
				assert.strictEqual(result.status, 0, result.stderr);
				assert.deepStrictEqual(result.names, ["main.bpmn"]);
			} finally {
				chmodSync(join(root, "other", "locked"), 0o755);
			}
		},
	);

	test("a selected file that cannot be read", posixOnly, async () => {
		const root = project(
			{ deployResources: ["resources/**"] },
			{
				"resources/main.bpmn": BPMN("main"),
				"resources/secret.bpmn": BPMN("secret"),
			},
		);
		chmodSync(join(root, "resources", "secret.bpmn"), 0o000);
		try {
			assertFailsWith(await deployDryRun([root]), readError);
		} finally {
			chmodSync(join(root, "resources", "secret.bpmn"), 0o644);
		}
	});

	test("a selected dangling symlink is an error; one no pattern selects is ignored", {
		skip:
			process.platform === "win32" &&
			"symlinks need elevated rights on Windows",
	}, async () => {
		const root = project(
			{ deployResources: ["resources/*.bpmn"] },
			{
				"resources/main.bpmn": BPMN("main"),
			},
		);
		symlinkSync(
			join(root, "missing-target.md"),
			join(root, "resources", "notes.md"),
		);
		const ignored = await deployDryRun([root]);
		assert.strictEqual(ignored.status, 0, ignored.stderr);
		assert.deepStrictEqual(ignored.names, ["main.bpmn"]);

		symlinkSync(
			join(root, "missing.bpmn"),
			join(root, "resources", "link.bpmn"),
		);
		const selected = await deployDryRun([root]);
		assertFailsWith(
			selected,
			/dangling symlink[^\n]*link\.bpmn|link\.bpmn[^\n]*dangling symlink/,
		);
	});

	test("a selected file removed between the selection walk and the content read", async () => {
		const root = project(
			{ deployResources: ["resources/**"] },
			{
				"resources/main.bpmn": BPMN("main"),
				"resources/vanishing.bpmn": BPMN("vanishing"),
			},
		);
		const result = await deployDryRun([root], {
			vanishOnRead: join(root, "resources", "vanishing.bpmn"),
		});
		assertFailsWith(result, readError);
	});
});

// ─── Specification: Camunda 8 version compatibility ─────────────────────────

describe("Spec: Camunda 8 version compatibility", () => {
	test('"c8ctl must not apply its existing <8.10 extension fallback when deployResources is present" — the selected set is submitted unchanged to an 8.8 cluster, with no version check', async () => {
		mock = await startMockCluster({ gatewayVersion: "8.8.0" });
		const root = project(
			{ deployResources: ["**/*.bpmn", "**/*.md"] },
			{
				"main.bpmn": BPMN("main"),
				"prompts/agent.md": "# prompt",
			},
		);
		const result = await deployTo(mock.baseUrl, [root]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(mock.deployments, [["agent.md", "main.bpmn"]]);
		assert.strictEqual(mock.topologyCalls(), 0, "no capability check");
		assert.doesNotMatch(result.stderr, /Falling back to default extensions/);
	});

	test('"surface deployment errors as they do today" — AC: "unsupported resource types fail at the server"', async () => {
		mock = await startMockCluster({
			gatewayVersion: "8.8.0",
			rejectDeployments: true,
		});
		const root = project(
			{ deployResources: ["**/*.md"] },
			{
				"prompts/agent.md": "# prompt",
			},
		);
		const result = await deployTo(mock.baseUrl, [root]);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /Deployment failed/);
		assert.match(result.stderr, /INVALID_ARGUMENT/);
		assert.deepStrictEqual(mock.deployments, [["agent.md"]]);
	});

	test('AC: "missing deployResources preserves existing deployment behavior, including legacy projects and servers <8.10"', async () => {
		mock = await startMockCluster({ gatewayVersion: "8.8.0" });
		const root = project(
			{},
			{
				"main.bpmn": BPMN("main"),
				"prompts/agent.md": "# prompt",
			},
		);
		const modern = await deployTo(mock.baseUrl, [root, "--all-extensions"]);
		assert.strictEqual(modern.status, 0, modern.stderr);
		assert.match(modern.stderr, /Falling back to default extensions/);
		assert.strictEqual(mock.topologyCalls(), 1);

		const legacyRoot = join(tempDir, "legacy-pa");
		mkdirSync(legacyRoot);
		writeFileSync(join(legacyRoot, ".process-application"), "");
		writeProjectFile(legacyRoot, "legacy.bpmn", BPMN("legacy"));
		writeProjectFile(legacyRoot, "notes.md", "# notes");
		const legacy = await deployTo(mock.baseUrl, [legacyRoot]);
		assert.strictEqual(legacy.status, 0, legacy.stderr);

		assert.deepStrictEqual(mock.deployments, [["main.bpmn"], ["legacy.bpmn"]]);
	});
});
