import {
	isCommitSha,
	isIsoTimestamp,
	parseReviewEnvelope,
	parseWorkerTask,
	type ReviewEnvelope,
	type ReviewReport,
	type WorkerTask,
} from "./contracts.ts";

export interface RevisionSnapshot {
	head_sha: string;
	base_sha: string;
}

export interface ConvergenceState extends RevisionSnapshot {
	/** Initial implementation is excluded; reserve the next attempt before dispatch. */
	reimplementation_attempts: number;
	phase: "reviewing" | "implementing" | "blocked" | "clean" | "human";
	deadline: string;
}

export type ReviewObservation =
	| { status: "waiting" }
	| { status: "failed"; reason: string }
	| { status: "completed"; envelope: ReviewEnvelope };

export interface ConvergenceInput {
	snapshot: RevisionSnapshot;
	state: ConvergenceState;
	/** Tasks recorded by the coordinator, not identities supplied by a model. */
	expected: { copilot: WorkerTask; claude: WorkerTask };
	reviews: { copilot?: ReviewObservation; claude?: ReviewObservation };
	ci: "pending" | "success" | "failure" | "blocked";
	now: string;
	kill?: boolean;
	hold?: boolean;
	/** The adapter associates this completion with the in-flight implementation. */
	implementation?:
		| { status: "running" | "failed" }
		| { status: "complete"; head_sha: string };
}

export type ConvergenceAction =
	| { action: "wait" }
	| {
			action: "review";
			snapshot: RevisionSnapshot;
			reimplementation_attempts: number;
	  }
	| { action: "reimplement"; next_attempt: number }
	| { action: "eligible"; release_intent: "patch" | "minor" }
	| { action: "human"; reason: string }
	| { action: "block"; reason: string };

const identityFields = [
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
] as const;

function expectedTasks(input: ConvergenceInput): ConvergenceInput["expected"] {
	const copilot = parseWorkerTask(input.expected.copilot);
	const claude = parseWorkerTask(input.expected.claude);
	if (
		copilot.kind !== "review-copilot" ||
		claude.kind !== "review-claude" ||
		copilot.correlation === claude.correlation
	) {
		throw new TypeError("Expected distinct Copilot and Claude review tasks");
	}
	for (const field of [
		"repository",
		"number",
		"generation",
		"state_comment_id",
	] as const) {
		if (copilot[field] !== claude[field]) {
			throw new TypeError(`Expected review tasks disagree on ${field}`);
		}
	}
	for (const task of [copilot, claude]) {
		if (
			task.head_sha !== input.snapshot.head_sha ||
			task.base_sha !== input.snapshot.base_sha ||
			task.attempt !== input.state.reimplementation_attempts
		) {
			throw new TypeError(
				"Expected review task is for a stale revision or attempt",
			);
		}
	}
	return { copilot, claude };
}

function observedReview(
	observation: ReviewObservation | undefined,
	expected: WorkerTask,
	engine: "copilot" | "claude",
): ReviewReport | undefined {
	if (!observation || observation.status === "waiting") return undefined;
	if (observation.status === "failed") {
		throw new TypeError(`${engine} review worker failed`);
	}
	const envelope = parseReviewEnvelope(observation.envelope);
	if (
		envelope.engine !== engine ||
		identityFields.some((field) => envelope.task[field] !== expected[field])
	) {
		throw new TypeError(
			`${engine} review has stale or mismatched task identity`,
		);
	}
	if (
		envelope.report.status === "blocked" ||
		envelope.report.blockers.length > 0
	) {
		throw new TypeError(`${engine} review is blocked`);
	}
	return envelope.report;
}

/**
 * Decide only: never merge, mutate state, dispatch work or consume an attempt.
 * The adapter serializes updates, reserves next_attempt before dispatch, and
 * verifies App authorship, run provenance and external repository safety gates.
 */
export function decideConvergence(input: ConvergenceInput): ConvergenceAction {
	const { snapshot, state } = input;
	if (input.kill) return { action: "block", reason: "Kill switch is active" };
	if (input.hold) return { action: "block", reason: "Hold is active" };
	if (!isIsoTimestamp(state.deadline) || !isIsoTimestamp(input.now)) {
		return { action: "block", reason: "Invalid deadline or current timestamp" };
	}
	if (Date.parse(input.now) >= Date.parse(state.deadline)) {
		return { action: "block", reason: "Convergence deadline reached" };
	}
	if (
		!isCommitSha(snapshot.head_sha) ||
		!isCommitSha(snapshot.base_sha) ||
		!isCommitSha(state.head_sha) ||
		!isCommitSha(state.base_sha) ||
		!Number.isInteger(state.reimplementation_attempts) ||
		state.reimplementation_attempts < 0 ||
		state.reimplementation_attempts > 3 ||
		!["reviewing", "implementing", "blocked", "clean", "human"].includes(
			state.phase,
		) ||
		!["pending", "success", "failure", "blocked"].includes(input.ci)
	) {
		return {
			action: "block",
			reason: "Invalid revision, phase, CI status or reimplementation budget",
		};
	}
	if (state.phase === "implementing") {
		const implementation = input.implementation;
		if (!implementation || implementation.status === "running") {
			return { action: "wait" };
		}
		if (implementation?.status === "failed") {
			return { action: "block", reason: "Implementation worker failed" };
		}
		if (implementation?.status === "complete") {
			if (
				!isCommitSha(implementation.head_sha) ||
				implementation.head_sha === state.head_sha ||
				implementation.head_sha !== snapshot.head_sha
			) {
				return {
					action: "block",
					reason:
						"Implementation made no progress or completed at a different head",
				};
			}
		}
	}
	if (
		snapshot.head_sha !== state.head_sha ||
		snapshot.base_sha !== state.base_sha
	) {
		return {
			action: "review",
			snapshot: { ...snapshot },
			reimplementation_attempts: state.reimplementation_attempts,
		};
	}
	if (state.phase === "blocked") {
		return { action: "block", reason: "Convergence is blocked" };
	}
	if (state.phase === "human") {
		return { action: "human", reason: "Human intervention is required" };
	}
	if (state.phase === "implementing") return { action: "wait" };

	let copilot: ReviewReport | undefined;
	let claude: ReviewReport | undefined;
	try {
		const expected = expectedTasks(input);
		copilot = observedReview(
			input.reviews.copilot,
			expected.copilot,
			"copilot",
		);
		claude = observedReview(input.reviews.claude, expected.claude, "claude");
	} catch (error) {
		return {
			action: "block",
			reason:
				error instanceof Error ? error.message : "Invalid review observation",
		};
	}
	if (input.ci === "blocked")
		return { action: "block", reason: "CI is blocked" };
	if (!copilot || !claude || input.ci === "pending") return { action: "wait" };
	if (
		input.reviews.copilot?.status === "completed" &&
		input.reviews.claude?.status === "completed" &&
		input.reviews.copilot.envelope.run_id ===
			input.reviews.claude.envelope.run_id
	) {
		return {
			action: "block",
			reason: "One workflow run cannot supply both reviews",
		};
	}
	if (
		copilot.change_class !== claude.change_class ||
		copilot.release_intent !== claude.release_intent
	) {
		return {
			action: "human",
			reason: "Reviewers disagree on change class or release intent",
		};
	}
	if (
		copilot.findings.length > 0 ||
		claude.findings.length > 0 ||
		input.ci === "failure"
	) {
		return state.reimplementation_attempts < 3
			? {
					action: "reimplement",
					next_attempt: state.reimplementation_attempts + 1,
				}
			: {
					action: "block",
					reason: "Three reimplementation attempts exhausted",
				};
	}
	if (copilot.merge_eligible && claude.merge_eligible) {
		if (
			copilot.change_class === "patch" &&
			copilot.release_intent === "patch"
		) {
			return { action: "eligible", release_intent: "patch" };
		}
		if (
			copilot.change_class === "additive-minor" &&
			copilot.release_intent === "minor"
		) {
			return { action: "eligible", release_intent: "minor" };
		}
	}
	return {
		action: "human",
		reason: "Both reviews must approve a patch or additive minor release",
	};
}
