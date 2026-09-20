import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
	ReviewEnvelope,
	ReviewReport,
	WorkerTask,
} from "../../scripts/agentic/contracts.ts";
import {
	type ConvergenceInput,
	decideConvergence,
	type ReviewObservation,
} from "../../scripts/agentic/convergence.ts";

const head = "a".repeat(40);
const base = "b".repeat(40);
const changed = "d".repeat(40);
const now = "2026-09-18T17:00:00Z";
const deadline = "2026-09-18T18:00:00Z";

function task(engine: "copilot" | "claude", attempt = 0): WorkerTask {
	return {
		version: 1,
		kind: engine === "copilot" ? "review-copilot" : "review-claude",
		repository: "camunda/c8ctl",
		number: 577,
		generation: "generation-123456789",
		correlation:
			engine === "copilot"
				? "12345678-1234-4234-8234-123456789abc"
				: "12345678-1234-4234-8234-123456789abd",
		head_sha: head,
		base_sha: base,
		issue_revision: "",
		attempt,
		state_comment_id: 123,
		instruction: "Review this revision.",
	};
}

function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
	return {
		schema_version: 1,
		status: "complete",
		findings: [],
		change_class: "patch",
		release_intent: "patch",
		merge_eligible: true,
		evidence: "Reviewed the code and regression test.",
		blockers: [],
		...overrides,
	};
}

function envelope(
	engine: "copilot" | "claude",
	attempt = 0,
	review: ReviewReport = report(),
): ReviewEnvelope {
	return {
		schema_version: 1,
		repository: "camunda/c8ctl",
		task: task(engine, attempt),
		engine,
		run_id: engine === "copilot" ? 100 : 200,
		run_attempt: 1,
		workflow_sha: "c".repeat(40),
		report: review,
	};
}

function completed(value: ReviewEnvelope): ReviewObservation {
	return { status: "completed", envelope: value };
}

function input(attempt = 0): ConvergenceInput {
	return {
		snapshot: { head_sha: head, base_sha: base },
		state: {
			head_sha: head,
			base_sha: base,
			reimplementation_attempts: attempt,
			phase: "reviewing",
			deadline,
		},
		expected: {
			copilot: task("copilot", attempt),
			claude: task("claude", attempt),
		},
		reviews: {
			copilot: completed(envelope("copilot", attempt)),
			claude: completed(envelope("claude", attempt)),
		},
		ci: "success",
		now,
	};
}

const findings = report({
	merge_eligible: false,
	findings: [
		{
			severity: "low",
			path: "src/index.ts",
			line: 1,
			title: "Incorrect exit code",
			body: "Return nonzero on failure.",
		},
	],
});

describe("convergence report gates", () => {
	test("requires both clean streams and green CI for patch/minor eligibility", () => {
		for (const attempt of [0, 1, 2, 3]) {
			assert.deepEqual(decideConvergence(input(attempt)), {
				action: "eligible",
				release_intent: "patch",
			});
			const current = input(attempt);
			const minor = report({
				change_class: "additive-minor",
				release_intent: "minor",
			});
			current.reviews = {
				copilot: completed(envelope("copilot", attempt, minor)),
				claude: completed(envelope("claude", attempt, minor)),
			};
			assert.deepEqual(decideConvergence(current), {
				action: "eligible",
				release_intent: "minor",
			});
		}
	});

	test("waits for every missing or waiting stream, even when CI failed", () => {
		for (const engine of ["copilot", "claude"] as const) {
			for (const ci of ["pending", "success", "failure"] as const) {
				const current = input();
				current.ci = ci;
				delete current.reviews[engine];
				assert.deepEqual(decideConvergence(current), { action: "wait" });
				current.reviews[engine] = { status: "waiting" };
				assert.deepEqual(decideConvergence(current), { action: "wait" });
			}
		}
		assert.deepEqual(decideConvergence({ ...input(), reviews: {} }), {
			action: "wait",
		});
	});

	test("failed or blocked streams block even if the other stream is missing", () => {
		for (const engine of ["copilot", "claude"] as const) {
			for (const observation of [
				{ status: "failed", reason: "Worker failed" } as const,
				completed(
					envelope(
						engine,
						0,
						report({
							status: "blocked",
							merge_eligible: false,
							blockers: ["No repository access"],
						}),
					),
				),
			]) {
				const current = input();
				current.reviews = { [engine]: observation };
				assert.equal(decideConvergence(current).action, "block");
			}
		}
	});

	test("binds each report to every expected coordinator identity", () => {
		const mutations: Partial<WorkerTask>[] = [
			{ repository: "other/repo" },
			{ number: 578 },
			{ generation: "generation-987654321" },
			{ correlation: "12345678-1234-4234-8234-123456789abe" },
			{ head_sha: changed },
			{ base_sha: changed },
			{ state_comment_id: 456 },
			{ attempt: 1 },
			{ issue_revision: now },
			{ kind: "reimplement" },
		];
		for (const engine of ["copilot", "claude"] as const) {
			for (const mutation of mutations) {
				const current = input();
				const stale = envelope(engine);
				stale.task = { ...stale.task, ...mutation };
				stale.repository = stale.task.repository;
				current.reviews[engine] = completed(stale);
				assert.equal(
					decideConvergence(current).action,
					"block",
					JSON.stringify(mutation),
				);
			}
		}
	});

	test("rejects duplicate streams, wrong engines and malformed report payloads", () => {
		for (const engine of ["copilot", "claude"] as const) {
			const current = input();
			const other = engine === "copilot" ? "claude" : "copilot";
			current.reviews[engine] = completed(envelope(other));
			assert.equal(decideConvergence(current).action, "block");
			const mismatched = envelope(engine);
			mismatched.engine = other;
			current.reviews[engine] = completed(mismatched);
			assert.equal(decideConvergence(current).action, "block");
			const malformed = envelope(engine);
			malformed.report.evidence = "";
			current.reviews[engine] = completed(malformed);
			assert.equal(decideConvergence(current).action, "block");
		}
	});

	test("requires expected tasks to describe one revision, PR and generation", () => {
		for (const engine of ["copilot", "claude"] as const) {
			for (const mutation of [
				{ kind: "reimplement" },
				{ head_sha: changed },
				{ base_sha: changed },
				{ number: 578 },
				{ repository: "other/repo" },
				{ generation: "generation-987654321" },
				{ state_comment_id: 456 },
				{ attempt: 1 },
			] satisfies Partial<WorkerTask>[]) {
				const current = input();
				current.expected[engine] = { ...current.expected[engine], ...mutation };
				assert.equal(decideConvergence(current).action, "block");
			}
		}
		const current = input();
		current.expected.claude.correlation = current.expected.copilot.correlation;
		assert.equal(decideConvergence(current).action, "block");
	});

	test("one workflow run cannot supply both review streams", () => {
		for (const runAttempt of [1, 2]) {
			const current = input();
			const duplicate = envelope("claude");
			duplicate.run_id = envelope("copilot").run_id;
			duplicate.run_attempt = runAttempt;
			current.reviews.claude = completed(duplicate);
			assert.equal(decideConvergence(current).action, "block");
		}
	});

	test("classification disagreement requires a human even with findings or failed CI", () => {
		for (const ci of ["success", "failure"] as const) {
			const current = input();
			current.ci = ci;
			current.reviews.claude = completed(
				envelope("claude", 0, {
					...findings,
					change_class: "additive-minor",
					release_intent: "minor",
				}),
			);
			assert.equal(decideConvergence(current).action, "human");
		}
	});

	test("classification disagreement and unapproved empty findings require humans", () => {
		for (const engine of ["copilot", "claude"] as const) {
			for (const alternative of [
				report({ change_class: "additive-minor", release_intent: "minor" }),
				report({
					change_class: "unknown",
					release_intent: "unknown",
					merge_eligible: false,
				}),
				report({
					change_class: "other",
					release_intent: "none",
					merge_eligible: false,
				}),
				report({
					change_class: "other",
					release_intent: "major",
					merge_eligible: false,
				}),
				report({ merge_eligible: false }),
			]) {
				const current = input();
				current.reviews[engine] = completed(envelope(engine, 0, alternative));
				assert.equal(decideConvergence(current).action, "human");
			}
		}
		for (const alternative of [
			report({
				change_class: "unknown",
				release_intent: "unknown",
				merge_eligible: false,
			}),
			report({
				change_class: "other",
				release_intent: "major",
				merge_eligible: false,
			}),
			report({
				change_class: "patch",
				release_intent: "minor",
				merge_eligible: false,
			}),
		]) {
			const current = input();
			current.reviews = {
				copilot: completed(envelope("copilot", 0, alternative)),
				claude: completed(envelope("claude", 0, alternative)),
			};
			assert.equal(decideConvergence(current).action, "human");
		}
	});
});

describe("convergence retry budget and revisions", () => {
	test("reserves attempts one through three for findings or failed CI", () => {
		for (const attempt of [0, 1, 2]) {
			for (const cause of ["copilot", "claude", "ci"] as const) {
				const current = input(attempt);
				if (cause === "ci") current.ci = "failure";
				else
					current.reviews[cause] = completed(
						envelope(cause, attempt, findings),
					);
				assert.deepEqual(decideConvergence(current), {
					action: "reimplement",
					next_attempt: attempt + 1,
				});
				assert.equal(current.state.reimplementation_attempts, attempt);
			}
		}
	});

	test("attempt three can become eligible, but findings or CI failure never get a fourth fix", () => {
		assert.equal(decideConvergence(input(3)).action, "eligible");
		for (const cause of ["copilot", "claude", "ci"] as const) {
			const current = input(3);
			if (cause === "ci") current.ci = "failure";
			else current.reviews[cause] = completed(envelope(cause, 3, findings));
			assert.equal(decideConvergence(current).action, "block");
		}
	});

	test("changed head or base requests fresh reviews without replenishing attempts", () => {
		for (const attempt of [0, 1, 2, 3]) {
			for (const field of ["head_sha", "base_sha"] as const) {
				const current = input(attempt);
				current.snapshot[field] = changed;
				current.ci = "failure";
				assert.deepEqual(decideConvergence(current), {
					action: "review",
					snapshot: current.snapshot,
					reimplementation_attempts: attempt,
				});
				assert.equal(current.state[field], field === "head_sha" ? head : base);
				assert.equal(current.state.reimplementation_attempts, attempt);
			}
		}
	});

	test("pending CI waits and blocked CI blocks before findings can dispatch a fix", () => {
		for (const ci of ["pending", "blocked"] as const) {
			for (const attempt of [0, 3]) {
				const current = input(attempt);
				current.ci = ci;
				current.reviews.copilot = completed(
					envelope("copilot", attempt, findings),
				);
				assert.equal(
					decideConvergence(current).action,
					ci === "pending" ? "wait" : "block",
				);
			}
		}
		const current = input();
		current.reviews = {};
		current.ci = "blocked";
		assert.equal(decideConvergence(current).action, "block");
	});

	test("keeps implementation in flight without dispatching twice", () => {
		const current = input(1);
		current.state.phase = "implementing";
		assert.deepEqual(decideConvergence(current), { action: "wait" });
		current.implementation = { status: "running" };
		assert.deepEqual(decideConvergence(current), { action: "wait" });
		current.implementation = { status: "failed" };
		assert.equal(decideConvergence(current).action, "block");
	});

	test("revision changes cannot release an in-flight implementation", () => {
		for (const field of ["head_sha", "base_sha"] as const) {
			for (const attempt of [0, 1, 2, 3]) {
				const current = input(attempt);
				current.state.phase = "implementing";
				current.snapshot[field] = changed;
				current.ci = "failure";
				assert.deepEqual(decideConvergence(current), { action: "wait" });
				current.implementation = { status: "running" };
				assert.deepEqual(decideConvergence(current), { action: "wait" });
				current.implementation = { status: "failed" };
				assert.equal(decideConvergence(current).action, "block");
				current.implementation = { status: "complete", head_sha: head };
				assert.equal(decideConvergence(current).action, "block");
			}
		}
	});

	test("completion at the same head blocks, including a base-only revision change", () => {
		for (const attempt of [0, 1, 2, 3]) {
			for (const baseSha of [base, changed]) {
				const current = input(attempt);
				current.state.phase = "implementing";
				current.snapshot.base_sha = baseSha;
				current.implementation = { status: "complete", head_sha: head };
				assert.equal(decideConvergence(current).action, "block");
			}
		}
	});

	test("implementation completion reviews its new head without counting the initial implementation", () => {
		for (const attempt of [0, 3]) {
			const current = input(attempt);
			current.state.phase = "implementing";
			current.snapshot.head_sha = changed;
			current.implementation = { status: "complete", head_sha: changed };
			assert.deepEqual(decideConvergence(current), {
				action: "review",
				snapshot: current.snapshot,
				reimplementation_attempts: attempt,
			});
		}
		const current = input();
		current.state.phase = "implementing";
		current.implementation = { status: "complete", head_sha: changed };
		assert.equal(decideConvergence(current).action, "block");
	});
});

describe("convergence stop conditions and purity", () => {
	test("kill, hold and deadline dominate clean reports, fixes and revision changes", () => {
		for (const phase of [
			"reviewing",
			"implementing",
			"blocked",
			"clean",
			"human",
		] as const) {
			for (const stop of ["kill", "hold", "deadline"] as const) {
				for (const changedRevision of [false, true]) {
					const current = input();
					current.state.phase = phase;
					if (changedRevision) current.snapshot.head_sha = changed;
					if (stop === "deadline") current.now = deadline;
					else current[stop] = true;
					const result = decideConvergence(current);
					assert.equal(result.action, "block");
					if (result.action === "block")
						assert.match(result.reason, new RegExp(stop, "i"));
				}
			}
		}
		const current = input();
		current.kill = true;
		current.hold = true;
		current.now = deadline;
		const result = decideConvergence(current);
		assert.equal(result.action, "block");
		if (result.action === "block") assert.match(result.reason, /kill/i);
	});

	test("invalid times, revisions or counters fail closed instead of bypassing stops", () => {
		for (const value of [
			"",
			"not-a-date",
			"2026-02-29T17:00:00Z",
			"2026-09-18",
		]) {
			assert.equal(
				decideConvergence({ ...input(), now: value }).action,
				"block",
			);
			const current = input();
			current.state.deadline = value;
			assert.equal(decideConvergence(current).action, "block");
		}
		for (const attempt of [-1, 4, 1.5, Number.NaN]) {
			assert.equal(decideConvergence(input(attempt)).action, "block");
		}
		for (const field of ["head_sha", "base_sha"] as const) {
			const current = input();
			current.snapshot[field] = "";
			assert.equal(decideConvergence(current).action, "block");
			const old = input();
			old.state[field] = "";
			assert.equal(decideConvergence(old).action, "block");
		}
	});

	test("unrecognized CI or persisted phases never authorize work", () => {
		for (const value of ["unknown", "", null, undefined, 0]) {
			const invalidCi = input();
			Object.defineProperty(invalidCi, "ci", { value });
			assert.equal(decideConvergence(invalidCi).action, "block");
			for (const revision of [head, changed]) {
				const invalidPhase = input();
				Object.defineProperty(invalidPhase.state, "phase", { value });
				invalidPhase.snapshot.head_sha = revision;
				assert.equal(decideConvergence(invalidPhase).action, "block");
			}
		}
	});

	test("terminal phases do not silently resume at the same revision", () => {
		for (const phase of ["blocked", "human"] as const) {
			const current = input();
			current.state.phase = phase;
			assert.equal(
				decideConvergence(current).action,
				phase === "blocked" ? "block" : "human",
			);
		}
		const current = input();
		current.state.phase = "clean";
		current.reviews = {};
		assert.equal(decideConvergence(current).action, "wait");
	});

	test("repeated decisions are deterministic and never mutate the snapshot or state", () => {
		const current = input();
		const before = structuredClone(current);
		Object.freeze(current);
		Object.freeze(current.state);
		Object.freeze(current.snapshot);
		assert.deepEqual(decideConvergence(current), decideConvergence(current));
		assert.deepEqual(current, before);
	});
});
