/**
 * Integration test for migrated element templates
 * NOTE: This test requires a running Camunda 8 instance at http://localhost:8080
 *
 * Every cluster-free migration scenario lives in
 * tests/unit/element-template-update-scenarios.test.ts. This file only checks
 * that a migrated diagram is accepted by a real cluster.
 */

import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { makeTestEnv } from "../utils/mocks.ts";
import { pollUntil } from "../utils/polling.ts";
import {
	AGENT_V1,
	REST,
	TEMPLATE_FIXTURES,
	writeTemplateCache,
	writeTemplatedDiagram,
} from "../utils/realistic-diagram.ts";
import { asyncSpawn } from "../utils/spawn.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const CLI = join(ROOT, "src/index.ts");
const CLI_TIMEOUT = 30_000;
// Elasticsearch indexes a deployment asynchronously, so searches are polled.
const INDEX_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;

describe("element-template migration deploys to a cluster (requires Camunda 8 at localhost:8080)", () => {
	let dir = "";

	before(() => {
		dir = mkdtempSync(join(tmpdir(), "c8-migration-deploy-"));
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const cli = (...args: string[]) =>
		asyncSpawn("node", [CLI, ...args], {
			cwd: ROOT,
			env: makeTestEnv({ C8CTL_DATA_DIR: dir }),
			timeout: CLI_TIMEOUT,
		});

	test("a migrated collaboration deploys and its process definition is listed", async () => {
		writeTemplateCache(dir, TEMPLATE_FIXTURES);
		const bpmn = await writeTemplatedDiagram(dir);
		// A unique process id keeps repeated runs apart on a shared cluster.
		const unique = `migrated-${Date.now()}`;
		writeFileSync(
			bpmn,
			readFileSync(bpmn, "utf-8").replaceAll("realistic-main", unique),
		);

		for (const templateId of [REST, AGENT_V1]) {
			const migrated = await cli(
				"element-template",
				"update",
				templateId,
				bpmn,
				"--in-place",
				"--allow-lossy",
			);
			assert.equal(migrated.status, 0, migrated.stderr);
		}
		const xml = readFileSync(bpmn, "utf-8");
		assert.equal(xml.match(/zeebe:modelerTemplateVersion="17"/g)?.length, 4);
		assert.equal(xml.match(/zeebe:modelerTemplateVersion="11"/g)?.length, 1);
		assert.equal(existsSync(`${bpmn}.migration.lock`), false);

		const deployed = await cli("deploy", bpmn);
		assert.equal(deployed.status, 0, deployed.stderr);

		let listed: { "Process ID"?: string }[] = [];
		const found = await pollUntil(
			async () => {
				const search = await cli("search", "pd", `--id=${unique}`, "--json");
				if (search.status !== 0) return false;
				try {
					listed = JSON.parse(search.stdout);
				} catch {
					return false;
				}
				return listed.length > 0;
			},
			INDEX_TIMEOUT_MS,
			POLL_INTERVAL_MS,
		);
		assert.ok(found, "the deployed process definition is not listed");
		assert.equal(listed[0]["Process ID"], unique);
	});
});
