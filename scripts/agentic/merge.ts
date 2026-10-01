import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import { manualMergeReasons } from "./changes.ts";
import { parseCITask } from "./ci.ts";
import { isCommitSha } from "./contracts.ts";
import { type ConvergenceInput, decideConvergence } from "./convergence.ts";
import {
	array,
	type GitHubClient,
	GitHubError,
	inspectCI,
	integer,
	object,
	string,
} from "./github.ts";
import type { CISlot } from "./state.ts";

export interface MergeOptions {
	github: GitHubClient;
	repository: string;
	number: number;
	headSha: string;
	baseSha: string;
	changeClass?: "patch" | "additive-minor";
	releaseIntent: "patch" | "minor";
	appBotLogin: string;
	/** The coordinator has authenticated both envelopes against App-owned slots. */
	proof: ConvergenceInput;
	/** Persisted trusted-main CI reservation, never a cached status enum. */
	ciSlot: CISlot;
	/** Revalidate the coordinator's live generation, hold and revision state. */
	guard: () => Promise<void>;
}

export interface MergeResult {
	merged: boolean;
	reason: string;
	sha?: string;
}

const RELEASE_CONFIG = {
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
const ATTRIBUTION =
	"Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>";
const REVIEW_QUERY = `query GuardedMergeReviews($owner:String!,$name:String!,$number:Int!,$cursor:String) {
	repository(owner:$owner,name:$name) {
		pullRequest(number:$number) {
			headRefOid baseRefOid baseRefName isDraft isCrossRepository
			mergeable mergeStateStatus reviewDecision isInMergeQueue
			reviewThreads(first:100,after:$cursor) {
				totalCount nodes { id isResolved }
				pageInfo { hasNextPage endCursor }
			}
		}
	}
}`;

function requireGate(condition: unknown, reason: string): asserts condition {
	if (!condition) throw new Error(reason);
}

function nonnegative(value: unknown): number {
	requireGate(
		typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
		"Invalid nonnegative count",
	);
	return value;
}

function verifyProof(input: MergeOptions): void {
	requireGate(
		/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}(?![\s\S])/.test(
			input.repository,
		) &&
			isCommitSha(input.headSha) &&
			isCommitSha(input.baseSha) &&
			Number.isSafeInteger(input.number) &&
			input.number > 0 &&
			typeof input.appBotLogin === "string" &&
			input.appBotLogin.endsWith("[bot]") &&
			input.appBotLogin !== "github-actions[bot]" &&
			typeof input.guard === "function",
		"Invalid trusted merge identity or revision",
	);
	requireGate(
		input.proof.snapshot.head_sha === input.headSha &&
			input.proof.snapshot.base_sha === input.baseSha &&
			Object.values(input.proof.expected).every(
				(task) =>
					task.repository === input.repository && task.number === input.number,
			),
		"Review proof does not identify this repository, PR and revision",
	);
	const decision = decideConvergence({
		...input.proof,
		now: new Date().toISOString(),
	});
	requireGate(
		decision.action === "eligible",
		`Review proof is not eligible: ${"reason" in decision ? decision.reason : decision.action}`,
	);
	requireGate(
		decision.release_intent === input.releaseIntent &&
			(input.changeClass === undefined ||
				input.changeClass ===
					(decision.release_intent === "patch" ? "patch" : "additive-minor")),
		"Review proof, change class and release intent disagree",
	);
	const task = parseCITask(input.ciSlot.task);
	const expected = input.proof.expected.copilot;
	requireGate(
		task.repository === input.repository &&
			task.number === input.number &&
			task.head_sha === input.headSha &&
			task.base_sha === input.baseSha &&
			task.generation === expected.generation &&
			task.attempt === input.proof.state.reimplementation_attempts &&
			task.state_comment_id === expected.state_comment_id &&
			Object.values(input.proof.expected).every(
				(review) => review.correlation !== task.correlation,
			),
		"Reserved CI task does not match the current review generation, revision or attempt",
	);
	requireGate(
		input.ciSlot.run_id !== null &&
			integer(input.ciSlot.run_id) > 0 &&
			input.ciSlot.run_attempt === 1 &&
			input.ciSlot.artifact_id !== null &&
			integer(input.ciSlot.artifact_id) > 0,
		"Reserved CI slot is missing a bound completed run and receipt artifact",
	);
}

async function snapshot(input: MergeOptions): Promise<Record<string, unknown>> {
	const root = `/repos/${input.repository}`;
	const [repository, pull, branch, enabled, autoMerge] = (
		await Promise.all([
			input.github.request("GET", root),
			input.github.request("GET", `${root}/pulls/${input.number}`),
			input.github.request("GET", `${root}/branches/main`),
			input.github.request(
				"GET",
				`${root}/actions/variables/C8CTL_AUTOMATION_ENABLED`,
			),
			input.github.request(
				"GET",
				`${root}/actions/variables/C8CTL_AUTO_MERGE_ENABLED`,
			),
		])
	).map(object);
	requireGate(
		repository && pull && branch && enabled && autoMerge,
		"Incomplete repository snapshot",
	);
	requireGate(
		repository.default_branch === "main",
		"Default branch must be main, never release",
	);
	requireGate(
		repository.archived === false &&
			repository.disabled === false &&
			repository.full_name === input.repository,
		"Repository is archived, disabled or mismatched",
	);
	requireGate(
		object(repository.permissions).push === true,
		"Missing repository write permission",
	);
	requireGate(
		repository.allow_squash_merge === true,
		"Repository does not permit squash merging",
	);
	requireGate(
		enabled.name === "C8CTL_AUTOMATION_ENABLED" &&
			enabled.value === "true" &&
			autoMerge.name === "C8CTL_AUTO_MERGE_ENABLED" &&
			autoMerge.value === "true",
		"Live automation or auto-merge switch is disabled",
	);
	requireGate(
		pull.number === input.number && pull.state === "open",
		"PR must still be open",
	);
	requireGate(pull.draft === false, "Draft PRs require manual handling");
	requireGate(
		!array(pull.labels).some(
			(label) =>
				(typeof label === "string" ? label : object(label).name) ===
				"agentic:hold",
		),
		"Maintainer hold is active",
	);
	const head = object(pull.head),
		base = object(pull.base);
	requireGate(base.ref === "main", "PR must target main, never release");
	const repoId = integer(repository.id);
	const target = object(base.repo),
		source = object(head.repo);
	requireGate(
		target.id === repoId &&
			target.full_name === input.repository &&
			target.fork === false,
		"Mismatched base repository requires manual handling",
	);
	const sourceId = integer(source.id);
	const sourceName = string(source.full_name);
	requireGate(
		sourceId === repoId
			? sourceName === input.repository && source.fork === false
			: sourceName !== input.repository &&
					source.fork === true &&
					/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}(?![\s\S])/.test(
						sourceName,
					),
		"Unknown or inconsistent fork repository metadata requires manual handling",
	);
	requireGate(
		head.sha === input.headSha &&
			base.sha === input.baseSha &&
			object(branch.commit).sha === input.baseSha,
		"PR head or main base revision changed; obtain fresh reviews and CI",
	);
	requireGate(branch.protected === true, "Main is not protected");
	requireGate(
		pull.mergeable === true,
		"PR is not known conflict-free and mergeable",
	);
	requireGate(
		pull.mergeable_state === "clean",
		"PR must be clean and strictly up to date",
	);
	requireGate(
		isCommitSha(pull.merge_commit_sha) &&
			pull.merge_commit_sha === input.ciSlot.task.merge_sha,
		"Missing or changed reserved CI synthetic merge revision",
	);
	return pull;
}

function squashTitle(
	title: unknown,
	intent: MergeOptions["releaseIntent"],
): string {
	const value = string(title);
	requireGate(
		value.trim().length > 0 &&
			value.length <= 190 &&
			!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) &&
			!value.includes("!") &&
			!/BREAKING[ -]CHANGE/i.test(value),
		"Unsafe squash title or breaking-change marker",
	);
	const expected = intent === "patch" ? "fix" : "feat";
	const conventional = /^(fix|feat)(?:\([a-z0-9][a-z0-9._/-]*\))?: \S/.exec(
		value,
	);
	if (conventional) {
		requireGate(
			conventional[1] === expected,
			"Squash title disagrees with verified change class",
		);
		return value;
	}
	requireGate(
		!/^[^\s:]+(?:\([^)]*\))?:/.test(value),
		"Unsupported conventional squash title",
	);
	return `${expected}: ${value}`;
}

async function wholeDiff(
	input: MergeOptions,
	pull: Record<string, unknown>,
): Promise<void> {
	const expected = nonnegative(pull.changed_files);
	requireGate(
		expected > 0 && expected <= 3000,
		"Whole diff must have 1–3000 files within GitHub's completeness limit",
	);
	const files = (
		await input.github.list(
			`/repos/${input.repository}/pulls/${input.number}/files`,
		)
	).map(object);
	requireGate(files.length === expected, "Whole diff file count is incomplete");
	const names = new Set<string>();
	const paths: string[] = [];
	for (const file of files) {
		const path = string(file.filename);
		const key = path.normalize("NFC").toLowerCase();
		requireGate(
			!names.has(key),
			"Whole diff has duplicate or aliased file paths",
		);
		names.add(key);
		requireGate(
			["added", "modified", "removed", "renamed"].includes(string(file.status)),
			"Unsupported whole-diff file status",
		);
		requireGate(
			!(file.status === "removed" && path.startsWith("tests/")),
			"Deleted tests require manual merge",
		);
		paths.push(path);
		if (file.status === "renamed") {
			const previous = string(file.previous_filename);
			requireGate(
				!previous.startsWith("tests/"),
				"Renamed tests require manual merge",
			);
			paths.push(previous);
		} else {
			requireGate(
				file.previous_filename === undefined,
				"Malformed whole-diff rename metadata",
			);
		}
	}
	const reasons = manualMergeReasons(paths);
	requireGate(
		reasons.length === 0,
		`Protected whole diff requires manual merge: ${reasons.slice(0, 3).join("; ")}`,
	);
}

interface RequiredCheck {
	context: string;
	appId: number;
}
interface Protection {
	checks: RequiredCheck[];
	approvals: number;
	requireReviewDecision: boolean;
}

async function protection(input: MergeOptions): Promise<Protection> {
	const root = `/repos/${input.repository}`;
	const [value, rules, rulesets] = await Promise.all([
		input.github.request("GET", `${root}/branches/main/protection`),
		input.github.list(`${root}/rules/branches/main`),
		input.github.list(`${root}/rulesets?includes_parents=true`),
	]);
	requireGate(
		!rules.some((rule) => object(rule).type === "merge_queue"),
		"Merge queue requires merge_group support",
	);
	requireGate(
		rules.length === 0,
		"Unsupported applicable repository rules; manual merge required",
	);
	for (const item of rulesets) {
		const rule = object(item);
		requireGate(
			["active", "disabled", "evaluate"].includes(string(rule.enforcement)),
			"Unknown ruleset enforcement",
		);
		requireGate(
			rule.enforcement !== "active",
			"Active rulesets require manual merge until their complete policy is supported",
		);
	}
	const settings = object(value);
	requireGate(
		object(settings.enforce_admins).enabled === true,
		"Branch protection must enforce admins; no bypass",
	);
	requireGate(
		object(settings.allow_force_pushes).enabled === false,
		"Force-push protection must be enabled",
	);
	requireGate(
		object(settings.allow_deletions).enabled === false,
		"Branch deletion protection must be enabled",
	);
	requireGate(
		object(settings.lock_branch).enabled === false,
		"Protected branch is locked",
	);
	requireGate(
		object(settings.required_conversation_resolution).enabled === true,
		"Required conversation/thread resolution must be enforced",
	);
	const checks = object(settings.required_status_checks);
	requireGate(
		checks.strict === true,
		"Strict up-to-date required status checks must be enforced",
	);
	const required = array(checks.checks).map((item) => {
		const check = object(item);
		const context = string(check.context);
		requireGate(
			context.trim().length > 0 &&
				typeof check.app_id === "number" &&
				check.app_id > 0,
			"Required checks must be bound to an explicit GitHub App",
		);
		return { context, appId: integer(check.app_id) };
	});
	const contexts = array(checks.contexts).map(string);
	requireGate(
		required.length > 0 &&
			new Set(required.map((check) => check.context)).size ===
				required.length &&
			contexts.length === required.length &&
			contexts.every((context) =>
				required.some((check) => check.context === context),
			),
		"Required check contexts are missing, duplicated or unsupported",
	);
	const reviews = object(settings.required_pull_request_reviews);
	requireGate(
		reviews.dismiss_stale_reviews === true,
		"Stale approvals must be dismissed by branch protection",
	);
	requireGate(
		typeof reviews.require_code_owner_reviews === "boolean" &&
			typeof reviews.require_last_push_approval === "boolean",
		"Unsupported required approval policy",
	);
	const bypass = object(reviews.bypass_pull_request_allowances);
	requireGate(
		["users", "teams", "apps"].every((key) => array(bypass[key]).length === 0),
		"Branch protection has review bypass allowances",
	);
	const approvals = nonnegative(reviews.required_approving_review_count);
	requireGate(approvals <= 6, "Unsupported required approval count");
	return {
		checks: required,
		approvals,
		requireReviewDecision:
			approvals > 0 ||
			reviews.require_code_owner_reviews ||
			reviews.require_last_push_approval,
	};
}

async function reviews(
	input: MergeOptions,
	policy: Protection,
	pull: Record<string, unknown>,
): Promise<void> {
	const [owner, name] = input.repository.split("/");
	let cursor: string | null = null;
	let total: number | undefined;
	const seen = new Set<string>();
	const cursors = new Set<string>();
	for (let page = 0; page < 100; page++) {
		const response = await input.github.graphql(REVIEW_QUERY, {
			owner,
			name,
			number: input.number,
			cursor,
		});
		const pr = object(object(response.repository).pullRequest);
		requireGate(
			pr.headRefOid === input.headSha &&
				pr.baseRefOid === input.baseSha &&
				pr.baseRefName === "main" &&
				pr.isDraft === false &&
				pr.isCrossRepository ===
					(object(object(pull.head).repo).id !==
						object(object(pull.base).repo).id) &&
				pr.mergeable === "MERGEABLE" &&
				pr.mergeStateStatus === "CLEAN",
			"Review snapshot or mergeability changed",
		);
		requireGate(
			pr.isInMergeQueue === false,
			"Merge queue is unsupported without merge_group CI",
		);
		requireGate(
			pr.reviewDecision === "APPROVED" ||
				(!policy.requireReviewDecision && pr.reviewDecision === null),
			"GitHub required review/approval decision is not satisfied",
		);
		const connection = object(pr.reviewThreads);
		const count = nonnegative(connection.totalCount);
		requireGate(
			total === undefined || total === count,
			"Review thread count changed during pagination",
		);
		total = count;
		for (const item of array(connection.nodes)) {
			const thread = object(item);
			const id = string(thread.id);
			requireGate(
				id.length > 0 && !seen.has(id),
				"Duplicate or incomplete review threads",
			);
			seen.add(id);
			requireGate(
				thread.isResolved === true,
				"Unresolved review thread requires manual handling",
			);
		}
		const info = object(connection.pageInfo);
		requireGate(
			typeof info.hasNextPage === "boolean",
			"Missing review-thread pagination evidence",
		);
		if (!info.hasNextPage) {
			requireGate(seen.size === total, "Incomplete review-thread pagination");
			break;
		}
		cursor = string(info.endCursor);
		requireGate(
			cursor.length > 0 && !cursors.has(cursor) && page < 99,
			"Incomplete or repeated review-thread cursor",
		);
		cursors.add(cursor);
	}
	const all = (
		await input.github.list(
			`/repos/${input.repository}/pulls/${input.number}/reviews`,
		)
	)
		.map(object)
		.sort((left, right) => integer(left.id) - integer(right.id));
	const latest = new Map<number, Record<string, unknown>>();
	const ids = new Set<number>();
	for (const review of all) {
		const id = integer(review.id);
		requireGate(!ids.has(id), "Duplicate review pagination");
		ids.add(id);
		requireGate(
			[
				"APPROVED",
				"CHANGES_REQUESTED",
				"DISMISSED",
				"COMMENTED",
				"PENDING",
			].includes(string(review.state)),
			"Unknown review state",
		);
		if (review.state === "COMMENTED" || review.state === "PENDING") continue;
		latest.set(integer(object(review.user).id), review);
	}
	let approvals = 0;
	for (const review of latest.values()) {
		requireGate(
			review.state !== "CHANGES_REQUESTED",
			"Blocking review still requests changes",
		);
		const user = object(review.user);
		if (
			review.state === "APPROVED" &&
			review.commit_id === input.headSha &&
			user.type === "User" &&
			user.login !== input.appBotLogin &&
			user.login !== object(pull.user).login &&
			["MEMBER", "OWNER", "COLLABORATOR"].includes(
				string(review.author_association),
			)
		)
			approvals++;
	}
	requireGate(
		approvals >= policy.approvals,
		"Missing fresh required human approvals on the current head",
	);
}

async function aggregateStatus(
	input: MergeOptions,
	required: RequiredCheck,
	synthetic: string,
): Promise<void> {
	const root = `/repos/${input.repository}`;
	const [head, merge] = await Promise.all([
		input.github.list(`${root}/commits/${input.headSha}/statuses`),
		input.github.list(`${root}/commits/${synthetic}/statuses`),
	]);
	const matching = (values: unknown[]) =>
		values
			.map(object)
			.filter((status) => status.context === required.context)
			.sort((left, right) => integer(right.id) - integer(left.id));
	const mergeStatuses = matching(merge);
	const statuses = mergeStatuses.length > 0 ? mergeStatuses : matching(head);
	requireGate(
		new Set(statuses.map((status) => integer(status.id))).size ===
			statuses.length,
		"Duplicate aggregate status pagination",
	);
	const status = statuses[0];
	requireGate(
		status?.state === "success",
		"Latest required aggregate status is missing or unsuccessful",
	);
	const creator = object(status.creator);
	requireGate(
		creator.login === input.appBotLogin && creator.type === "Bot",
		"Required aggregate status was not published by the configured App",
	);
	const slug = input.appBotLogin.slice(0, -"[bot]".length);
	requireGate(
		/^[a-z0-9][a-z0-9-]*$/.test(slug),
		"Unsupported aggregate status App identity",
	);
	const app = object(await input.github.request("GET", `/apps/${slug}`));
	requireGate(
		app.slug === slug && app.id === required.appId,
		"Aggregate status publisher does not match the required GitHub App",
	);
}

async function requiredTestJobs(
	input: MergeOptions,
	pull: Record<string, unknown>,
	sha: string,
): Promise<Record<string, unknown>[]> {
	const root = `/repos/${input.repository}`;
	const workflow = object(
		await input.github.request("GET", `${root}/actions/workflows/test.yml`),
	);
	requireGate(
		workflow.path === ".github/workflows/test.yml" &&
			workflow.state === "active",
		"Required-check Test workflow is unavailable",
	);
	const runs = (
		await input.github.list(
			`${root}/actions/workflows/${integer(workflow.id)}/runs?event=pull_request&head_sha=${sha}`,
			"workflow_runs",
		)
	)
		.map(object)
		.filter((run) => run.head_sha === sha)
		.sort((left, right) => integer(right.id) - integer(left.id));
	const latest = runs[0];
	requireGate(latest, "Required checks have no current PR Test run");
	requireGate(
		new Set(runs.map((run) => integer(run.id))).size === runs.length,
		"Duplicate required-check Test runs",
	);
	const run = object(
		await input.github.request(
			"GET",
			`${root}/actions/runs/${integer(latest.id)}`,
		),
	);
	for (const observed of [latest, run]) {
		requireGate(
			observed.id === latest.id &&
				observed.workflow_id === workflow.id &&
				observed.path === workflow.path &&
				observed.event === "pull_request" &&
				observed.head_sha === sha &&
				observed.head_branch === object(pull.head).ref &&
				observed.run_attempt === latest.run_attempt &&
				observed.status === "completed" &&
				observed.conclusion === "success",
			"Required-check Test run is stale, changed or unsuccessful",
		);
		const associations = array(observed.pull_requests).map(object);
		// Fork runs may omit associations. The reserved CI receipt, not this
		// optional metadata, independently proves the exact head/base merge.
		requireGate(
			associations.length === 0 ||
				associations.some(
					(pr) =>
						pr.number === input.number &&
						object(pr.head).sha === input.headSha &&
						object(pr.base).sha === input.baseSha,
				),
			"Required-check Test run has a mismatched PR revision",
		);
	}
	const jobs = (
		await input.github.list(
			`${root}/actions/runs/${integer(run.id)}/attempts/${integer(run.run_attempt)}/jobs`,
			"jobs",
		)
	).map(object);
	requireGate(
		jobs.every((job) => job.run_id === run.id && job.head_sha === sha),
		"Required-check Test jobs do not belong to the current run and revision",
	);
	return jobs;
}

async function requiredChecks(
	input: MergeOptions,
	policy: Protection,
	pull: Record<string, unknown>,
): Promise<void> {
	const synthetic = string(pull.merge_commit_sha);
	const root = `/repos/${input.repository}`;
	const [head, merge] = await Promise.all([
		input.github.list(
			`${root}/commits/${input.headSha}/check-runs?filter=latest`,
			"check_runs",
		),
		input.github.list(
			`${root}/commits/${synthetic}/check-runs?filter=latest`,
			"check_runs",
		),
	]);
	const mergeChecks = merge.map(object);
	const onMerge = mergeChecks.some((run) =>
		policy.checks.some((check) => check.context === run.name),
	);
	const selected = onMerge ? mergeChecks : head.map(object);
	const sha = onMerge ? synthetic : input.headSha;
	let testJobs: Record<string, unknown>[] | undefined;
	for (const required of policy.checks) {
		if (required.context === "c8ctl/agentic") {
			requireGate(
				![...head.map(object), ...mergeChecks].some(
					(run) => run.name === required.context,
				),
				"Aggregate status has an ambiguous same-name Check Run",
			);
			await aggregateStatus(input, required, synthetic);
			continue;
		}
		const matching = selected.filter(
			(run) =>
				run.name === required.context && object(run.app).id === required.appId,
		);
		const run = matching[0];
		requireGate(
			matching.length === 1 &&
				run?.head_sha === sha &&
				run.status === "completed" &&
				run.conclusion === "success",
			`Required check ${required.context} is missing, skipped, stale, ambiguous or unsuccessful`,
		);
		testJobs ??= await requiredTestJobs(input, pull, sha);
		const jobs = testJobs.filter(
			(job) =>
				job.name === required.context &&
				job.check_run_url ===
					`https://api.github.com${root}/check-runs/${integer(run.id)}`,
		);
		requireGate(
			jobs.length === 1 &&
				jobs[0]?.status === "completed" &&
				jobs[0]?.conclusion === "success",
			`Required check ${required.context} does not identify a successful job in the latest PR Test run`,
		);
	}
	const ci = await inspectCI({
		github: input.github,
		repository: input.repository,
		number: input.number,
		headSha: input.headSha,
		baseSha: input.baseSha,
		mergeSha: synthetic,
		ci: input.ciSlot,
		appBotLogin: input.appBotLogin,
	});
	requireGate(
		ci.status === "success",
		`Test CI is not green for this revision: ${ci.evidence}`,
	);
}

async function releaseCI(input: MergeOptions): Promise<void> {
	const root = `/repos/${input.repository}`;
	const workflow = object(
		await input.github.request("GET", `${root}/actions/workflows/release.yml`),
	);
	requireGate(
		workflow.path === ".github/workflows/release.yml" &&
			workflow.state === "active",
		"Trusted Release workflow is unavailable",
	);
	const runs = (
		await input.github.list(
			`${root}/actions/workflows/${integer(workflow.id)}/runs?branch=main&head_sha=${input.baseSha}`,
			"workflow_runs",
		)
	)
		.map(object)
		.filter(
			(run) =>
				run.workflow_id === workflow.id &&
				run.path === workflow.path &&
				run.head_sha === input.baseSha &&
				run.head_branch === "main" &&
				["push", "workflow_dispatch"].includes(string(run.event)),
		)
		.sort((left, right) => integer(right.id) - integer(left.id));
	const run = runs[0];
	requireGate(
		run && run.status === "completed" && run.conclusion === "success",
		"Current-main Release CI is missing, pending or failed",
	);
	const jobs = (
		await input.github.list(
			`${root}/actions/runs/${integer(run.id)}/attempts/${integer(run.run_attempt)}/jobs`,
			"jobs",
		)
	).map(object);
	const expected = [
		...[22, 24].flatMap((node) =>
			["8.8", "8.9", "8.10"].map(
				(version) => `Test (Node ${node} - Camunda ${version})`,
			),
		),
		"Release",
	];
	for (const name of expected) {
		const selected = jobs.filter((job) => job.name === name);
		requireGate(
			selected.length === 1 &&
				selected[0]?.status === "completed" &&
				selected[0]?.conclusion === "success",
			`Release publication gate is missing, skipped or failed: ${name}`,
		);
	}
}

interface ReleaseTag {
	name: string;
	major: bigint;
	minor: bigint;
	patch: bigint;
	alpha: bigint | null;
}

function releaseTag(value: unknown): ReleaseTag | null {
	const release = object(value);
	if (release.draft === true) return null;
	requireGate(
		release.draft === false && typeof release.published_at === "string",
		"Unknown published release state",
	);
	const name = string(release.tag_name);
	const match =
		/^v(0|[1-9]\d{0,14})\.(0|[1-9]\d{0,14})\.(0|[1-9]\d{0,14})(?:-alpha\.(0|[1-9]\d{0,14}))?(?![\s\S])/.exec(
			name,
		);
	requireGate(
		match,
		"Unknown release tag format; only stable and alpha semantic-release tags are supported",
	);
	requireGate(
		release.prerelease === (match[4] !== undefined),
		"Release tag and prerelease metadata disagree",
	);
	return {
		name,
		major: BigInt(string(match[1])),
		minor: BigInt(string(match[2])),
		patch: BigInt(string(match[3])),
		alpha: match[4] === undefined ? null : BigInt(match[4]),
	};
}

function tagOrder(left: ReleaseTag, right: ReleaseTag): number {
	for (const part of ["major", "minor", "patch"] as const) {
		if (left[part] !== right[part]) return left[part] > right[part] ? -1 : 1;
	}
	if (left.alpha === right.alpha) return 0;
	if (left.alpha === null) return -1;
	if (right.alpha === null) return 1;
	return left.alpha > right.alpha ? -1 : 1;
}

async function releaseCommit(
	input: MergeOptions,
	name: string,
): Promise<string> {
	const root = `/repos/${input.repository}`;
	const ref = object(
		await input.github.request(
			"GET",
			`${root}/git/ref/tags/${encodeURIComponent(name)}`,
		),
	);
	requireGate(
		ref.ref === `refs/tags/${name}`,
		"Release tag reference mismatch",
	);
	let target = object(ref.object);
	const seen = new Set<string>();
	for (let depth = 0; depth < 8; depth++) {
		const sha = target.sha;
		requireGate(
			isCommitSha(sha) && !seen.has(sha),
			"Malformed or cyclic release tag",
		);
		if (target.type === "commit") return sha;
		requireGate(target.type === "tag", "Unsupported release tag target");
		seen.add(sha);
		const tag = object(
			await input.github.request("GET", `${root}/git/tags/${sha}`),
		);
		requireGate(tag.sha === sha, "Annotated release tag SHA mismatch");
		target = object(tag.object);
	}
	throw new Error("Release tag annotation depth exceeds the inspection budget");
}

async function releaseHistory(input: MergeOptions): Promise<void> {
	const root = `/repos/${input.repository}`;
	const file = object(
		await input.github.request(
			"GET",
			`${root}/contents/.releaserc.json?ref=${input.baseSha}`,
		),
	);
	requireGate(
		file.type === "file" &&
			file.path === ".releaserc.json" &&
			file.encoding === "base64",
		"Missing trusted-base release configuration",
	);
	const encoded = string(file.content).replace(/\s/g, "");
	requireGate(
		encoded.length <= 90000 &&
			/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
				encoded,
			),
		"Malformed release configuration encoding",
	);
	const bytes = Buffer.from(encoded, "base64");
	requireGate(
		bytes.length === nonnegative(file.size),
		"Incomplete release configuration",
	);
	const config: unknown = JSON.parse(
		new TextDecoder("utf-8", { fatal: true }).decode(bytes),
	);
	requireGate(
		isDeepStrictEqual(config, RELEASE_CONFIG),
		"Unsupported release configuration; only known main alpha / release stable rules are authorized",
	);
	const tags = (await input.github.list(`${root}/releases`))
		.map(releaseTag)
		.filter((tag) => tag !== null)
		.sort(tagOrder);
	requireGate(
		tags.length > 0 && tags.length <= 1000,
		"Missing or unbounded release-tag history",
	);
	for (const tag of tags.slice(0, 20)) {
		const tagSha = await releaseCommit(input, tag.name);
		const path = `${root}/compare/${tagSha}...${input.baseSha}`;
		const first = object(
			await input.github.request("GET", `${path}?per_page=100&page=1`),
		);
		requireGate(
			["ahead", "identical", "behind", "diverged"].includes(
				string(first.status),
			),
			"Unknown release-history ancestry",
		);
		if (first.status === "behind" || first.status === "diverged") continue;
		const anchor = object(first.base_commit).sha;
		requireGate(
			isCommitSha(anchor) &&
				anchor === tagSha &&
				object(first.merge_base_commit).sha === anchor,
			"Release tag is not a verified ancestor",
		);
		const total = nonnegative(first.total_commits);
		requireGate(
			total <= 2000,
			"Pending release history exceeds the complete-inspection budget",
		);
		requireGate(
			(first.status === "identical") === (total === 0),
			"Inconsistent release-history comparison",
		);
		const seen = new Set<string>();
		let last = anchor;
		for (let page = 1; page <= Math.max(1, Math.ceil(total / 100)); page++) {
			const result =
				page === 1
					? first
					: object(
							await input.github.request(
								"GET",
								`${path}?per_page=100&page=${page}`,
							),
						);
			requireGate(
				result.total_commits === total &&
					result.status === first.status &&
					object(result.base_commit).sha === anchor &&
					object(result.merge_base_commit).sha === anchor,
				"Release history changed during pagination",
			);
			const commits = array(result.commits).map(object);
			requireGate(
				commits.length === Math.min(100, total - (page - 1) * 100),
				"Incomplete pending release commit history",
			);
			for (const commit of commits) {
				requireGate(
					isCommitSha(commit.sha) && !seen.has(commit.sha),
					"Duplicate or malformed release history commit",
				);
				seen.add(commit.sha);
				last = commit.sha;
				const message = string(object(commit.commit).message);
				const headline = message.split("\n")[0] ?? "";
				requireGate(
					!/BREAKING[ -]CHANGE/i.test(message) && !headline.includes("!"),
					"Breaking change in pending release history",
				);
				requireGate(
					/^(?:fix|feat|perf|chore|docs|style|refactor|test|build|ci)(?:\([^()\r\n]+\))?: \S/.test(
						headline,
					),
					"Unknown conventional release effect in pending history",
				);
			}
		}
		requireGate(
			seen.size === total && last === input.baseSha,
			"Pending release history does not completely reach current main",
		);
		return;
	}
	throw new Error(
		"No reachable published release tag within the inspection budget",
	);
}

async function liveGates(
	input: MergeOptions,
	pull: Record<string, unknown>,
): Promise<void> {
	const policy = await protection(input);
	await reviews(input, policy, pull);
	await requiredChecks(input, policy, pull);
	await releaseCI(input);
}

/**
 * Supported policy is deliberately narrow: strict classic protection without
 * bypasses or active rulesets, and the repository's known semantic-release rules.
 * GitHub binds PUT to head only. Final base/hold reads reduce, but cannot atomically
 * eliminate, that race; strict required checks remain enforced by GitHub itself.
 */
export async function mergePullRequest(
	input: MergeOptions,
): Promise<MergeResult> {
	let mutationStarted = false;
	try {
		verifyProof(input);
		const initial = await snapshot(input);
		const title = squashTitle(initial.title, input.releaseIntent);
		await wholeDiff(input, initial);
		await releaseHistory(input);
		await liveGates(input, initial);
		await input.guard();
		const fresh = await snapshot(input);
		requireGate(
			squashTitle(fresh.title, input.releaseIntent) === title,
			"PR title changed before merge",
		);
		await liveGates(input, fresh);
		await releaseHistory(input);
		await input.guard();
		const final = await snapshot(input);
		requireGate(
			squashTitle(final.title, input.releaseIntent) === title,
			"PR title changed before merge",
		);
		verifyProof(input);
		mutationStarted = true;
		const result = object(
			await input.github.request(
				"PUT",
				`/repos/${input.repository}/pulls/${input.number}/merge`,
				{
					sha: input.headSha,
					merge_method: "squash",
					commit_title: title,
					commit_message: ATTRIBUTION,
				},
			),
		);
		requireGate(
			result.merged === true && isCommitSha(result.sha),
			"Merge outcome is uncertain; inspect the PR before taking further action",
		);
		return {
			merged: true,
			sha: result.sha,
			reason:
				"SHA-bound squash merge completed; only the main alpha release channel is authorized",
		};
	} catch (error) {
		const reason =
			error instanceof Error
				? error.message.slice(0, 1000)
				: "Unknown merge gate failure";
		if (mutationStarted) {
			return {
				merged: false,
				reason:
					error instanceof GitHubError && [405, 409, 422].includes(error.status)
						? `GitHub rejected guarded merge (HTTP ${error.status}); obtain fresh reviews and gates`
						: `Merge outcome uncertain; inspect the PR without retrying: ${reason}`,
			};
		}
		return { merged: false, reason: `Manual merge required: ${reason}` };
	}
}
