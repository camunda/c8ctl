import { createHash, randomUUID } from "node:crypto";
import { type CITask, parseCITask } from "./ci.ts";
import {
	type FitnessReport,
	isCommitSha,
	isIsoTimestamp,
	parseWorkerTask,
	type WorkerKind,
	type WorkerTask,
} from "./contracts.ts";
import { array, integer, object, string } from "./github.ts";

export const STATE_MARKER = "<!-- c8ctl-agentic-state:v1 -->";
export const WORKER_KINDS = [
	"fitness",
	"implement",
	"review-copilot",
	"review-claude",
	"reimplement",
] as const;
export interface Slot {
	task: WorkerTask;
	run_id: number | null;
	run_attempt: number | null;
	artifact_id: number | null;
	dispatched_at: string;
}
export interface CISlot {
	task: CITask;
	run_id: number | null;
	run_attempt: number | null;
	artifact_id: number | null;
	dispatched_at: string;
}
export interface State {
	schema_version: 1;
	subject: "issue" | "pr";
	number: number;
	generation: string;
	head_sha: string;
	base_sha: string;
	issue_revision: string;
	revision_hash: string;
	reimplementation_attempts: number;
	phase:
		| "fitness"
		| "implementing"
		| "reviewing"
		| "blocked"
		| "human"
		| "complete";
	deadline: string;
	total_dispatches: number;
	slots: Partial<Record<WorkerKind, Slot>>;
	ci: CISlot | null;
	outcome: string;
	related_prs: number[];
	implemented_pr: number | null;
	write_branch: string | null;
	written_sha: string | null;
	pending_operation: "branch" | "commit" | "pull-request" | null;
}

function valid(condition: boolean): asserts condition {
	if (!condition) throw new TypeError("Invalid agentic state");
}
function keys(input: Record<string, unknown>, expected: readonly string[]) {
	valid(
		Object.keys(input).length === expected.length &&
			expected.every((key) => Object.hasOwn(input, key)),
	);
}

export function parseState(value: unknown): State {
	const input = object(value);
	keys(input, [
		"schema_version",
		"subject",
		"number",
		"generation",
		"head_sha",
		"base_sha",
		"issue_revision",
		"revision_hash",
		"reimplementation_attempts",
		"phase",
		"deadline",
		"total_dispatches",
		"slots",
		"ci",
		"outcome",
		"related_prs",
		"implemented_pr",
		"write_branch",
		"written_sha",
		"pending_operation",
	]);
	valid(
		input.schema_version === 1 &&
			(input.subject === "issue" || input.subject === "pr"),
	);
	valid(isCommitSha(input.head_sha) && isCommitSha(input.base_sha));
	valid(
		typeof input.generation === "string" &&
			/^[A-Za-z0-9_-]{16,128}$/.test(input.generation),
	);
	valid(
		input.subject === "issue"
			? isIsoTimestamp(input.issue_revision)
			: input.issue_revision === "",
	);
	valid(
		typeof input.revision_hash === "string" &&
			(input.subject === "issue"
				? /^[a-f0-9]{64}$/.test(input.revision_hash)
				: input.revision_hash === "" ||
					/^[a-f0-9]{64}$/.test(input.revision_hash)),
	);
	valid(
		typeof input.reimplementation_attempts === "number" &&
			Number.isInteger(input.reimplementation_attempts) &&
			input.reimplementation_attempts >= 0 &&
			input.reimplementation_attempts <= 3,
	);
	valid(
		input.phase === "fitness" ||
			input.phase === "implementing" ||
			input.phase === "reviewing" ||
			input.phase === "blocked" ||
			input.phase === "human" ||
			input.phase === "complete",
	);
	valid(isIsoTimestamp(input.deadline));
	valid(
		typeof input.total_dispatches === "number" &&
			Number.isInteger(input.total_dispatches) &&
			input.total_dispatches >= 0 &&
			input.total_dispatches <= 20,
	);
	valid(typeof input.outcome === "string" && input.outcome.length <= 16000);
	valid(
		input.implemented_pr === null ||
			(typeof input.implemented_pr === "number" &&
				Number.isSafeInteger(input.implemented_pr) &&
				input.implemented_pr > 0),
	);
	valid(
		input.write_branch === null ||
			(typeof input.write_branch === "string" &&
				/^agentic\/(?:issue|remediation)-[1-9]\d*-[A-Za-z0-9_-]{16,128}$/.test(
					input.write_branch,
				)),
	);
	valid(input.written_sha === null || isCommitSha(input.written_sha));
	valid(
		input.pending_operation === null ||
			input.pending_operation === "branch" ||
			input.pending_operation === "commit" ||
			input.pending_operation === "pull-request",
	);
	const number = integer(input.number);
	const slots: State["slots"] = {};
	const rawSlots = object(input.slots);
	valid(
		Object.keys(rawSlots).every((kind) =>
			WORKER_KINDS.some((allowed) => allowed === kind),
		),
	);
	const correlations = new Set<string>();
	for (const kind of WORKER_KINDS) {
		if (!Object.hasOwn(rawSlots, kind)) continue;
		const slot = object(rawSlots[kind]);
		keys(slot, [
			"task",
			"run_id",
			"run_attempt",
			"artifact_id",
			"dispatched_at",
		]);
		const task = parseWorkerTask(slot.task);
		valid(
			task.kind === kind &&
				task.number === number &&
				task.generation === input.generation &&
				task.head_sha === input.head_sha &&
				task.base_sha === input.base_sha &&
				task.issue_revision === input.issue_revision &&
				task.attempt <= input.reimplementation_attempts &&
				(kind === "fitness" || kind === "implement") ===
					(input.subject === "issue"),
		);
		valid(!correlations.has(task.correlation));
		correlations.add(task.correlation);
		valid(isIsoTimestamp(slot.dispatched_at));
		const runId = slot.run_id === null ? null : integer(slot.run_id);
		const attempt =
			slot.run_attempt === null ? null : integer(slot.run_attempt);
		const artifactId =
			slot.artifact_id === null ? null : integer(slot.artifact_id);
		valid(
			(runId === null) === (attempt === null) &&
				(artifactId === null || runId !== null),
		);
		valid(attempt === null || attempt === 1);
		slots[kind] = {
			task,
			run_id: runId,
			run_attempt: attempt,
			artifact_id: artifactId,
			dispatched_at: slot.dispatched_at,
		};
	}
	let ci: CISlot | null = null;
	if (input.ci !== null) {
		const slot = object(input.ci);
		keys(slot, [
			"task",
			"run_id",
			"run_attempt",
			"artifact_id",
			"dispatched_at",
		]);
		const task = parseCITask(slot.task);
		valid(
			input.subject === "pr" &&
				task.number === number &&
				task.generation === input.generation &&
				task.head_sha === input.head_sha &&
				task.base_sha === input.base_sha &&
				task.attempt <= input.reimplementation_attempts &&
				!correlations.has(task.correlation) &&
				isIsoTimestamp(slot.dispatched_at),
		);
		const runId = slot.run_id === null ? null : integer(slot.run_id);
		const attempt =
			slot.run_attempt === null ? null : integer(slot.run_attempt);
		const artifactId =
			slot.artifact_id === null ? null : integer(slot.artifact_id);
		valid(
			(runId === null) === (attempt === null) &&
				(attempt === null || attempt === 1) &&
				(artifactId === null || runId !== null),
		);
		ci = {
			task,
			run_id: runId,
			run_attempt: attempt,
			artifact_id: artifactId,
			dispatched_at: slot.dispatched_at,
		};
	}
	valid(input.total_dispatches >= Object.keys(slots).length + (ci ? 1 : 0));
	const relatedPrs = array(input.related_prs).map(integer);
	valid(
		relatedPrs.length <= 50 && new Set(relatedPrs).size === relatedPrs.length,
	);
	return {
		schema_version: 1,
		subject: input.subject,
		number,
		generation: input.generation,
		head_sha: input.head_sha,
		base_sha: input.base_sha,
		issue_revision: string(input.issue_revision),
		revision_hash: input.revision_hash,
		reimplementation_attempts: input.reimplementation_attempts,
		phase: input.phase,
		deadline: input.deadline,
		total_dispatches: input.total_dispatches,
		slots,
		ci,
		outcome: input.outcome,
		related_prs: relatedPrs,
		implemented_pr: input.implemented_pr,
		write_branch: input.write_branch,
		written_sha: input.written_sha,
		pending_operation: input.pending_operation,
	};
}

export function newState(input: {
	subject: State["subject"];
	number: number;
	headSha: string;
	baseSha: string;
	now: string;
	issueRevision?: string;
	revisionHash?: string;
}): State {
	valid(isIsoTimestamp(input.now));
	return parseState({
		schema_version: 1,
		subject: input.subject,
		number: input.number,
		generation: randomUUID(),
		head_sha: input.headSha,
		base_sha: input.baseSha,
		issue_revision: input.issueRevision ?? "",
		revision_hash: input.revisionHash ?? "",
		reimplementation_attempts: 0,
		phase: input.subject === "issue" ? "fitness" : "reviewing",
		deadline: new Date(
			Date.parse(input.now) + 2 * 60 * 60 * 1000,
		).toISOString(),
		total_dispatches: 0,
		slots: {},
		ci: null,
		outcome: "Awaiting workers",
		related_prs: [],
		implemented_pr: null,
		write_branch: null,
		written_sha: null,
		pending_operation: null,
	});
}

export function renderState(input: State): string {
	const state = parseState(input);
	const outcome = state.outcome.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	// Escaping '<' prevents untrusted report text from creating another marker.
	const payload = JSON.stringify(state)
		.replaceAll("<", "\\u003c")
		.replaceAll("`", "\\u0060");
	const body = `${STATE_MARKER}\n### Agentic ${state.subject} coordination\nPhase: **${state.phase}** · fixes ${state.reimplementation_attempts}/3 · dispatches ${state.total_dispatches}/20\n\n${outcome}\n\n<details><summary>Coordinator state</summary>\n\n\`\`\`json\n${payload}\n\`\`\`\n</details>`;
	if (Buffer.byteLength(body) >= 60000)
		throw new Error("Agentic state comment is too large");
	return body;
}

export function remediationState(input: {
	source: State;
	number: number;
	headSha: string;
	baseSha: string;
	now: string;
}): State {
	const { source, number, headSha, baseSha, now } = input;
	if (
		source.subject !== "pr" ||
		source.written_sha !== headSha ||
		source.write_branch !==
			`agentic/remediation-${source.number}-${source.generation}` ||
		(source.implemented_pr !== null && source.implemented_pr !== number)
	)
		throw new Error("Remediation does not match a trusted parent session");
	return parseState({
		...newState({ subject: "pr", number, headSha, baseSha, now }),
		generation: source.generation,
		reimplementation_attempts: source.reimplementation_attempts,
		total_dispatches: source.total_dispatches,
		deadline: source.deadline,
		related_prs: [source.number],
		outcome: `Remediation of #${source.number}; original session budget and deadline retained`,
	});
}

export function findState(
	comments: readonly unknown[],
	appBotLogin: string,
	number: number,
): { id: number; state: State } | undefined {
	valid(appBotLogin.endsWith("[bot]") && appBotLogin !== "github-actions[bot]");
	const matches = comments.map(object).filter((comment) => {
		const user = object(comment.user);
		return (
			user.login === appBotLogin &&
			user.type === "Bot" &&
			typeof comment.body === "string" &&
			comment.body.includes(STATE_MARKER)
		);
	});
	if (matches.length > 1)
		throw new Error("Duplicate App-owned agentic state comments");
	const comment = matches[0];
	if (!comment) return undefined;
	const body = string(comment.body);
	valid(
		Buffer.byteLength(body) < 60000 &&
			body.startsWith(`${STATE_MARKER}\n`) &&
			body.split(STATE_MARKER).length === 2,
	);
	const payload = /\n```json\n([^\n]+)\n```\n<\/details>$/.exec(body)?.[1];
	valid(payload !== undefined);
	let decoded: unknown;
	try {
		decoded = JSON.parse(payload);
	} catch {
		throw new Error("Malformed agentic state JSON");
	}
	const state = parseState(decoded);
	valid(state.number === number);
	const id = integer(comment.id);
	for (const slot of Object.values(state.slots))
		valid(slot.task.state_comment_id === id);
	if (state.ci) valid(state.ci.task.state_comment_id === id);
	return { id, state };
}

export interface IssueRevision {
	hash: string;
	timestamp: string;
}

export function pullRequestRevision(value: unknown): string {
	const pr = object(value);
	valid(typeof pr.draft === "boolean");
	return createHash("sha256")
		.update(
			JSON.stringify([
				string(pr.title),
				pr.body === null ? "" : string(pr.body),
				pr.draft,
			]),
		)
		.digest("hex");
}

export function fitnessOutcome(input: {
	state: State;
	report: FitnessReport;
	artifactId: number | null;
}): string {
	const { state, report, artifactId } = input;
	const summary = {
		decision: report.decision,
		issue_revision: state.issue_revision,
		base_sha: state.base_sha,
		criteria: report.criteria,
		evidence: report.evidence,
		blockers: report.blockers,
		complete_report_artifact_id: artifactId,
	};
	const full = JSON.stringify(summary);
	const preview =
		full.length <= 12000
			? full
			: JSON.stringify({
					...summary,
					criteria: report.criteria
						.slice(0, 10)
						.map((item) => item.slice(0, 200)),
					evidence: report.evidence.slice(0, 3000),
					blockers: report.blockers
						.slice(0, 10)
						.map((item) => item.slice(0, 200)),
					truncated: true,
				});
	return `${report.decision}: ${preview}`;
}
export function issueRevision(
	issueValue: unknown,
	comments: readonly unknown[],
	appBotLogin: string,
	previous?: IssueRevision,
): IssueRevision {
	const issue = object(issueValue);
	const relevant = comments
		.map(object)
		.filter((comment) => {
			const user = object(comment.user);
			return (
				user.type !== "Bot" &&
				user.login !== appBotLogin &&
				typeof comment.body === "string" &&
				comment.body.trim().length > 0
			);
		})
		.sort((left, right) => integer(left.id) - integer(right.id));
	const hash = createHash("sha256")
		.update(
			JSON.stringify([
				string(issue.title),
				issue.body === null ? "" : string(issue.body),
				relevant.map((comment) => [integer(comment.id), string(comment.body)]),
			]),
		)
		.digest("hex");
	if (previous?.hash === hash) return previous;
	const timestamps = [
		issue.updated_at,
		issue.created_at,
		...relevant.map((comment) => comment.updated_at),
	];
	valid(timestamps.every(isIsoTimestamp));
	const timestamp = timestamps.map(string).sort().at(-1);
	valid(timestamp !== undefined);
	return { hash, timestamp };
}
