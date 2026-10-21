import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	applyRegeneration,
	assertArtifactEntries,
	assertCompileResult,
	assertCompilerIdentity,
	assertGeneratedTree,
	assertNoGeneratedDrift,
	assertPublishedRelease,
	compilerArguments,
	GENERATED_PATHS,
	type MaintenanceGitHub,
	parseCompilerVersion,
	parseRegeneration,
	prepareMaintenance,
	validateChangedFiles,
	validatePullRequest,
} from "../../scripts/agentic/maintenance.ts";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const sha = "a".repeat(40);
const sourceSha = "b".repeat(40);
const expected = {
	repository: "camunda/c8ctl",
	pull_request: 123,
	expected_head_sha: sha,
	version: "v0.89.0",
	source_sha: sourceSha,
};
const artifact = () => ({
	schema_version: 1,
	...expected,
	files: [
		{
			path: ".github/workflows/agentic-fitness.lock.yml",
			content: Buffer.from("name: Fitness\n").toString("base64"),
		},
	],
});
const pullRequest = () => ({
	number: 123,
	state: "open",
	draft: false,
	user: { login: "renovate[bot]", type: "Bot" },
	head: {
		sha,
		ref: "renovate/github-gh-aw-0.x",
		repo: { full_name: "camunda/c8ctl" },
	},
	base: { ref: "main", repo: { full_name: "camunda/c8ctl" } },
	labels: [],
	changed_files: 1,
});
const release = () => ({
	tag_name: "v0.89.0",
	draft: false,
	prerelease: false,
	published_at: "2026-09-18T00:00:00Z",
});

describe("compiler input boundaries", () => {
	it("refreshes compiler-owned action pins only during candidate regeneration", () => {
		const validation = compilerArguments();
		const regeneration = compilerArguments({ refreshPins: true });
		assert.deepEqual(regeneration, [
			...validation,
			"--force-refresh-action-pins",
		]);
		assert.ok(validation.includes("--strict"));
		assert.ok(validation.includes("--no-check-update"));
		assert.ok(!validation.includes("--json"));
		for (const option of [
			"--approve",
			"--fix",
			"--engine",
			"--action-tag",
			"--force-refresh-action-pins",
		]) {
			assert.ok(!validation.includes(option));
		}
		assert.ok(!regeneration.includes("--approve"));
		assert.ok(!regeneration.includes("--fix"));
	});

	it("accepts exact release declarations, never options or executable text", () => {
		assert.equal(parseCompilerVersion("v0.88.7\n"), "v0.88.7");
		for (const value of [
			"--help",
			"v1.2.3;whoami",
			"v1.2.3\nx",
			"v1.2.3\n\n",
			"v1.2.3-rc.1",
			"v01.2.3",
			"1.2.3",
			null,
		]) {
			assert.throws(() => parseCompilerVersion(value));
		}
	});

	it("checks the installed compiler identity exactly", () => {
		for (const channel of ["stdout", "stderr"])
			assert.doesNotThrow(() =>
				assertCompilerIdentity("v0.88.7", {
					status: 0,
					stdout: "",
					stderr: "",
					[channel]: "gh aw version v0.88.7\n",
				}),
			);
		for (const output of [
			"gh aw version v0.88.8",
			"gh aw version v0.88.70",
			"gh aw version v0.88.7-dev",
		]) {
			assert.throws(() =>
				assertCompilerIdentity("v0.88.7", {
					status: 0,
					stdout: "",
					stderr: output,
				}),
			);
		}
		for (const result of [
			{ status: 1, stdout: "", stderr: "gh aw version v0.88.7\n" },
			{ status: null, stdout: "", stderr: "gh aw version v0.88.7\n" },
			{
				status: 0,
				stdout: "warning: unexpected diagnostic\n",
				stderr: "gh aw version v0.88.7\n",
			},
			{ status: 0, stdout: "", stderr: "" },
		])
			assert.throws(() => assertCompilerIdentity("v0.88.7", result));
	});

	it("rejects numeric prereleases, drafts, mismatched releases, and downgrades", () => {
		assert.doesNotThrow(() =>
			assertPublishedRelease(release(), "v0.89.0", "v0.88.7"),
		);
		for (const data of [
			{ ...release(), prerelease: true },
			{ ...release(), draft: true },
			{ ...release(), tag_name: "v0.90.0" },
			{ ...release(), published_at: null },
		]) {
			assert.throws(() => assertPublishedRelease(data, "v0.89.0", "v0.88.7"));
		}
		assert.throws(() =>
			assertPublishedRelease(release(), "v0.89.0", "v0.90.0"),
		);
		assert.throws(() =>
			assertPublishedRelease(release(), "v0.89.0", "v0.89.0"),
		);
	});

	it("rejects all non-Renovate, fork, protected-branch, closed, held and draft PRs", () => {
		assert.equal(
			validatePullRequest(pullRequest(), "camunda/c8ctl").branch,
			"renovate/github-gh-aw-0.x",
		);
		for (const data of [
			{ ...pullRequest(), user: { login: "other", type: "Bot" } },
			{ ...pullRequest(), user: { login: "renovate[bot]", type: "User" } },
			{ ...pullRequest(), state: "closed" },
			{ ...pullRequest(), draft: true },
			{ ...pullRequest(), labels: [{ name: "agentic:hold" }] },
			{
				...pullRequest(),
				head: { ...pullRequest().head, repo: { full_name: "attacker/c8ctl" } },
			},
			...[
				"main",
				"release/1.0",
				"release-1.0",
				"refs/heads/sneaky",
				"renovate/../main",
			].map((ref) => ({
				...pullRequest(),
				head: { ...pullRequest().head, ref },
			})),
		])
			assert.throws(() => validatePullRequest(data, "camunda/c8ctl"));
	});

	it("accepts only complete, unique version/generated additions or modifications", () => {
		const version = { filename: ".github/gh-aw-version", status: "modified" };
		assert.doesNotThrow(() => validateChangedFiles([version], 1));
		for (const files of [
			[],
			[version, version],
			[{ ...version, status: "renamed", previous_filename: "secret" }],
			[{ ...version, status: "removed" }],
			[
				version,
				{
					filename: ".github/workflows/agentic-validate.yml",
					status: "modified",
				},
			],
			[
				version,
				{ filename: "scripts/agentic/maintenance.ts", status: "modified" },
			],
		])
			assert.throws(() => validateChangedFiles(files, files.length));
		assert.throws(() => validateChangedFiles([version], 2));
	});
});

describe("generated artifact boundaries", () => {
	it("rejects additional or unexpected downloaded artifact members", () => {
		assert.doesNotThrow(() => assertArtifactEntries(["regeneration.json"]));
		for (const files of [
			[],
			["payload.sh"],
			["regeneration.json", "payload.sh"],
			["regeneration.json", "regeneration.json"],
		]) {
			assert.throws(() => assertArtifactEntries(files));
		}
	});

	it("owns the observed action-pin manifest but no arbitrary aw configuration", () => {
		assert.ok(GENERATED_PATHS.includes(".github/aw/actions-lock.json"));
		assert.doesNotThrow(() =>
			parseRegeneration(
				{
					...artifact(),
					files: [
						{
							path: ".github/aw/actions-lock.json",
							content: Buffer.from("{}").toString("base64"),
						},
					],
				},
				expected,
			),
		);
		assert.throws(() =>
			parseRegeneration(
				{
					...artifact(),
					files: [
						{
							path: ".github/aw/aw.json",
							content: Buffer.from("{}").toString("base64"),
						},
					],
				},
				expected,
			),
		);
	});

	it("accepts bounded generated bytes and an explicit no-op", () => {
		assert.deepEqual(parseRegeneration(artifact(), expected), artifact());
		assert.deepEqual(
			parseRegeneration({ ...artifact(), files: [] }, expected).files,
			[],
		);
	});

	function fixture(
		options: {
			disabled?: boolean;
			heldOnRecheck?: boolean;
			headOnRecheck?: string;
			unchanged?: boolean;
			conflict?: boolean;
			extraFile?: boolean;
			prerelease?: boolean;
		} = {},
	) {
		const requests: string[] = [];
		const mutations: unknown[] = [];
		let reads = 0;
		const bytes = Buffer.from("name: Fitness\n");
		const blobSha = createHash("sha1")
			.update(`blob ${bytes.length}\0`)
			.update(bytes)
			.digest("hex");
		const github = {
			async request(method: string, path: string) {
				assert.equal(method, "GET");
				requests.push(path);
				if (path === "/repos/camunda/c8ctl/pulls/123") {
					reads++;
					return {
						...pullRequest(),
						changed_files: options.extraFile ? 2 : 1,
						head: {
							...pullRequest().head,
							sha:
								reads > 1 && options.headOnRecheck
									? options.headOnRecheck
									: sha,
						},
						labels:
							reads > 1 && options.heldOnRecheck
								? [{ name: "agentic:hold" }]
								: [],
					};
				}
				if (path.includes("/git/trees/"))
					return {
						truncated: false,
						tree: [
							{
								path: ".github/gh-aw-version",
								mode: "100644",
								type: "blob",
								sha,
							},
							{
								path: ".github/workflows/agentic-fitness.lock.yml",
								mode: "100644",
								type: "blob",
								sha: options.unchanged ? blobSha : sourceSha,
							},
						],
					};
				if (path.includes("/contents/"))
					return {
						type: "file",
						encoding: "base64",
						sha,
						content: Buffer.from("v0.89.0\n").toString("base64"),
					};
				if (path === "/repos/github/gh-aw/releases/latest")
					return { ...release(), prerelease: options.prerelease ?? false };
				if (path.includes("/actions/variables/"))
					return { value: options.disabled ? "false" : "true" };
				throw new Error(`Unexpected request ${path}`);
			},
			async list(path: string) {
				requests.push(path);
				assert.equal(path, "/repos/camunda/c8ctl/pulls/123/files");
				return [
					{ filename: ".github/gh-aw-version", status: "modified" },
					...(options.extraFile
						? [{ filename: "package.json", status: "modified" }]
						: []),
				];
			},
			async graphql(query: string, variables: Record<string, unknown>) {
				assert.match(query, /createCommitOnBranch/);
				mutations.push(variables);
				if (options.conflict)
					throw Object.assign(new Error("Head changed"), { status: 409 });
				return { createCommitOnBranch: { commit: { oid: "c".repeat(40) } } };
			},
		} satisfies MaintenanceGitHub;
		return { github, requests, mutations };
	}

	describe("trusted maintenance transaction", () => {
		it("prepares using API data without checking out or executing a candidate PR", async () => {
			const { github, requests, mutations } = fixture();
			const prepared = await prepareMaintenance({
				github,
				repository: expected.repository,
				number: 123,
				currentVersion: "v0.88.7",
			});
			assert.equal(prepared.version, expected.version);
			assert.equal(prepared.headSha, sha);
			assert.ok(requests.includes("/repos/github/gh-aw/releases/latest"));
			assert.equal(mutations.length, 0);
		});

		it("commits only generated base64 bytes with expected-head compare-and-swap", async () => {
			const { github, requests, mutations } = fixture();
			assert.equal(
				await applyRegeneration({
					github,
					value: artifact(),
					expected,
					currentVersion: "v0.88.7",
				}),
				"applied",
			);
			assert.deepEqual(mutations, [
				{
					input: {
						branch: {
							repositoryNameWithOwner: "camunda/c8ctl",
							branchName: "renovate/github-gh-aw-0.x",
						},
						expectedHeadOid: sha,
						message: {
							headline: "chore(agentic): regenerate workflows for v0.89.0",
							body: "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>",
						},
						fileChanges: {
							additions: artifact().files.map((file) => ({
								path: file.path,
								contents: file.content,
							})),
						},
					},
				},
			]);
			assert.ok(
				requests
					.slice(-2)
					.every((path) => path.includes("/actions/variables/")),
			);
			assert.equal(
				requests.filter((path) => path.endsWith("/pulls/123")).length,
				2,
			);
		});

		it("does not mutate when current generated bytes already match", async () => {
			const { github, mutations } = fixture({ unchanged: true });
			assert.equal(
				await applyRegeneration({
					github,
					value: artifact(),
					expected,
					currentVersion: "v0.88.7",
				}),
				"noop",
			);
			assert.equal(mutations.length, 0);
		});

		it("revalidates live switches, hold, current head, release metadata and full diff", async () => {
			for (const options of [
				{ disabled: true },
				{ heldOnRecheck: true },
				{ headOnRecheck: sourceSha },
				{ prerelease: true },
				{ extraFile: true },
			]) {
				const { github, mutations } = fixture(options);
				await assert.rejects(
					applyRegeneration({
						github,
						value: artifact(),
						expected,
						currentVersion: "v0.88.7",
					}),
				);
				assert.equal(mutations.length, 0);
			}
		});

		it("fails once on CAS conflict, never retrying or overwriting another head", async () => {
			const { github, mutations } = fixture({ conflict: true });
			await assert.rejects(
				applyRegeneration({
					github,
					value: artifact(),
					expected,
					currentVersion: "v0.88.7",
				}),
				/compare-and-swap|head changed/i,
			);
			assert.equal(mutations.length, 1);
		});
	});

	it("rejects unknown keys, identity drift, duplicate paths, traversal, and malformed base64", () => {
		for (const value of [
			{ ...artifact(), command: "anything" },
			{ ...artifact(), pull_request: 124 },
			{ ...artifact(), expected_head_sha: sourceSha },
			{ ...artifact(), source_sha: sha },
			{ ...artifact(), version: "v99.0.0" },
			{ ...artifact(), files: [...artifact().files, ...artifact().files] },
			{
				...artifact(),
				files: [{ path: ".github/workflows/../secrets.yml", content: "YQ==" }],
			},
			{ ...artifact(), files: [{ ...artifact().files[0], mode: "100755" }] },
			{
				...artifact(),
				files: [{ ...artifact().files[0], content: "%%%not-base64" }],
			},
			{
				...artifact(),
				files: [
					{
						...artifact().files[0],
						content: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64"),
					},
				],
			},
		])
			assert.throws(() => parseRegeneration(value, expected));
	});

	it("rejects non-regular generated files and truncated trees", () => {
		const tree = {
			truncated: false,
			tree: [
				{ path: ".github/gh-aw-version", mode: "100644", type: "blob", sha },
				{
					path: ".github/workflows/agentic-fitness.lock.yml",
					mode: "100644",
					type: "blob",
					sha,
				},
			],
		};
		assert.doesNotThrow(() => assertGeneratedTree(tree));
		assert.throws(() => assertGeneratedTree({ ...tree, truncated: true }));
		for (const mode of ["120000", "100755", "160000"]) {
			assert.throws(() =>
				assertGeneratedTree({
					...tree,
					tree: tree.tree.map((file) => ({ ...file, mode })),
				}),
			);
		}
		assert.throws(() =>
			assertGeneratedTree({
				...tree,
				tree: [
					...tree.tree,
					{ path: ".github/workflows", mode: "120000", type: "blob", sha },
				],
			}),
		);
	});

	it("detects missing, untracked and modified generated output, not only git diff", () => {
		const clean = {
			tracked: [...GENERATED_PATHS],
			existing: [...GENERATED_PATHS],
			changed: [],
			untracked: [],
		};
		assert.doesNotThrow(() => assertNoGeneratedDrift(clean));
		assert.throws(() => assertNoGeneratedDrift({ ...clean, tracked: [] }));
		assert.throws(() => assertNoGeneratedDrift({ ...clean, existing: [] }));
		assert.throws(() =>
			assertNoGeneratedDrift({ ...clean, changed: [GENERATED_PATHS[0]] }),
		);
		assert.throws(() =>
			assertNoGeneratedDrift({ ...clean, untracked: [GENERATED_PATHS[0]] }),
		);
	});

	it("rejects zero-exit warning summaries and JSON that omits safe-update diagnostics", () => {
		const clean = "✓ Compiled 5 workflows: 5 succeeded, 0 warnings\n";
		assert.doesNotThrow(() => assertCompileResult("", clean));
		assert.doesNotThrow(() =>
			assertCompileResult(`\u001b[32m${clean}\u001b[0m`, ""),
		);
		for (const output of [
			"✓ Compiled 5 workflows: 5 succeeded, 1 warning",
			"✓ Compiled 5 workflows: 4 succeeded, 0 warnings, 1 error",
			"✓ Compiled 4 workflows: 4 succeeded, 0 warnings",
			`${clean}${clean}`,
			`${clean}warning: new action requires approval`,
			`${clean}⚠ restricted secret needs review`,
			JSON.stringify([
				{
					workflow: "agentic-fitness.md",
					valid: true,
					errors: [],
					warnings: [],
				},
			]),
			"",
		])
			assert.throws(() => assertCompileResult(output, ""));
		assert.throws(() =>
			assertCompileResult(clean, "ERROR: failed policy check"),
		);
	});
});

describe("agentic dependency ownership", () => {
	it("pins official actions to immutable, release-labelled commits", () => {
		for (const path of [
			".github/workflows/agentic-maintenance.yml",
			".github/workflows/agentic-validate.yml",
		]) {
			const actions = [...read(path).matchAll(/uses: (.+)/g)];
			assert.ok(actions.length > 0);
			for (const [, reference] of actions) {
				assert.ok(reference);
				assert.match(
					reference,
					/^actions\/(?:checkout|setup-node|upload-artifact|download-artifact)@[a-f0-9]{40} # v\d+\.\d+\.\d+$/,
				);
			}
		}
	});

	it("validates imported shared worker Markdown changes", () => {
		assert.ok(
			read(".github/workflows/agentic-validate.yml").includes(
				".github/workflows/shared/agentic-*.md",
			),
		);
	});

	it("declares an exact stable-shaped compiler version in one file", () => {
		assert.match(read(".github/gh-aw-version"), /^v\d+\.\d+\.\d+\n$/);
	});

	it("uses release metadata daily without automatic dependency merges", () => {
		const config = JSON.parse(read(".github/renovate.json"));
		assert.equal(config.automerge, false);
		assert.ok(
			!config.packageRules.some(
				(rule: Record<string, unknown>) => rule.automerge === true,
			),
		);
		assert.ok(
			config.customManagers.some(
				(rule: Record<string, unknown>) =>
					rule.customType === "regex" &&
					rule.datasourceTemplate === "github-releases" &&
					rule.depNameTemplate === "github/gh-aw",
			),
		);
		const rule = config.packageRules.find(
			(rule: Record<string, unknown>) =>
				Array.isArray(rule.matchPackageNames) &&
				rule.matchPackageNames.includes("github/gh-aw"),
		);
		assert.equal(rule.ignoreUnstable, true);
		assert.deepEqual(rule.schedule, ["before 6am"]);
		assert.equal(rule.allowedVersions, undefined);
		assert.ok(
			config.packageRules.some(
				(rule: Record<string, unknown>) =>
					Array.isArray(rule.matchManagers) &&
					rule.matchManagers.includes("github-actions") &&
					Array.isArray(rule.matchFileNames) &&
					rule.matchFileNames.includes(".github/workflows/*.lock.yml") &&
					rule.enabled === false,
			),
		);
	});

	it("keeps validation read-only and unrelated to App or inference credentials", () => {
		const workflow = read(".github/workflows/agentic-validate.yml");
		assert.match(workflow, /pull_request:/);
		assert.match(workflow, /workflow_dispatch:/);
		assert.match(workflow, /contents: read/);
		assert.match(workflow, /node-version: ['"]?22/);
		assert.match(workflow, /maintenance\.ts check/);
		assert.doesNotMatch(
			workflow,
			/pull_request_target:|secrets\.|create-github-app-token|--approve|: write/,
		);
	});

	it("isolates candidate execution from the apply credential", () => {
		const workflow = read(".github/workflows/agentic-maintenance.yml");
		assert.match(workflow, /pull_request_target:/);
		assert.match(workflow, /C8CTL_AUTOMATION_ENABLED == 'true'/);
		assert.match(workflow, /C8CTL_DEPENDENCY_MAINTENANCE_ENABLED == 'true'/);
		const [beforeApply, apply] = workflow.split("\n  apply:\n");
		assert.ok(beforeApply && apply);
		assert.doesNotMatch(
			beforeApply,
			/secrets\.|create-github-app-token|app-token\.ts/,
		);
		assert.match(beforeApply, /maintenance\.ts prepare/);
		assert.match(beforeApply, /maintenance\.ts collect/);
		assert.match(
			apply,
			/artifact-ids: \$\{\{ needs\.compile\.outputs\.artifact_id \}\}/,
		);
		assert.doesNotMatch(apply, /create-github-app-token|permission-variables:/);
		assert.match(apply, /app-token\.ts create maintenance/);
		assert.match(
			apply,
			/C8CTL_APP_CLIENT_ID: \$\{\{ vars\.C8CTL_APP_CLIENT_ID \}\}/,
		);
		assert.match(
			apply,
			/C8CTL_APP_PRIVATE_KEY: \$\{\{ secrets\.C8CTL_APP_PRIVATE_KEY \}\}/,
		);
		assert.match(apply, /maintenance\.ts apply/);
		assert.match(apply, /always\(\) && steps\.app\.outputs\.token != ''/);
		assert.match(apply, /app-token\.ts revoke/);
		assert.ok(
			apply.indexOf("app-token.ts revoke") >
				apply.indexOf("maintenance.ts apply"),
		);
		assert.doesNotMatch(
			apply,
			/npm ci|gh aw |maintenance\.ts (?:install|collect|check)/,
		);
	});
});
