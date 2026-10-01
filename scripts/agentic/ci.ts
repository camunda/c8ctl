const MAX_JSON_BYTES = 64 * 1024;
const SHA = /^[a-f0-9]{40}(?![\s\S])/;
const REPOSITORY =
	/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}(?![\s\S])/;
const UUID =
	/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/;

export interface CITask {
	version: 1;
	repository: string;
	number: number;
	generation: string;
	correlation: string;
	head_sha: string;
	base_sha: string;
	merge_sha: string;
	state_comment_id: number;
	attempt: number;
}

export type CIOutcome = "success" | "failure" | "cancelled" | "skipped";

export interface CIReceipt {
	schema_version: 1;
	repository: string;
	task: CITask;
	run_id: number;
	run_attempt: 1;
	workflow_sha: string;
	tested_sha: string;
	jobs: {
		lint: CIOutcome;
		typecheck: CIOutcome;
		unit: CIOutcome;
		integration: CIOutcome;
	};
}

function requireValid(condition: unknown, reason: string): asserts condition {
	if (!condition) throw new TypeError(reason);
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
	requireValid(record(value), "Expected a CI JSON object");
	return value;
}

function bounded(value: unknown): Record<string, unknown> {
	const serialized = typeof value === "string" ? value : JSON.stringify(value);
	requireValid(
		typeof serialized === "string" &&
			Buffer.byteLength(serialized) <= MAX_JSON_BYTES,
		"CI JSON exceeds 64 KiB or is missing",
	);
	try {
		return object(typeof value === "string" ? JSON.parse(serialized) : value);
	} catch {
		throw new TypeError("Malformed CI JSON object");
	}
}

function keys(
	value: Record<string, unknown>,
	expected: readonly string[],
): void {
	requireValid(
		Object.keys(value).length === expected.length &&
			expected.every((key) => Object.hasOwn(value, key)),
		"Unexpected or missing CI properties",
	);
}

function integer(
	value: unknown,
	minimum = 1,
	maximum = Number.MAX_SAFE_INTEGER,
): number {
	requireValid(
		typeof value === "number" &&
			Number.isSafeInteger(value) &&
			value >= minimum &&
			value <= maximum,
		"Invalid CI integer",
	);
	return value;
}

function match(value: unknown, pattern: RegExp, field: string): string {
	requireValid(
		typeof value === "string" && pattern.test(value),
		`Invalid CI ${field}`,
	);
	return value;
}

function outcome(value: unknown): CIOutcome {
	requireValid(
		value === "success" ||
			value === "failure" ||
			value === "cancelled" ||
			value === "skipped",
		"Invalid CI job outcome",
	);
	return value;
}

export function parseCITask(value: unknown): CITask {
	const input = bounded(value);
	keys(input, [
		"version",
		"repository",
		"number",
		"generation",
		"correlation",
		"head_sha",
		"base_sha",
		"merge_sha",
		"state_comment_id",
		"attempt",
	]);
	requireValid(input.version === 1, "Unsupported CI task version");
	return {
		version: 1,
		repository: match(input.repository, REPOSITORY, "repository"),
		number: integer(input.number),
		generation: match(
			input.generation,
			/^[A-Za-z0-9_-]{16,128}(?![\s\S])/,
			"generation",
		),
		correlation: match(input.correlation, UUID, "correlation"),
		head_sha: match(input.head_sha, SHA, "head SHA"),
		base_sha: match(input.base_sha, SHA, "base SHA"),
		merge_sha: match(input.merge_sha, SHA, "merge SHA"),
		state_comment_id: integer(input.state_comment_id),
		attempt: integer(input.attempt, 0, 3),
	};
}

export function parseCIReceipt(value: unknown): CIReceipt {
	const input = bounded(value);
	keys(input, [
		"schema_version",
		"repository",
		"task",
		"run_id",
		"run_attempt",
		"workflow_sha",
		"tested_sha",
		"jobs",
	]);
	requireValid(
		input.schema_version === 1 && input.run_attempt === 1,
		"Unsupported CI receipt version or rerun",
	);
	const task = parseCITask(input.task);
	const jobs = object(input.jobs);
	keys(jobs, ["lint", "typecheck", "unit", "integration"]);
	requireValid(
		input.repository === task.repository &&
			input.workflow_sha === task.base_sha &&
			input.tested_sha === task.merge_sha,
		"CI receipt repository or revision mismatch",
	);
	return {
		schema_version: 1,
		repository: task.repository,
		task,
		run_id: integer(input.run_id),
		run_attempt: 1,
		workflow_sha: task.base_sha,
		tested_sha: task.merge_sha,
		jobs: {
			lint: outcome(jobs.lint),
			typecheck: outcome(jobs.typecheck),
			unit: outcome(jobs.unit),
			integration: outcome(jobs.integration),
		},
	};
}

export interface CIContext {
	repository: string;
	ref: string;
	workflowSha: string;
	actor: string;
	appBotLogin: string;
	runId: number;
	runAttempt: number;
	eventName: string;
	enabled: string;
}

function authorizeInvocation(task: CITask, context: CIContext): void {
	requireValid(
		/^[A-Za-z0-9-]+\[bot\](?![\s\S])/.test(context.appBotLogin) &&
			context.appBotLogin !== "github-actions[bot]" &&
			context.actor === context.appBotLogin,
		"Only the configured dedicated App may dispatch automation CI",
	);
	requireValid(
		context.eventName === "workflow_dispatch" &&
			context.ref === "refs/heads/main" &&
			context.repository === task.repository &&
			context.workflowSha === task.base_sha,
		"Automation CI must use the reserved trusted-main workflow revision",
	);
	requireValid(context.enabled === "true", "Automation CI is disabled");
	requireValid(
		context.runAttempt === 1,
		"Automation CI reruns are not authorized",
	);
	integer(context.runId);
}

export async function prepareCI(input: {
	task: unknown;
	context: CIContext;
	github: Pick<GitHubClient, "request" | "list">;
	now: () => string;
}): Promise<{ checkout_sha: string; correlation: string }> {
	const task = parseCITask(input.task);
	authorizeInvocation(task, input.context);
	const root = `/repos/${task.repository}`;
	const comments = await input.github.list(
		`${root}/issues/${task.number}/comments`,
	);
	const { findState, pullRequestRevision } = await import("./state.ts");
	const reserved = findState(comments, input.context.appBotLogin, task.number);
	requireValid(
		reserved?.id === task.state_comment_id,
		"Current App-owned CI state comment is missing or replaced",
	);
	const state = object(reserved.state);
	requireValid(
		state.subject === "pr" &&
			state.number === task.number &&
			state.phase === "reviewing" &&
			state.generation === task.generation &&
			state.head_sha === task.head_sha &&
			state.base_sha === task.base_sha &&
			state.reimplementation_attempts === task.attempt,
		"CI reservation has been superseded or is inactive",
	);
	const slot = object(state.ci);
	requireValid(
		slot.artifact_id === null &&
			(slot.run_id === null || slot.run_id === input.context.runId) &&
			(slot.run_attempt === null || slot.run_attempt === 1) &&
			(slot.run_id === null) === (slot.run_attempt === null) &&
			JSON.stringify(parseCITask(slot.task)) === JSON.stringify(task),
		"CI task differs from its reservation, belongs to another run, or was consumed",
	);
	const [issueValue, prValue, mainValue, commitValue] = await Promise.all([
		input.github.request("GET", `${root}/issues/${task.number}`),
		input.github.request("GET", `${root}/pulls/${task.number}`),
		input.github.request("GET", `${root}/git/ref/heads/main`),
		input.github.request("GET", `${root}/git/commits/${task.merge_sha}`),
	]);
	const issue = object(issueValue);
	requireValid(
		issue.number === task.number &&
			issue.state === "open" &&
			Array.isArray(issue.labels),
		"CI pull request issue is closed or unavailable",
	);
	requireValid(
		!issue.labels.some(
			(label: unknown) =>
				label === "agentic:hold" ||
				(record(label) && label.name === "agentic:hold"),
		),
		"CI pull request is on hold",
	);
	const pr = object(prValue);
	const head = object(pr.head);
	const base = object(pr.base);
	requireValid(
		pr.number === task.number &&
			pr.state === "open" &&
			pr.draft === false &&
			pullRequestRevision(pr) === state.revision_hash &&
			pr.mergeable === true &&
			pr.merge_commit_sha === task.merge_sha &&
			head.sha === task.head_sha &&
			base.sha === task.base_sha &&
			base.ref === "main" &&
			object(base.repo).full_name === task.repository,
		"CI pull request is stale, has a foreign base, or has no matching mergeable revision",
	);
	match(object(head.repo).full_name, REPOSITORY, "fork repository");
	const main = object(mainValue);
	requireValid(
		main.ref === "refs/heads/main" &&
			object(main.object).type === "commit" &&
			object(main.object).sha === task.base_sha,
		"Main moved after the CI task was reserved",
	);
	const commit = object(commitValue);
	requireValid(
		commit.sha === task.merge_sha &&
			Array.isArray(commit.parents) &&
			commit.parents.length === 2 &&
			object(commit.parents[0]).sha === task.base_sha &&
			object(commit.parents[1]).sha === task.head_sha,
		"Synthetic merge commit must have exactly the reserved ordered base/head parents",
	);
	const now = Date.parse(input.now());
	requireValid(
		Number.isFinite(now) &&
			typeof state.deadline === "string" &&
			now < Date.parse(state.deadline) &&
			typeof slot.dispatched_at === "string" &&
			Date.parse(slot.dispatched_at) <= now,
		"CI reservation deadline expired or reservation time is invalid",
	);
	return { checkout_sha: task.merge_sha, correlation: task.correlation };
}

export function publishCIReceipt(input: {
	task: unknown;
	context: CIContext;
	testedSha: unknown;
	needs: unknown;
}): CIReceipt {
	const task = parseCITask(input.task);
	authorizeInvocation(task, input.context);
	const needs = bounded(input.needs);
	keys(needs, [
		"agentic-revision",
		"lint",
		"typecheck",
		"unit-test",
		"integration-test",
	]);
	const revision = object(needs["agentic-revision"]);
	const outputs = object(revision.outputs);
	requireValid(
		revision.result === "success" &&
			input.testedSha === task.merge_sha &&
			outputs.checkout_sha === task.merge_sha &&
			outputs.correlation === task.correlation,
		"CI revision authorization did not succeed for the reserved tested SHA",
	);
	return parseCIReceipt({
		schema_version: 1,
		repository: input.context.repository,
		task,
		run_id: input.context.runId,
		run_attempt: input.context.runAttempt,
		workflow_sha: input.context.workflowSha,
		tested_sha: input.testedSha,
		jobs: {
			lint: outcome(object(needs.lint).result),
			typecheck: outcome(object(needs.typecheck).result),
			unit: outcome(object(needs["unit-test"]).result),
			integration: outcome(object(needs["integration-test"]).result),
		},
	});
}

function required(name: string): string {
	const value = process.env[name];
	requireValid(value, `Missing ${name}`);
	return value;
}

async function main(): Promise<void> {
	const task = parseCITask(required("CI_TASK_JSON"));
	const context: CIContext = {
		repository: required("GITHUB_REPOSITORY"),
		ref: required("GITHUB_REF"),
		workflowSha: required("GITHUB_SHA"),
		actor: required("GITHUB_ACTOR"),
		appBotLogin: required("C8CTL_APP_BOT_LOGIN"),
		runId: Number(required("GITHUB_RUN_ID")),
		runAttempt: Number(required("GITHUB_RUN_ATTEMPT")),
		eventName: required("GITHUB_EVENT_NAME"),
		enabled: required("C8CTL_AUTOMATION_ENABLED"),
	};
	authorizeInvocation(task, context);
	requireValid(
		execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() ===
			context.workflowSha,
		"CI metadata host must check out the trusted workflow SHA",
	);
	if (process.argv[2] === "prepare") {
		const { GitHub } = await import("./github.ts");
		const result = await prepareCI({
			task,
			context,
			github: new GitHub({
				token: required("GH_TOKEN"),
				apiUrl: process.env.GITHUB_API_URL,
			}),
			now: () => new Date().toISOString(),
		});
		appendFileSync(
			required("GITHUB_OUTPUT"),
			`checkout_sha=${result.checkout_sha}\ncorrelation=${result.correlation}\n`,
		);
		console.log("Reserved immutable CI revision authorized.");
		return;
	}
	requireValid(process.argv[2] === "publish", "Usage: ci.ts prepare|publish");
	const receipt = publishCIReceipt({
		task,
		context,
		testedSha: required("CI_TESTED_SHA"),
		needs: required("CI_NEEDS_JSON"),
	});
	const output = required("CI_REPORT_OUT");
	const directory = required("RUNNER_TEMP");
	requireValid(
		basename(output) === "report.json" &&
			resolve(output) === resolve(directory, "report.json"),
		"CI receipt output must be runner.temp/report.json",
	);
	const metadata = lstatSync(directory);
	requireValid(
		metadata.isDirectory() && !metadata.isSymbolicLink(),
		"CI receipt output directory must be a real directory",
	);
	writeFileSync(output, `${JSON.stringify(receipt)}\n`, {
		flag: "wx",
		mode: 0o600,
	});
	console.log(
		"Immutable CI receipt recorded; aggregate outcomes do not replace required-job API verification.",
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	main().catch((error: unknown) => {
		console.error(
			error instanceof Error ? error.message : "Immutable CI task failed",
		);
		process.exitCode = 1;
	});
}

import { execFileSync } from "node:child_process";
import { appendFileSync, lstatSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { GitHubClient } from "./github.ts";
