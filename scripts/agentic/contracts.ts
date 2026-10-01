/**
 * Versioned automation contracts. Parsers accept decoded JSON, reject unknown
 * fields, and throw TypeError; they do not authenticate the source of an envelope.
 * Only the adapter may attach coordinator identities to an untrusted report.
 */
export type WorkerKind =
	| "fitness"
	| "implement"
	| "review-copilot"
	| "review-claude"
	| "reimplement";

export interface WorkerTask {
	version: 1;
	kind: WorkerKind;
	repository: string;
	number: number;
	generation: string;
	correlation: string;
	head_sha: string;
	base_sha: string;
	/** UTC ISO timestamp, with seconds or three fractional digits; empty for PRs. */
	issue_revision: string;
	attempt: number;
	state_comment_id: number;
	/** Untrusted issue, review and CI text, never an authority for identities. */
	instruction: string;
}

export interface Finding {
	severity: "low" | "medium" | "high" | "critical";
	path: string;
	line: number;
	title: string;
	body: string;
}

export interface ReviewReport {
	schema_version: 1;
	status: "complete" | "blocked";
	findings: readonly Finding[];
	change_class: "patch" | "additive-minor" | "other" | "unknown";
	release_intent: "patch" | "minor" | "none" | "major" | "unknown";
	merge_eligible: boolean;
	evidence: string;
	blockers: readonly string[];
}

export interface FitnessReport {
	schema_version: 1;
	decision:
		| "ready"
		| "already_implemented"
		| "needs_spec"
		| "in_progress"
		| "blocked";
	criteria: readonly string[];
	evidence: string;
	blockers: readonly string[];
	related_prs: readonly number[];
}

interface ReportEnvelope<Report> {
	schema_version: 1;
	repository: string;
	task: WorkerTask;
	engine: "copilot" | "claude";
	run_id: number;
	run_attempt: number;
	workflow_sha: string;
	report: Report;
}

export type ReviewEnvelope = ReportEnvelope<ReviewReport>;
export type FitnessEnvelope = ReportEnvelope<FitnessReport>;

function invalid(field: string): never {
	throw new TypeError(`Invalid ${field}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null)
	);
}

function record(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	if (
		!isRecord(value) ||
		Reflect.ownKeys(value).length !== keys.length ||
		!keys.every((key) => Object.hasOwn(value, key))
	) {
		return invalid(`object; expected only ${keys.join(", ")}`);
	}
	return value;
}

function text(
	value: unknown,
	field: string,
	max: number,
	allowEmpty = false,
): string {
	if (
		typeof value !== "string" ||
		value.length > max ||
		(!allowEmpty && value.trim().length === 0)
	) {
		return invalid(field);
	}
	return value;
}

function choice<const T extends string | number>(
	value: unknown,
	choices: readonly T[],
	field: string,
): T {
	for (const option of choices) {
		if (value === option) return option;
	}
	return invalid(field);
}

function integer(
	value: unknown,
	field: string,
	min = 1,
	max = Number.MAX_SAFE_INTEGER,
): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < min ||
		value > max
	) {
		return invalid(field);
	}
	return value;
}

function pattern(
	value: unknown,
	field: string,
	expression: RegExp,
	max: number,
): string {
	const parsed = text(value, field, max);
	if (!expression.test(parsed)) return invalid(field);
	return parsed;
}

function isUnknownArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
}

function list<T>(
	value: unknown,
	field: string,
	parse: (item: unknown) => T,
	min = 0,
): T[] {
	if (!isUnknownArray(value) || value.length < min || value.length > 50) {
		return invalid(field);
	}
	return Array.from(value, parse);
}

function strings(
	value: unknown,
	field: string,
	max: number,
	min = 0,
): string[] {
	return list(value, field, (item) => text(item, field, max), min);
}

// Negative lookahead anchors avoid JavaScript `$` accepting a trailing newline.
export function isCommitSha(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{40}(?![\s\S])/.test(value);
}

export function isIsoTimestamp(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z(?![\s\S])/.test(value)
	) {
		return false;
	}
	const milliseconds = Date.parse(value);
	const canonical = value.length === 20 ? value.replace("Z", ".000Z") : value;
	return (
		Number.isFinite(milliseconds) &&
		new Date(milliseconds).toISOString() === canonical
	);
}

function sha(value: unknown, field: string): string {
	return isCommitSha(value) ? value : invalid(field);
}

function repository(value: unknown): string {
	const parsed = pattern(
		value,
		"repository",
		/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}(?![\s\S])/,
		140,
	);
	const [owner, name] = parsed.split("/");
	if (owner?.includes("--") || name === "." || name === "..") {
		return invalid("repository");
	}
	return parsed;
}

export function parseWorkerTask(value: unknown): WorkerTask {
	const input = record(value, [
		"version",
		"kind",
		"repository",
		"number",
		"generation",
		"correlation",
		"head_sha",
		"base_sha",
		"issue_revision",
		"attempt",
		"state_comment_id",
		"instruction",
	]);
	const kind = choice(
		input.kind,
		["fitness", "implement", "review-copilot", "review-claude", "reimplement"],
		"kind",
	);
	const issueRevision = text(input.issue_revision, "issue_revision", 24, true);
	const issueTask = kind === "fitness" || kind === "implement";
	if (issueTask ? !isIsoTimestamp(issueRevision) : issueRevision !== "") {
		return invalid("issue_revision");
	}
	return {
		version: choice(input.version, [1], "version"),
		kind,
		repository: repository(input.repository),
		number: integer(input.number, "number"),
		generation: pattern(
			input.generation,
			"generation",
			/^[A-Za-z0-9_-]{16,128}(?![\s\S])/,
			128,
		),
		correlation: pattern(
			input.correlation,
			"correlation",
			/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/,
			36,
		),
		head_sha: sha(input.head_sha, "head_sha"),
		base_sha: sha(input.base_sha, "base_sha"),
		issue_revision: issueRevision,
		attempt: integer(input.attempt, "attempt", 0, 3),
		state_comment_id: integer(input.state_comment_id, "state_comment_id"),
		instruction: text(input.instruction, "instruction", 20000, true),
	};
}

function parseFinding(value: unknown): Finding {
	const input = record(value, ["severity", "path", "line", "title", "body"]);
	const path = text(input.path, "finding.path", 1024);
	if (
		[...path].some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		) ||
		path.includes("\\") ||
		path.includes(":") ||
		path
			.split("/")
			.some((segment) => segment === "" || segment === "." || segment === "..")
	) {
		return invalid("finding.path");
	}
	return {
		severity: choice(
			input.severity,
			["low", "medium", "high", "critical"],
			"finding.severity",
		),
		path,
		line: integer(input.line, "finding.line"),
		title: text(input.title, "finding.title", 200),
		body: text(input.body, "finding.body", 4000),
	};
}

export function parseReviewReport(value: unknown): ReviewReport {
	const input = record(value, [
		"schema_version",
		"status",
		"findings",
		"change_class",
		"release_intent",
		"merge_eligible",
		"evidence",
		"blockers",
	]);
	if (typeof input.merge_eligible !== "boolean")
		return invalid("merge_eligible");
	const report: ReviewReport = {
		schema_version: choice(input.schema_version, [1], "schema_version"),
		status: choice(input.status, ["complete", "blocked"], "status"),
		findings: list(input.findings, "findings", parseFinding),
		change_class: choice(
			input.change_class,
			["patch", "additive-minor", "other", "unknown"],
			"change_class",
		),
		release_intent: choice(
			input.release_intent,
			["patch", "minor", "none", "major", "unknown"],
			"release_intent",
		),
		merge_eligible: input.merge_eligible,
		evidence: text(input.evidence, "evidence", 12000),
		blockers: strings(input.blockers, "blockers", 4000),
	};
	if (
		(report.status === "complete" && report.blockers.length > 0) ||
		(report.status === "blocked" &&
			(report.merge_eligible || report.blockers.length === 0))
	) {
		return invalid("status/blockers contradiction");
	}
	const allowedRelease =
		(report.change_class === "patch" && report.release_intent === "patch") ||
		(report.change_class === "additive-minor" &&
			report.release_intent === "minor");
	if (
		report.merge_eligible &&
		(report.findings.length > 0 || !allowedRelease)
	) {
		return invalid("merge_eligible contradiction");
	}
	return report;
}

export function parseFitnessReport(value: unknown): FitnessReport {
	const input = record(value, [
		"schema_version",
		"decision",
		"criteria",
		"evidence",
		"blockers",
		"related_prs",
	]);
	const report: FitnessReport = {
		schema_version: choice(input.schema_version, [1], "schema_version"),
		decision: choice(
			input.decision,
			["ready", "already_implemented", "needs_spec", "in_progress", "blocked"],
			"decision",
		),
		criteria: strings(input.criteria, "criteria", 2000, 1),
		evidence: text(input.evidence, "evidence", 12000),
		blockers: strings(input.blockers, "blockers", 4000),
		related_prs: list(input.related_prs, "related_prs", (item) =>
			integer(item, "related_prs"),
		),
	};
	if (report.decision === "ready" && report.blockers.length > 0) {
		return invalid("ready/blockers contradiction");
	}
	return report;
}

function parseEnvelope<Report>(
	value: unknown,
	parseReport: (report: unknown) => Report,
): ReportEnvelope<Report> {
	const input = record(value, [
		"schema_version",
		"repository",
		"task",
		"engine",
		"run_id",
		"run_attempt",
		"workflow_sha",
		"report",
	]);
	const task = parseWorkerTask(input.task);
	const provenance = repository(input.repository);
	if (provenance !== task.repository) return invalid("repository provenance");
	return {
		schema_version: choice(input.schema_version, [1], "schema_version"),
		repository: provenance,
		task,
		engine: choice(input.engine, ["copilot", "claude"], "engine"),
		run_id: integer(input.run_id, "run_id"),
		run_attempt: integer(input.run_attempt, "run_attempt"),
		workflow_sha: sha(input.workflow_sha, "workflow_sha"),
		report: parseReport(input.report),
	};
}

export function parseReviewEnvelope(value: unknown): ReviewEnvelope {
	const envelope = parseEnvelope(value, parseReviewReport);
	if (envelope.task.kind !== `review-${envelope.engine}`) {
		return invalid("review engine/task kind");
	}
	return envelope;
}

export function parseFitnessEnvelope(value: unknown): FitnessEnvelope {
	const envelope = parseEnvelope(value, parseFitnessReport);
	if (envelope.task.kind !== "fitness") return invalid("fitness task kind");
	return envelope;
}
