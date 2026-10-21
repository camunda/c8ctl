import { constants } from "node:fs";
import { lstat, open, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { type ChangeReport, parseChangeReport } from "./changes.ts";
import {
	type FitnessReport,
	isCommitSha,
	isIsoTimestamp,
	parseFitnessReport,
	parseReviewReport,
	parseWorkerTask,
	type ReviewReport,
	type WorkerTask,
} from "./contracts.ts";
import { GitHub } from "./github.ts";
import { findState, issueRevision, pullRequestRevision } from "./state.ts";

const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_REPORT_BYTES = 750_000;
const MAX_TRANSPORT_BYTES = 500_000;
const REPORT_TRANSPORT_PREFIX = "c8ctl-report-v1:gzip-base64:";
type Engine = "copilot" | "claude";

export interface PublishedReport {
	schema_version: 1;
	repository: string;
	task: WorkerTask;
	engine: Engine;
	run_id: number;
	run_attempt: number;
	workflow_sha: string;
	report: FitnessReport | ReviewReport | ChangeReport;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireValid(condition: unknown, reason: string): asserts condition {
	if (!condition) throw new TypeError(reason);
}

function decode(value: unknown): unknown {
	if (typeof value !== "string") return value;
	requireValid(
		Buffer.byteLength(value, "utf8") <= MAX_OUTPUT_BYTES,
		"Agent output exceeds size limit",
	);
	return JSON.parse(value);
}

function decodeReportTransport(value: string): unknown {
	requireValid(
		value.length <= MAX_TRANSPORT_BYTES &&
			value.startsWith(REPORT_TRANSPORT_PREFIX),
		"Expected bounded c8ctl-report-v1:gzip-base64 transport",
	);
	const encoded = value.slice(REPORT_TRANSPORT_PREFIX.length);
	requireValid(
		encoded.length > 0 &&
			encoded.length % 4 === 0 &&
			/^[A-Za-z0-9+/]+={0,2}$/.test(encoded),
		"Report transport is not canonical base64",
	);
	const compressed = Buffer.from(encoded, "base64");
	requireValid(
		compressed.toString("base64") === encoded,
		"Report transport is not canonical base64",
	);
	let bytes: Buffer;
	try {
		bytes = gunzipSync(compressed, { maxOutputLength: MAX_REPORT_BYTES });
	} catch {
		throw new TypeError(
			"Invalid gzip report or decoded report exceeds 750000 bytes",
		);
	}
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function reportType(task: WorkerTask): string {
	return task.kind === "fitness"
		? "report_fitness"
		: task.kind.startsWith("review-")
			? "report_review"
			: "report_change";
}

function blockedReport(
	task: WorkerTask,
	reason: string,
): PublishedReport["report"] {
	const evidence =
		"The trusted publisher could not validate a successful worker report.";
	if (task.kind === "fitness")
		return {
			schema_version: 1,
			decision: "blocked",
			criteria: ["Trusted worker report validation must succeed."],
			evidence,
			blockers: [reason],
			related_prs: [],
		};
	if (task.kind.startsWith("review-"))
		return {
			schema_version: 1,
			status: "blocked",
			findings: [],
			change_class: "unknown",
			release_intent: "unknown",
			merge_eligible: false,
			evidence,
			blockers: [reason],
		};
	return {
		schema_version: 1,
		status: "blocked",
		title: "chore: automation blocked",
		summary: "Trusted worker validation blocked this report.",
		evidence,
		blockers: [reason],
		files: [],
	};
}

/** Model data supplies only a report; identities are exclusively runner context. */
export function publishReport(input: {
	raw: unknown;
	task: unknown;
	engine: unknown;
	repository: unknown;
	runId: unknown;
	runAttempt: unknown;
	workflowSha: unknown;
	needs: unknown;
}): PublishedReport {
	const task = parseWorkerTask(input.task);
	const engine = task.kind === "review-claude" ? "claude" : "copilot";
	requireValid(
		input.engine === engine,
		"Engine does not match the reserved task",
	);
	requireValid(
		input.repository === task.repository,
		"Repository does not match the reserved task",
	);
	requireValid(
		typeof input.runId === "number" &&
			Number.isSafeInteger(input.runId) &&
			input.runId > 0,
		"Invalid run ID",
	);
	requireValid(
		typeof input.runAttempt === "number" &&
			Number.isSafeInteger(input.runAttempt) &&
			input.runAttempt > 0,
		"Invalid run attempt",
	);
	requireValid(isCommitSha(input.workflowSha), "Invalid workflow SHA");
	let report: PublishedReport["report"];
	try {
		const needs = decode(input.needs);
		requireValid(record(needs), "Missing worker job outcomes");
		requireValid(
			record(needs.agent) && needs.agent.result === "success",
			"Agent job did not succeed",
		);
		requireValid(
			record(needs.detection) &&
				needs.detection.result === "success" &&
				record(needs.detection.outputs) &&
				needs.detection.outputs.detection_success === "true",
			"Threat detection did not explicitly succeed",
		);
		const type = reportType(task);
		const job = needs[type];
		requireValid(
			record(job) && job.result === "success",
			"Expected report job did not succeed",
		);
		requireValid(input.raw !== undefined, "Agent output file is missing");
		const raw = decode(input.raw);
		requireValid(record(raw), "Agent output must be an object");
		requireValid(
			Buffer.byteLength(JSON.stringify(raw), "utf8") <= MAX_OUTPUT_BYTES,
			"Agent output exceeds size limit",
		);
		requireValid(
			raw.errors === undefined ||
				(Array.isArray(raw.errors) && raw.errors.length === 0),
			"Agent output contains errors",
		);
		requireValid(
			Array.isArray(raw.items) && raw.items.length === 1,
			"Expected exactly one report tool call",
		);
		const item: unknown = raw.items[0];
		requireValid(
			record(item) &&
				item.type === type &&
				typeof item.report === "string" &&
				Object.keys(item).length === 2,
			"Unexpected report tool call",
		);
		const decoded = decodeReportTransport(item.report);
		report =
			task.kind === "fitness"
				? parseFitnessReport(decoded)
				: task.kind.startsWith("review-")
					? parseReviewReport(decoded)
					: parseChangeReport(decoded);
		if (task.kind === "reimplement" && "title" in report)
			requireValid(
				/^chore(?:\([^()\r\n]+\))?: /.test(report.title),
				"Reimplementation title must use chore",
			);
	} catch (error) {
		const reason =
			error instanceof Error && error.name === "TypeError"
				? error.message.slice(0, 500)
				: "Malformed or unreadable worker report";
		report = blockedReport(task, reason);
	}
	const envelope: PublishedReport = {
		schema_version: 1,
		repository: task.repository,
		task,
		engine,
		run_id: input.runId,
		run_attempt: input.runAttempt,
		workflow_sha: input.workflowSha,
		report,
	};
	requireValid(
		Buffer.byteLength(JSON.stringify(envelope), "utf8") <= MAX_OUTPUT_BYTES,
		"Published worker report exceeds size limit",
	);
	return envelope;
}

export async function readAgentOutput(
	path: string,
): Promise<string | undefined> {
	try {
		const metadata = await lstat(path);
		requireValid(
			metadata.isFile() && !metadata.isSymbolicLink(),
			"Agent output must be a regular file",
		);
		requireValid(
			metadata.size <= MAX_OUTPUT_BYTES,
			"Agent output exceeds size limit",
		);
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stats = await file.stat();
			requireValid(stats.isFile(), "Agent output must be a regular file");
			requireValid(
				stats.size <= MAX_OUTPUT_BYTES,
				"Agent output exceeds size limit",
			);
			const buffer = Buffer.alloc(MAX_OUTPUT_BYTES + 1);
			let length = 0;
			while (length < buffer.length) {
				const read = await file.read(
					buffer,
					length,
					buffer.length - length,
					null,
				);
				if (read.bytesRead === 0) break;
				length += read.bytesRead;
			}
			requireValid(
				length <= MAX_OUTPUT_BYTES,
				"Agent output exceeds size limit",
			);
			return new TextDecoder("utf-8", { fatal: true }).decode(
				buffer.subarray(0, length),
			);
		} finally {
			await file.close();
		}
	} catch (error) {
		if (record(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
}

/** Read-only authorization, separate from all coordinator mutation APIs. */
export function authorizeWorkerTask(input: {
	task: unknown;
	repository: unknown;
	kind: unknown;
	headSha: unknown;
	botLogin: unknown;
	actor: unknown;
	runAttempt: unknown;
	now: unknown;
	comment: unknown;
	issue: unknown;
	comments?: unknown;
	pullRequest?: unknown;
	mainSha?: unknown;
}): WorkerTask {
	const botLogin = authorizeInvocation(input);
	const task = parseWorkerTask(input.task);
	requireValid(
		task.repository === input.repository && task.kind === input.kind,
		"Wrong workflow repository or task kind",
	);
	requireValid(
		task.head_sha === input.headSha,
		"Checkout differs from reserved head",
	);
	const comment = input.comment;
	requireValid(
		record(comment) &&
			comment.id === task.state_comment_id &&
			record(comment.user) &&
			comment.user.login === input.botLogin &&
			comment.user.type === "Bot" &&
			comment.issue_url ===
				`https://api.github.com/repos/${task.repository}/issues/${task.number}`,
		"State comment is not owned by the configured App on this item",
	);
	let reserved: ReturnType<typeof findState>;
	try {
		reserved = findState([comment], botLogin, task.number);
	} catch {
		throw new TypeError("Invalid coordinator state comment");
	}
	requireValid(reserved, "Missing coordinator state comment");
	const state = reserved.state;
	requireValid(
		isIsoTimestamp(input.now) &&
			Date.parse(input.now) < Date.parse(state.deadline),
		"Worker deadline has expired or current time is invalid",
	);
	requireValid(
		state.generation === task.generation,
		"Invalid state generation",
	);
	const issueTask = task.kind === "fitness" || task.kind === "implement";
	requireValid(
		state.subject === (issueTask ? "issue" : "pr") &&
			state.head_sha === task.head_sha &&
			state.base_sha === task.base_sha &&
			state.issue_revision === task.issue_revision &&
			state.reimplementation_attempts === task.attempt,
		"Worker reservation has been superseded",
	);
	const phase =
		task.kind === "fitness"
			? "fitness"
			: task.kind.includes("implement")
				? "implementing"
				: "reviewing";
	requireValid(state.phase === phase, "Worker reservation is not active");
	const slot = state.slots[task.kind];
	requireValid(record(slot), "Worker has no reserved slot");
	requireValid(slot.artifact_id === null, "Worker report was already consumed");
	requireValid(
		JSON.stringify(parseWorkerTask(slot.task)) === JSON.stringify(task),
		"Worker task differs from its reservation",
	);
	const issue = input.issue;
	requireValid(
		record(issue) &&
			issue.number === task.number &&
			issue.state === "open" &&
			Array.isArray(issue.labels),
		"Issue is not open or labels are missing",
	);
	requireValid(
		!issue.labels.some(
			(label: unknown) =>
				label === "agentic:hold" ||
				(record(label) && label.name === "agentic:hold"),
		),
		"Item is on hold",
	);
	if (task.kind === "fitness" || task.kind === "implement") {
		requireValid(
			Array.isArray(input.comments) && input.comments.length === issue.comments,
			"Complete current issue comments are required",
		);
		const revision = issueRevision(issue, input.comments, botLogin, {
			hash: state.revision_hash,
			timestamp: state.issue_revision,
		});
		requireValid(
			revision.hash === state.revision_hash &&
				revision.timestamp === task.issue_revision,
			"Issue text or human replies changed after reservation",
		);
		requireValid(
			task.head_sha === task.base_sha && input.mainSha === task.base_sha,
			"Main has moved since the task was reserved",
		);
	} else {
		const pr = input.pullRequest;
		requireValid(
			record(pr) &&
				pr.number === task.number &&
				pr.state === "open" &&
				pr.draft === false &&
				pullRequestRevision(pr) === state.revision_hash &&
				record(pr.head) &&
				pr.head.sha === task.head_sha &&
				record(pr.head.repo) &&
				typeof pr.head.repo.full_name === "string" &&
				pr.head.repo.full_name.length > 0 &&
				record(pr.base) &&
				pr.base.sha === task.base_sha &&
				pr.base.ref === "main" &&
				record(pr.base.repo) &&
				pr.base.repo.full_name === task.repository,
			"Pull request is closed, has a foreign base, or its head/base changed",
		);
		parseWorkerTask({ ...task, repository: pr.head.repo.full_name });
	}
	return task;
}

function authorizeInvocation(input: {
	botLogin: unknown;
	actor: unknown;
	runAttempt: unknown;
}): string {
	requireValid(
		typeof input.botLogin === "string" &&
			/^[A-Za-z0-9-]+\[bot\]$/.test(input.botLogin) &&
			input.botLogin !== "github-actions[bot]",
		"Configure the dedicated App bot login",
	);
	requireValid(
		input.actor === input.botLogin,
		"Only the configured App may dispatch workers",
	);
	requireValid(input.runAttempt === 1, "Worker reruns are not authorized");
	return input.botLogin;
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	requireValid(
		typeof value === "string" && value.length > 0,
		`Missing ${name}`,
	);
	return value;
}

export async function prepareWorkerTask(input: {
	task: unknown;
	repository: unknown;
	kind: unknown;
	botLogin: unknown;
	actor: unknown;
	runAttempt: unknown;
	now: () => string;
	github: Pick<GitHub, "request" | "list">;
}): Promise<WorkerTask> {
	const botLogin = authorizeInvocation(input);
	const task = parseWorkerTask(input.task);
	requireValid(
		task.repository === input.repository && task.kind === input.kind,
		"Wrong workflow repository or task kind",
	);
	const root = `/repos/${task.repository}`;
	const comments = await input.github.list(
		`${root}/issues/${task.number}/comments`,
	);
	const tracked = findState(comments, botLogin, task.number);
	requireValid(
		tracked?.id === task.state_comment_id,
		"Reserved state comment is missing or replaced",
	);
	const comment = comments.find(
		(value) => record(value) && value.id === task.state_comment_id,
	);
	const issueTask = task.kind === "fitness" || task.kind === "implement";
	const [issue, revision] = await Promise.all([
		input.github.request("GET", `${root}/issues/${task.number}`),
		input.github.request(
			"GET",
			issueTask ? `${root}/git/ref/heads/main` : `${root}/pulls/${task.number}`,
		),
	]);
	const mainSha =
		record(revision) && record(revision.object)
			? revision.object.sha
			: undefined;
	return authorizeWorkerTask({
		task,
		repository: input.repository,
		kind: input.kind,
		headSha: task.head_sha,
		botLogin,
		actor: input.actor,
		runAttempt: input.runAttempt,
		now: input.now(),
		comment,
		comments,
		issue,
		pullRequest: issueTask ? undefined : revision,
		mainSha,
	});
}

async function prepare(): Promise<void> {
	await prepareWorkerTask({
		task: decode(requiredEnv("TASK_JSON")),
		repository: requiredEnv("GITHUB_REPOSITORY"),
		kind: requiredEnv("EXPECTED_KIND"),
		botLogin: requiredEnv("C8CTL_APP_BOT_LOGIN"),
		actor: requiredEnv("GITHUB_ACTOR"),
		runAttempt: Number(requiredEnv("GITHUB_RUN_ATTEMPT")),
		now: () => new Date().toISOString(),
		github: new GitHub({ token: requiredEnv("GH_TOKEN") }),
	});
	console.log("Reserved worker task authorized.");
}

async function publish(): Promise<void> {
	let raw: unknown;
	try {
		raw = await readAgentOutput(requiredEnv("GH_AW_AGENT_OUTPUT"));
	} catch {
		raw = { errors: ["Unreadable or oversized agent output"], items: [] };
	}
	const envelope = publishReport({
		raw,
		task: decode(requiredEnv("TASK_JSON")),
		engine: requiredEnv("EXPECTED_ENGINE"),
		needs: requiredEnv("NEEDS_JSON"),
		repository: requiredEnv("GITHUB_REPOSITORY"),
		runId: Number(requiredEnv("GITHUB_RUN_ID")),
		runAttempt: Number(requiredEnv("GITHUB_RUN_ATTEMPT")),
		workflowSha: requiredEnv("GITHUB_SHA"),
	});
	const output = requiredEnv("REPORT_OUT");
	requireValid(
		basename(output) === "report.json",
		"Publisher may write only report.json",
	);
	await writeFile(output, `${JSON.stringify(envelope)}\n`, {
		flag: "wx",
		mode: 0o600,
	});
	console.log(
		envelope.report.blockers.length > 0
			? `Worker report blocked: ${JSON.stringify(envelope.report.blockers[0]?.slice(0, 500))}`
			: "Worker report validated.",
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	try {
		if (process.argv[2] === "prepare") await prepare();
		else if (process.argv[2] === "publish") await publish();
		else throw new TypeError("Expected prepare or publish mode");
	} catch (error) {
		console.error(
			error instanceof TypeError ? error.message : "Trusted worker failed",
		);
		process.exitCode = 1;
	}
}
