import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	type ChangeReport,
	createCommitInput,
	type ExistingFile,
	isWritablePath,
	manualMergeReasons,
	parseChangeReport,
} from "../../scripts/agentic/changes.ts";

const report = {
	schema_version: 1,
	status: "complete",
	title: "fix: reject invalid input",
	summary: "Reject invalid input before dispatch.",
	evidence: "The regression tests pass.",
	blockers: [],
	files: [{ path: "src/example.ts", content: "export const value = 1;\n" }],
} as const satisfies ChangeReport;

const identity = {
	repository: "camunda/c8ctl",
	branch: "agentic/issue-577",
	expectedHeadOid: "0123456789abcdef0123456789abcdef01234567",
	reimplementation: false,
} as const;

function commit(
	input: ChangeReport = report,
	existingFiles: readonly ExistingFile[] = [],
) {
	return createCommitInput({ ...identity, report: input, existingFiles });
}

const allowedPaths = [
	"src/index.ts",
	"src/utils/check.ts",
	"tests/unit/example.test.ts",
	"tests/fixtures/process.bpmn",
	"docs/example.md",
	"docs/überblick.md",
	"default-plugins/example/index.ts",
	"README.md",
	"EXAMPLES.md",
	"PLUGIN-HELP.md",
];

const protectedBasenames = [
	"AGENTS.md",
	"agents.override.md",
	"AGENT.md",
	"CLAUDE.md",
	"CLAUDE.local.md",
	"GEMINI.md",
	"CODEX.md",
	"COPILOT.md",
	"copilot-instructions.md",
	"custom.instructions.md",
	"custom.prompt.md",
	"CURSOR.md",
	"WINDSURF.md",
	"CLINE.md",
	"AIDER.md",
	"OPENCODE.md",
	"WARP.md",
	"DROID.md",
	"AMP.md",
	"CRUSH.md",
	"CONVENTIONS.md",
	"SKILL.md",
	"INSTRUCTIONS.md",
	"CONTEXT.md",
	"CODEOWNERS",
	"security.md",
	"package.json",
	"PACKAGE-LOCK.JSON",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
	"deno.json",
	"deno.jsonc",
	"deno.lock",
	"composer.json",
	"composer.lock",
	"Cargo.toml",
	"Cargo.lock",
	"pyproject.toml",
	"requirements.txt",
	"requirements-dev.txt",
	"poetry.lock",
	"uv.lock",
	"Pipfile",
	"Pipfile.lock",
	"Gemfile",
	"Gemfile.lock",
	"go.mod",
	"go.sum",
	"gradle.lockfile",
	"packages.lock.json",
	"biome.json",
	"tsconfig.json",
	"tsconfig.check.json",
	"eslint.config.js",
	"release.config.cjs",
];

const unsafePaths = [
	"",
	"src",
	"src/",
	"/src/example.ts",
	"//src/example.ts",
	"./src/example.ts",
	"../src/example.ts",
	"src/./example.ts",
	"src/../README.md",
	"src//example.ts",
	"src\\example.ts",
	"src/example.ts:payload",
	"src/.hidden/example.ts",
	"src/.git/config",
	"src/..hidden/example.ts",
	"src/example.ts.",
	"src/example.ts ",
	"src/dir./example.ts",
	"src/dir /example.ts",
	"src/CON",
	"src/nul.txt",
	"src/AUX/index.ts",
	"src/COM1.ts",
	"src/LPT9/file.ts",
	"src/COM¹.ts",
	"src/CONOUT$",
	"src/CLOCK$",
	"src/CON .txt",
	"src/LPT1 .ts",
	"src/file?.ts",
	"src/file*.ts",
	'src/file".ts',
	"src/file<.ts",
	"src/file>.ts",
	"src/file|.ts",
	"src/file\u0000.ts",
	"src/file\u001f.ts",
	"src/file\u007f.ts",
	"src/file\u0085.ts",
	"src/file\u202e.ts",
	"src/file.ts\n",
	"scripts/example.ts",
	".github/workflows/example.yml",
	"assets/example.json",
	"plugins/example.grit",
	"config/example.json",
	"CONTEXT.md",
	"LICENSE",
	"tsconfig.json",
	"package.json",
	"src/templates/example.ts",
	"src/Templates/example.ts",
	"SRC/example.ts",
	"readme.md",
];

describe("change-report path policy", () => {
	test("allows only the exclusive source, test, documentation and plugin surfaces", () => {
		for (const path of allowedPaths) {
			assert.equal(isWritablePath(path), true, path);
			assert.equal(
				parseChangeReport({
					...report,
					files: [{ path, content: "text\n" }],
				}).files[0]?.path,
				path,
			);
		}
	});

	test("rejects traversal, platform aliases, hidden paths and protected roots", () => {
		for (const path of unsafePaths) {
			assert.equal(isWritablePath(path), false, JSON.stringify(path));
			assert.throws(
				() =>
					parseChangeReport({
						...report,
						files: [{ path, content: "text" }],
					}),
				TypeError,
				JSON.stringify(path),
			);
		}
	});

	test("protects dependency, instruction and tooling basenames at every depth", () => {
		for (const root of ["src", "tests", "docs", "default-plugins"]) {
			for (const basename of protectedBasenames) {
				for (const path of [
					`${root}/${basename}`,
					`${root}/nested/${basename}`,
				]) {
					assert.equal(isWritablePath(path), false, path);
				}
			}
		}
	});

	test("requires manual merge for original-PR risks independently of write eligibility", () => {
		for (const [path, reason] of [
			["package.json", /dependency/i],
			["default-plugins/example/package.json", /dependency/i],
			[".github/workflows/check.yml", /workflow/i],
			["scripts/build.mjs", /script/i],
			["src/scripts/runner.ts", /script/i],
			["docs/helper.sh", /script/i],
			["src/helper.ps1", /script/i],
			["tests/helper.cmd", /script/i],
			["src/core/auth.ts", /auth/i],
			["src/core/authorization.ts", /auth/i],
			["src/oauth/client.ts", /auth/i],
			["tests/security.test.ts", /security/i],
			["docs/migration-guide.md", /migration/i],
			["src/db/migrations/001.ts", /migration/i],
			["release.config.cjs", /release/i],
			["src/release/config.ts", /release/i],
			["src/AGENTS.md", /instruction/i],
			["src/templates/example.ts", /allowlist|protected/i],
			["assets/reference.yml", /allowlist|protected/i],
			["new-root/file.txt", /allowlist|protected/i],
		] as const) {
			const reasons = manualMergeReasons([path]);
			assert.ok(
				reasons.some((item) => item.includes(path)),
				path,
			);
			assert.ok(
				reasons.some((item) => reason.test(item)),
				path,
			);
		}
		assert.equal(isWritablePath("src/core/auth.ts"), true);
		assert.deepEqual(manualMergeReasons(allowedPaths), []);
		assert.deepEqual(manualMergeReasons([]), []);
		assert.deepEqual(
			manualMergeReasons(["package.json", "package.json"]),
			manualMergeReasons(["package.json"]),
		);
	});
});

describe("strict change-report contract", () => {
	test("round-trips complete and blocked reports without retaining input references", () => {
		const parsed = parseChangeReport(report);
		assert.deepEqual(parsed, report);
		assert.notEqual(parsed, report);
		assert.notEqual(parsed.files, report.files);
		assert.notEqual(parsed.files[0], report.files[0]);
		assert.notEqual(parsed.blockers, report.blockers);
		assert.ok(Object.isFrozen(parsed));
		assert.ok(Object.isFrozen(parsed.files));
		assert.ok(Object.isFrozen(parsed.files[0]));
		assert.ok(Object.isFrozen(parsed.blockers));
		const blocked = {
			...report,
			status: "blocked",
			blockers: ["Need an approved API contract."],
			files: [],
		} as const;
		assert.deepEqual(parseChangeReport(blocked), blocked);
	});

	test("rejects missing fields, unknown fields and model-supplied identities", () => {
		for (const key of Object.keys(report)) {
			const incomplete: Record<string, unknown> = { ...report };
			delete incomplete[key];
			assert.throws(() => parseChangeReport(incomplete), TypeError, key);
		}
		for (const value of [null, [], 1, "{}", new Date()]) {
			assert.throws(() => parseChangeReport(value), TypeError);
		}
		for (const key of [
			"unexpected",
			"repository",
			"branch",
			"expectedHeadOid",
			"head_sha",
			"author",
			"run_id",
			Symbol("extra"),
		]) {
			assert.throws(
				() => parseChangeReport({ ...report, [key]: "untrusted" }),
				TypeError,
			);
		}
		for (const file of [
			{ path: "src/example.ts" },
			{ content: "text" },
			{ path: "src/example.ts", content: "text", mode: "100755" },
			{ path: "src/example.ts", content: "text", [Symbol("extra")]: true },
			{ path: "src/example.ts", content: 123 },
			{ path: "src/example.ts", content: undefined },
			undefined,
		]) {
			assert.throws(
				() => parseChangeReport({ ...report, files: [file] }),
				TypeError,
			);
		}
	});

	test("enforces state invariants, scalar types and string bounds", () => {
		const variants: Record<string, readonly unknown[]> = {
			schema_version: [0, 2, "1"],
			status: ["done", "", null],
			title: [
				"",
				" ",
				1,
				"a".repeat(201),
				"fix: example\n",
				"fix:\rexample",
				"fix:\texample",
				"fix: example\u0000",
				"fix: example\u007f",
				"fix: example\u0085",
				"fix: example\u2028",
				"fix: example\u2029",
			],
			summary: ["", " ", 1, "a".repeat(12001)],
			evidence: ["", " ", null, "a".repeat(12001)],
			blockers: [["Not done"], "no", [42]],
			files: [[], "files", Array(1), Array(21).fill(report.files[0])],
		};
		for (const [key, values] of Object.entries(variants)) {
			for (const value of values) {
				assert.throws(
					() => parseChangeReport({ ...report, [key]: value }),
					TypeError,
					key,
				);
			}
		}
		for (const blockers of [
			[],
			[""],
			[" "],
			[1],
			["a".repeat(2001)],
			Array(21).fill("blocked"),
		]) {
			assert.throws(
				() =>
					parseChangeReport({
						...report,
						status: "blocked",
						files: [],
						blockers,
					}),
				TypeError,
			);
		}
		assert.throws(
			() =>
				parseChangeReport({
					...report,
					status: "blocked",
					blockers: ["blocked"],
				}),
			TypeError,
		);
		assert.equal(
			parseChangeReport({
				...report,
				title: "a".repeat(200),
				summary: "a".repeat(12000),
				evidence: "a".repeat(12000),
				files: Array.from({ length: 20 }, (_, index) => ({
					path: `src/file-${index}.ts`,
					content: "",
				})),
			}).files.length,
			20,
		);
		assert.equal(
			parseChangeReport({
				...report,
				status: "blocked",
				files: [],
				blockers: Array(20).fill("a".repeat(2000)),
			}).blockers.length,
			20,
		);
	});

	test("counts UTF-8 content bytes and rejects binary NUL or invalid Unicode", () => {
		assert.equal(
			parseChangeReport({
				...report,
				files: [{ path: "src/example.ts", content: "é".repeat(100000) }],
			}).files[0]?.content?.length,
			100000,
		);
		for (const content of [
			"a".repeat(200001),
			"é".repeat(100001),
			"x\u0000y",
			"\ud800",
			"\udfff",
		]) {
			assert.throws(
				() =>
					parseChangeReport({
						...report,
						files: [{ path: "src/example.ts", content }],
					}),
				TypeError,
			);
		}
	});

	test("bounds the entire serialized report, including JSON escaping", () => {
		const files = Array.from({ length: 4 }, (_, index) => ({
			path: `src/file-${index}.ts`,
			content: "a".repeat(index < 3 ? 200000 : 0),
		}));
		const empty = { ...report, files };
		const remaining = 750000 - Buffer.byteLength(JSON.stringify(empty));
		const last = files[3];
		assert.ok(last);
		last.content = "a".repeat(remaining);
		assert.equal(Buffer.byteLength(JSON.stringify(empty)), 750000);
		assert.deepEqual(parseChangeReport(empty), empty);
		last.content += "a";
		assert.throws(() => parseChangeReport(empty), TypeError);
		assert.throws(
			() =>
				parseChangeReport({
					...report,
					files: Array.from({ length: 4 }, (_, index) => ({
						path: `src/file-${index}.ts`,
						content: "\\".repeat(100000),
					})),
				}),
			TypeError,
		);
	});

	test("rejects duplicate paths, case aliases and conflicting ancestor paths", () => {
		for (const paths of [
			["src/file.ts", "src/file.ts"],
			["src/file.ts", "src/FILE.ts"],
			["docs/é.md", "docs/e\u0301.md"],
			["src/parent", "src/parent/child.ts"],
			["src/Parent/child.ts", "src/parent"],
		]) {
			assert.throws(
				() =>
					parseChangeReport({
						...report,
						files: paths.map((path) => ({ path, content: "text" })),
					}),
				TypeError,
			);
		}
	});

	test("never permits test deletion but accepts deletions for other write surfaces", () => {
		for (const path of [
			"tests/unit/file.test.ts",
			"tests/fixtures/file.bpmn",
			"tests/readme.txt",
		]) {
			assert.throws(
				() =>
					parseChangeReport({ ...report, files: [{ path, content: null }] }),
				TypeError,
			);
		}
		for (const path of [
			"src/example.ts",
			"docs/example.md",
			"default-plugins/example.ts",
			"EXAMPLES.md",
		]) {
			assert.equal(
				parseChangeReport({ ...report, files: [{ path, content: null }] })
					.files[0]?.content,
				null,
			);
		}
	});
});

describe("trusted expected-head commit construction", () => {
	test("preserves trusted identities, encodes complete UTF-8 text and adds attribution", () => {
		const content = "export const greeting = 'Grüße 🌍';\r\n";
		const input = { ...report, files: [{ path: "src/example.ts", content }] };
		const result = commit(input);
		assert.deepEqual(result, {
			branch: {
				repositoryNameWithOwner: identity.repository,
				branchName: identity.branch,
			},
			expectedHeadOid: identity.expectedHeadOid,
			message: {
				headline: report.title,
				body: `${report.summary}\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`,
			},
			fileChanges: {
				additions: [
					{
						path: "src/example.ts",
						contents: Buffer.from(content, "utf8").toString("base64"),
					},
				],
				deletions: [],
			},
		});
		const addition = result.fileChanges.additions[0];
		assert.ok(addition);
		assert.equal(
			Buffer.from(addition.contents, "base64").toString("utf8"),
			content,
		);
		assert.ok(!result.message.body.includes(report.evidence));
	});

	test("forces review fixes to chore while accepting only safe initial conventional titles", () => {
		const result = createCommitInput({
			...identity,
			reimplementation: true,
			report: { ...report, title: "feat: proposed model headline" },
			existingFiles: [],
		});
		assert.equal(
			result.message.headline,
			"chore(gh-aw): address review feedback",
		);
		for (const title of [
			"fix: repair validation",
			"feat(cli): add validation",
			"chore: improve tests",
		]) {
			assert.equal(commit({ ...report, title }).message.headline, title);
		}
		for (const title of [
			"arbitrary title",
			"Fix: uppercase type",
			"docs: unsupported release intent",
			"feat!: breaking change",
			"fix(cli)!: breaking change",
			"fix: surprise!",
			"fix: BREAKING CHANGE: changed behavior",
			"fix: BREAKING-CHANGE: changed behavior",
			"fix: ",
			"fix(): empty scope",
		]) {
			assert.throws(() => commit({ ...report, title }), TypeError, title);
		}
		for (const summary of [
			"Change.\n\nBREAKING CHANGE: remove support",
			"Change.\n\nBREAKING-CHANGE: remove support",
			"Change.\n\nCo-authored-by: Untrusted <user@example.com>",
		]) {
			assert.throws(() => commit({ ...report, summary }), TypeError);
		}
	});

	test("rejects unsafe repository, default/release branches, Git refs and malformed SHA", () => {
		for (const repository of [
			"owner",
			"/owner/repo",
			"owner/repo/extra",
			"owner/..",
			"owner/.",
			"-owner/repo",
			"owner-/repo",
			"ow--ner/repo",
			"owner/re po",
			"owner/repo\n",
			`${"o".repeat(40)}/repo`,
			`owner/${"r".repeat(101)}`,
		]) {
			assert.throws(
				() =>
					createCommitInput({
						...identity,
						repository,
						report,
						existingFiles: [],
					}),
				TypeError,
				repository,
			);
		}
		for (const branch of [
			"",
			"main",
			"MAIN",
			"master",
			"release",
			"release/8.9",
			"release-8.9",
			"refs/heads/main",
			"refs/heads/agentic/577",
			"HEAD",
			"-branch",
			"/branch",
			"branch/",
			"branch.",
			"branch..name",
			"branch//name",
			".branch",
			"parent/.branch",
			"branch.lock",
			"parent.lock/child",
			"branch name",
			"branch\nname",
			"branch\u0000name",
			"branch\u007fname",
			"branch\\name",
			"branch@{1}",
			"@",
			"branch~1",
			"branch^",
			"branch:name",
			"branch?",
			"branch*",
			"branch[0]",
		]) {
			assert.throws(
				() =>
					createCommitInput({ ...identity, branch, report, existingFiles: [] }),
				TypeError,
				branch,
			);
		}
		for (const expectedHeadOid of [
			"",
			"a".repeat(39),
			"a".repeat(41),
			"A".repeat(40),
			"g".repeat(40),
			`${"a".repeat(40)}\n`,
		]) {
			assert.throws(
				() =>
					createCommitInput({
						...identity,
						expectedHeadOid,
						report,
						existingFiles: [],
					}),
				TypeError,
			);
		}
	});

	test("revalidates reports and refuses blocked results before mutation", () => {
		assert.throws(
			() =>
				commit({
					...report,
					status: "blocked",
					files: [],
					blockers: ["Not ready"],
				}),
			TypeError,
		);
		assert.throws(
			() =>
				commit({
					...report,
					files: [
						{ path: ".github/workflows/check.yml", content: "untrusted" },
					],
				}),
			TypeError,
		);
		assert.throws(
			() =>
				commit({
					...report,
					files: [{ path: "tests/unit/example.test.ts", content: null }],
				}),
			TypeError,
		);
	});

	test("requires ordinary nonexecutable blobs for every existing affected target", () => {
		for (const [mode, type] of [
			["120000", "blob"],
			["160000", "commit"],
			["100755", "blob"],
			["040000", "tree"],
			["100644", "tree"],
			["040000", "blob"],
			["100664", "blob"],
		]) {
			for (const content of ["changed", null]) {
				assert.throws(
					() =>
						commit(
							{ ...report, files: [{ path: "src/example.ts", content }] },
							[{ path: "src/example.ts", mode, type, content: "old" }],
						),
					TypeError,
					`${mode} ${type}`,
				);
			}
		}
	});

	test("rejects symlink, submodule, blob and malformed tree ancestors at any depth", () => {
		for (const path of [
			"src",
			"src/parent",
			"src/parent/child",
			"src/Parent/child",
		]) {
			for (const [mode, type] of [
				["120000", "blob"],
				["160000", "commit"],
				["100644", "blob"],
				["100755", "blob"],
				["100644", "tree"],
			]) {
				assert.throws(
					() =>
						commit(
							{
								...report,
								files: [{ path: "src/parent/child/file.ts", content: "new" }],
							},
							[{ path, mode, type }],
						),
					TypeError,
					`${path} ${mode} ${type}`,
				);
			}
		}
		assert.equal(
			commit(
				{
					...report,
					files: [{ path: "src/parent/child/file.ts", content: "new" }],
				},
				[
					{ path: "src", mode: "040000", type: "tree" },
					{ path: "src/parent", mode: "040000", type: "tree" },
				],
			).fileChanges.additions.length,
			1,
		);
	});

	test("rejects case aliases, duplicate tree entries and directory overwrite", () => {
		for (const existingFiles of [
			[
				{
					path: "src/Example.ts",
					mode: "100644",
					type: "blob",
					content: "old",
				},
			],
			[
				{
					path: "src/example.ts",
					mode: "100644",
					type: "blob",
					content: "old",
				},
				{
					path: "src/EXAMPLE.ts",
					mode: "100644",
					type: "blob",
					content: "old",
				},
			],
			[
				{
					path: "src/example.ts/child.ts",
					mode: "100644",
					type: "blob",
					content: "old",
				},
			],
		]) {
			assert.throws(() => commit(report, existingFiles), TypeError);
		}
	});

	test("requires existing deletions and retains ordinary validated deletions", () => {
		const deletion = {
			...report,
			files: [{ path: "src/example.ts", content: null }],
		};
		assert.throws(() => commit(deletion), TypeError);
		assert.deepEqual(
			commit(deletion, [
				{ path: "src/example.ts", mode: "100644", type: "blob" },
			]).fileChanges,
			{ additions: [], deletions: [{ path: "src/example.ts" }] },
		);
	});

	test("requires comparison content for modified files and refuses all-no-op reports", () => {
		assert.throws(
			() =>
				commit(report, [
					{ path: "src/example.ts", mode: "100644", type: "blob" },
				]),
			TypeError,
		);
		assert.throws(
			() =>
				commit(report, [
					{
						path: "src/example.ts",
						mode: "100644",
						type: "blob",
						content: report.files[0].content,
					},
				]),
			TypeError,
		);
		assert.deepEqual(
			commit(
				{
					...report,
					files: [...report.files, { path: "src/new.ts", content: "" }],
				},
				[
					{
						path: "src/example.ts",
						mode: "100644",
						type: "blob",
						content: report.files[0].content,
					},
				],
			).fileChanges,
			{ additions: [{ path: "src/new.ts", contents: "" }], deletions: [] },
		);
	});

	test("does not mutate frozen reports, identities or trusted tree entries", () => {
		const input = parseChangeReport(report);
		const existingFiles = Object.freeze([
			Object.freeze({ path: "src", mode: "040000", type: "tree" }),
			Object.freeze({
				path: "src/example.ts",
				mode: "100644",
				type: "blob",
				content: "old\n",
			}),
		]);
		const options = Object.freeze({
			...identity,
			report: input,
			existingFiles,
		});
		const before = JSON.stringify(options);
		const result = createCommitInput(options);
		assert.equal(JSON.stringify(options), before);
		assert.deepEqual(result, createCommitInput(options));
		result.fileChanges.additions.splice(0);
		assert.equal(input.files.length, 1);
		assert.equal(createCommitInput(options).fileChanges.additions.length, 1);
	});
});
