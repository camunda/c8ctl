/**
 * Behavioural contract tests for the two-stage flag parser proposed in
 * issue #373.
 *
 * **Status: RED phase.** These tests describe the *desired* behaviour
 * after the parser refactor lands. They are expected to fail against the
 * current single-pass parser. Each `test` is named after the contract
 * statement it encodes; the failure messages document the gap.
 *
 * Contract summary (see issue #373 for the full design):
 *
 *   1. Stage 1 parses GLOBAL_FLAGS only, before the verb.
 *   2. Verb + resource are resolved as positionals between stages.
 *   3. Stage 2 parses the remainder against
 *      `effectiveFlags(verb, resource) = resourceFlags[resource] ?? flags`,
 *      with `--help` claimed by the host before dispatch.
 *
 * The tests are **class-scoped** wherever possible: the assertions iterate
 * over verbs/resources from `COMMAND_REGISTRY` rather than naming a single
 * instance, so a regression in any sibling code path is caught.
 *
 * The lenient variant of the design is assumed (post-verb globals still
 * accepted) — see the issue body. If the strict variant is chosen instead,
 * the post-verb-globals tests below need updating, not removing.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { COMMAND_REGISTRY } from "../../src/command-registry.ts";
import { isRecord } from "../../src/logger.ts";
import { c8 } from "../utils/cli.ts";

/** Parse stdout as JSON and narrow to a record, or fail with context. */
function parseJsonRecord(
	stdout: string,
	stderr: string,
): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (err) {
		throw new Error(
			`expected JSON on stdout; got non-JSON.\nstdout: ${stdout}\nstderr: ${stderr}\n${String(err)}`,
		);
	}
	if (!isRecord(parsed)) {
		throw new Error(
			`expected JSON object on stdout, got ${typeof parsed}. stdout: ${stdout}`,
		);
	}
	return parsed;
}

// ─── A. --help is claimed by the host, never silently swallowed ──────────────

describe("two-stage parser contract: --help reaches the help renderer", () => {
	test("c8ctl <verb> <resource> --help renders help and does not execute", async () => {
		// `get topology` is the canonical reproducer from the issue thread —
		// today it executes a real /v2/topology call against the configured
		// cluster instead of rendering help. The test asserts the host claims
		// `--help` *before* dispatch.
		const result = await c8("get", "topology", "--help");

		assert.strictEqual(
			result.status,
			0,
			`expected exit 0 (help), got ${result.status}. stderr: ${result.stderr}`,
		);

		// Help output in JSON test mode is a single JSON document with a
		// `verb` field. A topology fetch response would have a `brokers` field
		// at the top level instead.
		const parsed = parseJsonRecord(result.stdout, result.stderr);

		assert.ok(
			!("brokers" in parsed),
			"expected help payload, got what looks like a topology fetch response (`brokers` present)",
		);
		assert.ok(
			"verb" in parsed || "command" in parsed || "usage" in parsed,
			`expected a help-shaped payload (verb/command/usage). got keys: ${Object.keys(parsed).join(", ")}`,
		);
	});

	test("c8ctl <verb> <resource> <key> --help renders help and does not execute", async () => {
		// Same defect class one positional deeper — the resource is present
		// AND a key is present, so the missing-resource guard at line 546 of
		// src/index.ts cannot save us. The dispatch path runs.
		const result = await c8("get", "topology", "some-key", "--help");

		assert.strictEqual(
			result.status,
			0,
			`expected exit 0 (help), got ${result.status}. stderr: ${result.stderr}`,
		);

		const parsed = parseJsonRecord(result.stdout, result.stderr);

		assert.ok(
			!("brokers" in parsed),
			"expected help payload, got what looks like a topology fetch response",
		);
	});

	test("c8ctl <verb> --help renders verb-level help for every verb in the registry", async () => {
		// Class-scoped: every verb in the registry must honour `--help` after
		// the verb. Today this works by accident for verbs with
		// `requiresResource: true` (the missing-resource guard at index.ts:546
		// honours `values.help`), but verbs with `requiresResource: false`
		// (deploy, run, watch, mcp-proxy, doctor, output, version, repl) have
		// no such guard and the handler runs anyway. The contract is uniform:
		// `--help` after the verb must always reach the help renderer.
		//
		// We exclude verbs whose handlers start a long-running / interactive
		// process when `--help` is silently dropped today: those would hang
		// the test run instead of failing it. Once `--help` is honoured at
		// the parser layer they will exit fast and can be re-enabled.
		const LONG_RUNNING_VERBS = new Set(["watch", "repl", "mcp-proxy"]);
		const allVerbs = Object.keys(COMMAND_REGISTRY).filter(
			(v) => !LONG_RUNNING_VERBS.has(v),
		);
		assert.ok(
			allVerbs.length >= 10,
			`expected many verbs in registry, got ${allVerbs.length}`,
		);

		const failures: string[] = [];
		for (const verb of allVerbs) {
			const result = await c8(verb, "--help");
			if (result.status !== 0) {
				failures.push(
					`\`c8ctl ${verb} --help\` → exit ${result.status}; stderr: ${result.stderr.slice(0, 200)}`,
				);
				continue;
			}
			// Stderr must be empty under help: a help invocation that prints
			// warnings, info messages, or errors is leaking implementation
			// detail (or, worse, executing) on the help path.
			if (result.stderr !== "") {
				failures.push(
					`\`c8ctl ${verb} --help\` produced stderr: ${result.stderr.slice(0, 200)}`,
				);
			}
		}

		assert.deepStrictEqual(
			failures,
			[],
			`expected every verb to honour --help. failures:\n${failures.join("\n")}`,
		);
	});

	test("c8ctl <verb> <resource> --help renders help for every (verb, resource) in the registry", async () => {
		// Class-scoped: every (verb, resource) pair that the registry knows
		// about must honour `--help` instead of dispatching to the handler.
		// We use only safely-named, well-known canonical resources to avoid
		// alias-resolution noise.
		const cases: Array<{ verb: string; resource: string }> = [];
		for (const [verb, def] of Object.entries(COMMAND_REGISTRY)) {
			if (!def.requiresResource) continue;
			for (const resource of def.resources) {
				cases.push({ verb, resource });
			}
		}

		assert.ok(
			cases.length >= 10,
			`expected many (verb, resource) pairs in registry, got ${cases.length}`,
		);

		const failures: string[] = [];
		for (const { verb, resource } of cases) {
			const result = await c8(verb, resource, "--help");
			if (result.status !== 0) {
				failures.push(
					`\`c8ctl ${verb} ${resource} --help\` → exit ${result.status}; stderr: ${result.stderr.slice(0, 200)}`,
				);
				continue;
			}
			// Help should never produce a payload that looks like a real API
			// response. We don't enumerate every possible response shape, but
			// we do check that no `--help` invocation prints to stderr.
			if (result.stderr !== "") {
				failures.push(
					`\`c8ctl ${verb} ${resource} --help\` produced stderr: ${result.stderr.slice(0, 200)}`,
				);
			}
		}

		assert.deepStrictEqual(
			failures,
			[],
			`expected every (verb, resource) pair to honour --help. failures:\n${failures.join("\n")}`,
		);
	});
});

// ─── B. Resource-aware effective flag table (stage 2 is per-resource) ────────

describe("two-stage parser contract: stage 2 uses effectiveFlags(verb, resource)", () => {
	test("resource-specific filter flag is accepted on its own resource", async () => {
		// `--bpmnProcessId` lives in PI_SEARCH_FLAGS (resourceFlags.pi). Today
		// it is parsed because deriveParseArgsOptions() unions every resource
		// bucket; the contract says it should still be accepted under the
		// scoped model when invoked on its own resource.
		const result = await c8(
			"search",
			"pi",
			"--bpmnProcessId=test",
			"--dry-run",
		);
		assert.strictEqual(
			result.status,
			0,
			`expected exit 0 (dry-run), got ${result.status}. stderr: ${result.stderr}`,
		);
		// Dry-run output is JSON with dryRun=true.
		const parsed = parseJsonRecord(result.stdout, result.stderr);
		assert.strictEqual(
			parsed.dryRun,
			true,
			`expected dry-run payload, got: ${JSON.stringify(parsed).slice(0, 200)}`,
		);
	});

	test("resource-specific flag from a sibling resource is rejected on this resource", async () => {
		// `--parentProcessInstanceKey` is a PI-only filter (PI_SEARCH_FLAGS).
		// Passing it against incidents must surface as an unknown-flag
		// rejection (or at least a stderr warning that names the flag).
		// Under today's union parser this already warns via `detectUnknownFlags`
		// (#256); the contract pins the warning shape so the two-stage refactor
		// cannot regress it.
		const result = await c8(
			"search",
			"inc",
			"--parentProcessInstanceKey=999",
			"--dry-run",
		);

		// Either the host rejects with non-zero exit AND a clear message,
		// or it accepts with exit 0 BUT prints a warning that names the flag
		// AND the resource. Both are acceptable shapes for the contract; what
		// is *not* acceptable is silent acceptance with empty stderr.
		const stderrMentionsFlag = result.stderr.includes(
			"--parentProcessInstanceKey",
		);
		assert.ok(
			result.status !== 0 || stderrMentionsFlag,
			`expected the host to reject or warn on --parentProcessInstanceKey for \`search inc\`. got exit ${result.status}, stderr: "${result.stderr.slice(0, 200)}"`,
		);
	});
});

// ─── C. Globals-before-verb (must still work; the docked baseline) ───────────

describe("two-stage parser contract: globals-before-verb baseline", () => {
	test("--profile before the verb is accepted (stage 1 owns globals)", async () => {
		// This already works today; the contract is that it MUST keep working
		// after the refactor. It pins the stage-1 behaviour.
		const result = await c8(
			"--profile=__nonexistent__",
			"get",
			"topology",
			"--dry-run",
		);
		// We don't assert exit code here because --profile=__nonexistent__
		// may produce a profile-not-found error; what we assert is that the
		// CLI did not treat `--profile` as an unknown flag (which would print
		// "Unknown option" to stderr).
		assert.ok(
			!result.stderr.includes("Unknown option"),
			`expected --profile before verb to be parsed, not rejected. stderr: ${result.stderr}`,
		);
	});

	test("--help before the verb still produces top-level help (does not leak into stage 2)", async () => {
		// `c8ctl --help` today renders top-level help. The contract: the
		// stage-1/stage-2 split must not regress this path.
		const result = await c8("--help");
		assert.strictEqual(
			result.status,
			0,
			`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
		);
		const parsed = parseJsonRecord(result.stdout, result.stderr);
		assert.ok(
			Array.isArray(parsed.commands),
			"expected top-level help to include a `commands` array",
		);
	});
});

// ─── D. Globals-after-verb (lenient variant — see #373 strict-vs-lenient) ───

describe("two-stage parser contract: globals-after-verb (lenient variant)", () => {
	// These tests assume the **lenient** variant of #373: post-verb globals
	// continue to work, achieved by stage 2 accepting known global flag names
	// as a pass-through. If the **strict** variant is chosen instead, these
	// tests need to flip to "post-verb globals are deprecated → emit a
	// deprecation warning to stderr but still execute" and eventually to
	// "post-verb globals are a parse error".

	test("--profile after the verb is still accepted", async () => {
		const result = await c8(
			"get",
			"topology",
			"--profile=__nonexistent__",
			"--dry-run",
		);
		assert.ok(
			!result.stderr.includes("Unknown option"),
			`expected --profile after verb to be parsed under lenient variant. stderr: ${result.stderr}`,
		);
	});

	test("--dry-run after the verb is still accepted", async () => {
		const result = await c8("get", "topology", "some-key", "--dry-run");
		// `--dry-run` is a global; the contract says lenient stage 2 must
		// still pass it through. A dry-run produces JSON with kind="dry-run"
		// and exits 0.
		assert.strictEqual(
			result.status,
			0,
			`expected exit 0 (dry-run), got ${result.status}. stderr: ${result.stderr}`,
		);
		const parsed = parseJsonRecord(result.stdout, result.stderr);
		assert.strictEqual(parsed.dryRun, true);
	});
});

// ─── E. Stage 2 strictness (typo detection on verb-flags) ───────────────────

describe("two-stage parser contract: stage 2 rejects unknown verb-flags", () => {
	test("an unknown flag on a known verb is reported, not silently accepted", async () => {
		// `--xyzzy-not-a-real-flag` is not in any registry table. Today
		// `strict: false` accepts it silently; the contract says stage 2
		// must reject or warn so users catch typos like `--limti` instead
		// of `--limit`.
		const result = await c8(
			"search",
			"pi",
			"--xyzzy-not-a-real-flag=value",
			"--dry-run",
		);

		const stderrMentionsFlag = result.stderr.includes("xyzzy-not-a-real-flag");
		assert.ok(
			result.status !== 0 || stderrMentionsFlag,
			`expected stage 2 to reject or warn on --xyzzy-not-a-real-flag. got exit ${result.status}, stderr: "${result.stderr.slice(0, 200)}"`,
		);
	});
});
