/**
 * CLI behavioural tests for suspending and resuming process definitions.
 *
 * These tests spawn the CLI as a subprocess with --dry-run. They check the
 * endpoint, the request body and the local selector validation without a
 * running cluster.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { c8, c8WithOptions, parseJson } from "../utils/cli.ts";
import { asRecord, getUrl } from "../utils/guards.ts";

const VERBS: Array<[verb: string, suffix: string]> = [
	["suspend", "suspension"],
	["resume", "resumption"],
];

for (const [verb, suffix] of VERBS) {
	describe(`CLI behavioural: ${verb} process-definition`, () => {
		test("--dry-run by key posts the key only", async () => {
			const result = await c8(verb, "pd", "--dry-run", "2251799813685249");

			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			const out = parseJson(result);
			assert.strictEqual(out.dryRun, true);
			assert.strictEqual(out.method, "POST");
			assert.ok(getUrl(out).endsWith(`/process-definitions/${suffix}`));

			const body = asRecord(out.body, "dry-run body");
			assert.strictEqual(body.processDefinitionKey, "2251799813685249");
			assert.strictEqual(body.processDefinitionId, undefined);
			assert.strictEqual(body.processDefinitionVersion, undefined);
			assert.strictEqual(body.tenantId, undefined);
			assert.ok(
				!("includeProcessInstances" in body),
				"includeProcessInstances must be omitted when the flag is not set",
			);
		});

		test("--dry-run by ID without version omits the version", async () => {
			const result = await c8(
				verb,
				"pd",
				"--dry-run",
				"--processDefinitionId",
				"order-process",
			);

			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			const body = asRecord(parseJson(result).body, "dry-run body");
			assert.strictEqual(body.processDefinitionId, "order-process");
			assert.strictEqual(body.processDefinitionKey, undefined);
			assert.strictEqual(body.processDefinitionVersion, undefined);
		});

		test("--dry-run by ID uses the default tenant from the environment", async () => {
			const result = await c8WithOptions(
				{ env: { CAMUNDA_DEFAULT_TENANT_ID: "env-tenant" } },
				verb,
				"pd",
				"--dry-run",
				"--processDefinitionId",
				"order-process",
			);

			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			const body = asRecord(parseJson(result).body, "dry-run body");
			assert.strictEqual(body.tenantId, "env-tenant");
		});

		test("--tenantId overrides the default tenant from the environment", async () => {
			const result = await c8WithOptions(
				{ env: { CAMUNDA_DEFAULT_TENANT_ID: "env-tenant" } },
				verb,
				"pd",
				"--dry-run",
				"--processDefinitionId",
				"order-process",
				"--tenantId",
				"flag-tenant",
			);

			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			const body = asRecord(parseJson(result).body, "dry-run body");
			assert.strictEqual(body.tenantId, "flag-tenant");
		});

		test("by key never sends a tenant even when a default tenant is set", async () => {
			const result = await c8WithOptions(
				{ env: { CAMUNDA_DEFAULT_TENANT_ID: "env-tenant" } },
				verb,
				"pd",
				"--dry-run",
				"2251799813685249",
			);

			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			const body = asRecord(parseJson(result).body, "dry-run body");
			assert.strictEqual(body.tenantId, undefined);
		});

		test("--dry-run by ID with --version and --tenantId sends a numeric version", async () => {
			const result = await c8(
				verb,
				"pd",
				"--dry-run",
				"--processDefinitionId",
				"order-process",
				"--version",
				"3",
				"--tenantId",
				"t1",
			);

			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			const body = asRecord(parseJson(result).body, "dry-run body");
			assert.strictEqual(body.processDefinitionId, "order-process");
			assert.strictEqual(body.processDefinitionVersion, 3);
			assert.strictEqual(body.tenantId, "t1");
			assert.strictEqual(body.processDefinitionKey, undefined);
		});

		test("--includeProcessInstances sets the flag to true in the body", async () => {
			const result = await c8(
				verb,
				"pd",
				"--dry-run",
				"2251799813685249",
				"--includeProcessInstances",
			);

			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			const body = asRecord(parseJson(result).body, "dry-run body");
			assert.strictEqual(body.includeProcessInstances, true);
		});

		test("--includeProcessInstances reaches the body with --processDefinitionId, with and without --version", async () => {
			for (const extra of [[], ["--version", "2"]]) {
				const result = await c8(
					verb,
					"pd",
					"--dry-run",
					"--processDefinitionId",
					"order-process",
					...extra,
					"--includeProcessInstances",
				);

				assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
				const body = asRecord(parseJson(result).body, "dry-run body");
				assert.strictEqual(body.processDefinitionId, "order-process");
				assert.strictEqual(body.includeProcessInstances, true);
				assert.strictEqual(
					body.processDefinitionVersion,
					extra.length > 0 ? 2 : undefined,
				);
			}
		});

		test("rejects a key together with --processDefinitionId", async () => {
			const result = await c8(
				verb,
				"pd",
				"--dry-run",
				"2251799813685249",
				"--processDefinitionId",
				"order-process",
			);

			assert.strictEqual(result.status, 1);
			assert.ok(result.stderr.includes("not both"), `stderr: ${result.stderr}`);
			assert.ok(
				result.stderr.includes("--processDefinitionId"),
				`stderr: ${result.stderr}`,
			);
		});

		test("rejects a key together with --version", async () => {
			const result = await c8(
				verb,
				"pd",
				"--dry-run",
				"2251799813685249",
				"--version",
				"2",
			);

			assert.strictEqual(result.status, 1);
			assert.ok(
				result.stderr.includes("only apply with --processDefinitionId"),
				`stderr: ${result.stderr}`,
			);
		});

		test("rejects a key together with --tenantId", async () => {
			const result = await c8(
				verb,
				"pd",
				"--dry-run",
				"2251799813685249",
				"--tenantId",
				"t1",
			);

			assert.strictEqual(result.status, 1);
			assert.ok(
				result.stderr.includes("only apply with --processDefinitionId"),
				`stderr: ${result.stderr}`,
			);
		});

		test("rejects neither a key nor --processDefinitionId with a usage line", async () => {
			const result = await c8(verb, "pd", "--dry-run");

			assert.strictEqual(result.status, 1);
			assert.ok(
				result.stderr.includes("--processDefinitionId"),
				`stderr: ${result.stderr}`,
			);
			assert.ok(result.stderr.includes("Usage:"), `stderr: ${result.stderr}`);
		});

		for (const bad of ["abc", "0", "1.5", "2abc"]) {
			test(`rejects --version ${bad} as not a positive integer`, async () => {
				const result = await c8(
					verb,
					"pd",
					"--dry-run",
					"--processDefinitionId",
					"order-process",
					"--version",
					bad,
				);

				assert.strictEqual(result.status, 1);
				assert.ok(
					result.stderr.includes("--version"),
					`stderr: ${result.stderr}`,
				);
			});
		}

		test("help for the verb lists the process-definition resource and --includeProcessInstances", async () => {
			const result = await c8WithOptions(
				{ env: { C8CTL_OUTPUT_MODE: "text" } },
				"help",
				verb,
			);

			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			assert.ok(
				result.stdout.includes("process-definition"),
				`stdout: ${result.stdout}`,
			);
			assert.ok(
				result.stdout.includes("--includeProcessInstances"),
				`stdout: ${result.stdout}`,
			);
		});

		test("regression: process-instance dry-run still hits the instance endpoint", async () => {
			const result = await c8(verb, "pi", "--dry-run", "12345");

			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			assert.ok(
				getUrl(parseJson(result)).includes(
					`/process-instances/12345/${suffix}`,
				),
			);
		});
	});
}
