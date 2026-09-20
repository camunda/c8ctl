import assert from "node:assert/strict";
import { test } from "node:test";
import {
	GitHub,
	type GitHubClient,
	GitHubError,
	inspectCI,
	observeWorker,
	prepareCommit,
} from "../../scripts/agentic/github.ts";
import type { CISlot, Slot } from "../../scripts/agentic/state.ts";

test("transport rejects absolute and escaping endpoints before fetch", async () => {
	const github = new GitHub({
		token: "secret",
		fetch: async () => {
			throw new Error("must not fetch");
		},
	});
	for (const path of [
		"https://evil.example/path",
		"//evil.example/path",
		"/../x",
		"/repos/%2e%2e/x",
		"/repos\\evil",
		"/repos/x#fragment",
	])
		await assert.rejects(github.request("GET", path), /endpoint/);
});

test("pagination consumes every page, including API object collections", async () => {
	const pages: number[] = [];
	const github = new GitHub({
		token: "secret",
		fetch: async (url, init) => {
			const page = Number(new URL(String(url)).searchParams.get("page"));
			pages.push(page);
			assert.equal(
				new Headers(init?.headers).get("authorization"),
				"Bearer secret",
			);
			return Response.json({
				total_count: 101,
				workflow_runs:
					page === 1
						? Array.from({ length: 100 }, (_, id) => ({ id }))
						: [{ id: 100 }],
			});
		},
	});
	assert.equal(
		(await github.list("/repos/camunda/c8ctl/actions/runs", "workflow_runs"))
			.length,
		101,
	);
	assert.deepEqual(pages, [1, 2]);
});

test("errors never expose server or fetch messages and mutations are not retried", async () => {
	let calls = 0;
	const github = new GitHub({
		token: "very-secret",
		fetch: async () => {
			calls++;
			return new Response("very-secret", { status: 404 });
		},
	});
	await assert.rejects(
		github.request("POST", "/repos/a/b/issues", {}),
		(error: unknown) =>
			error instanceof GitHubError &&
			error.status === 404 &&
			!error.message.includes("very-secret"),
	);
	assert.equal(calls, 1);
	const throwing = new GitHub({
		token: "secret",
		fetch: async () => {
			throw new Error("secret");
		},
	});
	await assert.rejects(
		throwing.request("GET", "/repos/a/b"),
		/^Error: GitHub transport failed$/,
	);
});

test("artifact redirects do not forward credentials to signed storage URLs", async () => {
	const authorizations: (string | null)[] = [];
	const github = new GitHub({
		token: "secret",
		fetch: async (url, init) => {
			authorizations.push(new Headers(init?.headers).get("authorization"));
			if (String(url).startsWith("https://api.github.com/"))
				return new Response(null, {
					status: 302,
					headers: {
						location: "https://storage.example/report?signature=sensitive",
					},
				});
			return new Response("invalid zip");
		},
	});
	await assert.rejects(github.artifact("/repos/a/b/actions/artifacts/10/zip"));
	assert.deepEqual(authorizations, ["Bearer secret", null]);
});

test("GraphQL rejects partial errors instead of treating them as successful writes", async () => {
	const github = new GitHub({
		token: "secret",
		fetch: async () =>
			Response.json({ data: { node: {} }, errors: [{ message: "secret" }] }),
	});
	await assert.rejects(
		github.graphql("query { viewer { login } }", {}),
		/GraphQL operation failed/,
	);
});

function workerFixture() {
	const slot: Slot = {
		task: {
			version: 1,
			kind: "review-copilot",
			repository: "camunda/c8ctl",
			number: 12,
			generation: "0123456789abcdef",
			correlation: "b132a809-748e-44aa-a660-a3d527691c00",
			head_sha: "a".repeat(40),
			base_sha: "b".repeat(40),
			issue_revision: "",
			attempt: 0,
			state_comment_id: 8,
			instruction: "review",
		},
		run_id: null,
		run_attempt: null,
		artifact_id: null,
		dispatched_at: "2026-09-18T12:00:00.000Z",
	};
	const run = {
		id: 100,
		workflow_id: 10,
		path: ".github/workflows/agentic-review-copilot.lock.yml",
		display_title: `c8ctl-${slot.task.correlation}`,
		event: "workflow_dispatch",
		head_branch: "main",
		actor: { login: "c8ctl[bot]", type: "Bot" },
		run_attempt: 1,
		head_sha: "c".repeat(40),
		status: "completed",
		conclusion: "success",
	};
	const report = {
		schema_version: 1,
		repository: "camunda/c8ctl",
		task: slot.task,
		engine: "copilot",
		run_id: 100,
		run_attempt: 1,
		workflow_sha: run.head_sha,
		report: {
			schema_version: 1,
			status: "complete",
			findings: [],
			change_class: "patch",
			release_intent: "patch",
			merge_eligible: true,
			evidence: "Regression tests passed",
			blockers: [],
		},
	};
	const artifact = {
		id: 90,
		name: `worker-report-${slot.task.correlation}-1`,
		expired: false,
	};
	const github: GitHubClient = {
		request: async () => ({ id: 10, path: run.path }),
		list: async (path) => (path.includes("artifacts") ? [artifact] : [run]),
		graphql: async () => {
			throw new Error("unexpected mutation");
		},
		artifact: async () => report,
	};
	return { slot, run, report, artifact, github };
}

test("worker report provenance binds exact reserved task, workflow, run, actor and artifact", async () => {
	const fixture = workerFixture();
	const result = await observeWorker({
		github: fixture.github,
		repository: "camunda/c8ctl",
		appBotLogin: "c8ctl[bot]",
		slot: fixture.slot,
	});
	assert.equal(result.status, "completed");
	assert.equal(fixture.slot.run_id, 100);
	assert.equal(fixture.slot.artifact_id, 90);
	for (const change of [
		(f: ReturnType<typeof workerFixture>) => {
			f.run.actor.login = "github-actions[bot]";
		},
		(f: ReturnType<typeof workerFixture>) => {
			f.run.run_attempt = 2;
		},
		(f: ReturnType<typeof workerFixture>) => {
			f.run.head_branch = "attacker";
		},
		(f: ReturnType<typeof workerFixture>) => {
			f.run.path = ".github/workflows/evil.yml";
		},
		(f: ReturnType<typeof workerFixture>) => {
			f.report.task = { ...f.report.task, instruction: "substituted" };
		},
		(f: ReturnType<typeof workerFixture>) => {
			f.report.workflow_sha = "d".repeat(40);
		},
		(f: ReturnType<typeof workerFixture>) => {
			f.artifact.expired = true;
		},
	]) {
		const invalid = workerFixture();
		change(invalid);
		await assert.rejects(
			observeWorker({
				github: invalid.github,
				repository: "camunda/c8ctl",
				appBotLogin: "c8ctl[bot]",
				slot: invalid.slot,
			}),
		);
	}
});

test("reserved dispatch waits for discovery, duplicate run claims and missing outputs fail closed", async () => {
	const fixture = workerFixture();
	fixture.github.list = async () => [];
	assert.deepEqual(
		await observeWorker({
			github: fixture.github,
			repository: "camunda/c8ctl",
			appBotLogin: "c8ctl[bot]",
			slot: fixture.slot,
		}),
		{ status: "waiting" },
	);
	fixture.github.list = async () => [fixture.run, { ...fixture.run, id: 101 }];
	await assert.rejects(
		observeWorker({
			github: fixture.github,
			repository: "camunda/c8ctl",
			appBotLogin: "c8ctl[bot]",
			slot: fixture.slot,
		}),
		/duplicate|multiple/i,
	);
	fixture.github.list = async (path) =>
		path.includes("artifacts") ? [] : [fixture.run];
	await assert.rejects(
		observeWorker({
			github: fixture.github,
			repository: "camunda/c8ctl",
			appBotLogin: "c8ctl[bot]",
			slot: fixture.slot,
		}),
		/artifact/,
	);
});

const jobNames = [
	"Lint",
	"Typecheck",
	...[22, 24].flatMap((node) =>
		["ubuntu-latest", "macos-latest", "windows-latest"].map(
			(os) => `Unit Test (Node ${node} / ${os})`,
		),
	),
	...[22, 24].flatMap((node) =>
		["8.8", "8.9", "8.10"].map(
			(camunda) =>
				`Integration Test (Node ${node} / Camunda ${camunda} / ubuntu-latest)`,
		),
	),
];

test("CI requires an App-reserved immutable receipt and every original matrix job", async () => {
	const headSha = "a".repeat(40),
		baseSha = "b".repeat(40);
	const ci: CISlot = {
		task: {
			version: 1,
			repository: "camunda/c8ctl",
			number: 12,
			generation: "generation-0000000000",
			correlation: "b132a809-748e-44aa-a660-a3d527691c00",
			head_sha: headSha,
			base_sha: baseSha,
			merge_sha: "c".repeat(40),
			state_comment_id: 8,
			attempt: 0,
		},
		run_id: null,
		run_attempt: null,
		artifact_id: null,
		dispatched_at: "2026-09-18T12:00:00.000Z",
	};
	const run = {
		id: 100,
		workflow_id: 10,
		name: "Test",
		path: ".github/workflows/test.yml",
		event: "workflow_dispatch",
		display_title: `c8ctl-ci-${ci.task.correlation}`,
		head_branch: "main",
		actor: { login: "c8ctl[bot]", type: "Bot" },
		head_sha: baseSha,
		run_attempt: 1,
		status: "completed",
		conclusion: "success",
		html_url: "https://github.com/camunda/c8ctl/actions/runs/100",
		pull_requests: [],
	};
	const names = [...jobNames, "Agentic CI Revision", "Agentic CI Receipt"];
	let jobs = names.map((name) => ({
		name,
		status: "completed",
		conclusion: "success",
	}));
	const receipt = {
		schema_version: 1,
		repository: "camunda/c8ctl",
		task: ci.task,
		run_id: 100,
		run_attempt: 1,
		workflow_sha: baseSha,
		tested_sha: ci.task.merge_sha,
		jobs: {
			lint: "success",
			typecheck: "success",
			unit: "success",
			integration: "success",
		},
	};
	let duplicate = false;
	const github: GitHubClient = {
		request: async (_method, path) =>
			path.includes("/commits/")
				? {
						sha: ci.task.merge_sha,
						parents: [{ sha: baseSha }, { sha: headSha }],
					}
				: { id: 10, path: ".github/workflows/test.yml" },
		list: async (path) =>
			path.includes("jobs")
				? jobs
				: path.includes("artifacts")
					? [
							{
								id: 7,
								name: `ci-report-${ci.task.correlation}-1`,
								expired: false,
								workflow_run: { id: 100, head_sha: baseSha },
							},
						]
					: duplicate
						? [run, { ...run, id: 101 }]
						: [run],
		graphql: async () => ({}),
		artifact: async () => receipt,
	};
	const options = {
		github,
		repository: "camunda/c8ctl",
		number: 12,
		headSha,
		baseSha,
		mergeSha: ci.task.merge_sha,
		appBotLogin: "c8ctl[bot]",
		ci,
	};
	assert.equal((await inspectCI({ ...options, ci: null })).status, "pending");
	assert.equal((await inspectCI(options)).status, "success");
	assert.equal(ci.artifact_id, 7);
	assert.equal(ci.run_id, 100);
	jobs = jobs.slice(1);
	assert.equal((await inspectCI(options)).status, "blocked");
	jobs = names.map((name) => ({
		name,
		status: "completed",
		conclusion: name === "Lint" ? "skipped" : "success",
	}));
	assert.equal((await inspectCI(options)).status, "blocked");
	jobs = names.map((name) => ({
		name,
		status: "completed",
		conclusion: "success",
	}));
	for (const mutation of [
		{ event: "pull_request" },
		{ head_sha: headSha },
		{ run_attempt: 2 },
		{ actor: { login: "human", type: "User" } },
		{ workflow_id: 11 },
		{ head_branch: "other" },
		{ path: ".github/workflows/untrusted.yml" },
	]) {
		const original = { ...run };
		Object.assign(run, mutation);
		assert.equal((await inspectCI(options)).status, "blocked");
		Object.assign(run, original);
	}
	duplicate = true;
	assert.equal((await inspectCI(options)).status, "blocked");
	duplicate = false;
	receipt.tested_sha = headSha;
	assert.equal((await inspectCI(options)).status, "blocked");
	receipt.tested_sha = ci.task.merge_sha;
	jobs = names.map((name) => ({
		name,
		status: "completed",
		conclusion: name === "Lint" ? "failure" : "success",
	}));
	run.conclusion = "failure";
	receipt.jobs.lint = "failure";
	assert.equal((await inspectCI(options)).status, "failure");
	for (const job of jobs)
		if (job.name.startsWith("Unit Test")) job.conclusion = "skipped";
	receipt.jobs.unit = "skipped";
	assert.equal((await inspectCI(options)).status, "failure");
	receipt.jobs.lint = "success";
	assert.equal((await inspectCI(options)).status, "blocked");
});

test("worker discovery tolerates GitHub's second-resolution creation timestamp", async () => {
	const f = workerFixture();
	f.slot.dispatched_at = "2026-09-18T12:00:00.999Z";
	const list = f.github.list;
	f.github.list = async (path, key) => {
		if (path.includes("/runs?")) {
			const filter = new URL(`https://api.github.com${path}`).searchParams.get(
				"created",
			);
			assert.ok(filter);
			assert.ok(
				Date.parse(filter.slice(2)) <= Date.parse("2026-09-18T12:00:00.000Z"),
			);
		}
		return list(path, key);
	};
	await observeWorker({
		github: f.github,
		repository: "camunda/c8ctl",
		appBotLogin: "c8ctl[bot]",
		slot: f.slot,
	});
});

test("commit preparation compares only touched blobs and refuses incomplete or unsafe trees", async () => {
	const requested: string[] = [];
	const tree = {
		truncated: false,
		tree: [
			{ path: "src", mode: "040000", type: "tree", sha: "a".repeat(40) },
			{
				path: "src/example.ts",
				mode: "100644",
				type: "blob",
				sha: "b".repeat(40),
			},
			{
				path: "src/untouched.ts",
				mode: "100644",
				type: "blob",
				sha: "c".repeat(40),
			},
		],
	};
	const github: GitHubClient = {
		request: async (_method, path) => {
			requested.push(path);
			return path.includes("/trees/")
				? tree
				: {
						encoding: "base64",
						content: Buffer.from("old").toString("base64"),
					};
		},
		list: async () => [],
		graphql: async () => {
			throw new Error("Not a writer");
		},
		artifact: async () => null,
	};
	const input = {
		github,
		repository: "camunda/c8ctl",
		branch: "fix/example",
		expectedHeadOid: "a".repeat(40),
		reimplementation: true,
		report: {
			schema_version: 1,
			status: "complete",
			title: "fix: repair bug",
			summary: "Repair bug",
			evidence: "Regression test",
			blockers: [],
			files: [{ path: "src/example.ts", content: "new" }],
		} as const,
	};
	const commit = await prepareCommit(input);
	assert.equal(commit.expectedHeadOid, input.expectedHeadOid);
	assert.equal(
		commit.message.headline,
		"chore(gh-aw): address review feedback",
	);
	assert.equal(requested.filter((path) => path.includes("/blobs/")).length, 1);
	assert.ok(requested.some((path) => path.endsWith("b".repeat(40))));
	tree.truncated = true;
	await assert.rejects(prepareCommit(input), /truncated/);
	tree.truncated = false;
	tree.tree[0] = {
		path: "src",
		mode: "120000",
		type: "blob",
		sha: "a".repeat(40),
	};
	await assert.rejects(prepareCommit(input), /ancestor/);
});
