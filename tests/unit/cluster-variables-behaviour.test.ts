/**
 * CLI behavioural tests for the cluster-variable commands and
 * `search authorization --own`: dispatch, scope, validation and request
 * shape, through `--dry-run`.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { c8, c8WithOptions, parseJson } from "../utils/cli.ts";
import { getBody, getUrl } from "../utils/guards.ts";

const GLOBAL = "/cluster-variables/global";
const TENANT = "/cluster-variables/tenants";

describe("CLI behavioural: create cluster-variable --dry-run", () => {
	test("global scope sends name and value", async () => {
		const result = await c8(
			"create",
			"cluster-variable",
			"MY_VAR",
			"--value",
			'{"url":"https://example.org","n":1}',
			"--dry-run",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.method, "POST");
		assert.ok(getUrl(out).endsWith(GLOBAL));
		assert.deepStrictEqual(getBody(out), {
			name: "MY_VAR",
			value: { url: "https://example.org", n: 1 },
		});
	});

	test("--tenantId, --metadata and --kind", async () => {
		const result = await c8(
			"create",
			"cluster-variable",
			"MY_SECRET",
			"--value",
			'{"ref":"camunda.secrets.X"}',
			"--metadata",
			'{"owner":"ops","rev":2}',
			"--kind",
			"SECRET_REFERENCE",
			"--tenantId",
			"acme",
			"--dry-run",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.ok(getUrl(out).endsWith(`${TENANT}/acme`));
		assert.deepStrictEqual(getBody(out), {
			name: "MY_SECRET",
			value: { ref: "camunda.secrets.X" },
			metadata: { owner: "ops", rev: 2 },
			kind: "SECRET_REFERENCE",
		});
	});

	test("reads --value from @file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "c8ctl-clustervar-"));
		try {
			const file = join(dir, "value.json");
			writeFileSync(file, '{"from":"file"}');
			const result = await c8(
				"create",
				"cluster-variable",
				"MY_VAR",
				"--value",
				`@${file}`,
				"--dry-run",
			);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			assert.deepStrictEqual(getBody(parseJson(result)).value, {
				from: "file",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("CLI behavioural: cluster-variable scope", () => {
	test("get, update and delete address the tenant with --tenantId", async () => {
		for (const [verb, method, extra] of [
			["get", "GET", []],
			["update", "PUT", ["--value", '{"a":2}']],
			["delete", "DELETE", []],
		] as const) {
			const result = await c8(
				verb,
				"cluster-variable",
				"MY_VAR",
				...extra,
				"--tenantId",
				"acme",
				"--dry-run",
			);
			assert.strictEqual(result.status, 0, `${verb}: ${result.stderr}`);
			const out = parseJson(result);
			assert.strictEqual(out.method, method);
			assert.ok(getUrl(out).endsWith(`${TENANT}/acme/MY_VAR`), verb);
		}
	});

	test("the default tenant never selects the tenant scope", async () => {
		const result = await c8WithOptions(
			{ env: { CAMUNDA_DEFAULT_TENANT_ID: "acme" } },
			"get",
			"cluster-variable",
			"MY_VAR",
			"--dry-run",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(getUrl(parseJson(result)).endsWith(`${GLOBAL}/MY_VAR`));
	});
});

describe("CLI behavioural: update --dry-run", () => {
	test("update cluster-variable sends value and metadata", async () => {
		const result = await c8(
			"update",
			"cluster-variable",
			"MY_VAR",
			"--value",
			'{"a":2}',
			"--metadata",
			'{"owner":"ops"}',
			"--dry-run",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.deepStrictEqual(getBody(parseJson(result)), {
			value: { a: 2 },
			metadata: { owner: "ops" },
		});
	});

	test("update job keeps its flags", async () => {
		const result = await c8(
			"update",
			"job",
			"12345",
			"--retries",
			"3",
			"--dry-run",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.deepStrictEqual(getBody(parseJson(result)), {
			changeset: { retries: 3 },
		});
	});
});

describe("CLI behavioural: search cluster-variables --dry-run", () => {
	test("maps the flags into the filter", async () => {
		const result = await c8(
			"search",
			"cluster-variables",
			"--name=MY_*",
			"--scope",
			"TENANT",
			"--tenantId",
			"acme",
			"--kind",
			"JSON",
			"--fullValue",
			"--dry-run",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.ok(
			getUrl(out).endsWith("/cluster-variables/search?truncateValues=false"),
		);
		assert.deepStrictEqual(getBody(out).filter, {
			name: { $like: "MY_*" },
			scope: "TENANT",
			tenantId: "acme",
			kind: "JSON",
		});
	});

	test("truncates values by default", async () => {
		const result = await c8("search", "cluster-variables", "--dry-run");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			getUrl(parseJson(result)).endsWith(
				"/cluster-variables/search?truncateValues=true",
			),
		);
	});
});

describe("CLI behavioural: cluster-variable validation", () => {
	const cases: Array<{ label: string; args: string[]; stderr: string }> = [
		{
			label: "malformed --value",
			args: ["create", "cluster-variable", "V", "--value", "{nope"],
			stderr: "Invalid JSON for --value",
		},
		{
			label: "array --value",
			args: ["update", "cluster-variable", "V", "--value", "[1]"],
			stderr: "must be a JSON object",
		},
		{
			label: "metadata value that is not a string or number",
			args: [
				"create",
				"cluster-variable",
				"V",
				"--value",
				"{}",
				"--metadata",
				'{"k":true}',
			],
			stderr: "--metadata value for key 'k' must be a string or number",
		},
		{
			label: "invalid --kind",
			args: ["create", "cluster-variable", "V", "--value", "{}", "--kind", "X"],
			stderr: "--kind",
		},
		{
			label: "invalid --scope",
			args: ["search", "cluster-variables", "--scope", "X"],
			stderr: "--scope",
		},
		{
			label: "missing --value",
			args: ["create", "cluster-variable", "V"],
			stderr: "--value is required",
		},
	];
	for (const { label, args, stderr } of cases) {
		test(`rejects ${label} before any request`, async () => {
			const result = await c8(...args, "--dry-run");
			assert.strictEqual(result.status, 1, `stdout: ${result.stdout}`);
			assert.ok(
				result.stderr.includes(stderr),
				`expected stderr to include '${stderr}', got: ${result.stderr}`,
			);
			assert.ok(!result.stdout.includes('"dryRun"'));
		});
	}
});

describe("CLI behavioural: search authorization --own --dry-run", () => {
	test("searches the authenticated user's own authorizations", async () => {
		const result = await c8(
			"search",
			"auth",
			"--own",
			"--resourceType",
			"CLUSTER_VARIABLE",
			"--dry-run",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.ok(getUrl(out).endsWith("/authentication/me/authorizations/search"));
		assert.deepStrictEqual(getBody(out), {
			filter: { resourceType: "CLUSTER_VARIABLE" },
		});
	});
});
