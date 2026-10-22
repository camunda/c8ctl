/**
 * CLI behavioural tests for cluster-variable commands.
 *
 * Dry-run tests prove dispatch, validation and request shape without a
 * server. Mock-server tests prove the real SDK call (method, path, body)
 * and output rendering.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { c8, c8WithOptions, parseJson } from "../utils/cli.ts";
import {
	asRecord,
	asRecordArray,
	getBody,
	getUrl,
	isRecord,
} from "../utils/guards.ts";

const GLOBAL = "/cluster-variables/global";
const TENANT = "/cluster-variables/tenants";

// ─── create ──────────────────────────────────────────────────────────────────

describe("CLI behavioural: create cluster-variable --dry-run", () => {
	test("global scope emits POST to /cluster-variables/global", async () => {
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

	test("--tenantId switches to the tenant endpoint", async () => {
		const result = await c8(
			"create",
			"cluster-variable",
			"MY_VAR",
			"--value",
			'{"a":1}',
			"--tenantId",
			"acme",
			"--dry-run",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.ok(getUrl(out).endsWith(`${TENANT}/acme`));
		assert.deepStrictEqual(getBody(out), { name: "MY_VAR", value: { a: 1 } });
	});

	test("includes --metadata and --kind in the body", async () => {
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
			"--dry-run",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.deepStrictEqual(getBody(parseJson(result)), {
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

	test("reads --value from stdin with @-", async () => {
		const result = await c8WithOptions(
			{ stdin: '{"from":"stdin"}' },
			"create",
			"cluster-variable",
			"MY_VAR",
			"--value",
			"@-",
			"--dry-run",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.deepStrictEqual(getBody(parseJson(result)).value, {
			from: "stdin",
		});
	});
});

// ─── get ─────────────────────────────────────────────────────────────────────

describe("CLI behavioural: get cluster-variable --dry-run", () => {
	test("global scope emits GET to /cluster-variables/global/<name>", async () => {
		const result = await c8("get", "cluster-variable", "MY_VAR", "--dry-run");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.method, "GET");
		assert.ok(getUrl(out).endsWith(`${GLOBAL}/MY_VAR`));
	});

	test("--tenantId emits GET to the tenant endpoint", async () => {
		const result = await c8(
			"get",
			"cluster-variable",
			"MY_VAR",
			"--tenantId",
			"acme",
			"--dry-run",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(getUrl(parseJson(result)).endsWith(`${TENANT}/acme/MY_VAR`));
	});

	test("ignores the session/default tenant (explicit --tenantId only)", async () => {
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

// ─── update ──────────────────────────────────────────────────────────────────

describe("CLI behavioural: update cluster-variable --dry-run", () => {
	test("global scope emits PUT with value only", async () => {
		const result = await c8(
			"update",
			"cluster-variable",
			"MY_VAR",
			"--value",
			'{"a":2}',
			"--dry-run",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.method, "PUT");
		assert.ok(getUrl(out).endsWith(`${GLOBAL}/MY_VAR`));
		assert.deepStrictEqual(getBody(out), { value: { a: 2 } });
	});

	test("tenant scope includes --metadata and never a kind", async () => {
		const result = await c8(
			"update",
			"cluster-variable",
			"MY_VAR",
			"--value",
			'{"a":2}',
			"--metadata",
			'{"owner":"ops"}',
			"--tenantId",
			"acme",
			"--dry-run",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.ok(getUrl(out).endsWith(`${TENANT}/acme/MY_VAR`));
		assert.deepStrictEqual(getBody(out), {
			value: { a: 2 },
			metadata: { owner: "ops" },
		});
	});

	test("update job still works with its own flags", async () => {
		const result = await c8(
			"update",
			"job",
			"12345",
			"--retries",
			"3",
			"--dry-run",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.method, "PATCH");
		assert.deepStrictEqual(getBody(out), { changeset: { retries: 3 } });
	});

	test("--kind is not accepted on update (kind is immutable)", async () => {
		const result = await c8(
			"update",
			"cluster-variable",
			"MY_VAR",
			"--value",
			'{"a":2}',
			"--kind",
			"JSON",
			"--dry-run",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(!("kind" in getBody(parseJson(result))));
	});
});

// ─── delete ──────────────────────────────────────────────────────────────────

describe("CLI behavioural: delete cluster-variable --dry-run", () => {
	test("global scope emits DELETE", async () => {
		const result = await c8(
			"delete",
			"cluster-variable",
			"MY_VAR",
			"--dry-run",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.method, "DELETE");
		assert.ok(getUrl(out).endsWith(`${GLOBAL}/MY_VAR`));
		assert.strictEqual(out.body, null);
	});

	test("--tenantId emits DELETE to the tenant endpoint", async () => {
		const result = await c8(
			"delete",
			"cluster-variable",
			"MY_VAR",
			"--tenantId",
			"acme",
			"--dry-run",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(getUrl(parseJson(result)).endsWith(`${TENANT}/acme/MY_VAR`));
	});
});

// ─── list / search ───────────────────────────────────────────────────────────

describe("CLI behavioural: list/search cluster-variables --dry-run", () => {
	test("list emits POST to /cluster-variables/search", async () => {
		const result = await c8("list", "cluster-variables", "--dry-run");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.method, "POST");
		assert.ok(getUrl(out).endsWith("/cluster-variables/search"));
	});

	test("search maps flags into the filter and truncateValues", async () => {
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
			"--isTruncated",
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
			isTruncated: true,
		});
	});

	test("search truncates values by default", async () => {
		const result = await c8(
			"search",
			"cluster-variables",
			"--name",
			"MY_VAR",
			"--dry-run",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.ok(
			getUrl(out).endsWith("/cluster-variables/search?truncateValues=true"),
		);
		assert.deepStrictEqual(getBody(out).filter, { name: "MY_VAR" });
	});
});

// ─── validation (fails before any request, even with --dry-run) ─────────────

describe("CLI behavioural: cluster-variable validation", () => {
	const cases: Array<{ label: string; args: string[]; stderr: string }> = [
		{
			label: "malformed --value",
			args: ["create", "cluster-variable", "V", "--value", "{nope"],
			stderr: "Invalid JSON for --value",
		},
		{
			label: "array --value",
			args: ["create", "cluster-variable", "V", "--value", "[1]"],
			stderr: "must be a JSON object (not an array)",
		},
		{
			label: "malformed --value on update",
			args: ["update", "cluster-variable", "V", "--value", "{nope"],
			stderr: "Invalid JSON for --value",
		},
		{
			label: "non string/number metadata value",
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
			label: "array --metadata",
			args: [
				"update",
				"cluster-variable",
				"V",
				"--value",
				"{}",
				"--metadata",
				"[1]",
			],
			stderr: "--metadata must be a JSON object (not an array)",
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
			label: "invalid name",
			args: ["get", "cluster-variable", "bad name!"],
			stderr: "name",
		},
		{
			label: "missing name",
			args: ["get", "cluster-variable"],
			stderr: "name",
		},
		{
			label: "missing --value on create",
			args: ["create", "cluster-variable", "V"],
			stderr: "--value is required",
		},
		{
			label: "missing --value on update",
			args: ["update", "cluster-variable", "V"],
			stderr: "--value is required",
		},
	];
	for (const { label, args, stderr } of cases) {
		test(`rejects ${label} with exit code 1`, async () => {
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

// ─── Defect class: dry-run schema consistency ────────────────────────────────

describe("Defect class: cluster-variable --dry-run output includes body field", () => {
	const REQUIRED_KEYS = ["dryRun", "command", "method", "url", "body"] as const;
	const MUTATING: Array<{ verb: string; flags: string[] }> = [
		{ verb: "create", flags: ["--value", '{"a":1}'] },
		{ verb: "update", flags: ["--value", '{"a":1}'] },
		{ verb: "delete", flags: [] },
	];
	for (const { verb, flags } of MUTATING) {
		for (const scope of [[], ["--tenantId", "acme"]]) {
			test(`${verb} cluster-variable ${scope.join(" ") || "(global)"} emits all keys`, async () => {
				const result = await c8(
					verb,
					"cluster-variable",
					"MY_VAR",
					...flags,
					...scope,
					"--dry-run",
				);
				assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
				const out = parseJson(result);
				for (const key of REQUIRED_KEYS) {
					assert.ok(key in out, `missing '${key}', got ${Object.keys(out)}`);
				}
			});
		}
	}
});

// ─── Mock server: real SDK calls and rendering ───────────────────────────────

interface Recorded {
	method: string;
	path: string;
	body: string;
}

async function startMockServer(
	handler: (req: IncomingMessage, res: ServerResponse, rec: Recorded) => void,
): Promise<{ url: string; seen: Recorded[]; close: () => Promise<void> }> {
	const seen: Recorded[] = [];
	const server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			const rec = { method: req.method ?? "", path: req.url ?? "", body };
			seen.push(rec);
			handler(req, res, rec);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const addr = server.address();
	if (!isRecord(addr) || typeof addr.port !== "number") {
		throw new Error("mock server has no port");
	}
	return {
		url: `http://127.0.0.1:${addr.port}/v2`,
		seen,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

const VARIABLE = {
	name: "MY_VAR",
	scope: "TENANT",
	tenantId: "acme",
	metadata: {},
	kind: "JSON",
	value: '{"a":1}',
};

describe("CLI behavioural: cluster-variable against a mock server", () => {
	let server: Awaited<ReturnType<typeof startMockServer>> | null = null;
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	const run = (...args: string[]) => {
		if (!server) throw new Error("server not started");
		return c8WithOptions({ env: { CAMUNDA_BASE_URL: server.url } }, ...args);
	};

	test("search renders the table columns including Truncated", async () => {
		server = await startMockServer((_req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					items: [{ ...VARIABLE, isTruncated: true }],
					page: {
						totalItems: 1,
						startCursor: null,
						endCursor: null,
						hasMoreTotalItems: false,
					},
				}),
			);
		});
		const result = await run("search", "cluster-variables");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const rows = asRecordArray(JSON.parse(result.stdout), "rows");
		assert.deepStrictEqual(rows, [
			{
				Name: "MY_VAR",
				Scope: "TENANT",
				"Tenant ID": "acme",
				Kind: "JSON",
				Value: '{"a":1}',
				Truncated: true,
			},
		]);
		assert.strictEqual(server.seen[0].method, "POST");
		assert.ok(
			server.seen[0].path.endsWith(
				"/cluster-variables/search?truncateValues=true",
			),
			server.seen[0].path,
		);
	});

	test("list reports an empty result", async () => {
		server = await startMockServer((_req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					items: [],
					page: {
						totalItems: 0,
						startCursor: null,
						endCursor: null,
						hasMoreTotalItems: false,
					},
				}),
			);
		});
		const result = await run("list", "cluster-variables");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			`${result.stdout}${result.stderr}`.includes("No cluster variables found"),
		);
	});

	test("get returns the full variable", async () => {
		server = await startMockServer((_req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(VARIABLE));
		});
		const result = await run(
			"get",
			"cluster-variable",
			"MY_VAR",
			"--tenantId",
			"acme",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.deepStrictEqual(asRecord(JSON.parse(result.stdout)), VARIABLE);
		assert.strictEqual(server.seen[0].method, "GET");
		assert.ok(
			server.seen[0].path.endsWith("/cluster-variables/tenants/acme/MY_VAR"),
		);
	});

	test("update sends PUT with the JSON body to the tenant endpoint", async () => {
		server = await startMockServer((_req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(VARIABLE));
		});
		const result = await run(
			"update",
			"cluster-variable",
			"MY_VAR",
			"--tenantId",
			"acme",
			"--value",
			'{"a":1}',
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(server.seen[0].method, "PUT");
		assert.ok(
			server.seen[0].path.endsWith("/cluster-variables/tenants/acme/MY_VAR"),
		);
		assert.deepStrictEqual(JSON.parse(server.seen[0].body), {
			value: { a: 1 },
		});
	});

	test("create sends POST to the global endpoint", async () => {
		server = await startMockServer((_req, res) => {
			res.statusCode = 200;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ ...VARIABLE, scope: "GLOBAL", tenantId: null }));
		});
		const result = await run(
			"create",
			"cluster-variable",
			"MY_VAR",
			"--value",
			'{"a":1}',
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(server.seen[0].method, "POST");
		assert.ok(server.seen[0].path.endsWith("/cluster-variables/global"));
		assert.deepStrictEqual(JSON.parse(server.seen[0].body), {
			name: "MY_VAR",
			value: { a: 1 },
		});
	});

	test("delete sends DELETE to the global endpoint", async () => {
		server = await startMockServer((_req, res) => {
			res.statusCode = 204;
			res.end();
		});
		const result = await run("delete", "cluster-variable", "MY_VAR");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(server.seen[0].method, "DELETE");
		assert.ok(server.seen[0].path.endsWith("/cluster-variables/global/MY_VAR"));
	});

	test("a 404 from the server exits 1", async () => {
		server = await startMockServer((_req, res) => {
			res.statusCode = 404;
			res.setHeader("content-type", "application/problem+json");
			res.end(
				JSON.stringify({
					type: "about:blank",
					title: "NOT_FOUND",
					status: 404,
					detail: "Cluster variable not found",
					instance: "/v2/cluster-variables/global/MISSING",
				}),
			);
		});
		const result = await run("get", "cluster-variable", "MISSING");
		assert.strictEqual(result.status, 1);
	});
});
