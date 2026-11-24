import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	parseFitnessEnvelope,
	parseFitnessReport,
	parseReviewEnvelope,
	parseReviewReport,
	parseWorkerTask,
} from "../../scripts/agentic/contracts.ts";

const task = {
	version: 1,
	kind: "review-copilot",
	repository: "camunda/c8ctl",
	number: 577,
	generation: "generation-123456789",
	correlation: "12345678-1234-4234-8234-123456789abc",
	head_sha: "a".repeat(40),
	base_sha: "b".repeat(40),
	issue_revision: "",
	attempt: 0,
	state_comment_id: 123,
	instruction: "Review the untrusted issue text.",
} as const;

const finding = {
	severity: "high",
	path: "src/core/config.ts",
	line: 1,
	title: "Missing validation",
	body: "Reject invalid input.",
} as const;

const review = {
	schema_version: 1,
	status: "complete",
	findings: [],
	change_class: "patch",
	release_intent: "patch",
	merge_eligible: true,
	evidence: "Verified the regression test and implementation.",
	blockers: [],
} as const;

const fitness = {
	schema_version: 1,
	decision: "ready",
	criteria: ["Invalid input is rejected."],
	evidence: "The issue defines a reproducible failure and expected behavior.",
	blockers: [],
	related_prs: [123],
} as const;

const envelope = {
	schema_version: 1,
	repository: task.repository,
	task,
	engine: "copilot",
	run_id: 123,
	run_attempt: 1,
	workflow_sha: "c".repeat(40),
	report: review,
} as const;

function rejectVariants(
	parse: (value: unknown) => unknown,
	valid: Record<string, unknown>,
	variants: Record<string, unknown[]>,
) {
	for (const [key, values] of Object.entries(variants)) {
		for (const value of values) {
			assert.throws(() => parse({ ...valid, [key]: value }), {
				name: "TypeError",
			});
		}
	}
}

function rejectMissingAndUnknown(
	parse: (value: unknown) => unknown,
	valid: Record<string, unknown>,
) {
	for (const key of Object.keys(valid)) {
		const incomplete = { ...valid };
		delete incomplete[key];
		assert.throws(() => parse(incomplete), TypeError, `missing ${key}`);
	}
	for (const value of [
		null,
		[],
		42,
		"{}",
		{ ...valid, unexpected: true },
		{ ...valid, [Symbol("extra")]: true },
	]) {
		assert.throws(() => parse(value), TypeError);
	}
}

describe("worker task contract", () => {
	test("round-trips a single JSON task for all five worker kinds", () => {
		for (const kind of [
			"fitness",
			"implement",
			"review-copilot",
			"review-claude",
			"reimplement",
		]) {
			const input = {
				...task,
				kind,
				issue_revision:
					kind === "fitness" || kind === "implement"
						? "2026-09-18T17:00:00Z"
						: "",
			};
			assert.deepEqual(
				parseWorkerTask(JSON.parse(JSON.stringify(input))),
				input,
			);
		}
	});

	test("requires all coordinator identities and rejects unknown properties", () => {
		rejectMissingAndUnknown(parseWorkerTask, task);
	});

	test("rejects unsafe identities, numeric coercion and invalid bounds", () => {
		rejectVariants(parseWorkerTask, task, {
			version: [0, 2, "1"],
			kind: ["review", ""],
			repository: [
				"owner",
				"/owner/repo",
				"owner/repo/extra",
				"owner/..",
				"-owner/repo",
				"owner-/repo",
				"ow--ner/repo",
				"owner/re po",
				"owner\\repo",
				"owner/repo\n",
				`${"o".repeat(40)}/repo`,
				`owner/${"r".repeat(101)}`,
			],
			number: [0, -1, 1.5, "577", Number.MAX_SAFE_INTEGER + 1],
			generation: ["", "short", "a".repeat(129), `${"a".repeat(16)}/`, "a\nb"],
			correlation: [
				"",
				"not-a-uuid",
				"12345678-1234-1234-8234-123456789abc",
				task.correlation.toUpperCase(),
				`${task.correlation}\n`,
			],
			head_sha: ["a".repeat(39), "A".repeat(40), "g".repeat(40)],
			base_sha: ["b".repeat(41), "", `${"b".repeat(40)}\n`],
			attempt: [-1, 4, 0.5, "0", Number.NaN],
			state_comment_id: [0, -1, 1.5, "123", Number.POSITIVE_INFINITY],
			instruction: [42, "a".repeat(20001)],
			issue_revision: ["2026-09-18T17:00:00Z"],
		});
		for (const attempt of [0, 1, 2, 3]) {
			assert.equal(parseWorkerTask({ ...task, attempt }).attempt, attempt);
		}
		assert.equal(parseWorkerTask({ ...task, instruction: "" }).instruction, "");
		assert.equal(
			parseWorkerTask({ ...task, instruction: "a".repeat(20000) }).instruction
				.length,
			20000,
		);
	});

	test("uses real UTC ISO seconds or milliseconds for issue revisions", () => {
		for (const kind of ["fitness", "implement"]) {
			for (const issue_revision of [
				"2026-09-18T17:00:00Z",
				"2026-09-18T17:00:00.123Z",
				"2024-02-29T00:00:00Z",
			]) {
				assert.equal(
					parseWorkerTask({ ...task, kind, issue_revision }).issue_revision,
					issue_revision,
				);
			}
			rejectVariants(
				parseWorkerTask,
				{ ...task, kind },
				{
					issue_revision: [
						"",
						"2026-09-18",
						"2026-02-29T00:00:00Z",
						"2026-04-31T00:00:00Z",
						"2026-09-18T24:00:00Z",
						"2026-09-18T17:00:00+00:00",
						"2026-09-18T17:00:00.1Z",
						"2026-09-18T17:00:00Z\n",
					],
				},
			);
		}
	});
});

describe("model report contracts", () => {
	test("accepts complete patch/minor reports and actionable blocked reports", () => {
		assert.deepEqual(parseReviewReport(review), review);
		assert.equal(
			parseReviewReport({
				...review,
				change_class: "additive-minor",
				release_intent: "minor",
			}).merge_eligible,
			true,
		);
		assert.equal(
			parseReviewReport({
				...review,
				status: "blocked",
				merge_eligible: false,
				blockers: ["Cannot read the revision."],
			}).status,
			"blocked",
		);
		for (const severity of ["low", "medium", "high", "critical"]) {
			assert.equal(
				parseReviewReport({
					...review,
					merge_eligible: false,
					findings: [{ ...finding, severity }],
				}).findings.length,
				1,
			);
		}
	});

	test("requires exact report and finding fields, never model identities", () => {
		rejectMissingAndUnknown(parseReviewReport, review);
		rejectMissingAndUnknown(parseFitnessReport, fitness);
		rejectMissingAndUnknown(
			(value) =>
				parseReviewReport({
					...review,
					merge_eligible: false,
					findings: [value],
				}),
			finding,
		);
		for (const identity of Object.keys(task)) {
			assert.throws(
				() => parseReviewReport({ ...review, [identity]: "model" }),
				TypeError,
			);
			assert.throws(
				() => parseFitnessReport({ ...fitness, [identity]: "model" }),
				TypeError,
			);
		}
		assert.throws(() => parseReviewReport([review, review]), TypeError);
		assert.throws(() => parseFitnessReport([fitness, fitness]), TypeError);
	});

	test("rejects every unsafe repository-relative finding path class", () => {
		for (const path of [
			"",
			" ",
			".",
			"..",
			"../file",
			"src/../file",
			"src/..",
			"./file",
			"src/./file",
			"/etc/passwd",
			"//host/file",
			"C:/file",
			"C:\\file",
			"src\\file",
			"src/file:stream",
			"src//file",
			"src/",
			"src/\u0000file",
			"src/\nfile",
			"x".repeat(1025),
		]) {
			assert.throws(
				() =>
					parseReviewReport({
						...review,
						merge_eligible: false,
						findings: [{ ...finding, path }],
					}),
				TypeError,
				JSON.stringify(path),
			);
		}
		for (const path of [
			"README.md",
			".github/workflows/test.yml",
			"src/a b.ts",
		]) {
			assert.equal(
				parseReviewReport({
					...review,
					merge_eligible: false,
					findings: [{ ...finding, path }],
				}).findings[0]?.path,
				path,
			);
		}
	});

	test("bounds every model-controlled collection, string and number", () => {
		rejectVariants(parseReviewReport, review, {
			schema_version: [2, "1"],
			status: ["ready"],
			findings: [Array.from({ length: 51 }, () => finding), null],
			change_class: ["feature"],
			release_intent: ["breaking"],
			merge_eligible: ["true", 1],
			evidence: ["", " ", "a".repeat(12001)],
			blockers: [[""], ["a".repeat(4001)], Array(51).fill("reason")],
		});
		rejectVariants(
			(value) =>
				parseReviewReport({
					...review,
					merge_eligible: false,
					findings: [value],
				}),
			finding,
			{
				severity: ["warning"],
				line: [0, -1, 0.5, "1", Number.MAX_SAFE_INTEGER + 1],
				title: ["", " ", "a".repeat(201)],
				body: ["", " ", "a".repeat(4001)],
			},
		);
		assert.equal(
			parseReviewReport({
				...review,
				merge_eligible: false,
				findings: Array.from({ length: 50 }, () => ({
					...finding,
					title: "a".repeat(200),
					body: "a".repeat(4000),
				})),
				evidence: "a".repeat(12000),
			}).findings.length,
			50,
		);
		rejectVariants(parseFitnessReport, fitness, {
			schema_version: [2],
			decision: ["yes"],
			criteria: [
				[],
				[""],
				[" "],
				["a".repeat(2001)],
				Array(51).fill("criterion"),
			],
			evidence: ["", " ", "a".repeat(12001)],
			blockers: [[""], ["a".repeat(4001)], Array(51).fill("reason")],
			related_prs: [[0], [-1], [1.5], ["1"], Array(51).fill(1)],
		});
	});

	test("rejects merge contradictions rather than trusting empty findings", () => {
		for (const report of [
			{ ...review, status: "blocked" },
			{ ...review, status: "blocked", merge_eligible: false },
			{ ...review, blockers: ["Not safe"] },
			{ ...review, merge_eligible: false, blockers: ["Not complete"] },
			{ ...review, findings: [finding] },
			{ ...review, release_intent: "minor" },
			{ ...review, change_class: "additive-minor" },
			{ ...review, change_class: "other", release_intent: "none" },
			{ ...review, change_class: "other", release_intent: "major" },
			{ ...review, change_class: "unknown", release_intent: "unknown" },
		]) {
			assert.throws(() => parseReviewReport(report), TypeError);
		}
		assert.equal(
			parseReviewReport({
				...review,
				change_class: "unknown",
				release_intent: "unknown",
				merge_eligible: false,
			}).merge_eligible,
			false,
		);
	});

	test("fitness ready requires actionable criteria and no blockers", () => {
		assert.deepEqual(parseFitnessReport(fitness), fitness);
		assert.throws(
			() => parseFitnessReport({ ...fitness, blockers: ["Missing spec"] }),
			TypeError,
		);
		for (const decision of [
			"already_implemented",
			"needs_spec",
			"in_progress",
			"blocked",
		]) {
			assert.equal(
				parseFitnessReport({
					...fitness,
					decision,
					blockers: ["Requires human follow-up."],
				}).decision,
				decision,
			);
		}
	});
});

describe("trusted report envelopes", () => {
	test("parses paired review and fitness envelopes", () => {
		assert.deepEqual(parseReviewEnvelope(envelope), envelope);
		const claude = {
			...envelope,
			engine: "claude",
			task: { ...task, kind: "review-claude" },
		};
		assert.deepEqual(parseReviewEnvelope(claude), claude);
		const input = {
			...envelope,
			task: {
				...task,
				kind: "fitness",
				issue_revision: "2026-09-18T17:00:00Z",
			},
			report: fitness,
		};
		assert.deepEqual(parseFitnessEnvelope(input), input);
		assert.throws(() => parseReviewEnvelope(input), TypeError);
		assert.throws(() => parseFitnessEnvelope(envelope), TypeError);
	});

	test("rejects missing provenance, double reports and repository/engine/kind mismatch", () => {
		rejectMissingAndUnknown(parseReviewEnvelope, envelope);
		rejectVariants(parseReviewEnvelope, envelope, {
			schema_version: [2],
			repository: ["other/repo"],
			engine: ["claude", "other"],
			run_id: [0, 1.5, "123", Number.MAX_SAFE_INTEGER + 1],
			run_attempt: [0, -1, 1.5],
			workflow_sha: ["c".repeat(39), "C".repeat(40)],
			task: [
				{ ...task, kind: "reimplement" },
				{ ...task, kind: "review-claude" },
			],
			report: [[review, review], fitness],
		});
		assert.throws(() => parseReviewEnvelope([envelope, envelope]), TypeError);
	});
});
