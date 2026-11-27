/**
 * Integration tests for cluster variables and own authorizations
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 *
 * All assertions and setup drive the CLI via the subprocess helper.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { makeTestEnv } from "../utils/mocks.ts";
import { pollUntil, pollUntilValue } from "../utils/polling.ts";
import { asyncSpawn } from "../utils/spawn.ts";

const POLL_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 1000;
const DEFAULT_TENANT = "<default>";

const camundaVersion = process.env.CAMUNDA_VERSION;
// The 8.8 gateway has no /v2/cluster-variables endpoints.
const clusterVariablesSkip =
	camundaVersion?.startsWith("8.8") === true
		? `Cluster variables require Camunda 8.9+ (CAMUNDA_VERSION=${camundaVersion})`
		: false;
// kind, metadata and the own authorizations search are new in 8.10.
const camunda810Skip =
	camundaVersion?.startsWith("8.8") === true ||
	camundaVersion?.startsWith("8.9") === true
		? `Requires Camunda 8.10+ (CAMUNDA_VERSION=${camundaVersion})`
		: false;

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(PROJECT_ROOT, "src", "index.ts");

describe("Cluster variables Integration Tests (requires Camunda 8 at localhost:8080)", {
	skip: clusterVariablesSkip,
}, () => {
	let dataDir: string;
	let created: Array<{ name: string; tenantId?: string }>;

	const cli = (...args: string[]) =>
		asyncSpawn("node", ["--experimental-strip-types", CLI, "--json", ...args], {
			cwd: PROJECT_ROOT,
			env: makeTestEnv({ C8CTL_DATA_DIR: dataDir }),
		});

	const uniqueName = (prefix: string) =>
		`C8CTL_${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

	/** Create a variable through the CLI and register it for cleanup. */
	const create = async (
		name: string,
		tenantId?: string,
		...extra: string[]
	) => {
		const result = await cli(
			"create",
			"cluster-variable",
			name,
			"--value",
			'{"a":1}',
			...(tenantId ? ["--tenantId", tenantId] : []),
			...extra,
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		created.push({ name, tenantId });
	};

	/** Reads are eventually consistent: poll until the variable matches `accept`. */
	const getEventually = (
		name: string,
		tenantArgs: string[],
		accept: (v: Record<string, unknown>) => boolean = () => true,
	) =>
		pollUntilValue(
			async () => {
				const got = await cli("get", "cluster-variable", name, ...tenantArgs);
				if (got.status !== 0) return undefined;
				const variable: Record<string, unknown> = JSON.parse(got.stdout);
				return accept(variable) ? variable : undefined;
			},
			POLL_TIMEOUT_MS,
			POLL_INTERVAL_MS,
			`cluster variable ${name}`,
		);

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "c8ctl-clustervar-int-"));
		created = [];
	});

	afterEach(async () => {
		for (const { name, tenantId } of created) {
			await cli(
				"delete",
				"cluster-variable",
				name,
				...(tenantId ? ["--tenantId", tenantId] : []),
			);
		}
		rmSync(dataDir, { recursive: true, force: true });
	});

	for (const scope of ["global", "tenant"] as const) {
		const tenantId = scope === "tenant" ? DEFAULT_TENANT : undefined;
		const tenantArgs = tenantId ? ["--tenantId", tenantId] : [];

		test(`create, get and search a ${scope} variable`, async () => {
			const name = uniqueName(scope.toUpperCase());
			await create(name, tenantId);

			const variable = await getEventually(name, tenantArgs);
			assert.strictEqual(variable.scope, scope.toUpperCase());
			assert.deepStrictEqual(JSON.parse(String(variable.value)), { a: 1 });

			const row = await pollUntilValue(
				async () => {
					const found = await cli(
						"search",
						"cluster-variables",
						`--name=${name}`,
						"--fullValue",
					);
					if (found.status !== 0) return undefined;
					const rows: Array<Record<string, unknown>> = JSON.parse(found.stdout);
					return rows.find((r) => r.Name === name);
				},
				POLL_TIMEOUT_MS,
				POLL_INTERVAL_MS,
			);
			assert.strictEqual(row?.Scope, scope.toUpperCase());
		});

		test(`update a ${scope} variable`, async () => {
			const name = uniqueName(`UPD_${scope.toUpperCase()}`);
			await create(name, tenantId);

			const updated = await cli(
				"update",
				"cluster-variable",
				name,
				"--value",
				'{"a":2}',
				...tenantArgs,
			);
			assert.strictEqual(updated.status, 0, `stderr: ${updated.stderr}`);

			const got = await getEventually(
				name,
				tenantArgs,
				(v) => JSON.parse(String(v.value)).a === 2,
			);
			assert.deepStrictEqual(JSON.parse(String(got.value)), { a: 2 });
		});

		test(`delete a ${scope} variable`, async () => {
			const name = uniqueName(`DEL_${scope.toUpperCase()}`);
			await create(name, tenantId);
			await getEventually(name, tenantArgs);

			const deleted = await cli(
				"delete",
				"cluster-variable",
				name,
				...tenantArgs,
			);
			assert.strictEqual(deleted.status, 0, `stderr: ${deleted.stderr}`);

			const gone = await pollUntil(
				async () =>
					(await cli("get", "cluster-variable", name, ...tenantArgs)).status ===
					1,
				POLL_TIMEOUT_MS,
				POLL_INTERVAL_MS,
			);
			assert.ok(gone, "deleted variable should not be found");
		});
	}

	test("kind and metadata", { skip: camunda810Skip }, async () => {
		const name = uniqueName("KIND");
		await create(
			name,
			undefined,
			"--kind",
			"SECRET_REFERENCE",
			"--metadata",
			'{"kind":"CREDENTIAL","rev":1}',
		);

		const variable = await getEventually(name, []);
		assert.strictEqual(variable.kind, "SECRET_REFERENCE");
		assert.deepStrictEqual(variable.metadata, { kind: "CREDENTIAL", rev: 1 });

		const updated = await cli(
			"update",
			"cluster-variable",
			name,
			"--value",
			'{"a":2}',
			"--metadata",
			'{"kind":"CREDENTIAL","rev":2}',
		);
		assert.strictEqual(updated.status, 0, `stderr: ${updated.stderr}`);
		const got = await getEventually(
			name,
			[],
			(v) => JSON.parse(String(v.value)).a === 2,
		);
		assert.deepStrictEqual(got.metadata, { kind: "CREDENTIAL", rev: 2 });
	});

	// The test cluster runs with authorizations disabled (assets/c8/8.10).
	test("search own authorizations", { skip: camunda810Skip }, async () => {
		const result = await cli(
			"search",
			"auth",
			"--own",
			"--resourceType=CLUSTER_VARIABLE",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.match(result.stderr, /Authorizations are disabled on this cluster/);
	});
});
