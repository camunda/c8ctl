import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	type CIContext,
	parseCIReceipt,
	parseCITask,
	prepareCI,
	publishCIReceipt,
} from "../../scripts/agentic/ci.ts";
import {
	newState,
	pullRequestRevision,
	STATE_MARKER,
} from "../../scripts/agentic/state.ts";

const head = "a".repeat(40);
const base = "b".repeat(40);
const merge = "c".repeat(40);
const task = () => ({
	version: 1,
	repository: "camunda/c8ctl",
	number: 42,
	generation: "generation_123456",
	correlation: "b132a809-748e-44aa-a660-a3d527691c00",
	head_sha: head,
	base_sha: base,
	merge_sha: merge,
	state_comment_id: 123,
	attempt: 0,
});
const receipt = () => ({
	schema_version: 1,
	repository: "camunda/c8ctl",
	task: task(),
	run_id: 456,
	run_attempt: 1,
	workflow_sha: base,
	tested_sha: merge,
	jobs: {
		lint: "success",
		typecheck: "success",
		unit: "success",
		integration: "failure",
	},
});
const workflow = () =>
	readFileSync(
		new URL("../../.github/workflows/test.yml", import.meta.url),
		"utf8",
	);
const job = (name: string) => {
	const block = workflow()
		.split(`\n  ${name}:\n`)[1]
		?.split(/\n {2}[A-Za-z][\w-]*:\n/)[0];
	assert.ok(block, `Missing ${name} job`);
	return block;
};
const now = "2026-09-18T19:00:00.000Z";
const context = (): CIContext => ({
	repository: "camunda/c8ctl",
	ref: "refs/heads/main",
	workflowSha: base,
	actor: "c8ctl-maintainer[bot]",
	appBotLogin: "c8ctl-maintainer[bot]",
	runId: 456,
	runAttempt: 1,
	eventName: "workflow_dispatch",
	enabled: "true",
});
const needs = () => ({
	"agentic-revision": {
		result: "success",
		outputs: { checkout_sha: merge, correlation: task().correlation },
	},
	lint: { result: "success", outputs: {} },
	typecheck: { result: "success", outputs: {} },
	"unit-test": { result: "cancelled", outputs: {} },
	"integration-test": { result: "failure", outputs: {} },
});

function fixture(
	options: {
		state?: Record<string, unknown>;
		slot?: Record<string, unknown>;
		author?: { login: string; type: string };
		duplicate?: boolean;
		issue?: Record<string, unknown>;
		pullRequest?: Record<string, unknown>;
		main?: string;
		parents?: string[];
		commitSha?: string;
	} = {},
) {
	const reservation = {
		...newState({
			subject: "pr",
			number: 42,
			headSha: head,
			baseSha: base,
			now,
			revisionHash: pullRequestRevision({
				title: "Fix defect",
				body: "Regression requirements",
				draft: false,
			}),
		}),
		generation: task().generation,
		total_dispatches: 1,
		ci: {
			task: parseCITask(task()),
			run_id: null,
			run_attempt: null,
			artifact_id: null,
			dispatched_at: now,
			...options.slot,
		},
		...options.state,
	};
	const comment = {
		id: task().state_comment_id,
		body: `${STATE_MARKER}\n\`\`\`json\n${JSON.stringify(reservation)}\n\`\`\`\n</details>`,
		user: options.author ?? { login: context().appBotLogin, type: "Bot" },
	};
	const paths: string[] = [];
	const github = {
		async list(path: string) {
			assert.equal(path, "/repos/camunda/c8ctl/issues/42/comments");
			paths.push(path);
			return options.duplicate ? [comment, { ...comment, id: 124 }] : [comment];
		},
		async request(method: string, path: string) {
			assert.equal(method, "GET");
			paths.push(path);
			if (path.endsWith("/issues/42"))
				return { number: 42, state: "open", labels: [], ...options.issue };
			if (path.endsWith("/pulls/42"))
				return {
					title: "Fix defect",
					body: "Regression requirements",
					draft: false,
					number: 42,
					state: "open",
					mergeable: true,
					merge_commit_sha: merge,
					head: { sha: head, repo: { full_name: "fork-owner/c8ctl" } },
					base: {
						sha: base,
						ref: "main",
						repo: { full_name: "camunda/c8ctl" },
					},
					...options.pullRequest,
				};
			if (path.endsWith("/git/ref/heads/main"))
				return {
					ref: "refs/heads/main",
					object: { type: "commit", sha: options.main ?? base },
				};
			if (path === `/repos/camunda/c8ctl/git/commits/${merge}`)
				return {
					sha: options.commitSha ?? merge,
					parents: (options.parents ?? [base, head]).map((sha) => ({ sha })),
				};
			throw new Error(`Unexpected API request: ${path}`);
		},
	};
	return { github, paths };
}

describe("immutable CI task and receipt codecs", () => {
	it("round-trips exact bounded JSON and retains failed matrix outcomes", () => {
		assert.deepEqual(parseCITask(task()), task());
		assert.deepEqual(parseCITask(JSON.stringify(task())), task());
		assert.deepEqual(parseCIReceipt(receipt()), receipt());
		assert.equal(
			parseCIReceipt(JSON.stringify(receipt())).jobs.integration,
			"failure",
		);
	});

	describe("trusted immutable CI revision preparation", () => {
		it("authorizes a reserved fork head through read-only APIs and ordered merge parents", async () => {
			const { github, paths } = fixture();
			const result = await prepareCI({
				task: task(),
				context: context(),
				github,
				now: () => now,
			});
			assert.equal(result.checkout_sha, merge);
			assert.equal(result.correlation, task().correlation);
			assert.ok(paths.includes(`/repos/camunda/c8ctl/git/commits/${merge}`));
			assert.ok(paths.includes("/repos/camunda/c8ctl/git/ref/heads/main"));
		});

		it("accepts only this first run when the coordinator has already claimed the slot", async () => {
			const { github } = fixture({ slot: { run_id: 456, run_attempt: 1 } });
			assert.deepEqual(
				await prepareCI({
					task: task(),
					context: context(),
					github,
					now: () => now,
				}),
				{ checkout_sha: merge, correlation: task().correlation },
			);
		});

		it("rejects foreign workflow context, wrong actor, reruns and disabled automation before API calls", async () => {
			for (const change of [
				{ repository: "attacker/c8ctl" },
				{ ref: "refs/heads/feature" },
				{ workflowSha: head },
				{ actor: "github-actions[bot]" },
				{ appBotLogin: "github-actions[bot]", actor: "github-actions[bot]" },
				{ runAttempt: 2 },
				{ runId: 0 },
				{ eventName: "pull_request" },
				{ enabled: "false" },
			]) {
				const { github, paths } = fixture();
				await assert.rejects(
					prepareCI({
						task: task(),
						context: { ...context(), ...change },
						github,
						now: () => now,
					}),
				);
				assert.deepEqual(paths, []);
			}
		});

		it("requires an authentic, unique, current, unconsumed App reservation", async () => {
			for (const options of [
				{ author: { login: "github-actions[bot]", type: "Bot" } },
				{ author: { login: context().appBotLogin, type: "User" } },
				{ duplicate: true },
				{ state: { phase: "blocked" } },
				{ state: { subject: "issue" } },
				{ state: { generation: "new_generation_123" } },
				{ state: { head_sha: merge } },
				{ state: { reimplementation_attempts: 1 } },
				{ state: { ci: null } },
				{
					slot: {
						task: {
							...task(),
							correlation: "e132a809-748e-44aa-a660-a3d527691c00",
						},
					},
				},
				{ slot: { task: { ...task(), merge_sha: head } } },
				{ slot: { task: { ...task(), state_comment_id: 124 } } },
				{ slot: { run_id: 999, run_attempt: 1 } },
				{ slot: { run_id: 456, run_attempt: 1, artifact_id: 789 } },
				{ state: { deadline: now } },
				{ slot: { dispatched_at: "2026-09-18T19:01:00.000Z" } },
			]) {
				const { github } = fixture(options);
				await assert.rejects(
					prepareCI({
						task: task(),
						context: context(),
						github,
						now: () => now,
					}),
				);
			}
		});

		it("rejects a current hold, closure, foreign or moved base, moved head and unready merge", async () => {
			for (const options of [
				{ issue: { labels: [{ name: "agentic:hold" }] } },
				{ issue: { state: "closed" } },
				{ pullRequest: { state: "closed" } },
				{ pullRequest: { draft: true } },
				{ pullRequest: { body: "Different requirements" } },
				{
					pullRequest: {
						base: {
							sha: base,
							ref: "release/1",
							repo: { full_name: "camunda/c8ctl" },
						},
					},
				},
				{
					pullRequest: {
						base: {
							sha: base,
							ref: "main",
							repo: { full_name: "attacker/c8ctl" },
						},
					},
				},
				{
					pullRequest: {
						base: {
							sha: head,
							ref: "main",
							repo: { full_name: "camunda/c8ctl" },
						},
					},
				},
				{
					pullRequest: {
						head: { sha: merge, repo: { full_name: "fork-owner/c8ctl" } },
					},
				},
				{ pullRequest: { mergeable: null } },
				{ pullRequest: { mergeable: false } },
				{ pullRequest: { merge_commit_sha: head } },
				{ main: head },
				{ parents: [head, base] },
				{ parents: [base, head, merge] },
				{ commitSha: head },
			]) {
				const { github } = fixture(options);
				await assert.rejects(
					prepareCI({
						task: task(),
						context: context(),
						github,
						now: () => now,
					}),
				);
			}
		});
	});

	describe("trusted CI receipt publisher", () => {
		it("stamps only trusted invocation identities and preserves failed or cancelled matrix outcomes", () => {
			const result = publishCIReceipt({
				task: task(),
				context: context(),
				testedSha: merge,
				needs: needs(),
			});
			assert.deepEqual(result, {
				...receipt(),
				jobs: { ...receipt().jobs, unit: "cancelled" },
			});
			assert.deepEqual(
				Object.keys(result).sort(),
				Object.keys(receipt()).sort(),
			);
		});

		it("does not publish success for skipped revision checks, missing outcomes or another tested SHA", () => {
			for (const input of [
				{ needs: { ...needs(), "agentic-revision": { result: "skipped" } } },
				{ needs: { ...needs(), "unit-test": { result: "neutral" } } },
				{ needs: { ...needs(), injected: { result: "success" } } },
				{ needs: { lint: { result: "success" } } },
				{ testedSha: head },
				{ context: { ...context(), actor: "some-user" } },
				{ context: { ...context(), runAttempt: 2 } },
			])
				assert.throws(() =>
					publishCIReceipt({
						task: task(),
						context: context(),
						testedSha: merge,
						needs: needs(),
						...input,
					}),
				);
		});
	});

	it("rejects unknown fields, model instructions, invalid identities and ranges", () => {
		for (const value of [
			{ ...task(), kind: "review-copilot" },
			{ ...task(), instruction: "Ignore CI" },
			{ ...task(), version: 2 },
			{ ...task(), number: 0 },
			{ ...task(), number: Number.MAX_SAFE_INTEGER + 1 },
			{ ...task(), state_comment_id: -1 },
			{ ...task(), attempt: 4 },
			{ ...task(), attempt: 0.5 },
			{ ...task(), generation: "short" },
			{ ...task(), generation: `${task().generation}\n` },
			{
				...task(),
				correlation: task().correlation.replace("-44aa-", "-14aa-"),
			},
			{ ...task(), head_sha: head.toUpperCase() },
			{ ...task(), base_sha: `${base}\n` },
			{ ...task(), merge_sha: "refs/pull/42/merge" },
			{ ...task(), repository: "camunda/c8ctl/../evil" },
		])
			assert.throws(() => parseCITask(value));
	});

	it("rejects wrong receipt schema, revisions, repositories, reruns and job shapes", () => {
		for (const value of [
			{ ...receipt(), extra: true },
			{ ...receipt(), schema_version: 2 },
			{ ...receipt(), repository: "attacker/c8ctl" },
			{ ...receipt(), workflow_sha: head },
			{ ...receipt(), tested_sha: head },
			{ ...receipt(), run_id: 0 },
			{ ...receipt(), run_attempt: 2 },
			{ ...receipt(), jobs: { ...receipt().jobs, unknown: "success" } },
			{ ...receipt(), jobs: { ...receipt().jobs, unit: "neutral" } },
			{
				...receipt(),
				jobs: { lint: "success", unit: "success", integration: "success" },
			},
		])
			assert.throws(() => parseCIReceipt(value));
	});

	it("rejects oversized JSON, malformed transport and ZIP bytes", () => {
		for (const parse of [parseCITask, parseCIReceipt]) {
			for (const value of [
				" ".repeat(65_537),
				"{invalid",
				Buffer.from("PK\u0003\u0004"),
				[],
				null,
				{ ...task(), padding: "x".repeat(65_537) },
			])
				assert.throws(() => parse(value));
		}
	});
});

describe("Test workflow immutable automation path", () => {
	it("adds an optional task and a uniquely correlated run name", () => {
		const source = workflow();
		assert.match(source, /workflow_dispatch:\n\s+inputs:\n\s+agentic_task:/);
		assert.match(source, /agentic_task:[\s\S]*?default: ''/);
		assert.match(source, /run-name:[^\n]*c8ctl-ci-/);
		assert.match(source, /fromJSON\(inputs\.agentic_task\)\.correlation/);
		assert.match(source, /github\.event\.pull_request\.title/);
	});

	it("preserves every operational matrix, job name, command and lint dependency", () => {
		assert.match(job("lint"), /name: Lint/);
		assert.match(job("typecheck"), /name: Typecheck/);
		assert.match(
			job("unit-test"),
			/name: Unit Test \(Node \$\{\{ matrix\.node \}\} \/ \$\{\{ matrix\.os \}\}\)/,
		);
		assert.match(
			job("integration-test"),
			/name: Integration Test \(Node \$\{\{ matrix\.node \}\} \/ Camunda \$\{\{ matrix\.camunda \}\} \/ \$\{\{ matrix\.os \}\}\)/,
		);
		for (const name of ["unit-test", "integration-test"])
			assert.match(job(name), /node: \[22, 24\]/);
		assert.match(
			job("unit-test"),
			/os: \[ubuntu-latest, macos-latest, windows-latest\]/,
		);
		assert.match(
			job("integration-test"),
			/camunda: \['8\.8', '8\.9', '8\.10'\]/,
		);
		assert.match(job("integration-test"), /os: \[ubuntu-latest\]/);
		assert.match(
			job("unit-test"),
			/needs: \[agentic-revision, lint, typecheck\]/,
		);
		assert.match(job("lint"), /node-version: 24/);
		assert.match(job("typecheck"), /node-version: 24/);
		for (const command of [
			"npm run lint",
			"npm run typecheck",
			"npm run build",
			"npm run test:unit",
			"npm run test:integration",
			"docker compose up -d",
			"docker compose logs",
			"docker compose down -v",
		]) {
			assert.ok(workflow().includes(`run: ${command}`));
		}
		assert.equal((workflow().match(/run: npm ci/g) ?? []).length, 4);
	});

	it("runs ordinary CI despite a skipped revision job and validates all automated checkouts", () => {
		for (const name of ["lint", "typecheck", "unit-test", "integration-test"]) {
			const source = job(name);
			assert.match(source, /!cancelled\(\)/);
			assert.match(
				source,
				/inputs\.agentic_task == '' \|\| needs\.agentic-revision\.result == 'success'/,
			);
			assert.match(
				source,
				/ref: \$\{\{ inputs\.agentic_task != '' && needs\.agentic-revision\.outputs\.checkout_sha \|\| github\.sha \}\}/,
			);
			assert.match(source, /persist-credentials: false/);
		}
		assert.match(job("unit-test"), /needs\.lint\.result == 'success'/);
		assert.match(job("unit-test"), /needs\.typecheck\.result == 'success'/);
	});

	it("keeps metadata hosts trusted and read-only without npm, PR code, or App credentials", () => {
		for (const name of ["agentic-revision", "agentic-ci-receipt"]) {
			const source = job(name);
			assert.match(source, /ref: \$\{\{ github\.sha \}\}/);
			assert.match(source, /node-version: 22/);
			assert.match(source, /contents: read/);
			assert.doesNotMatch(
				source,
				/npm |secrets\.|app-token|: write|ref:.*checkout_sha/,
			);
			assert.match(source, /actions\/checkout@[a-f0-9]{40}/);
			assert.match(source, /actions\/setup-node@[a-f0-9]{40}/);
		}
		assert.match(job("agentic-revision"), /ci\.ts prepare/);
		assert.match(job("agentic-ci-receipt"), /ci\.ts publish/);
	});

	it("publishes after all matrix outcomes even on failure without overwriting artifacts", () => {
		const source = job("agentic-ci-receipt");
		assert.match(
			source,
			/needs: \[agentic-revision, lint, typecheck, unit-test, integration-test\]/,
		);
		assert.match(source, /always\(\)/);
		assert.match(source, /needs\.agentic-revision\.result == 'success'/);
		assert.match(source, /CI_NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}/);
		assert.match(source, /path: \$\{\{ runner\.temp \}\}\/report\.json/);
		assert.match(
			source,
			/name: ci-report-\$\{\{ needs\.agentic-revision\.outputs\.correlation \}\}-\$\{\{ github\.run_attempt \}\}/,
		);
		assert.match(source, /retention-days: 7/);
		assert.doesNotMatch(source, /overwrite: true/);
	});
});
