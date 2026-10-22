/**
 * Integration tests for cluster variables
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
// Update, metadata and kind are absent from the 8.9-era API spec.
const updateSkip =
	camundaVersion?.startsWith("8.8") === true ||
	camundaVersion?.startsWith("8.9") === true
		? `Cluster variable update requires Camunda 8.10+ (CAMUNDA_VERSION=${camundaVersion})`
		: false;

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(PROJECT_ROOT, "src", "index.ts");

describe("Cluster variables Integration Tests (requires Camunda 8 at localhost:8080)", () => {
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
	const create = async (name: string, tenantId?: string) => {
		const result = await cli(
			"create",
			"cluster-variable",
			name,
			"--value",
			'{"a":1}',
			...(tenantId ? ["--tenantId", tenantId] : []),
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		created.push({ name, tenantId });
	};

	/**
	 * Get is eventually consistent: 8.8 reads from Elasticsearch, 8.9+ from RDBMS.
	 * Poll until the variable is readable and `accept` holds.
	 */
	const getEventually = (
		name: string,
		tenantArgs: string[],
		accept: (v: Record<string, string>) => boolean = () => true,
	) =>
		pollUntilValue(
			async () => {
				const got = await cli("get", "cluster-variable", name, ...tenantArgs);
				if (got.status !== 0) return undefined;
				const variable: Record<string, string> = JSON.parse(got.stdout);
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
			assert.strictEqual(variable.name, name);
			assert.strictEqual(variable.scope, scope.toUpperCase());
			assert.deepStrictEqual(JSON.parse(variable.value), { a: 1 });

			// Search is eventually consistent.
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
			assert.ok(row, "created variable should appear in search");
			assert.strictEqual(row.Scope, scope.toUpperCase());
		});

		test(`update a ${scope} variable`, { skip: updateSkip }, async () => {
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
				(v) => JSON.stringify(JSON.parse(v.value)) === '{"a":2}',
			);
			assert.deepStrictEqual(JSON.parse(got.value), { a: 2 });
		});

		test(`delete a ${scope} variable`, async () => {
			const name = uniqueName(`DEL_${scope.toUpperCase()}`);
			await create(name, tenantId);

			const deleted = await cli(
				"delete",
				"cluster-variable",
				name,
				...tenantArgs,
			);
			assert.strictEqual(deleted.status, 0, `stderr: ${deleted.stderr}`);

			// Delete propagates to the read store eventually.
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
});
