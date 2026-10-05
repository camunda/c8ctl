/**
 * Run against an installed c8run containing physical-tenant CLI support:
 * C8RUN_CACHE_DIR=<scratch cache> C8CTL_PHYSICAL_TENANTS_VERSION=8.10.1 \
 *   node --experimental-strip-types --test tests/integration/physical-tenants.test.ts
 * Owns cluster start/stop: run separately from the general live-cluster suite.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pollUntil } from "../utils/polling.ts";
import { asyncSpawn, asyncSpawnWithStdin } from "../utils/spawn.ts";

const version = process.env.C8CTL_PHYSICAL_TENANTS_VERSION;

test("physical tenants: setup, authentication, isolated deployment, secrets, restart and removal via c8ctl", {
	skip: !version,
	timeout: 300_000,
}, async () => {
	assert.ok(version);
	assert.ok(process.env.C8RUN_CACHE_DIR, "use a dedicated C8RUN_CACHE_DIR");
	const dir = mkdtempSync(join(tmpdir(), "c8ctl-physical-e2e-"));
	const tenant = `t${Date.now().toString(36).slice(-7)}`;
	const cli = resolve("src/index.ts");
	const env = {
		...process.env,
		C8CTL_DATA_DIR: join(dir, "profiles"),
		C8CTL_OUTPUT_MODE: "text",
		C8RUN_TENANTS_FILE: "tenants.yaml",
		C8RUN_SECRETS_DIR: "secrets",
		CAMUNDA_SECURITY_AUTHENTICATION_UNPROTECTEDAPI: "false",
		CAMUNDA_SECURITY_AUTHORIZATIONS_ENABLED: "true",
	};
	const options = { cwd: dir, env, timeout: 120_000 };
	const run = (...args: string[]) =>
		asyncSpawn("node", [cli, ...args], options);
	const successful = async (...args: string[]) => {
		const result = await run(...args);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		return result;
	};
	try {
		const added = await asyncSpawnWithStdin(
			"node",
			[
				cli,
				"cluster",
				"tenants",
				"--c8-version",
				version,
				"add",
				tenant,
				"--username",
				"alice",
				"--password-stdin",
			],
			(stdin) => {
				stdin.write("local-e2e-password\n");
			},
			options,
		);
		assert.equal(added.status, 0, added.stderr);
		assert.doesNotMatch(added.stdout + added.stderr, /local-e2e-password/);
		writeFileSync(
			join(dir, "values.env"),
			"C8CTL_E2E_SECRET=tenant-only-value\n",
		);
		await successful(
			"cluster",
			"secrets",
			"--c8-version",
			version,
			"--tenant",
			tenant,
			"import",
			"values.env",
		);
		const secrets = await successful(
			"cluster",
			"secrets",
			"--c8-version",
			version,
			"--tenant",
			tenant,
			"list",
		);
		assert.match(secrets.stdout, /C8CTL_E2E_SECRET/);
		assert.doesNotMatch(secrets.stdout, /tenant-only-value/);
		const defaults = await successful(
			"cluster",
			"secrets",
			"--c8-version",
			version,
			"list",
		);
		assert.doesNotMatch(defaults.stdout, /C8CTL_E2E_SECRET/);
		const started = await successful("cluster", "start", version);
		assert.ok(
			started.stdout.includes(`/physical-tenants/${tenant}/`),
			started.stdout,
		);
		await successful(
			"add",
			"profile",
			"tenant",
			`--baseUrl=http://localhost:8080/physical-tenants/${tenant}/v2`,
			"--exactBaseUrl",
			"--username=alice",
			"--password=local-e2e-password",
		);
		await successful(
			"add",
			"profile",
			"default",
			"--baseUrl=http://localhost:8080/v2",
			"--username=demo",
			"--password=demo",
		);
		await successful(
			"add",
			"profile",
			"wrong-login",
			`--baseUrl=http://localhost:8080/physical-tenants/${tenant}/v2`,
			"--exactBaseUrl",
			"--username=demo",
			"--password=demo",
		);
		const rejected = await run(
			"--profile",
			"wrong-login",
			"list",
			"process-definitions",
		);
		assert.notEqual(rejected.status, 0);
		const processId = `physical_${tenant}`;
		const model = join(dir, "isolated.bpmn");
		writeFileSync(
			model,
			`<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="http://camunda.org/test">
  <process id="${processId}" isExecutable="true">
    <startEvent id="start"><outgoing>flow</outgoing></startEvent>
    <sequenceFlow id="flow" sourceRef="start" targetRef="end"/>
    <endEvent id="end"><incoming>flow</incoming></endEvent>
  </process>
</definitions>`,
		);
		await successful("--profile", "tenant", "deploy", model);
		assert.ok(
			await pollUntil(
				async () => {
					const result = await successful(
						"--json",
						"--profile",
						"tenant",
						"search",
						"process-definitions",
						`--id=${processId}`,
					);
					return result.stdout.includes(processId);
				},
				30_000,
				500,
			),
		);
		const isolated = await successful(
			"--json",
			"--profile",
			"default",
			"search",
			"process-definitions",
			`--id=${processId}`,
		);
		assert.ok(!isolated.stdout.includes(processId), isolated.stdout);
		await successful("cluster", "stop");
		await successful("cluster", "start", version);
		const restored = await successful(
			"--json",
			"--profile",
			"tenant",
			"search",
			"process-definitions",
			`--id=${processId}`,
		);
		assert.ok(restored.stdout.includes(processId));
		await successful(
			"cluster",
			"secrets",
			"--c8-version",
			version,
			"--tenant",
			tenant,
			"delete",
			"C8CTL_E2E_SECRET",
			"--yes",
		);
		await successful(
			"cluster",
			"tenants",
			"--c8-version",
			version,
			"remove",
			tenant,
			"--yes",
		);
		await successful("cluster", "stop");
		await successful(
			"cluster",
			"start",
			version,
			`--physical-tenants=${tenant}`,
		);
		const saved = await successful(
			"cluster",
			"tenants",
			"--c8-version",
			version,
			"list",
		);
		assert.match(saved.stdout, /No extra physical tenants yet/i);
	} finally {
		await run("cluster", "stop");
		rmSync(dir, { recursive: true, force: true });
	}
});
