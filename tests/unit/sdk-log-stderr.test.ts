/**
 * Camunda SDK log lines must never reach stdout. stdout is reserved for
 * command results so `--json` output stays a single parseable document.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { c8WithEnv } from "../utils/cli.ts";

describe("SDK logging is routed to stderr", () => {
	for (const [label, extraArgs, env] of [
		["--verbose (trace)", ["--verbose"], {}],
		["CAMUNDA_SDK_LOG_LEVEL=debug", [], { CAMUNDA_SDK_LOG_LEVEL: "debug" }],
	] as const) {
		test(`${label}: stdout has no SDK log lines in --json mode`, async () => {
			const result = await c8WithEnv(
				{ ...env, CAMUNDA_BASE_URL: "http://127.0.0.1:1/v2" },
				"--json",
				...extraArgs,
				"list",
				"pi",
			);
			assert.doesNotMatch(result.stdout, /\[camunda-sdk\]/);
			assert.match(result.stderr, /\[camunda-sdk\]\[debug\]/);
		});
	}
});
