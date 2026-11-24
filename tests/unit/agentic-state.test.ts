import assert from "node:assert/strict";
import { test } from "node:test";
import {
	findState,
	issueRevision,
	newState,
	parseState,
	renderState,
	STATE_MARKER,
} from "../../scripts/agentic/state.ts";

const now = "2026-09-18T12:00:00.000Z";
const bot = "c8ctl-maintainer[bot]";
const initial = () =>
	newState({
		subject: "issue",
		number: 42,
		headSha: "a".repeat(40),
		baseSha: "a".repeat(40),
		now,
		issueRevision: now,
		revisionHash: "b".repeat(64),
	});

test("state round-trips strict bounded schema and trusts only configured Bot author", () => {
	const state = initial();
	const body = renderState(state);
	assert.match(body, /c8ctl-agentic-state:v1/);
	const comment = { id: 12, body, user: { login: bot, type: "Bot" } };
	assert.deepEqual(findState([comment], bot, 42), { id: 12, state });
	assert.equal(
		findState(
			[{ ...comment, user: { login: "github-actions[bot]", type: "Bot" } }],
			bot,
			42,
		),
		undefined,
	);
	assert.equal(
		findState([{ ...comment, user: { login: bot, type: "User" } }], bot, 42),
		undefined,
	);
	assert.throws(
		() => findState([comment, { ...comment, id: 13 }], bot, 42),
		/Duplicate/,
	);
	assert.throws(
		() =>
			findState([{ ...comment, body: `${STATE_MARKER}\nmalformed` }], bot, 42),
		/state/,
	);
	assert.throws(() => parseState({ ...state, unknown: true }), /state/);
	assert.throws(
		() => parseState({ ...state, reimplementation_attempts: 4 }),
		/state/,
	);
	assert.throws(() => parseState({ ...state, phase: "clean" }), /state/);
	assert.throws(() => parseState({ ...state, total_dispatches: 21 }), /state/);
});

test("state rejects slots for another subject/generation and oversized comment payloads", () => {
	const state = initial();
	const task = {
		version: 1,
		kind: "fitness",
		repository: "camunda/c8ctl",
		number: 43,
		generation: state.generation,
		correlation: "b132a809-748e-44aa-a660-a3d527691c00",
		head_sha: state.head_sha,
		base_sha: state.base_sha,
		issue_revision: now,
		attempt: 0,
		state_comment_id: 12,
		instruction: "",
	};
	assert.throws(
		() =>
			parseState({
				...state,
				slots: {
					fitness: {
						task,
						run_id: null,
						run_attempt: null,
						artifact_id: null,
						dispatched_at: now,
					},
				},
			}),
		/state/,
	);
	assert.throws(
		() => renderState({ ...state, outcome: "x".repeat(60000) }),
		/state|large/,
	);
	assert.throws(
		() =>
			parseState({
				...state,
				total_dispatches: 1,
				slots: {
					fitness: {
						task: { ...task, number: state.number, head_sha: "c".repeat(40) },
						run_id: null,
						run_attempt: null,
						artifact_id: null,
						dispatched_at: now,
					},
				},
			}),
		/state/,
	);
});

test("issue revision ignores state comments, bot activity, timestamps and whitespace replies", () => {
	const issue = {
		title: "Fix bug",
		body: "Expected behavior",
		created_at: now,
		updated_at: now,
	};
	const first = issueRevision(issue, [], bot);
	const comments = [
		{
			id: 1,
			body: "state",
			updated_at: "2026-09-18T13:00:00.000Z",
			user: { login: bot, type: "Bot" },
		},
	];
	assert.deepEqual(
		issueRevision(
			{ ...issue, updated_at: "2026-09-18T15:00:00.000Z" },
			comments,
			bot,
			first,
		),
		first,
	);
	const edited = issueRevision(
		{ ...issue, body: "Changed scope", updated_at: "2026-09-18T15:00:00.000Z" },
		comments,
		bot,
		first,
	);
	assert.notEqual(edited.hash, first.hash);
	assert.equal(edited.timestamp, "2026-09-18T15:00:00.000Z");
	const reply = issueRevision(
		issue,
		[
			...comments,
			{
				id: 2,
				body: "A reproduction",
				updated_at: "2026-09-18T16:00:00.000Z",
				user: { login: "maintainer", type: "User" },
			},
		],
		bot,
		first,
	);
	assert.notEqual(reply.hash, first.hash);
	assert.equal(reply.timestamp, "2026-09-18T16:00:00.000Z");
});

test("CI reservations round-trip and remain bound to the App comment and current PR session", () => {
	const state = newState({
		subject: "pr",
		number: 42,
		headSha: "a".repeat(40),
		baseSha: "b".repeat(40),
		now,
	});
	const ci = {
		task: {
			version: 1,
			repository: "camunda/c8ctl",
			number: 42,
			generation: state.generation,
			correlation: "b132a809-748e-44aa-a660-a3d527691c00",
			head_sha: state.head_sha,
			base_sha: state.base_sha,
			merge_sha: "c".repeat(40),
			state_comment_id: 12,
			attempt: 0,
		},
		run_id: null,
		run_attempt: null,
		artifact_id: null,
		dispatched_at: now,
	};
	const reserved = parseState({ ...state, ci, total_dispatches: 1 });
	assert.deepEqual(reserved.ci, ci);
	const body = renderState(reserved);
	const comment = { id: 12, body, user: { login: bot, type: "Bot" } };
	assert.deepEqual(findState([comment], bot, 42)?.state.ci, ci);
	assert.throws(() => findState([{ ...comment, id: 13 }], bot, 42), /state/);
	for (const task of [
		{ ...ci.task, number: 43 },
		{ ...ci.task, head_sha: "d".repeat(40) },
		{ ...ci.task, base_sha: "d".repeat(40) },
		{ ...ci.task, generation: "other-generation-0000" },
		{ ...ci.task, attempt: 1 },
	])
		assert.throws(() => parseState({ ...reserved, ci: { ...ci, task } }));
	for (const claims of [
		{ run_id: 3, run_attempt: null },
		{ run_id: 3, run_attempt: 2 },
		{ artifact_id: 8 },
		{ dispatched_at: "yesterday" },
		{ unknown: true },
	])
		assert.throws(() => parseState({ ...reserved, ci: { ...ci, ...claims } }));
	assert.throws(
		() => parseState({ ...reserved, total_dispatches: 0 }),
		/state/,
	);
	assert.throws(
		() => parseState({ ...initial(), ci, total_dispatches: 1 }),
		/state/,
	);
	assert.equal(
		newState({
			subject: "pr",
			number: 42,
			headSha: "a".repeat(40),
			baseSha: "b".repeat(40),
			now,
		}).ci,
		null,
	);
});
