import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { crc32 } from "node:zlib";
import type { CIReceipt, CITask } from "../../scripts/agentic/ci.ts";
import type {
	ReviewEnvelope,
	WorkerTask,
} from "../../scripts/agentic/contracts.ts";
import type { ConvergenceInput } from "../../scripts/agentic/convergence.ts";
import { GitHub, object } from "../../scripts/agentic/github.ts";
import {
	type MergeOptions,
	mergePullRequest,
} from "../../scripts/agentic/merge.ts";

const repository = "camunda/c8ctl";
const root = `/repos/${repository}`;
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const mergeSha = "c".repeat(40);
const releaseSha = "d".repeat(40);
const mergedSha = "e".repeat(40);
const bot = "c8ctl-automation[bot]";
const releaseTag = "v1.2.3-alpha.1";
const attribution =
	"Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>";

const releaseConfig = {
	branches: [
		"release",
		{ name: "main", prerelease: "alpha", channel: "alpha" },
	],
	plugins: [
		"@semantic-release/commit-analyzer",
		"@semantic-release/release-notes-generator",
		["@semantic-release/npm", { npmPublish: true }],
		[
			"@semantic-release/github",
			{
				successComment: `This has been released in \${nextRelease.version}.`,
				failComment: false,
			},
		],
	],
};

function proof(): ConvergenceInput {
	const task: WorkerTask = {
		version: 1,
		kind: "review-copilot",
		repository,
		number: 577,
		generation: "generation-123456789",
		correlation: "12345678-1234-4234-8234-123456789abc",
		head_sha: headSha,
		base_sha: baseSha,
		issue_revision: "",
		attempt: 3,
		state_comment_id: 123,
		instruction: "Review the full diff.",
	};
	const copilot: ReviewEnvelope = {
		schema_version: 1,
		repository,
		task,
		engine: "copilot",
		run_id: 301,
		run_attempt: 1,
		workflow_sha: baseSha,
		report: {
			schema_version: 1,
			status: "complete",
			findings: [],
			change_class: "patch",
			release_intent: "patch",
			merge_eligible: true,
			evidence: "Regression fails before the fix and passes afterward.",
			blockers: [],
		},
	};
	const claude: ReviewEnvelope = {
		...copilot,
		engine: "claude",
		run_id: 302,
		task: {
			...task,
			kind: "review-claude",
			correlation: "22345678-1234-4234-8234-123456789abc",
		},
	};
	return {
		snapshot: { head_sha: headSha, base_sha: baseSha },
		state: {
			head_sha: headSha,
			base_sha: baseSha,
			reimplementation_attempts: 3,
			phase: "reviewing",
			deadline: "2099-01-01T00:00:00Z",
		},
		expected: { copilot: task, claude: claude.task },
		reviews: {
			copilot: { status: "completed", envelope: copilot },
			claude: { status: "completed", envelope: claude },
		},
		ci: "success",
		now: "2026-09-18T18:00:00Z",
	};
}

interface Call {
	method: string;
	path: string;
	url: URL;
	body: unknown;
}
interface Reply {
	data: unknown;
	body?: ArrayBuffer;
	status?: number;
	headers?: Record<string, string>;
}
type Handler = (call: Call, count: number) => Reply;

function empty<T>(): T[] {
	return [];
}

function receiptArchive(receipt: CIReceipt): Uint8Array<ArrayBuffer> {
	const content = Buffer.from(JSON.stringify(receipt));
	const name = Buffer.from("report.json");
	const checksum = crc32(content);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50);
	local.writeUInt16LE(20, 4);
	local.writeUInt32LE(checksum, 14);
	local.writeUInt32LE(content.length, 18);
	local.writeUInt32LE(content.length, 22);
	local.writeUInt16LE(name.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50);
	central.writeUInt16LE(0x0314, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt32LE(checksum, 16);
	central.writeUInt32LE(content.length, 20);
	central.writeUInt32LE(content.length, 24);
	central.writeUInt16LE(name.length, 28);
	central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + name.length, 12);
	end.writeUInt32LE(local.length + name.length + content.length, 16);
	return Uint8Array.from(
		Buffer.concat([local, name, content, central, name, end]),
	);
}

function fixture() {
	const calls: Call[] = [];
	const routes = new Map<string, Handler>();
	const counts = new Map<string, number>();
	const route = (method: string, path: string, handler: Handler) =>
		routes.set(`${method} ${path}`, handler);
	const repo = {
		id: 1,
		full_name: repository,
		default_branch: "main",
		fork: false,
		archived: false,
		disabled: false,
		allow_squash_merge: true,
		permissions: { push: true },
	};
	const pr = {
		number: 577,
		state: "open",
		draft: false,
		title: "fix: reject invalid input",
		body: "Untrusted description.\n\nBREAKING CHANGE: never copy this into a commit.",
		mergeable: true,
		mergeable_state: "clean",
		merge_commit_sha: mergeSha,
		changed_files: 1,
		labels: empty<{ name: string }>(),
		user: { login: "contributor", type: "User" },
		head: { sha: headSha, ref: "fix/input", repo: { ...repo } },
		base: { sha: baseSha, ref: "main", repo: { ...repo } },
	};
	const branch = { protected: true, commit: { sha: baseSha } };
	const protection = {
		required_status_checks: {
			strict: true,
			contexts: ["Lint", "Typecheck"],
			checks: [
				{ context: "Lint", app_id: 15368 },
				{ context: "Typecheck", app_id: 15368 },
			],
		},
		enforce_admins: { enabled: true },
		required_pull_request_reviews: {
			dismiss_stale_reviews: true,
			require_code_owner_reviews: true,
			required_approving_review_count: 1,
			require_last_push_approval: false,
			bypass_pull_request_allowances: {
				users: empty<unknown>(),
				teams: empty<unknown>(),
				apps: empty<unknown>(),
			},
		},
		required_conversation_resolution: { enabled: true },
		allow_force_pushes: { enabled: false },
		allow_deletions: { enabled: false },
		lock_branch: { enabled: false },
	};
	const ciTask: CITask = {
		version: 1,
		repository,
		number: 577,
		generation: "generation-123456789",
		correlation: "33345678-1234-4234-8234-123456789abc",
		head_sha: headSha,
		base_sha: baseSha,
		merge_sha: mergeSha,
		state_comment_id: 123,
		attempt: 3,
	};
	const strongReceipt: CIReceipt = {
		schema_version: 1,
		repository,
		task: structuredClone(ciTask),
		run_id: 801,
		run_attempt: 1,
		workflow_sha: baseSha,
		tested_sha: mergeSha,
		jobs: {
			lint: "success",
			typecheck: "success",
			unit: "success",
			integration: "success",
		},
	};
	const data = {
		repo,
		pr,
		branch,
		protection,
		enabled: "true",
		autoMerge: "true",
		files: [{ filename: "src/core/validation.ts", status: "modified" }],
		rules: empty<unknown>(),
		rulesets: empty<unknown>(),
		reviews: [
			{
				id: 10,
				user: { id: 20, login: "maintainer", type: "User" },
				state: "APPROVED",
				commit_id: headSha,
				author_association: "MEMBER",
			},
		],
		graphql: {
			headRefOid: headSha,
			baseRefOid: baseSha,
			baseRefName: "main",
			isDraft: false,
			isCrossRepository: false,
			mergeable: "MERGEABLE",
			mergeStateStatus: "CLEAN",
			reviewDecision: "APPROVED",
			isInMergeQueue: false,
			reviewThreads: {
				totalCount: 0,
				nodes: empty<{ id: string; isResolved: boolean }>(),
				pageInfo: { hasNextPage: false, endCursor: null },
			},
		},
		checkRuns: ["Lint", "Typecheck"].map((name, index) => ({
			id: index + 100,
			name,
			head_sha: headSha,
			details_url: `https://github.com/${repository}/actions/runs/501/job/${index + 700}`,
			app: { id: 15368 },
			status: "completed",
			conclusion: "success",
		})),
		ciRun: {
			id: 501,
			workflow_id: 1,
			run_attempt: 1,
			path: ".github/workflows/test.yml",
			event: "pull_request",
			status: "completed",
			conclusion: "success",
			head_sha: headSha,
			head_branch: "fix/input",
			pull_requests: [
				{ number: 577, head: { sha: headSha }, base: { sha: baseSha } },
			],
		},
		ciJobs: [
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
		].map((name, index) => ({
			name,
			id: index + 700,
			run_id: 501,
			head_sha: headSha,
			check_run_url: `https://api.github.com${root}/check-runs/${index + 100}`,
			status: "completed",
			conclusion: "success",
		})),
		strongReceipt,
		strongRun: {
			id: 801,
			workflow_id: 1,
			run_attempt: 1,
			path: ".github/workflows/test.yml",
			display_title: `c8ctl-ci-${ciTask.correlation}`,
			event: "workflow_dispatch",
			status: "completed",
			conclusion: "success",
			head_sha: baseSha,
			head_branch: "main",
			actor: { login: bot, type: "Bot" },
			triggering_actor: { login: bot, type: "Bot" },
			pull_requests: [],
			created_at: "2026-09-18T18:01:00Z",
		},
		releaseRun: {
			id: 601,
			workflow_id: 2,
			run_attempt: 1,
			path: ".github/workflows/release.yml",
			event: "push",
			status: "completed",
			conclusion: "success",
			head_sha: baseSha,
			head_branch: "main",
		},
		releaseJobs: [
			...[22, 24].flatMap((node) =>
				["8.8", "8.9", "8.10"].map(
					(version) => `Test (Node ${node} - Camunda ${version})`,
				),
			),
			"Release",
		].map((name) => ({ name, status: "completed", conclusion: "success" })),
		config: structuredClone(releaseConfig),
		releases: [
			{
				tag_name: releaseTag,
				prerelease: true,
				draft: false,
				published_at: "2026-09-17T18:00:00Z",
			},
		],
		comparison: {
			status: "ahead",
			base_commit: { sha: releaseSha },
			merge_base_commit: { sha: releaseSha },
			total_commits: 1,
			commits: [
				{ sha: baseSha, commit: { message: "chore: address review feedback" } },
			],
		},
	};
	route("GET", root, () => ({ data: data.repo }));
	route("GET", `${root}/pulls/577`, () => ({ data: data.pr }));
	route("GET", `${root}/branches/main`, () => ({ data: data.branch }));
	route("GET", `${root}/actions/variables/C8CTL_AUTOMATION_ENABLED`, () => ({
		data: { name: "C8CTL_AUTOMATION_ENABLED", value: data.enabled },
	}));
	route("GET", `${root}/actions/variables/C8CTL_AUTO_MERGE_ENABLED`, () => ({
		data: { name: "C8CTL_AUTO_MERGE_ENABLED", value: data.autoMerge },
	}));
	route("GET", `${root}/pulls/577/files`, () => ({ data: data.files }));
	route("GET", `${root}/branches/main/protection`, () => ({
		data: data.protection,
	}));
	route("GET", `${root}/rules/branches/main`, () => ({ data: data.rules }));
	route("GET", `${root}/rulesets`, () => ({ data: data.rulesets }));
	route("GET", `${root}/pulls/577/reviews`, () => ({ data: data.reviews }));
	route("POST", "/graphql", (call) => {
		assert.match(String(object(call.body).query), /^query /);
		return { data: { data: { repository: { pullRequest: data.graphql } } } };
	});
	route("GET", `${root}/commits/${headSha}/check-runs`, () => ({
		data: { total_count: data.checkRuns.length, check_runs: data.checkRuns },
	}));
	route("GET", `${root}/commits/${mergeSha}/check-runs`, () => ({
		data: { total_count: 0, check_runs: [] },
	}));
	route("GET", `${root}/actions/workflows/test.yml`, () => ({
		data: { id: 1, path: ".github/workflows/test.yml", state: "active" },
	}));
	route("GET", `${root}/actions/workflows/1/runs`, (call) => {
		const runs =
			call.url.searchParams.get("event") === "workflow_dispatch"
				? [data.strongRun]
				: call.url.searchParams.get("head_sha") === headSha
					? [data.ciRun]
					: [];
		return { data: { total_count: runs.length, workflow_runs: runs } };
	});
	route("GET", `${root}/actions/runs/501`, () => ({ data: data.ciRun }));
	route("GET", `${root}/actions/runs/501/attempts/1/jobs`, () => ({
		data: { total_count: data.ciJobs.length, jobs: data.ciJobs },
	}));
	route("GET", `${root}/commits/${mergeSha}`, () => ({
		data: { sha: mergeSha, parents: [{ sha: baseSha }, { sha: headSha }] },
	}));
	route("GET", `${root}/actions/runs/801`, () => ({ data: data.strongRun }));
	route("GET", `${root}/actions/runs/801/attempts/1/jobs`, () => {
		const jobs = [
			...data.ciJobs.map((job, index) => ({
				...job,
				id: index + 1800,
				run_id: 801,
				head_sha: baseSha,
				check_run_url: `https://api.github.com${root}/check-runs/${index + 800}`,
			})),
			{
				name: "Agentic CI Revision",
				status: "completed",
				conclusion: "success",
				run_id: 801,
				head_sha: baseSha,
			},
			{
				name: "Agentic CI Receipt",
				status: "completed",
				conclusion: "success",
				run_id: 801,
				head_sha: baseSha,
			},
		];
		return { data: { total_count: jobs.length, jobs } };
	});
	route("GET", `${root}/actions/runs/801/artifacts`, () => ({
		data: {
			total_count: 1,
			artifacts: [
				{
					id: 901,
					name: `ci-report-${ciTask.correlation}-1`,
					expired: false,
					workflow_run: { id: 801, head_sha: baseSha },
					digest: `sha256:${createHash("sha256").update(receiptArchive(data.strongReceipt)).digest("hex")}`,
				},
			],
		},
	}));
	route("GET", `${root}/actions/artifacts/901/zip`, () => ({
		data: null,
		body: receiptArchive(data.strongReceipt).buffer,
	}));
	route("GET", `${root}/actions/workflows/release.yml`, () => ({
		data: { id: 2, path: ".github/workflows/release.yml", state: "active" },
	}));
	route("GET", `${root}/actions/workflows/2/runs`, () => ({
		data: { total_count: 1, workflow_runs: [data.releaseRun] },
	}));
	route("GET", `${root}/actions/runs/601/attempts/1/jobs`, () => ({
		data: { total_count: data.releaseJobs.length, jobs: data.releaseJobs },
	}));
	route("GET", `${root}/contents/.releaserc.json`, (call) => {
		assert.equal(call.url.searchParams.get("ref"), baseSha);
		const content = JSON.stringify(data.config);
		return {
			data: {
				type: "file",
				path: ".releaserc.json",
				sha: "1".repeat(40),
				encoding: "base64",
				size: Buffer.byteLength(content),
				content: Buffer.from(content).toString("base64"),
			},
		};
	});
	route("GET", `${root}/releases`, () => ({ data: data.releases }));
	route("GET", `${root}/git/ref/tags/${releaseTag}`, () => ({
		data: {
			ref: `refs/tags/${releaseTag}`,
			object: { type: "commit", sha: releaseSha },
		},
	}));
	route("GET", `${root}/compare/${releaseSha}...${baseSha}`, () => ({
		data: data.comparison,
	}));
	route("PUT", `${root}/pulls/577/merge`, () => ({
		data: { merged: true, sha: mergedSha },
	}));
	const github = new GitHub({
		token: "test-token",
		fetch: async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			assert.equal(url.origin, "https://api.github.com");
			const call: Call = {
				method: init?.method ?? "GET",
				path: url.pathname,
				url,
				body:
					typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			};
			calls.push(call);
			const key = `${call.method} ${call.path}`;
			const count = (counts.get(key) ?? 0) + 1;
			counts.set(key, count);
			const handler = routes.get(key);
			const reply = handler?.(call, count) ?? {
				status: 500,
				data: { message: `Unexpected endpoint ${key}` },
			};
			return new Response(reply.body ?? JSON.stringify(reply.data), {
				status: reply.status ?? 200,
				headers: { "content-type": "application/json", ...reply.headers },
			});
		},
	});
	let guards = 0;
	const options: MergeOptions = {
		github,
		repository,
		number: 577,
		headSha,
		baseSha,
		changeClass: "patch",
		releaseIntent: "patch",
		appBotLogin: bot,
		proof: proof(),
		ciSlot: {
			task: structuredClone(ciTask),
			run_id: 801,
			run_attempt: 1,
			artifact_id: 901,
			dispatched_at: "2026-09-18T18:00:00Z",
		},
		guard: async () => {
			guards++;
		},
	};
	return { options, data, calls, route, guards: () => guards };
}

type Scenario = ReturnType<typeof fixture>;

function requireAggregate(scenario: Scenario) {
	scenario.data.protection.required_status_checks.contexts.push(
		"c8ctl/agentic",
	);
	scenario.data.protection.required_status_checks.checks.push({
		context: "c8ctl/agentic",
		app_id: 5001,
	});
	const status = {
		id: 900,
		state: "success",
		context: "c8ctl/agentic",
		creator: { id: 5002, login: bot, type: "Bot" },
	};
	const app = { id: 5001, slug: "c8ctl-automation" };
	scenario.route("GET", "/apps/c8ctl-automation", () => ({ data: app }));
	scenario.route("GET", `${root}/commits/${headSha}/statuses`, () => ({
		data: [status],
	}));
	scenario.route("GET", `${root}/commits/${mergeSha}/statuses`, () => ({
		data: [],
	}));
	return { status, app };
}

async function blocked(scenario: Scenario, reason: RegExp) {
	const result = await mergePullRequest(scenario.options);
	assert.equal(result.merged, false, JSON.stringify(result));
	assert.match(result.reason, reason);
	assert.equal(
		scenario.calls.filter((call) => call.method === "PUT").length,
		0,
	);
	assert.ok(
		scenario.calls.every(
			(call) =>
				call.method === "GET" ||
				(call.method === "POST" && call.path === "/graphql"),
		),
	);
}

describe("guarded squash merge", () => {
	test("a clean third attempt merges once with an exact head SHA and safe squash body", async () => {
		const scenario = fixture();
		const before = JSON.stringify(scenario.options.proof);
		const result = await mergePullRequest(scenario.options);
		assert.equal(
			result.merged,
			true,
			`${result.reason}\n${scenario.calls.map((call) => call.path).join("\n")}`,
		);
		assert.equal(result.sha, mergedSha);
		assert.equal(JSON.stringify(scenario.options.proof), before);
		assert.ok(scenario.guards() >= 1);
		const writes = scenario.calls.filter((call) => call.method === "PUT");
		assert.equal(writes.length, 1);
		assert.deepEqual(writes[0]?.body, {
			sha: headSha,
			merge_method: "squash",
			commit_title: "fix: reject invalid input",
			commit_message: attribution,
		});
		for (const path of [
			`${root}/pulls/577`,
			`${root}/branches/main`,
			`${root}/actions/variables/C8CTL_AUTOMATION_ENABLED`,
			`${root}/actions/variables/C8CTL_AUTO_MERGE_ENABLED`,
			`${root}/actions/workflows/1/runs`,
			`${root}/actions/workflows/2/runs`,
		]) {
			assert.ok(
				scenario.calls.filter((call) => call.path === path).length >= 2,
				path,
			);
		}
	});

	test("minor intent comes from matching reports rather than title or last chore commit", async () => {
		const scenario = fixture();
		scenario.options.changeClass = "additive-minor";
		scenario.options.releaseIntent = "minor";
		for (const observation of Object.values(scenario.options.proof.reviews)) {
			if (observation.status === "completed") {
				observation.envelope.report.change_class = "additive-minor";
				observation.envelope.report.release_intent = "minor";
			}
		}
		scenario.data.pr.title = "feat(cli): add validation";
		assert.equal((await mergePullRequest(scenario.options)).merged, true);
		assert.equal(
			object(scenario.calls.at(-1)?.body).commit_title,
			scenario.data.pr.title,
		);
	});

	test("the coordinator seam needs only eligible proof, not a duplicate change-class authority", async () => {
		const scenario = fixture();
		delete scenario.options.changeClass;
		assert.equal((await mergePullRequest(scenario.options)).merged, true);
	});

	test("missing, dirty, stale, expired or mismatched proof never reaches a merge", async () => {
		for (const mutate of [
			(s: Scenario) => {
				s.options.proof.reviews.claude = { status: "waiting" };
			},
			(s: Scenario) => {
				s.options.proof.expected.copilot.head_sha = "f".repeat(40);
			},
			(s: Scenario) => {
				s.options.proof.expected.copilot.repository = "other/repo";
			},
			(s: Scenario) => {
				s.options.proof.expected.copilot.number = 578;
			},
			(s: Scenario) => {
				s.options.proof.state.deadline = "2000-01-01T00:00:00Z";
			},
			(s: Scenario) => {
				s.options.releaseIntent = "minor";
			},
			(s: Scenario) => {
				s.options.changeClass = "additive-minor";
			},
		]) {
			const scenario = fixture();
			mutate(scenario);
			await blocked(scenario, /proof|review|revision|intent|class|deadline/i);
		}
	});

	test("all initial repository, PR, switch and immutable revision gates fail closed", async () => {
		for (const [mutate, reason] of [
			[
				(s: Scenario) => {
					s.data.repo.permissions.push = false;
				},
				/permission/i,
			],
			[
				(s: Scenario) => {
					s.data.repo.default_branch = "develop";
				},
				/main/i,
			],
			[
				(s: Scenario) => {
					s.data.repo.allow_squash_merge = false;
				},
				/squash/i,
			],
			[
				(s: Scenario) => {
					s.data.repo.archived = true;
				},
				/archiv|repository/i,
			],
			[
				(s: Scenario) => {
					s.data.pr.state = "closed";
				},
				/open|closed/i,
			],
			[
				(s: Scenario) => {
					s.data.pr.draft = true;
				},
				/draft/i,
			],
			[
				(s: Scenario) => {
					s.data.pr.base.ref = "release";
				},
				/main/i,
			],
			[
				(s: Scenario) => {
					s.data.pr.head.repo.id = 2;
				},
				/fork|repository/i,
			],
			[
				(s: Scenario) => {
					s.data.pr.head.repo.fork = true;
				},
				/fork/i,
			],
			[
				(s: Scenario) => {
					s.data.pr.mergeable = false;
				},
				/conflict|mergeable/i,
			],
			[
				(s: Scenario) => {
					s.data.pr.mergeable_state = "behind";
				},
				/up.to.date|clean|behind/i,
			],
			[
				(s: Scenario) => {
					s.data.pr.head.sha = "f".repeat(40);
				},
				/head|revision/i,
			],
			[
				(s: Scenario) => {
					s.data.branch.commit.sha = "f".repeat(40);
				},
				/base|revision|main/i,
			],
			[
				(s: Scenario) => {
					s.data.pr.labels.push({ name: "agentic:hold" });
				},
				/hold/i,
			],
			[
				(s: Scenario) => {
					s.data.enabled = "false";
				},
				/switch|disabled/i,
			],
			[
				(s: Scenario) => {
					s.data.autoMerge = "false";
				},
				/switch|disabled/i,
			],
		] as const) {
			const scenario = fixture();
			mutate(scenario);
			await blocked(scenario, reason);
		}
	});

	test("whole-diff pagination, renames, deleted tests and count mismatches are guarded", async () => {
		for (const [path, status] of [
			["scripts/policy.ts", "modified"],
			["src/core/auth.ts", "modified"],
			["tests/unit/guard.test.ts", "removed"],
			["package.json", "modified"],
		]) {
			const scenario = fixture();
			scenario.data.files = [{ filename: path, status }];
			await blocked(scenario, /manual|protected|test|dependency|auth|script/i);
		}
		const renamed = fixture();
		renamed.route("GET", `${root}/pulls/577/files`, () => ({
			data: [
				{
					filename: "docs/moved.md",
					status: "renamed",
					previous_filename: ".github/workflows/test.yml",
				},
			],
		}));
		await blocked(renamed, /workflow|protected/i);
		for (const count of [0, 2, 3001]) {
			const scenario = fixture();
			scenario.data.pr.changed_files = count;
			await blocked(scenario, /diff|file|complete/i);
		}
		const paginated = fixture();
		paginated.data.pr.changed_files = 101;
		paginated.route("GET", `${root}/pulls/577/files`, (call) => {
			const first = call.url.searchParams.get("page") === "1";
			return first
				? {
						data: Array.from({ length: 100 }, (_, index) => ({
							filename: `src/file-${index}.ts`,
							status: "modified",
						})),
						headers: {
							link: `<https://api.github.com${root}/pulls/577/files?page=2>; rel="next"`,
						},
					}
				: { data: [{ filename: "docs/CLAUDE.md", status: "added" }] };
		});
		await blocked(paginated, /instruction|protected/i);
		assert.ok(
			paginated.calls.some((call) => call.url.searchParams.get("page") === "2"),
		);
	});

	test("unprotected, bypassable, non-strict and unsupported rules never permit a merge", async () => {
		for (const [mutate, reason] of [
			[
				(s: Scenario) => {
					s.data.branch.protected = false;
				},
				/protect/i,
			],
			[
				(s: Scenario) => {
					s.data.protection.required_status_checks.strict = false;
				},
				/strict/i,
			],
			[
				(s: Scenario) => {
					s.data.protection.enforce_admins.enabled = false;
				},
				/admin|bypass/i,
			],
			[
				(s: Scenario) => {
					s.data.protection.required_pull_request_reviews.bypass_pull_request_allowances.apps.push(
						{ slug: bot },
					);
				},
				/bypass/i,
			],
			[
				(s: Scenario) => {
					s.data.protection.required_conversation_resolution.enabled = false;
				},
				/conversation|thread/i,
			],
			[
				(s: Scenario) => {
					s.data.protection.required_pull_request_reviews.dismiss_stale_reviews = false;
				},
				/stale/i,
			],
			[
				(s: Scenario) => {
					s.data.protection.allow_force_pushes.enabled = true;
				},
				/force|protect/i,
			],
			[
				(s: Scenario) => {
					s.data.rules.push({ type: "merge_queue" });
				},
				/queue/i,
			],
			[
				(s: Scenario) => {
					s.data.rules.push({ type: "unknown_rule" });
				},
				/unsupported|rule/i,
			],
			[
				(s: Scenario) => {
					s.data.rulesets.push({
						id: 1,
						enforcement: "active",
						target: "branch",
					});
				},
				/rule/i,
			],
			[
				(s: Scenario) => {
					s.data.protection.required_status_checks.checks[0].app_id = -1;
				},
				/app|check/i,
			],
		] as const) {
			const scenario = fixture();
			mutate(scenario);
			await blocked(scenario, reason);
		}
		for (const status of [403, 404]) {
			const scenario = fixture();
			scenario.route("GET", `${root}/branches/main/protection`, () => ({
				status,
				data: {},
			}));
			await blocked(scenario, /manual|protect|403|404/i);
		}
	});

	test("unresolved threads on later GraphQL pages and missing/inconsistent pages block", async () => {
		const scenario = fixture();
		scenario.route("POST", "/graphql", (call) => {
			const cursor = object(object(call.body).variables).cursor;
			return {
				data: {
					data: {
						repository: {
							pullRequest: {
								...scenario.data.graphql,
								reviewThreads:
									cursor === null
										? {
												totalCount: 2,
												nodes: [{ id: "thread1", isResolved: true }],
												pageInfo: { hasNextPage: true, endCursor: "cursor1" },
											}
										: {
												totalCount: 2,
												nodes: [{ id: "thread2", isResolved: false }],
												pageInfo: { hasNextPage: false, endCursor: "cursor2" },
											},
							},
						},
					},
				},
			};
		});
		await blocked(scenario, /unresolved|thread/i);
		assert.equal(
			scenario.calls.filter((call) => call.path === "/graphql").length,
			2,
		);
		const incomplete = fixture();
		incomplete.data.graphql.reviewThreads.totalCount = 1;
		await blocked(incomplete, /thread|complete/i);
	});

	test("latest substantive reviews, required approvals and GitHub review decision must all agree", async () => {
		for (const mutate of [
			(s: Scenario) => {
				s.data.reviews[0].state = "CHANGES_REQUESTED";
			},
			(s: Scenario) => {
				s.data.reviews[0].commit_id = releaseSha;
			},
			(s: Scenario) => {
				s.data.reviews[0].user.login = bot;
				s.data.reviews[0].user.type = "Bot";
			},
			(s: Scenario) => {
				s.data.graphql.reviewDecision = "REVIEW_REQUIRED";
			},
			(s: Scenario) => {
				s.data.graphql.reviewDecision = "CHANGES_REQUESTED";
			},
			(s: Scenario) => {
				s.data.graphql.isInMergeQueue = true;
			},
		]) {
			const scenario = fixture();
			mutate(scenario);
			await blocked(scenario, /review|approval|queue/i);
		}
		const commented = fixture();
		const initial = commented.data.reviews[0];
		commented.data.reviews = [
			{ ...initial, state: "CHANGES_REQUESTED" },
			{ ...initial, id: 11, state: "COMMENTED" },
		];
		await blocked(commented, /blocking|review/i);
		const approved = fixture();
		approved.data.reviews = [
			{ ...approved.data.reviews[0], state: "CHANGES_REQUESTED" },
			{ ...approved.data.reviews[0], id: 11, state: "APPROVED" },
		];
		assert.equal((await mergePullRequest(approved.options)).merged, true);
	});

	test("required checks and exact Test matrix reject missing, stale, skipped or spoofed success", async () => {
		for (const mutate of [
			(s: Scenario) => {
				s.data.checkRuns[0].conclusion = "skipped";
			},
			(s: Scenario) => {
				s.data.checkRuns[0].status = "in_progress";
			},
			(s: Scenario) => {
				s.data.checkRuns[0].app.id = 99;
			},
			(s: Scenario) => {
				s.data.checkRuns[0].head_sha = releaseSha;
			},
			(s: Scenario) => {
				s.data.checkRuns.pop();
			},
			(s: Scenario) => {
				s.data.ciJobs[0].conclusion = "skipped";
			},
			(s: Scenario) => {
				s.data.ciJobs.pop();
			},
			(s: Scenario) => {
				s.data.ciRun.pull_requests[0].base.sha = releaseSha;
			},
		]) {
			const scenario = fixture();
			mutate(scenario);
			await blocked(scenario, /check|CI|job|Test/i);
		}
		const synthetic = fixture();
		synthetic.route("GET", `${root}/commits/${mergeSha}/check-runs`, () => ({
			data: {
				total_count: 2,
				check_runs: synthetic.data.checkRuns.map((run) => ({
					...run,
					head_sha: mergeSha,
					conclusion: "failure",
				})),
			},
		}));
		await blocked(synthetic, /check/i);
	});

	test("required source-head contexts must belong to the real latest Test run jobs", async () => {
		for (const mutate of [
			(s: Scenario) => {
				s.data.checkRuns[0].id = 999;
			},
			(s: Scenario) => {
				s.data.ciJobs[0].check_run_url = `https://example.com${root}/check-runs/100`;
			},
			(s: Scenario) => {
				s.data.ciJobs[0].check_run_url += "?forged=true";
			},
			(s: Scenario) => {
				s.data.ciJobs[0].check_run_url = `https://api.github.com/repos/contributor/c8ctl/check-runs/100`;
			},
			(s: Scenario) => {
				s.data.ciJobs[0].run_id = 777;
			},
			(s: Scenario) => {
				s.data.ciJobs[0].head_sha = baseSha;
			},
			(s: Scenario) => {
				s.data.ciJobs[0].name = "Unrelated job";
			},
			(s: Scenario) => {
				s.data.ciJobs.push({ ...s.data.ciJobs[0] });
			},
		]) {
			const scenario = fixture();
			mutate(scenario);
			await blocked(scenario, /check|job|Test/i);
		}
	});

	test("required-check run provenance is read from Test runs rather than details URL text", async () => {
		for (const mutate of [
			(s: Scenario) => {
				s.data.ciRun.workflow_id = 999;
			},
			(s: Scenario) => {
				s.data.ciRun.path = ".github/workflows/other.yml";
			},
			(s: Scenario) => {
				s.data.ciRun.event = "workflow_dispatch";
			},
			(s: Scenario) => {
				s.data.ciRun.head_sha = baseSha;
			},
			(s: Scenario) => {
				s.data.ciRun.head_branch = "other";
			},
			(s: Scenario) => {
				s.data.ciRun.status = "in_progress";
			},
			(s: Scenario) => {
				s.data.ciRun.conclusion = "failure";
			},
			(s: Scenario) => {
				s.route("GET", `${root}/actions/runs/501`, () => ({
					data: { ...s.data.ciRun, run_attempt: 2 },
				}));
			},
		]) {
			const scenario = fixture();
			mutate(scenario);
			await blocked(scenario, /Test|check|run/i);
		}
		const scenario = fixture();
		scenario.data.checkRuns[0].details_url =
			"https://example.com/not-authority";
		const result = await mergePullRequest(scenario.options);
		assert.equal(result.merged, true, result.reason);
		assert.ok(
			scenario.calls.some((call) => call.path === `${root}/actions/runs/501`),
		);
	});

	test("a later PR Test run cannot be replaced by successful check IDs from its predecessor", async () => {
		const scenario = fixture();
		scenario.route("GET", `${root}/actions/workflows/1/runs`, (call) => ({
			data:
				call.url.searchParams.get("event") === "workflow_dispatch"
					? { total_count: 1, workflow_runs: [scenario.data.strongRun] }
					: {
							total_count: 2,
							workflow_runs: [
								scenario.data.ciRun,
								{ ...scenario.data.ciRun, id: 502 },
							],
						},
		}));
		scenario.route("GET", `${root}/actions/runs/502`, () => ({
			data: { ...scenario.data.ciRun, id: 502 },
		}));
		scenario.route("GET", `${root}/actions/runs/502/attempts/1/jobs`, () => ({
			data: {
				total_count: scenario.data.ciJobs.length,
				jobs: scenario.data.ciJobs.map((job, index) => ({
					...job,
					run_id: 502,
					check_run_url: `https://api.github.com${root}/check-runs/${index + 200}`,
				})),
			},
		}));
		await blocked(scenario, /check|job|Test/i);
	});

	test("unknown success-shaped check responses cannot substitute for REST check runs", async () => {
		for (const data of [
			{ allChecks: [{ name: "Lint", status: "success" }] },
			{ total_count: 0, check_runs: [], conclusion: "success" },
			{ check_runs: [{ name: "Lint", conclusion: "success" }] },
		]) {
			const scenario = fixture();
			scenario.route("GET", `${root}/commits/${headSha}/check-runs`, () => ({
				data,
			}));
			await blocked(scenario, /check|JSON|integer/i);
		}
	});

	test("a clean known fork can merge through the base repository without writing the fork", async () => {
		const scenario = fixture();
		scenario.data.pr.head.repo.id = 2;
		scenario.data.pr.head.repo.full_name = "contributor/c8ctl";
		scenario.data.pr.head.repo.fork = true;
		scenario.data.graphql.isCrossRepository = true;
		scenario.data.ciRun.pull_requests = [];
		const result = await mergePullRequest(scenario.options);
		assert.equal(result.merged, true, result.reason);
		assert.ok(
			scenario.calls.every(
				(call) => !call.path.includes("/repos/contributor/"),
			),
		);
		assert.equal(
			scenario.calls.filter((call) => call.method === "PUT").length,
			1,
		);
	});

	test("trusted-main synthetic CI and ordinary source-head required checks are separate proofs", async () => {
		const scenario = fixture();
		scenario.data.ciRun.pull_requests = [];
		const before = JSON.stringify(scenario.options.ciSlot);
		const result = await mergePullRequest(scenario.options);
		assert.equal(result.merged, true, result.reason);
		assert.equal(JSON.stringify(scenario.options.ciSlot), before);
		assert.equal(scenario.data.ciRun.head_sha, headSha);
		assert.equal(scenario.data.strongRun.head_sha, baseSha);
		assert.equal(scenario.data.strongReceipt.tested_sha, mergeSha);
		for (const path of [
			`${root}/actions/runs/501/attempts/1/jobs`,
			`${root}/actions/runs/801/attempts/1/jobs`,
			`${root}/actions/runs/801/artifacts`,
		]) {
			assert.ok(
				scenario.calls.filter((call) => call.path === path).length >= 2,
				path,
			);
		}
	});

	test("required checks on the synthetic revision use their own PR Test jobs, not base CI jobs", async () => {
		const scenario = fixture();
		scenario.data.ciRun.head_sha = mergeSha;
		for (const job of scenario.data.ciJobs) job.head_sha = mergeSha;
		scenario.route("GET", `${root}/actions/workflows/1/runs`, (call) => ({
			data: {
				total_count: 1,
				workflow_runs: [
					call.url.searchParams.get("event") === "workflow_dispatch"
						? scenario.data.strongRun
						: scenario.data.ciRun,
				],
			},
		}));
		scenario.route("GET", `${root}/commits/${mergeSha}/check-runs`, () => ({
			data: {
				total_count: scenario.data.checkRuns.length,
				check_runs: scenario.data.checkRuns.map((run) => ({
					...run,
					head_sha: mergeSha,
				})),
			},
		}));
		const result = await mergePullRequest(scenario.options);
		assert.equal(result.merged, true, result.reason);
		assert.ok(
			scenario.calls.some(
				(call) =>
					call.path === `${root}/actions/workflows/1/runs` &&
					call.url.searchParams.get("head_sha") === mergeSha,
			),
		);
	});

	test("a cached success enum cannot replace exact reserved main-CI identity and receipt", async () => {
		for (const mutate of [
			(s: Scenario) => {
				s.options.ciSlot.run_id = null;
			},
			(s: Scenario) => {
				s.options.ciSlot.artifact_id = null;
			},
			(s: Scenario) => {
				s.options.ciSlot.task.base_sha = releaseSha;
			},
			(s: Scenario) => {
				s.options.ciSlot.task.merge_sha = releaseSha;
			},
			(s: Scenario) => {
				s.options.ciSlot.task.generation = "other-generation-123456";
			},
			(s: Scenario) => {
				s.options.ciSlot.task.attempt = 2;
			},
			(s: Scenario) => {
				s.options.ciSlot.task.state_comment_id = 999;
			},
			(s: Scenario) => {
				s.options.ciSlot.task.correlation =
					s.options.proof.expected.copilot.correlation;
			},
			(s: Scenario) => {
				s.data.strongReceipt.task.correlation =
					"44445678-1234-4234-8234-123456789abc";
			},
			(s: Scenario) => {
				s.data.strongReceipt.task.base_sha = releaseSha;
				s.data.strongReceipt.workflow_sha = releaseSha;
			},
			(s: Scenario) => {
				s.data.strongReceipt.tested_sha = headSha;
			},
			(s: Scenario) => {
				s.data.strongReceipt.run_id = 999;
			},
			(s: Scenario) => {
				s.data.strongReceipt.jobs.unit = "failure";
			},
			(s: Scenario) => {
				s.data.strongRun.run_attempt = 2;
			},
			(s: Scenario) => {
				s.data.strongRun.head_sha = headSha;
			},
			(s: Scenario) => {
				s.data.strongRun.actor.login = "other-app[bot]";
			},
			(s: Scenario) => {
				s.data.strongRun.display_title = "c8ctl-ci-replayed";
			},
		]) {
			const scenario = fixture();
			mutate(scenario);
			await blocked(
				scenario,
				/CI|slot|receipt|run|correlation|revision|attempt|generation/i,
			);
		}
	});

	test("the strong CI reservation is re-observed immediately before merge", async () => {
		const scenario = fixture();
		let observations = 0;
		scenario.route("GET", `${root}/actions/workflows/1/runs`, (call) => {
			const strong = call.url.searchParams.get("event") === "workflow_dispatch";
			if (strong) observations++;
			const run = strong
				? {
						...scenario.data.strongRun,
						run_attempt: observations === 1 ? 1 : 2,
					}
				: scenario.data.ciRun;
			return { data: { total_count: 1, workflow_runs: [run] } };
		});
		await blocked(scenario, /CI|run|attempt/i);
	});

	test("a changed immutable CI receipt is rejected during the final live gates", async () => {
		for (const change of [
			(receipt: CIReceipt) => {
				receipt.run_id = 999;
			},
			(receipt: CIReceipt) => {
				receipt.task.base_sha = releaseSha;
			},
			(receipt: CIReceipt) => {
				receipt.task.correlation = "44445678-1234-4234-8234-123456789abc";
			},
			(receipt: CIReceipt) => {
				receipt.tested_sha = headSha;
			},
		]) {
			const scenario = fixture();
			scenario.options.guard = async () => {
				change(scenario.data.strongReceipt);
			};
			await blocked(scenario, /CI|receipt|revision/i);
			assert.equal(
				scenario.calls.filter(
					(call) => call.path === `${root}/actions/artifacts/901/zip`,
				).length,
				2,
			);
		}
	});

	test("replayed immutable CI correlations cannot authorize a merge", async () => {
		const scenario = fixture();
		scenario.route("GET", `${root}/actions/workflows/1/runs`, (call) => {
			const runs =
				call.url.searchParams.get("event") === "workflow_dispatch"
					? [scenario.data.strongRun, { ...scenario.data.strongRun, id: 802 }]
					: [scenario.data.ciRun];
			return { data: { total_count: runs.length, workflow_runs: runs } };
		});
		await blocked(scenario, /CI|reserved|dispatch/i);
	});

	test("the required c8ctl/agentic commit status is accepted without checks-write permission", async () => {
		const scenario = fixture();
		requireAggregate(scenario);
		const result = await mergePullRequest(scenario.options);
		assert.equal(result.merged, true, result.reason);
		assert.ok(
			scenario.calls.some((call) => call.path === "/apps/c8ctl-automation"),
		);
		assert.ok(
			scenario.calls.every(
				(call) =>
					call.method === "GET" ||
					call.path === "/graphql" ||
					(call.method === "PUT" && call.path.endsWith("/merge")),
			),
		);
	});

	test("required aggregate status must be latest, successful and bound to the configured App", async () => {
		for (const mutate of [
			(value: ReturnType<typeof requireAggregate>) => {
				value.status.state = "pending";
			},
			(value: ReturnType<typeof requireAggregate>) => {
				value.status.creator.login = "other-app[bot]";
			},
			(value: ReturnType<typeof requireAggregate>) => {
				value.status.creator.type = "User";
			},
			(value: ReturnType<typeof requireAggregate>) => {
				value.app.id = 9999;
			},
			(value: ReturnType<typeof requireAggregate>) => {
				value.app.slug = "other-app";
			},
		]) {
			const scenario = fixture();
			mutate(requireAggregate(scenario));
			await blocked(scenario, /status|aggregate|App/i);
		}
		for (const revision of [headSha, mergeSha]) {
			const scenario = fixture();
			const { status } = requireAggregate(scenario);
			scenario.route("GET", `${root}/commits/${revision}/statuses`, () => ({
				data: [status, { ...status, id: 901, state: "failure" }],
			}));
			await blocked(scenario, /status|aggregate/i);
		}
	});

	test("current-main Release failure, missing jobs, skipped publication and wrong revision block", async () => {
		for (const mutate of [
			(s: Scenario) => {
				s.data.releaseRun.conclusion = "failure";
			},
			(s: Scenario) => {
				s.data.releaseRun.status = "in_progress";
			},
			(s: Scenario) => {
				s.data.releaseRun.head_sha = releaseSha;
			},
			(s: Scenario) => {
				s.data.releaseJobs.pop();
			},
			(s: Scenario) => {
				s.data.releaseJobs[0].conclusion = "skipped";
			},
		]) {
			const scenario = fixture();
			mutate(scenario);
			await blocked(scenario, /Release|publication/i);
		}
	});

	test("trusted-base release config and full pending history prohibit unknown or major releases", async () => {
		for (const message of [
			"chore: review fix\n\nBREAKING CHANGE: remove compatibility",
			"feat!: remove behavior",
			"feat(cli)!: remove behavior",
			"fix: safe headline\n\nBREAKING-CHANGE: hidden footer",
			"unclassified historical commit",
			"revert: restore unknown behavior",
		]) {
			const scenario = fixture();
			scenario.data.comparison.commits[0].commit.message = message;
			await blocked(scenario, /release|breaking|history|conventional/i);
		}
		const config = fixture();
		config.data.config.branches = ["main", "release"];
		await blocked(config, /config|alpha/i);
		const noRelease = fixture();
		noRelease.data.releases = [];
		await blocked(noRelease, /release|tag/i);
		const truncated = fixture();
		truncated.data.comparison.total_commits = 2;
		await blocked(truncated, /history|complete|commit/i);
	});

	test("pending history pagination inspects breaking footers beyond the first page", async () => {
		const scenario = fixture();
		scenario.route(
			"GET",
			`${root}/compare/${releaseSha}...${baseSha}`,
			(call) => {
				const first = call.url.searchParams.get("page") === "1";
				const commits = first
					? Array.from({ length: 100 }, (_, index) => ({
							sha: (index + 1).toString(16).padStart(40, "0"),
							commit: { message: "chore: maintenance" },
						}))
					: [
							{
								sha: baseSha,
								commit: {
									message: "chore: maintenance\n\nBREAKING CHANGE: hidden",
								},
							},
						];
				return {
					data: { ...scenario.data.comparison, total_commits: 101, commits },
				};
			},
		);
		await blocked(scenario, /breaking|release/i);
		assert.ok(
			scenario.calls.some(
				(call) =>
					call.path.includes("/compare/") &&
					call.url.searchParams.get("page") === "2",
			),
		);
	});

	test("safe squash titles must match independently verified class and contain no release markers", async () => {
		for (const title of [
			"feat: incompatible with patch judgment",
			"fix!: break behavior",
			"fix: line\nBREAKING CHANGE: danger",
			"fix: line\u2028next",
			"fix: line\u0000next",
			"fix: BREAKING CHANGE: danger",
			"chore: hide original feature",
		]) {
			const scenario = fixture();
			scenario.data.pr.title = title;
			await blocked(scenario, /title|message|class|breaking/i);
		}
		const neutral = fixture();
		neutral.data.pr.title = "reject invalid input";
		assert.equal((await mergePullRequest(neutral.options)).merged, true);
		assert.equal(
			object(neutral.calls.at(-1)?.body).commit_title,
			"fix: reject invalid input",
		);
	});

	test("a changed release tag cannot expose unchecked historical breaking commits at the final gate", async () => {
		const scenario = fixture();
		const older = "v1.2.2-alpha.9";
		scenario.route("GET", `${root}/releases`, (_call, count) => ({
			data:
				count === 1
					? scenario.data.releases
					: [
							{
								...scenario.data.releases[0],
								tag_name: older,
							},
						],
		}));
		scenario.route("GET", `${root}/git/ref/tags/${older}`, () => ({
			data: {
				ref: `refs/tags/${older}`,
				object: { type: "commit", sha: "2".repeat(40) },
			},
		}));
		scenario.route(
			"GET",
			`${root}/compare/${"2".repeat(40)}...${baseSha}`,
			() => ({
				data: {
					status: "ahead",
					base_commit: { sha: "2".repeat(40) },
					merge_base_commit: { sha: "2".repeat(40) },
					total_commits: 2,
					commits: [
						{
							sha: releaseSha,
							commit: { message: "feat!: prior breaking release" },
						},
						...scenario.data.comparison.commits,
					],
				},
			}),
		);
		await blocked(scenario, /release|breaking/i);
	});

	test("release ancestry resolves refs/tags explicitly instead of an ambiguous branch-like name", async () => {
		const scenario = fixture();
		const anchor = "2".repeat(40);
		scenario.route("GET", `${root}/git/ref/tags/${releaseTag}`, () => ({
			data: {
				ref: `refs/tags/${releaseTag}`,
				object: { type: "commit", sha: anchor },
			},
		}));
		scenario.route("GET", `${root}/compare/${anchor}...${baseSha}`, () => ({
			data: {
				status: "ahead",
				base_commit: { sha: anchor },
				merge_base_commit: { sha: anchor },
				total_commits: 2,
				commits: [
					{
						sha: releaseSha,
						commit: { message: "feat!: hidden before ambiguous branch" },
					},
					...scenario.data.comparison.commits,
				],
			},
		}));
		await blocked(scenario, /release|breaking/i);
	});

	test("annotated release tags are peeled to immutable commit IDs", async () => {
		const scenario = fixture();
		const annotated = "3".repeat(40);
		scenario.route("GET", `${root}/git/ref/tags/${releaseTag}`, () => ({
			data: {
				ref: `refs/tags/${releaseTag}`,
				object: { type: "tag", sha: annotated },
			},
		}));
		scenario.route("GET", `${root}/git/tags/${annotated}`, () => ({
			data: { sha: annotated, object: { type: "commit", sha: releaseSha } },
		}));
		assert.equal((await mergePullRequest(scenario.options)).merged, true);
		assert.ok(
			scenario.calls.some(
				(call) => call.path === `${root}/git/tags/${annotated}`,
			),
		);
	});

	test("final head/base/hold/switch and required CI races never reach PUT", async () => {
		for (const [path, response, reason] of [
			[
				`${root}/pulls/577`,
				(s: Scenario) => ({
					...s.data.pr,
					head: { ...s.data.pr.head, sha: releaseSha },
				}),
				/head|revision/i,
			],
			[
				`${root}/pulls/577`,
				(s: Scenario) => ({ ...s.data.pr, labels: [{ name: "agentic:hold" }] }),
				/hold/i,
			],
			[
				`${root}/branches/main`,
				(s: Scenario) => ({ ...s.data.branch, commit: { sha: releaseSha } }),
				/base|main|revision/i,
			],
			[
				`${root}/actions/variables/C8CTL_AUTOMATION_ENABLED`,
				() => ({ name: "C8CTL_AUTOMATION_ENABLED", value: "false" }),
				/switch|disabled/i,
			],
			[
				`${root}/actions/variables/C8CTL_AUTO_MERGE_ENABLED`,
				() => ({ name: "C8CTL_AUTO_MERGE_ENABLED", value: "false" }),
				/switch|disabled/i,
			],
		] as const) {
			const scenario = fixture();
			const initial = path.includes("/pulls/")
				? scenario.data.pr
				: path.includes("/branches/")
					? scenario.data.branch
					: { name: path.split("/").at(-1), value: "true" };
			scenario.route("GET", path, (_call, count) => ({
				data: count === 1 ? initial : response(scenario),
			}));
			await blocked(scenario, reason);
		}
		const ci = fixture();
		ci.route(
			"GET",
			`${root}/actions/runs/501/attempts/1/jobs`,
			(_call, count) => ({
				data: {
					total_count: ci.data.ciJobs.length,
					jobs: ci.data.ciJobs.map((job) => ({
						...job,
						conclusion: count === 1 ? "success" : "failure",
					})),
				},
			}),
		);
		await blocked(ci, /CI|Test|job/i);
	});

	test("GitHub permission/protection rejection and ambiguous merge responses are never retried", async () => {
		for (const status of [405, 409, 422, 500]) {
			const scenario = fixture();
			scenario.route("PUT", `${root}/pulls/577/merge`, () => ({
				status,
				data: {},
			}));
			const result = await mergePullRequest(scenario.options);
			assert.equal(result.merged, false);
			assert.match(result.reason, /manual|rejected|uncertain|unknown/i);
			assert.equal(
				scenario.calls.filter((call) => call.method === "PUT").length,
				1,
			);
		}
	});
});
