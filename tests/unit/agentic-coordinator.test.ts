import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type CITask, parseCITask } from "../../scripts/agentic/ci.ts";
import {
	parseWorkerTask,
	type WorkerTask,
} from "../../scripts/agentic/contracts.ts";
import {
	automationSwitches,
	coordinatorFailureReason,
	eventRequest,
	reconcile,
} from "../../scripts/agentic/coordinator.ts";
import {
	array,
	type GitHubClient,
	GitHubError,
	object,
	string,
} from "../../scripts/agentic/github.ts";
import { mergePullRequest } from "../../scripts/agentic/merge.ts";
import {
	findState,
	renderState,
	type State,
} from "../../scripts/agentic/state.ts";

const repository = "camunda/c8ctl",
	appBotLogin = "c8ctl[bot]";
const now = "2026-09-18T12:00:00.000Z";
const head = "a".repeat(40);
const options = {
	repository,
	appBotLogin,
	enabled: true,
	autoMerge: false,
	since: "2026-09-01T00:00:00.000Z",
	now,
	number: 42,
};
const cleanReview = {
	schema_version: 1,
	status: "complete",
	findings: [],
	change_class: "patch",
	release_intent: "patch",
	merge_eligible: true,
	evidence: "Reproduced defect. New and existing tests pass.",
	blockers: [],
};
const readyFitness = {
	schema_version: 1,
	decision: "ready",
	criteria: ["Correct the bounded defect with a regression test"],
	evidence: "Bug exists on main",
	blockers: [],
	related_prs: [],
};
const change = {
	schema_version: 1,
	status: "complete",
	title: "fix: repair a bounded defect",
	summary: "Restore the expected behavior",
	evidence: "Regression test failed before and passed after",
	blockers: [],
	files: [
		{
			path: "src/commands/example.ts",
			content: "export const fixed = true;\n",
		},
	],
};

test("only trusted workflow_dispatch command resume requests a maintainer budget reset", () => {
	assert.deepEqual(
		eventRequest({
			event: { inputs: { command: "resume", number: "42" } },
			eventName: "workflow_dispatch",
			actor: "maintainer",
		}),
		{ number: 42, resumeActor: "maintainer" },
	);
	assert.deepEqual(
		eventRequest({
			event: {
				issue: { number: 42 },
				inputs: { command: "resume", number: "999" },
			},
			eventName: "issue_comment",
			actor: "external",
		}),
		{ number: 42, resumeActor: undefined },
	);
	assert.deepEqual(
		eventRequest({
			event: { inputs: { command: "reconcile", number: "" } },
			eventName: "workflow_dispatch",
			actor: "maintainer",
		}),
		{ number: undefined, resumeActor: undefined },
	);
	assert.throws(
		() =>
			eventRequest({
				event: { inputs: { command: "resume", number: "" } },
				eventName: "workflow_dispatch",
				actor: "maintainer",
			}),
		/number/,
	);
	assert.throws(
		() =>
			eventRequest({
				event: { inputs: { command: "delete", number: "42" } },
				eventName: "workflow_dispatch",
				actor: "maintainer",
			}),
		/command/,
	);
});

test("real merge gate refuses absent branch protection without merge or policy mutation", async () => {
	const f = fixture("pr");
	const current = new Date().toISOString();
	const request = f.github.request;
	f.github.request = async (method, path, body) => {
		if (path.endsWith("/actions/variables/C8CTL_AUTO_MERGE_ENABLED"))
			return { name: "C8CTL_AUTO_MERGE_ENABLED", value: "true" };
		if (path.endsWith("/branches/main/protection")) throw new GitHubError(404);
		return request(method, path, body);
	};
	await reconcile({ ...options, github: f.github, now: current });
	for (const kind of ["review-copilot", "review-claude"] as const)
		f.complete(kind, cleanReview);
	await reconcile({
		...options,
		github: f.github,
		now: current,
		autoMerge: true,
		merge: mergePullRequest,
	});
	assert.equal(f.state().phase, "human");
	assert.match(f.state().outcome, /protection|protected/i);
	assert.equal(
		f.mutations.some(
			(item) =>
				item.path.endsWith("/merge") ||
				item.method === "GRAPHQL" ||
				item.path.includes("/protection"),
		),
		false,
	);
});

test("fork execution-policy changes never become an App-authored same-repository PR", async () => {
	for (const filename of [
		".github/workflows/test.yml",
		".github/actions/token/action.yml",
		"scripts/agentic/coordinator.ts",
		"package.json",
	]) {
		const f = fixture("pr");
		object(f.pr.head).repo = { full_name: "contributor/c8ctl" };
		const list = f.github.list;
		f.github.list = async (path, key) =>
			path.endsWith("/pulls/42/files")
				? [{ filename, status: "modified" }]
				: list(path, key);
		await reconcile({ ...options, github: f.github });
		for (const kind of ["review-copilot", "review-claude"] as const)
			f.complete(kind, {
				...cleanReview,
				merge_eligible: false,
				findings: [
					{
						severity: "high",
						path: "src/commands/example.ts",
						line: 1,
						title: "Bug",
						body: "Fix the bounded defect",
					},
				],
			});
		await reconcile({ ...options, github: f.github });
		f.complete("reimplement", change);
		await reconcile({ ...options, github: f.github });
		assert.equal(f.state().phase, "blocked");
		assert.match(f.state().outcome, /protected|policy/i);
		assert.equal(
			f.mutations.some(
				(item) =>
					item.path.endsWith("/git/refs") ||
					item.path.endsWith("/pulls") ||
					item.method === "GRAPHQL",
			),
			false,
		);
	}
});

test("App aggregate status is pending until both reviews and CI are clean, and never overwrites existing CI contexts", async () => {
	const f = fixture("pr");
	await reconcile({ ...options, github: f.github });
	assert.equal(f.statuses.at(-1)?.state, "pending");
	assert.equal(f.statuses.at(-1)?.sha, head);
	const before = f.statuses.length;
	await reconcile({ ...options, github: f.github });
	assert.equal(f.statuses.length, before);
	f.complete("review-copilot", cleanReview);
	await reconcile({ ...options, github: f.github });
	assert.equal(f.statuses.at(-1)?.state, "pending");
	f.complete("review-claude", cleanReview);
	await reconcile({ ...options, github: f.github });
	assert.equal(f.statuses.at(-1)?.state, "success");
	assert.ok(f.statuses.every((status) => status.context === "c8ctl/agentic"));
	assert.match(string(f.statuses.at(-1)?.description), /merge policy/i);
	assert.match(
		string(f.statuses.at(-1)?.target_url),
		/pull\/42#issuecomment-8$/,
	);
});

test("clean manual-only classifications publish successful evidence without authorizing merge", async () => {
	for (const [copilot, claude] of [
		[
			{
				...cleanReview,
				change_class: "other",
				release_intent: "none",
				merge_eligible: false,
				evidence: "Protected workflow policy requires a human merge",
			},
			{
				...cleanReview,
				change_class: "other",
				release_intent: "none",
				merge_eligible: false,
			},
		],
		[{ ...cleanReview, merge_eligible: false }, cleanReview],
		[
			cleanReview,
			{
				...cleanReview,
				change_class: "additive-minor",
				release_intent: "minor",
			},
		],
	]) {
		const f = fixture("pr");
		let merges = 0,
			authenticatedSuccess = false;
		const github: GitHubClient = {
			...f.github,
			async request(method, path, body) {
				if (
					method === "POST" &&
					path.includes("/statuses/") &&
					object(body).state === "success"
				) {
					assert.equal(f.state().phase, "human");
					for (const kind of ["review-copilot", "review-claude"] as const) {
						assert.ok(f.state().slots[kind]?.run_id);
						assert.ok(f.state().slots[kind]?.artifact_id);
					}
					authenticatedSuccess = true;
				}
				return f.github.request(method, path, body);
			},
		};
		const input = {
			...options,
			github,
			autoMerge: true,
			merge: async () => {
				merges++;
				return { merged: true, reason: "Unexpected merge" };
			},
		};
		await reconcile(input);
		f.complete("review-copilot", copilot);
		f.complete("review-claude", claude);
		await reconcile(input);
		assert.equal(f.state().phase, "human");
		assert.equal(f.statuses.at(-1)?.state, "success");
		assert.match(string(f.statuses.at(-1)?.description), /manual|human/i);
		assert.equal(authenticatedSuccess, true);
		assert.equal(merges, 0);
	}
});

test("manual classifications with findings, blocked reports or failed CI cannot publish clean evidence", async () => {
	for (const failure of [
		"findings",
		"blocked-report",
		"failed-ci",
		"blocked-ci",
	] as const) {
		const f = fixture("pr");
		let merges = 0;
		const github: GitHubClient = {
			...f.github,
			async list(path, key) {
				const values = await f.github.list(path, key);
				return path.includes("/jobs") &&
					(failure === "failed-ci" || failure === "blocked-ci")
					? values.map((value) => ({
							...object(value),
							conclusion: failure === "failed-ci" ? "failure" : "cancelled",
						}))
					: values;
			},
		};
		const input = {
			...options,
			github,
			autoMerge: true,
			merge: async () => {
				merges++;
				return { merged: true, reason: "Unexpected merge" };
			},
		};
		await reconcile(input);
		f.complete("review-copilot", {
			...cleanReview,
			...(failure === "findings"
				? {
						findings: [
							{
								severity: "high",
								path: "src/commands/example.ts",
								line: 1,
								title: "Defect",
								body: "Regression remains",
							},
						],
					}
				: {}),
			...(failure === "blocked-report"
				? { status: "blocked", blockers: ["Missing evidence"] }
				: {}),
		});
		f.complete("review-claude", {
			...cleanReview,
			change_class: "other",
			release_intent: "none",
			merge_eligible: false,
		});
		await reconcile(input);
		assert.equal(f.statuses.at(-1)?.state, "failure");
		assert.equal(merges, 0);
	}
});

test("inherited fork test deletions and unsafe Git modes cannot bypass the report allowlist", async () => {
	for (const source of [
		{
			filename: "tests/unit/inherited.test.ts",
			status: "removed",
			mode: "100644",
			type: "blob",
		},
		{
			filename: "src/commands/inherited.ts",
			previous_filename: "tests/unit/inherited.test.ts",
			status: "renamed",
			mode: "100644",
			type: "blob",
		},
		{
			filename: "src/commands/inherited.ts",
			status: "modified",
			mode: "120000",
			type: "blob",
		},
		{
			filename: "src/commands/inherited.ts",
			status: "modified",
			mode: "100755",
			type: "blob",
		},
		{
			filename: "src/commands/inherited.ts",
			status: "modified",
			mode: "160000",
			type: "commit",
		},
	]) {
		const f = fixture("pr");
		object(f.pr.head).repo = { full_name: "contributor/c8ctl" };
		const list = f.github.list,
			request = f.github.request;
		f.github.list = async (path, key) =>
			path.endsWith("/pulls/42/files") ? [source] : list(path, key);
		f.github.request = async (method, path, body) => {
			const result = await request(method, path, body);
			if (path.includes("/git/trees/") && source.status !== "removed") {
				const tree = object(result);
				array(tree.tree).push({
					path: source.filename,
					mode: source.mode,
					type: source.type,
					sha: "f".repeat(40),
				});
			}
			return result;
		};
		await reconcile({ ...options, github: f.github });
		for (const kind of ["review-copilot", "review-claude"] as const)
			f.complete(kind, {
				...cleanReview,
				merge_eligible: false,
				findings: [
					{
						severity: "high",
						path: "src/commands/example.ts",
						line: 1,
						title: "Bug",
						body: "Fix",
					},
				],
			});
		await reconcile({ ...options, github: f.github });
		f.complete("reimplement", change);
		await reconcile({ ...options, github: f.github });
		assert.equal(f.state().phase, "blocked");
		assert.equal(
			f.mutations.some(
				(item) =>
					item.path.endsWith("/git/refs") ||
					item.path.endsWith("/pulls") ||
					item.method === "GRAPHQL",
			),
			false,
		);
	}
});

test("fork promotion validates an immutable diff even when mutable PR files omit protected paths", async () => {
	const f = fixture("pr");
	object(f.pr.head).repo = { full_name: "contributor/c8ctl" };
	const request = f.github.request;
	f.github.request = async (method, path, body) =>
		path.includes("/compare/")
			? {
					files: [
						{ filename: ".github/workflows/test.yml", status: "modified" },
					],
				}
			: request(method, path, body);
	await reconcile({ ...options, github: f.github });
	for (const kind of ["review-copilot", "review-claude"] as const)
		f.complete(kind, {
			...cleanReview,
			merge_eligible: false,
			findings: [
				{
					severity: "high",
					path: "src/commands/example.ts",
					line: 1,
					title: "Bug",
					body: "Fix",
				},
			],
		});
	await reconcile({ ...options, github: f.github });
	f.complete("reimplement", change);
	await reconcile({ ...options, github: f.github });
	assert.equal(f.state().phase, "blocked");
	assert.match(f.state().outcome, /protected|immutable/i);
	assert.equal(
		f.mutations.some(
			(item) =>
				item.path.endsWith("/git/refs") ||
				item.path.endsWith("/pulls") ||
				item.method === "GRAPHQL",
		),
		false,
	);
});

test("fork comparisons at GitHub's file cap require manual handling rather than accepting truncated evidence", async () => {
	for (const count of [300, 301]) {
		const f = fixture("pr");
		object(f.pr.head).repo = { full_name: "contributor/c8ctl" };
		f.pr.changed_files = count;
		const files = Array.from({ length: count }, (_, index) => ({
			filename: `src/commands/file-${index}.ts`,
			status: "modified",
		}));
		const list = f.github.list,
			request = f.github.request;
		f.github.list = async (path, key) =>
			path.endsWith("/pulls/42/files") ? files : list(path, key);
		f.github.request = async (method, path, body) =>
			path.includes("/compare/")
				? { files: files.slice(0, 300) }
				: request(method, path, body);
		await reconcile({ ...options, github: f.github });
		for (const kind of ["review-copilot", "review-claude"] as const)
			f.complete(kind, {
				...cleanReview,
				merge_eligible: false,
				findings: [
					{
						severity: "high",
						path: "src/commands/example.ts",
						line: 1,
						title: "Bug",
						body: "Fix",
					},
				],
			});
		await reconcile({ ...options, github: f.github });
		f.complete("reimplement", change);
		await reconcile({ ...options, github: f.github });
		assert.equal(f.state().phase, "blocked");
		assert.match(f.state().outcome, /complete immutable fork diff/);
		assert.equal(
			f.mutations.some(
				(item) =>
					item.path.endsWith("/git/refs") ||
					item.path.endsWith("/pulls") ||
					item.method === "GRAPHQL",
			),
			false,
		);
	}
});

test("changed PR head or base restarts terminal reviews without replenishing session budgets", async () => {
	for (const phase of ["human", "blocked"] as const)
		for (const changed of ["head", "base"] as const) {
			const f = fixture("pr");
			await reconcile({ ...options, github: f.github });
			const report =
				phase === "human"
					? {
							...cleanReview,
							change_class: "other",
							release_intent: "none",
							merge_eligible: false,
						}
					: {
							...cleanReview,
							status: "blocked",
							merge_eligible: false,
							blockers: ["Evidence unavailable"],
						};
			for (const kind of ["review-copilot", "review-claude"] as const)
				f.complete(kind, report);
			await reconcile({ ...options, github: f.github });
			assert.equal(f.state().phase, phase);
			const previous = f.state(),
				comment = f.comments[0];
			assert.ok(comment);
			comment.body = renderState({
				...previous,
				reimplementation_attempts: 3,
				total_dispatches: 12,
			});
			if (changed === "head") {
				object(f.pr.head).sha = "b".repeat(40);
				f.refs.set("contributor-fix", "b".repeat(40));
			} else {
				object(f.pr.base).sha = "c".repeat(40);
				f.refs.set("main", "c".repeat(40));
			}
			await reconcile({ ...options, github: f.github });
			assert.equal(f.state().phase, "reviewing");
			assert.equal(f.state().generation, previous.generation);
			assert.equal(f.state().deadline, previous.deadline);
			assert.equal(f.state().reimplementation_attempts, 3);
			assert.equal(f.state().total_dispatches, 15);
			assert.deepEqual(
				f.tasks.slice(-2).map((task) => task.kind),
				["review-copilot", "review-claude"],
			);
			assert.ok(
				f.tasks
					.slice(-2)
					.every(
						(task) =>
							task.attempt === 3 &&
							task.head_sha === object(f.pr.head).sha &&
							task.base_sha === object(f.pr.base).sha,
					),
			);
			for (const kind of ["review-copilot", "review-claude"] as const)
				f.complete(kind, {
					...cleanReview,
					merge_eligible: false,
					findings: [
						{
							severity: "high",
							path: "src/commands/example.ts",
							line: 1,
							title: "Still broken",
							body: "Needs another change",
						},
					],
				});
			await reconcile({ ...options, github: f.github });
			assert.equal(f.state().phase, "blocked");
			assert.equal(
				f.tasks.filter((task) => task.kind === "reimplement").length,
				0,
			);
		}
});

test("head changes preserve ambiguous writes and do not supersede active write workers", async () => {
	for (const write of ["pending", "written", "running"] as const) {
		const f = fixture("pr");
		await reconcile({ ...options, github: f.github });
		if (write === "running") {
			for (const kind of ["review-copilot", "review-claude"] as const)
				f.complete(kind, {
					...cleanReview,
					merge_eligible: false,
					findings: [
						{
							severity: "high",
							path: "src/commands/example.ts",
							line: 1,
							title: "Bug",
							body: "Fix",
						},
					],
				});
			await reconcile({ ...options, github: f.github });
		} else {
			const comment = f.comments[0];
			assert.ok(comment);
			comment.body = renderState({
				...f.state(),
				phase: "blocked",
				pending_operation: write === "pending" ? "commit" : null,
				written_sha: write === "written" ? "b".repeat(40) : null,
			});
		}
		const previous = f.state(),
			count = f.tasks.length;
		object(f.pr.head).sha = "b".repeat(40);
		f.refs.set("contributor-fix", "b".repeat(40));
		await reconcile({ ...options, github: f.github });
		await reconcile({ ...options, github: f.github });
		assert.equal(f.tasks.length, count);
		assert.equal(f.state().head_sha, previous.head_sha);
		assert.equal(f.state().pending_operation, previous.pending_operation);
		assert.equal(f.state().written_sha, previous.written_sha);
		assert.equal(
			f.state().reimplementation_attempts,
			previous.reimplementation_attempts,
		);
		if (write === "running") {
			f.complete("reimplement", change);
			await reconcile({ ...options, github: f.github });
			assert.equal(f.tasks.length, count + 2);
			assert.equal(
				f.state().reimplementation_attempts,
				previous.reimplementation_attempts,
			);
		}
	}
});

test("revision changes never restart exhausted deadlines or dispatch budgets", async () => {
	for (const exhausted of ["deadline", "dispatches"] as const) {
		const f = fixture("pr");
		await reconcile({ ...options, github: f.github });
		const comment = f.comments[0];
		assert.ok(comment);
		const previous = f.state();
		comment.body = renderState({
			...previous,
			phase: "human",
			reimplementation_attempts: 3,
			total_dispatches:
				exhausted === "dispatches" ? 20 : previous.total_dispatches,
			deadline: exhausted === "deadline" ? now : previous.deadline,
		});
		object(f.pr.head).sha = "b".repeat(40);
		await reconcile({ ...options, github: f.github });
		assert.equal(f.state().phase, "blocked");
		assert.equal(f.tasks.length, 2);
		assert.equal(f.state().reimplementation_attempts, 3);
	}
});

test("top-level configuration failures retain safe reasons without revealing arbitrary error text", () => {
	assert.equal(
		coordinatorFailureReason(new Error("Unsupported coordinator command")),
		"Unsupported coordinator command",
	);
	assert.match(
		coordinatorFailureReason(new TypeError("Expected JSON string")),
		/environment/i,
	);
	assert.equal(
		coordinatorFailureReason(new GitHubError(403)),
		"GitHub API request failed (HTTP 403)",
	);
	assert.match(
		coordinatorFailureReason(
			new SyntaxError("payload contains never-log-this-secret"),
		),
		/JSON/,
	);
	assert.doesNotMatch(
		coordinatorFailureReason(
			new Error("never-log-this-secret\n::warning::injected"),
		),
		/never-log|::warning|\n/,
	);
	const result = spawnSync(
		process.execPath,
		[
			"--experimental-strip-types",
			fileURLToPath(
				new URL("../../scripts/agentic/coordinator.ts", import.meta.url),
			),
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				C8CTL_AUTOMATION_ENABLED: "true",
				GITHUB_REF: "refs/heads/untrusted",
				GH_TOKEN: "never-log-this-secret",
			},
		},
	);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /trusted default ref/);
	assert.doesNotMatch(result.stderr, /never-log-this-secret/);
});

test("a changed PR snapshot invalidates the reserved CI receipt without resetting its spent dispatch", async () => {
	const f = fixture("pr");
	await reconcile({ ...options, github: f.github });
	const before = f.state(),
		comment = f.comments[0];
	assert.ok(comment);
	comment.body = renderState({
		...before,
		total_dispatches: 3,
		ci: {
			task: {
				version: 1,
				repository,
				number: 42,
				generation: before.generation,
				correlation: "b132a809-748e-44aa-a660-a3d527691c00",
				head_sha: head,
				base_sha: head,
				merge_sha: "c".repeat(40),
				state_comment_id: 8,
				attempt: 0,
			},
			run_id: null,
			run_attempt: null,
			artifact_id: null,
			dispatched_at: now,
		},
	});
	object(f.pr.head).sha = "b".repeat(40);
	f.refs.set("contributor-fix", "b".repeat(40));
	await reconcile({ ...options, github: f.github });
	assert.equal(f.state().head_sha, "b".repeat(40));
	assert.equal(f.state().ci?.task.head_sha, "b".repeat(40));
	assert.notEqual(
		f.state().ci?.task.correlation,
		"b132a809-748e-44aa-a660-a3d527691c00",
	);
	assert.equal(f.state().total_dispatches, 6);
	assert.equal(f.state().deadline, before.deadline);
});

test("every PR snapshot reserves trusted Test CI, including forks with empty run associations", async () => {
	for (const fork of [false, true]) {
		const f = fixture("pr");
		if (fork) object(f.pr.head).repo = { full_name: "contributor/c8ctl" };
		await reconcile({ ...options, github: f.github });
		assert.equal(f.ciTasks.length, 1);
		assert.equal(f.state().total_dispatches, 3);
		assert.equal(f.state().ci?.task.head_sha, head);
		assert.equal(f.state().ci?.artifact_id, 501);
		for (const kind of ["review-copilot", "review-claude"] as const)
			f.complete(kind, cleanReview);
		let merged = false;
		await reconcile({
			...options,
			github: f.github,
			autoMerge: true,
			merge: async (request) => {
				assert.equal(request.ciSlot.artifact_id, 501);
				assert.equal(request.proof.ci, "success");
				merged = true;
				return { merged: true, reason: "Verified" };
			},
		});
		assert.equal(merged, true);
		assert.equal(f.ciTasks.length, 1);
	}
});

test("ambiguous trusted CI dispatch discovers its reservation but never posts it twice", async () => {
	for (const accepted of [false, true]) {
		const f = fixture("pr");
		let dispatches = 0;
		const github: GitHubClient = {
			...f.github,
			async request(method, path, body) {
				if (method === "POST" && path.endsWith("/test.yml/dispatches")) {
					dispatches++;
					if (accepted) await f.github.request(method, path, body);
					throw new Error("Lost dispatch response");
				}
				return f.github.request(method, path, body);
			},
		};
		await reconcile({ ...options, github });
		await reconcile({ ...options, github });
		assert.equal(dispatches, 1);
		assert.equal(f.state().total_dispatches, 3);
		assert.equal(f.state().ci?.run_id, accepted ? 501 : null);
	}
});

test("ready-for-review and intent edits restart unchanged-SHA PRs without refunding budgets", async () => {
	for (const initialDraft of [true, false]) {
		const f = fixture("pr");
		f.pr.draft = initialDraft;
		await reconcile({ ...options, github: f.github });
		if (!initialDraft) {
			for (const kind of ["review-copilot", "review-claude"] as const)
				f.complete(kind, cleanReview);
			await reconcile({ ...options, github: f.github });
		}
		const before = f.state();
		f.pr.draft = false;
		f.pr.body = "Updated testable requirements";
		f.issue.body = f.pr.body;
		await reconcile({ ...options, github: f.github });
		assert.equal(f.state().phase, "reviewing");
		assert.equal(f.state().generation, before.generation);
		assert.equal(f.state().deadline, before.deadline);
		assert.equal(f.state().total_dispatches, before.total_dispatches + 3);
		assert.notEqual(f.state().revision_hash, before.revision_hash);
		assert.equal(f.statuses.at(-1)?.state, "pending");
	}
});

test("GitHub's collapsed skipped unit matrix after failed typecheck starts one budgeted repair", async () => {
	const f = fixture("pr");
	await reconcile({ ...options, github: f.github });
	for (const kind of ["review-copilot", "review-claude"] as const)
		f.complete(kind, cleanReview);
	const run = f.runs.find((item) => item.id === 501);
	assert.ok(run);
	run.conclusion = "failure";
	const receipt = object(f.reports.get(501));
	object(receipt.jobs).typecheck = "failure";
	object(receipt.jobs).unit = "skipped";
	const list = f.github.list;
	f.github.list = async (path, key) => {
		const result = await list(path, key);
		if (!path.endsWith("/501/attempts/1/jobs")) return result;
		return [
			...result
				.map(object)
				.filter((job) => !string(job.name).startsWith("Unit Test"))
				.map((job) =>
					job.name === "Typecheck" ? { ...job, conclusion: "failure" } : job,
				),
			{
				name: `Unit Test (Node \${{ matrix.node }} / \${{ matrix.os }})`,
				status: "completed",
				conclusion: "skipped",
			},
		];
	};
	await reconcile({ ...options, github: f.github });
	assert.equal(f.state().phase, "implementing");
	assert.equal(f.state().reimplementation_attempts, 1);
	assert.equal(f.tasks.at(-1)?.kind, "reimplement");
	assert.equal(f.statuses.at(-1)?.state, "pending");
});

function fixture(subject: "issue" | "pr" = "issue") {
	const mutations: { method: string; path: string; body: unknown }[] = [];
	const comments: Record<string, unknown>[] = [];
	const childComments: Record<string, unknown>[] = [];
	const statuses: Record<string, unknown>[] = [];
	const tasks: WorkerTask[] = [];
	const ciTasks: CITask[] = [];
	const runs: Record<string, unknown>[] = [];
	const reports = new Map<number, unknown>();
	const refs = new Map<string, string>([["main", head]]);
	let enabled = true,
		nextCommit = 1;
	const issue: Record<string, unknown> = {
		number: 42,
		title: "Repair defect",
		body: "Expected behavior: reproduce and fix only the defect",
		created_at: now,
		updated_at: now,
		state: "open",
		labels: [],
		user: { login: "contributor", type: "User" },
		...(subject === "pr" ? { pull_request: {} } : {}),
	};
	const pr: Record<string, unknown> = {
		...issue,
		draft: false,
		mergeable: true,
		mergeable_state: "clean",
		merge_commit_sha: "f".repeat(40),
		head: {
			sha: head,
			ref: "contributor-fix",
			repo: { id: 1, full_name: repository, fork: false },
		},
		base: {
			sha: head,
			ref: "main",
			repo: { id: 1, full_name: repository, fork: false },
		},
		changed_files: 1,
	};
	refs.set("contributor-fix", head);
	const prs: Record<string, unknown>[] = subject === "pr" ? [pr] : [];
	function workflow(kind: string) {
		return {
			id:
				kind === "test"
					? 1
					: 10 +
						[
							"fitness",
							"implement",
							"review-copilot",
							"review-claude",
							"reimplement",
						].indexOf(kind),
			path:
				kind === "test"
					? ".github/workflows/test.yml"
					: `.github/workflows/agentic-${kind}.lock.yml`,
		};
	}
	const github: GitHubClient = {
		async request(method, path, body) {
			const data = body === undefined ? {} : object(body);
			if (method !== "GET") mutations.push({ method, path, body });
			if (path === `/repos/${repository}`)
				return {
					id: 1,
					default_branch: "main",
					full_name: repository,
					archived: false,
					disabled: false,
					permissions: { push: true },
					allow_squash_merge: true,
				};
			if (path.endsWith("/actions/variables/C8CTL_AUTOMATION_ENABLED"))
				return {
					name: "C8CTL_AUTOMATION_ENABLED",
					value: enabled ? "true" : "false",
				};
			if (path.includes("/collaborators/")) return { permission: "write" };
			if (method === "POST" && /\/statuses\/[a-f0-9]{40}$/.test(path)) {
				const status = {
					...data,
					id: statuses.length + 1000,
					sha: path.split("/").at(-1),
					creator: { login: appBotLogin, type: "Bot" },
				};
				statuses.push(status);
				return status;
			}
			if (path.endsWith("/issues/42")) return issue;
			if (path.endsWith("/pulls/42")) return pr;
			if (path.includes("/commits/") && !path.includes("/statuses")) {
				const task = ciTasks.findLast((item) => path.endsWith(item.merge_sha));
				return {
					sha: path.split("/").at(-1),
					parents: [
						{ sha: task?.base_sha ?? object(pr.base).sha },
						{ sha: task?.head_sha ?? object(pr.head).sha },
					],
				};
			}
			if (path.endsWith("/pulls/43") || path.endsWith("/issues/43")) {
				const linked = prs.find((item) => item.number === 43);
				assert.ok(linked);
				return linked;
			}
			if (path.includes("/git/ref/heads/")) {
				const branch = decodeURIComponent(
					path.split("/git/ref/heads/")[1] ?? "",
				);
				const sha = refs.get(branch);
				if (!sha) throw new GitHubError(404);
				return { object: { sha } };
			}
			if (path.endsWith("/git/refs")) {
				const branch = string(data.ref).replace("refs/heads/", "");
				if (refs.has(branch)) throw new GitHubError(422);
				refs.set(branch, string(data.sha));
				return { ref: data.ref, object: { sha: data.sha } };
			}
			if (path.includes("/git/trees/"))
				return {
					truncated: false,
					tree:
						object(object(pr.head).repo).full_name === repository
							? []
							: [
									{
										path: "src",
										mode: "040000",
										type: "tree",
										sha: "d".repeat(40),
									},
									{
										path: "src/commands",
										mode: "040000",
										type: "tree",
										sha: "d".repeat(40),
									},
									{
										path: "src/commands/example.ts",
										mode: "100644",
										type: "blob",
										sha: "e".repeat(40),
									},
								],
				};
			if (path.includes("/git/blobs/"))
				return {
					encoding: "base64",
					content: Buffer.from("original fork contents").toString("base64"),
				};
			if (path.includes("/compare/"))
				return {
					files: await github.list(`/repos/${repository}/pulls/42/files`),
				};
			if (/\/actions\/runs\/\d+$/.test(path)) {
				const run = runs.find(
					(item) => item.id === Number(path.split("/").at(-1)),
				);
				assert.ok(run);
				return run;
			}
			if (path.includes("/branches/"))
				return { protected: false, commit: { sha: head } };
			if (path.endsWith("/issues/42/comments") && method === "POST") {
				const comment = {
					id: 8,
					body: data.body,
					user: { login: appBotLogin, type: "Bot" },
				};
				comments.push(comment);
				return comment;
			}
			if (path.endsWith("/issues/43/comments") && method === "POST") {
				const comment = {
					id: 9,
					body: data.body,
					user: { login: appBotLogin, type: "Bot" },
				};
				childComments.push(comment);
				return comment;
			}
			if (path.includes("/issues/comments/")) {
				const comment = path.endsWith("/9") ? childComments[0] : comments[0];
				assert.ok(comment);
				if (method === "PATCH") comment.body = data.body;
				return comment;
			}
			if (path.endsWith("/dispatches")) {
				if (path.includes("/test.yml/")) {
					const task = parseCITask(object(data.inputs).agentic_task);
					assert.deepEqual(state(task.number).ci?.task, task);
					ciTasks.push(task);
					const id = 500 + ciTasks.length;
					runs.push({
						...workflow("test"),
						id,
						workflow_id: 1,
						display_title: `c8ctl-ci-${task.correlation}`,
						event: "workflow_dispatch",
						head_branch: "main",
						actor: { login: appBotLogin, type: "Bot" },
						run_attempt: 1,
						head_sha: task.base_sha,
						status: "completed",
						conclusion: "success",
						pull_requests: [],
					});
					reports.set(id, {
						schema_version: 1,
						repository,
						task,
						run_id: id,
						run_attempt: 1,
						workflow_sha: task.base_sha,
						tested_sha: task.merge_sha,
						jobs: {
							lint: "success",
							typecheck: "success",
							unit: "success",
							integration: "success",
						},
					});
					return null;
				}
				const task = parseWorkerTask(
					JSON.parse(string(object(data.inputs).task)),
				);
				tasks.push(task);
				const wf = workflow(task.kind);
				runs.push({
					...wf,
					id: 100 + tasks.length,
					workflow_id: wf.id,
					display_title: `c8ctl-${task.correlation}`,
					event: "workflow_dispatch",
					head_branch: "main",
					actor: { login: appBotLogin, type: "Bot" },
					run_attempt: 1,
					head_sha: head,
					status: "queued",
					conclusion: null,
				});
				return null;
			}
			if (path.includes("/actions/workflows/")) {
				const filename = path.split("/").at(-1) ?? "";
				return workflow(
					filename === "test.yml"
						? "test"
						: filename.replace("agentic-", "").replace(".lock.yml", ""),
				);
			}
			if (path.endsWith("/pulls") && method === "POST") {
				const created = {
					...pr,
					title: data.title,
					body: data.body,
					labels: [],
					user: { login: appBotLogin, type: "Bot" },
					pull_request: {},
					number: 43,
					state: "open",
					head: {
						ref: data.head,
						sha: refs.get(string(data.head)),
						repo: { full_name: repository },
					},
					base: { ref: "main", sha: head, repo: { full_name: repository } },
					html_url: `https://github.com/${repository}/pull/43`,
				};
				prs.push(created);
				return created;
			}
			throw new Error(`Unexpected ${method} ${path}`);
		},
		async list(path) {
			if (/\/commits\/[a-f0-9]{40}\/statuses$/.test(path))
				return statuses
					.filter((status) => status.sha === path.split("/").at(-2))
					.toReversed();
			if (path.includes("/issues/42/comments")) return comments;
			if (path.includes("/issues/43/comments")) return childComments;
			if (path.endsWith("/pulls/42/files"))
				return [{ filename: "src/commands/example.ts", status: "modified" }];
			if (path.includes("/pulls?"))
				return prs.filter(
					(item) =>
						object(item.head).ref ===
						new URL(`https://api.github.com${path}`).searchParams
							.get("head")
							?.split(":")[1],
				);
			if (path.endsWith("/issues?state=open")) return [issue];
			if (path.includes("/artifacts")) {
				const id = Number(path.split("/runs/")[1]?.split("/")[0]);
				const ci = ciTasks[id - 501];
				if (ci)
					return [
						{ id, name: `ci-report-${ci.correlation}-1`, expired: false },
					];
				const task = tasks[id - 101];
				assert.ok(task);
				return reports.has(id)
					? [
							{
								id,
								name: `worker-report-${task.correlation}-1`,
								expired: false,
							},
						]
					: [];
			}
			if (path.includes("/jobs"))
				return [
					"Agentic CI Revision",
					"Agentic CI Receipt",
					"Lint",
					"Typecheck",
					...[22, 24].flatMap((node) =>
						["ubuntu-latest", "macos-latest", "windows-latest"].map(
							(os) => `Unit Test (Node ${node} / ${os})`,
						),
					),
					...[22, 24].flatMap((node) =>
						["8.8", "8.9", "8.10"].map(
							(version) =>
								`Integration Test (Node ${node} / Camunda ${version} / ubuntu-latest)`,
						),
					),
				].map((name) => ({ name, status: "completed", conclusion: "success" }));
			if (path.includes("/actions/workflows/")) {
				const id = Number(path.split("/workflows/")[1]?.split("/")[0]);
				return runs.filter((run) => run.workflow_id === id);
			}
			if (path.includes("/actions/runs?"))
				return runs.filter(
					(run) =>
						run.status ===
						new URL(`https://api.github.com${path}`).searchParams.get("status"),
				);
			throw new Error(`Unexpected list ${path}`);
		},
		async artifact(path) {
			return reports.get(Number(path.split("/artifacts/")[1]?.split("/")[0]));
		},
		async graphql(_query, variables) {
			mutations.push({ method: "GRAPHQL", path: "/graphql", body: variables });
			const input = object(variables.input);
			const branch = string(object(input.branch).branchName);
			assert.equal(input.expectedHeadOid, refs.get(branch));
			const sha = String(nextCommit++).repeat(40);
			refs.set(branch, sha);
			for (const target of prs)
				if (branch === object(target.head).ref) object(target.head).sha = sha;
			return { createCommitOnBranch: { commit: { oid: sha } } };
		},
	};
	function complete(kind: WorkerTask["kind"], report: unknown) {
		const task = tasks.findLast((item) => item.kind === kind);
		assert.ok(task);
		const run = runs.find(
			(item) => item.display_title === `c8ctl-${task.correlation}`,
		);
		assert.ok(run);
		run.status = "completed";
		run.conclusion = "success";
		reports.set(Number(run.id), {
			schema_version: 1,
			repository,
			task,
			engine: kind === "review-claude" ? "claude" : "copilot",
			run_id: run.id,
			run_attempt: 1,
			workflow_sha: head,
			report,
		});
	}
	function state(number = 42): State {
		const current = findState(
			number === 43 ? childComments : comments,
			appBotLogin,
			number,
		);
		assert.ok(current);
		return current.state;
	}
	return {
		github,
		mutations,
		comments,
		childComments,
		statuses,
		tasks,
		ciTasks,
		runs,
		reports,
		refs,
		issue,
		pr,
		prs,
		complete,
		state,
		disable: () => {
			enabled = false;
		},
	};
}

test("disabled or held subjects cause zero writes or dispatches", async () => {
	const f = fixture();
	await reconcile({ ...options, github: f.github, enabled: false });
	assert.equal(f.mutations.length, 0);
	f.issue.labels = [{ name: "agentic:hold" }];
	await reconcile({ ...options, github: f.github });
	assert.equal(f.mutations.length, 0);
});

test("issue fitness -> reserved implementation -> SHA-CAS commit -> one linked PR", async () => {
	const f = fixture();
	await reconcile({ ...options, github: f.github });
	assert.deepEqual(
		f.tasks.map((task) => task.kind),
		["fitness"],
	);
	assert.equal(f.state().total_dispatches, 1);
	await reconcile({ ...options, github: f.github });
	assert.equal(f.tasks.length, 1);
	f.complete("fitness", readyFitness);
	await reconcile({ ...options, github: f.github });
	assert.deepEqual(
		f.tasks.map((task) => task.kind),
		["fitness", "implement"],
	);
	f.complete("implement", change);
	await reconcile({ ...options, github: f.github });
	assert.equal(f.state().implemented_pr, 43);
	assert.equal(f.state().phase, "complete");
	assert.equal(
		f.mutations.filter((item) => item.method === "GRAPHQL").length,
		1,
	);
	assert.match(
		string(
			object(f.mutations.find((item) => item.path.endsWith("/pulls"))?.body)
				.body,
		),
		/Closes #42/,
	);
	await reconcile({ ...options, github: f.github });
	assert.equal(f.prs.length, 1);
});

test("non-ready fitness publishes evidence, and substantive issue edits reassess without reset", async () => {
	const f = fixture();
	await reconcile({ ...options, github: f.github });
	f.complete("fitness", {
		...readyFitness,
		decision: "needs_spec",
		blockers: ["Expected behavior is missing"],
	});
	await reconcile({ ...options, github: f.github });
	assert.equal(f.state().phase, "human");
	assert.match(f.state().outcome, /Expected behavior is missing/);
	assert.deepEqual(
		object(JSON.parse(f.state().outcome.slice("needs_spec: ".length))).criteria,
		readyFitness.criteria,
	);
	await reconcile({ ...options, github: f.github });
	assert.equal(f.tasks.length, 1);
	f.issue.body = "New precise acceptance criterion";
	f.issue.updated_at = "2026-09-18T12:01:00.000Z";
	await reconcile({ ...options, github: f.github });
	assert.equal(f.tasks.length, 2);
	assert.equal(f.state().total_dispatches, 2);
});

test("changed issue revision cannot authorize implementation from stale fitness", async () => {
	const f = fixture();
	await reconcile({ ...options, github: f.github });
	f.complete("fitness", readyFitness);
	f.issue.body = "Changed accepted scope";
	await reconcile({ ...options, github: f.github });
	assert.deepEqual(
		f.tasks.map((task) => task.kind),
		["fitness", "fitness"],
	);
	assert.equal(
		f.mutations.some((item) => item.path.endsWith("/git/refs")),
		false,
	);
});

test("PR convergence spends exactly three fixes, reviews third attempt and stops before fourth", async () => {
	const f = fixture("pr");
	await reconcile({ ...options, github: f.github });
	for (let attempt = 1; attempt <= 3; attempt++) {
		for (const kind of ["review-copilot", "review-claude"] as const)
			f.complete(kind, {
				...cleanReview,
				merge_eligible: false,
				findings: [
					{
						severity: "high",
						path: "src/commands/example.ts",
						line: 1,
						title: "Defect remains",
						body: "Add failing regression test and fix defect",
					},
				],
			});
		await reconcile({ ...options, github: f.github });
		assert.equal(f.state().reimplementation_attempts, attempt);
		assert.equal(f.tasks.at(-1)?.kind, "reimplement");
		f.complete("reimplement", {
			...change,
			files: [
				{
					path: "src/commands/example.ts",
					content: `export const attempt = ${attempt};\n`,
				},
			],
		});
		await reconcile({ ...options, github: f.github });
		await reconcile({ ...options, github: f.github });
		assert.equal(f.tasks.at(-1)?.kind, "review-claude");
	}
	for (const kind of ["review-copilot", "review-claude"] as const)
		f.complete(kind, {
			...cleanReview,
			merge_eligible: false,
			findings: [
				{
					severity: "high",
					path: "src/commands/example.ts",
					line: 1,
					title: "Still broken",
					body: "Evidence",
				},
			],
		});
	await reconcile({ ...options, github: f.github });
	assert.equal(f.state().phase, "blocked");
	assert.equal(f.tasks.filter((task) => task.kind === "reimplement").length, 3);
});

test("global kill reread before each write stops a running reconciliation", async () => {
	const f = fixture();
	f.disable();
	await reconcile({ ...options, github: f.github });
	assert.equal(f.mutations.length, 0);
});

test("a reserved dispatch with no discoverable run never blindly redispatches", async () => {
	const f = fixture();
	await reconcile({ ...options, github: f.github });
	f.runs.length = 0;
	await reconcile({ ...options, github: f.github });
	assert.equal(f.tasks.length, 1);
	await reconcile({
		...options,
		github: f.github,
		now: "2026-09-18T15:00:00.000Z",
	});
	assert.equal(f.state().phase, "blocked");
	assert.equal(f.tasks.length, 1);
});

test("malformed App state and protected file reports cannot trigger code writes", async () => {
	const f = fixture();
	await reconcile({ ...options, github: f.github });
	f.complete("fitness", readyFitness);
	await reconcile({ ...options, github: f.github });
	f.complete("implement", {
		...change,
		files: [{ path: ".github/workflows/evil.yml", content: "danger" }],
	});
	await reconcile({ ...options, github: f.github });
	assert.equal(f.state().phase, "blocked");
	assert.equal(
		f.mutations.some(
			(item) => item.path.endsWith("/git/refs") || item.method === "GRAPHQL",
		),
		false,
	);
	const state = f.state();
	f.comments[0] = {
		id: 8,
		user: { login: appBotLogin, type: "Bot" },
		body: renderState(state).replace(
			'"schema_version":1',
			'"schema_version":2',
		),
	};
	const before = f.mutations.length;
	await reconcile({ ...options, github: f.github });
	assert.equal(f.mutations.length, before);
});

test("ambiguous dispatch is discovered without duplicate dispatch or permanent block", async () => {
	const f = fixture();
	const request = f.github.request;
	f.github.request = async (method, path, body) => {
		const result = await request(method, path, body);
		if (path.endsWith("/dispatches")) throw new GitHubError(502);
		return result;
	};
	await reconcile({ ...options, github: f.github });
	assert.equal(f.tasks.length, 1);
	assert.equal(f.state().phase, "fitness");
	f.complete("fitness", { ...readyFitness, decision: "already_implemented" });
	await reconcile({ ...options, github: f.github });
	assert.equal(f.state().phase, "human");
	assert.equal(f.tasks.length, 1);
});

test("PR creation with a lost response recovers exact branch without a second creation", async () => {
	const f = fixture();
	await reconcile({ ...options, github: f.github });
	f.complete("fitness", readyFitness);
	await reconcile({ ...options, github: f.github });
	f.complete("implement", change);
	const request = f.github.request;
	f.github.request = async (method, path, body) => {
		const result = await request(method, path, body);
		if (path.endsWith("/pulls") && method === "POST")
			throw new GitHubError(502);
		return result;
	};
	await reconcile({ ...options, github: f.github });
	assert.equal(f.state().phase, "implementing");
	await reconcile({ ...options, github: f.github });
	assert.equal(f.state().implemented_pr, 43);
	assert.equal(
		f.mutations.filter((item) => item.path.endsWith("/pulls")).length,
		1,
	);
	assert.equal(
		f.mutations.filter((item) => item.method === "GRAPHQL").length,
		1,
	);
});

test("unwritable fork uses a linked same-repository remediation PR and never writes the original branch", async () => {
	const f = fixture("pr");
	object(f.pr.head).repo = { full_name: "contributor/c8ctl" };
	await reconcile({ ...options, github: f.github });
	for (const kind of ["review-copilot", "review-claude"] as const)
		f.complete(kind, {
			...cleanReview,
			merge_eligible: false,
			findings: [
				{
					severity: "high",
					path: "src/commands/example.ts",
					line: 1,
					title: "Bug",
					body: "Fix the defect",
				},
			],
		});
	await reconcile({ ...options, github: f.github });
	f.complete("reimplement", change);
	await reconcile({ ...options, github: f.github });
	assert.equal(f.state().phase, "human");
	assert.equal(f.state().implemented_pr, 43);
	assert.equal(object(f.pr.head).sha, head);
	const commit = f.mutations.find((item) => item.method === "GRAPHQL");
	assert.match(
		string(object(object(object(commit?.body).input).branch).branchName),
		/^agentic\/remediation-42-/,
	);
	assert.match(
		string(
			object(f.mutations.find((item) => item.path.endsWith("/pulls"))?.body)
				.body,
		),
		/Remediates #42/,
	);
});

test("worker capacity and budgets survive revision changes, and explicit maintainer resume resets", async () => {
	const f = fixture("pr");
	f.runs.push(
		...Array.from({ length: 6 }, () => ({
			path: ".github/workflows/agentic-fitness.lock.yml",
			status: "queued",
		})),
	);
	await reconcile({ ...options, github: f.github });
	assert.equal(f.tasks.length, 0);
	f.runs.length = 0;
	await reconcile({ ...options, github: f.github });
	assert.equal(f.tasks.length, 2);
	const saved = f.state();
	const comment = f.comments[0];
	assert.ok(comment);
	comment.body = renderState({
		...saved,
		reimplementation_attempts: 3,
		total_dispatches: 20,
		phase: "blocked",
	});
	object(f.pr.head).sha = "b".repeat(40);
	await reconcile({ ...options, github: f.github });
	assert.equal(f.state().reimplementation_attempts, 3);
	assert.equal(f.tasks.length, 2);
	await reconcile({ ...options, github: f.github, resumeActor: "maintainer" });
	assert.equal(f.state().reimplementation_attempts, 0);
	assert.equal(f.state().total_dispatches, 3);
});

test("clean third attempt reaches trusted merge hook, while no configured gate never merges", async () => {
	const f = fixture("pr");
	await reconcile({ ...options, github: f.github });
	const previous = f.state();
	const comment = f.comments[0];
	assert.ok(comment);
	previous.reimplementation_attempts = 3;
	previous.slots = {};
	comment.body = renderState(previous);
	await reconcile({ ...options, github: f.github });
	for (const kind of ["review-copilot", "review-claude"] as const)
		f.complete(kind, cleanReview);
	let merges = 0;
	await reconcile({
		...options,
		github: f.github,
		autoMerge: true,
		merge: async (request) => {
			await request.guard();
			assert.equal(request.headSha, head);
			assert.equal(request.releaseIntent, "patch");
			assert.equal(request.changeClass, "patch");
			assert.equal(request.proof.state.reimplementation_attempts, 3);
			assert.equal(request.proof.ci, "success");
			assert.equal(request.proof.reviews.copilot?.status, "completed");
			assert.equal(request.proof.reviews.claude?.status, "completed");
			assert.equal(
				typeof f.state().slots["review-copilot"]?.artifact_id,
				"number",
			);
			assert.equal(
				typeof f.state().slots["review-claude"]?.artifact_id,
				"number",
			);
			assert.notEqual(
				request.proof.expected.copilot.correlation,
				request.proof.expected.claude.correlation,
			);
			merges++;
			f.issue.state = "closed";
			return {
				merged: true,
				reason: "SHA-pinned squash merge passed trusted gate",
			};
		},
	});
	assert.equal(merges, 1);
	assert.equal(f.state().phase, "complete");
});

test("diagnostic exclusion never excludes genuine automation-authored dependency PRs", async () => {
	const f = fixture("pr");
	f.issue.user = { login: "github-actions[bot]", type: "Bot" };
	f.issue.title = "[gh-aw] update compiler dependencies";
	await reconcile({ ...options, github: f.github });
	assert.equal(f.tasks.length, 2);
});

test("last-moment hold or revision changes cannot write branch content", async () => {
	for (const trigger of ["hold", "revision"] as const) {
		const f = fixture();
		await reconcile({ ...options, github: f.github });
		f.complete("fitness", readyFitness);
		await reconcile({ ...options, github: f.github });
		f.complete("implement", change);
		const request = f.github.request;
		f.github.request = async (method, path, body) => {
			const result = await request(method, path, body);
			if (path.includes("/branches/")) {
				if (trigger === "hold") f.issue.labels = [{ name: "agentic:hold" }];
				else f.issue.body = "A different issue revision";
			}
			return result;
		};
		await reconcile({ ...options, github: f.github });
		assert.equal(
			f.mutations.filter((item) => item.method === "GRAPHQL").length,
			0,
		);
	}
});

test("no-progress report blocks without consuming a second fix or modifying code", async () => {
	const f = fixture();
	await reconcile({ ...options, github: f.github });
	f.complete("fitness", readyFitness);
	await reconcile({ ...options, github: f.github });
	f.complete("implement", { ...change, files: [] });
	await reconcile({ ...options, github: f.github });
	assert.equal(f.state().phase, "blocked");
	assert.equal(
		f.mutations.some(
			(item) => item.path.endsWith("/git/refs") || item.method === "GRAPHQL",
		),
		false,
	);
	await reconcile({ ...options, github: f.github });
	assert.equal(f.tasks.length, 2);
});

test("scope edits after a written commit cannot recycle old code for newly accepted scope", async () => {
	const f = fixture();
	await reconcile({ ...options, github: f.github });
	f.complete("fitness", readyFitness);
	await reconcile({ ...options, github: f.github });
	f.complete("implement", change);
	const request = f.github.request;
	f.github.request = async (method, path, body) => {
		if (method === "POST" && path.endsWith("/pulls"))
			throw new GitHubError(502);
		return request(method, path, body);
	};
	await reconcile({ ...options, github: f.github });
	assert.equal(f.state().phase, "implementing");
	assert.ok(f.state().written_sha);
	f.issue.body = "Different scope with different required implementation";
	await reconcile({ ...options, github: f.github });
	assert.equal(f.state().phase, "blocked");
	assert.equal(f.tasks.length, 2);
});

test("maintainer resume never creates a second implementation while its linked PR is open", async () => {
	const f = fixture();
	await reconcile({ ...options, github: f.github });
	f.complete("fitness", readyFitness);
	await reconcile({ ...options, github: f.github });
	f.complete("implement", change);
	await reconcile({ ...options, github: f.github });
	await reconcile({ ...options, github: f.github, resumeActor: "maintainer" });
	assert.equal(f.state().implemented_pr, 43);
	assert.equal(f.tasks.length, 2);
});

test("auto-merge enabled without a trusted gate still makes zero merge or code mutations", async () => {
	const f = fixture("pr");
	await reconcile({ ...options, github: f.github });
	for (const kind of ["review-copilot", "review-claude"] as const)
		f.complete(kind, cleanReview);
	await reconcile({ ...options, github: f.github, autoMerge: true });
	assert.equal(f.state().phase, "human");
	assert.match(f.state().outcome, /merge authorization/);
	assert.equal(
		f.mutations.some(
			(item) => item.path.endsWith("/merge") || item.method === "GRAPHQL",
		),
		false,
	);
});

test("changed App reservation or manual rerun between report validation and CAS blocks writes", async () => {
	for (const trigger of ["reservation", "rerun"] as const) {
		const f = fixture();
		await reconcile({ ...options, github: f.github });
		f.complete("fitness", readyFitness);
		await reconcile({ ...options, github: f.github });
		f.complete("implement", change);
		const request = f.github.request;
		f.github.request = async (method, path, body) => {
			const response = await request(method, path, body);
			if (path.includes("/branches/")) {
				if (trigger === "rerun") {
					const run = f.runs.at(-1);
					assert.ok(run);
					run.run_attempt = 2;
				} else {
					const current = f.state(),
						slot = current.slots.implement,
						comment = f.comments[0];
					assert.ok(slot && comment);
					slot.task.instruction = "Changed reservation";
					comment.body = renderState(current);
				}
			}
			return response;
		};
		await reconcile({ ...options, github: f.github });
		assert.equal(
			f.mutations.some((item) => item.method === "GRAPHQL"),
			false,
		);
	}
});

test("write workers observe their active phase in the reservation before dispatch", async () => {
	for (const subject of ["issue", "pr"] as const) {
		const f = fixture(subject);
		const request = f.github.request;
		f.github.request = async (method, path, body) => {
			if (path.endsWith("/dispatches") && !path.includes("/test.yml/")) {
				const task = parseWorkerTask(
					JSON.parse(string(object(object(body).inputs).task)),
				);
				if (task.kind === "implement" || task.kind === "reimplement")
					assert.equal(f.state().phase, "implementing");
			}
			return request(method, path, body);
		};
		await reconcile({ ...options, github: f.github });
		if (subject === "issue") f.complete("fitness", readyFitness);
		else
			for (const kind of ["review-copilot", "review-claude"] as const) {
				f.complete(kind, {
					...cleanReview,
					merge_eligible: false,
					findings: [
						{
							severity: "high",
							path: "src/commands/example.ts",
							line: 1,
							title: "Bug",
							body: "Reproduce and fix",
						},
					],
				});
			}
		await reconcile({ ...options, github: f.github });
		assert.equal(
			f.tasks.at(-1)?.kind,
			subject === "issue" ? "implement" : "reimplement",
		);
	}
});

test("automation switches use exact true and the namespaced merge variable", () => {
	assert.deepEqual(automationSwitches({}), {
		enabled: false,
		autoMerge: false,
	});
	assert.deepEqual(
		automationSwitches({
			C8CTL_AUTOMATION_ENABLED: "true",
			C8CTL_AUTO_MERGE_ENABLED: "true",
		}),
		{ enabled: true, autoMerge: true },
	);
	assert.deepEqual(
		automationSwitches({
			C8CTL_AUTOMATION_ENABLED: "TRUE",
			AUTO_MERGE_ENABLED: "true",
		}),
		{ enabled: false, autoMerge: false },
	);
});

test("fork remediation inherits the spent session and cannot dispatch a fourth fix", async () => {
	const f = fixture("pr");
	object(f.pr.head).repo = { full_name: "contributor/c8ctl" };
	await reconcile({ ...options, github: f.github });
	const parent = f.state(),
		comment = f.comments[0];
	assert.ok(comment);
	comment.body = renderState({
		...parent,
		slots: {},
		reimplementation_attempts: 2,
		total_dispatches: 12,
	});
	await reconcile({ ...options, github: f.github });
	const findings = {
		...cleanReview,
		merge_eligible: false,
		findings: [
			{
				severity: "high",
				path: "src/commands/example.ts",
				line: 1,
				title: "Remaining bug",
				body: "Fix with regression evidence",
			},
		],
	};
	for (const kind of ["review-copilot", "review-claude"] as const)
		f.complete(kind, findings);
	await reconcile({ ...options, github: f.github });
	f.complete("reimplement", change);
	await reconcile({ ...options, github: f.github });
	const original = f.state(),
		child = f.state(43);
	assert.equal(child.reimplementation_attempts, 3);
	assert.equal(child.total_dispatches, original.total_dispatches);
	assert.equal(child.deadline, original.deadline);
	assert.equal(child.generation, original.generation);
	await reconcile({ ...options, github: f.github, number: 43 });
	for (const kind of ["review-copilot", "review-claude"] as const)
		f.complete(kind, findings);
	await reconcile({ ...options, github: f.github, number: 43 });
	assert.equal(f.state(43).phase, "blocked");
	assert.equal(
		f.tasks.filter((task) => task.number === 43 && task.kind === "reimplement")
			.length,
		0,
	);
});

test("remediation PR event can recover inherited session before its state comment exists", async () => {
	const f = fixture("pr");
	object(f.pr.head).repo = { full_name: "contributor/c8ctl" };
	await reconcile({ ...options, github: f.github });
	for (const kind of ["review-copilot", "review-claude"] as const)
		f.complete(kind, {
			...cleanReview,
			merge_eligible: false,
			findings: [
				{
					severity: "high",
					path: "src/commands/example.ts",
					line: 1,
					title: "Bug",
					body: "Fix",
				},
			],
		});
	await reconcile({ ...options, github: f.github });
	f.complete("reimplement", change);
	await reconcile({ ...options, github: f.github });
	f.childComments.length = 0;
	const original = f.state();
	await reconcile({ ...options, github: f.github, number: 43 });
	assert.equal(f.state(43).generation, original.generation);
	assert.equal(
		f.state(43).reimplementation_attempts,
		original.reimplementation_attempts,
	);
	assert.equal(f.state(43).total_dispatches, original.total_dispatches + 3);
	assert.equal(f.state(43).deadline, original.deadline);
});

test("unchanged reconciliations never patch comments, reviewers exclude peer reports, and oversized feedback blocks", async () => {
	const f = fixture("pr");
	await reconcile({ ...options, github: f.github });
	await reconcile({ ...options, github: f.github });
	const before = f.mutations.length;
	await reconcile({ ...options, github: f.github });
	assert.equal(f.mutations.length, before);
	assert.ok(
		f.tasks.every((task) =>
			task.instruction.includes("Do not read peer reports before submitting"),
		),
	);
	const report = {
		...cleanReview,
		merge_eligible: false,
		findings: Array.from({ length: 10 }, (_, line) => ({
			severity: "high",
			path: "src/commands/example.ts",
			line: line + 1,
			title: "Bug",
			body: "x".repeat(3000),
		})),
	};
	for (const kind of ["review-copilot", "review-claude"] as const)
		f.complete(kind, report);
	await reconcile({ ...options, github: f.github });
	assert.equal(f.state().phase, "blocked");
	assert.match(f.state().outcome, /instruction limit/);
	assert.equal(f.tasks.filter((task) => task.kind === "reimplement").length, 0);
});
