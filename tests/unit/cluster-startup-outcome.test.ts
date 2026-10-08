import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { c8WithEnv, parseJson } from "../utils/cli.ts";
import { pollUntil } from "../utils/polling.ts";

describe("cluster startup outcomes through the CLI", {
	skip: process.platform === "win32", // The fake c8run launcher is a POSIX shell script.
}, () => {
	let cacheDir: string;
	let installDir: string;
	let preload: string;
	let children: ChildProcess[];

	beforeEach(() => {
		cacheDir = mkdtempSync(join(tmpdir(), "c8ctl-startup-outcome-"));
		installDir = join(cacheDir, "c8run-8.10.1");
		mkdirSync(installDir);
		children = [];
		preload = join(cacheDir, "health.mjs");
		writeFileSync(
			preload,
			`globalThis.fetch = async () => new Response(JSON.stringify({ status: process.env.TEST_HEALTH }), { status: 200 });`,
		);
	});

	afterEach(async () => {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit");
				child.kill();
				await exited;
			}
		}
		rmSync(cacheDir, { recursive: true, force: true });
	});

	const cluster = (health: string, ...args: string[]) =>
		c8WithEnv(
			{
				C8RUN_CACHE_DIR: cacheDir,
				C8CTL_OUTPUT_MODE: "text",
				NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
				TEST_HEALTH: health,
			},
			"cluster",
			...args,
		);

	async function launcher(exitCode: number) {
		for (const name of ["camunda", "connectors", "connectors-sales"]) {
			const child = spawn(
				process.execPath,
				["-e", "setInterval(() => {}, 1000)"],
				{
					stdio: "ignore",
				},
			);
			children.push(child);
			await once(child, "spawn");
			assert.ok(child.pid);
			writeFileSync(join(cacheDir, `${name}.pid`), String(child.pid));
		}
		const binary = join(installDir, "c8run");
		writeFileSync(
			binary,
			`#!/bin/sh
if [ "$1" = start ]; then
  for name in camunda connectors connectors-sales; do
    cp "../$name.pid" "$name.process"
  done
  if [ ${exitCode} != 0 ]; then printf 'sales NOT READY\n' >&2; fi
  exit ${exitCode}
fi
exit 0
`,
		);
		chmodSync(binary, 0o755);
	}

	for (const health of ["UP", "DOWN"]) {
		test(`failed startup remains degraded with shared health ${health}, then stops all survivors`, async () => {
			await launcher(7);
			const start = await cluster(
				health,
				"start",
				"8.10.1",
				"--physical-tenants=sales",
			);
			assert.equal(start.status, 7);
			assert.match(start.stderr, /sales NOT READY/);
			assert.equal(existsSync(join(cacheDir, "cluster.active")), false);
			const text = await cluster(health, "status");
			assert.equal(text.status, 0);
			assert.match(text.stdout, /Cluster status: running after failed startup/);
			assert.match(text.stdout, /startup error|c8run logs/);
			assert.match(text.stdout, /c8ctl cluster stop.*before retrying/);
			assert.doesNotMatch(text.stdout, /replaced|removed|untracked/);
			const json = parseJson(await cluster(health, "status", "--json"));
			assert.equal(json.status, "running after failed startup");
			assert.equal(json.version, "8.10.1");
			assert.match(
				String(json.recovery),
				/c8ctl cluster stop.*before retrying/,
			);
			assert.doesNotMatch(String(json.recovery), /replaced|removed/);

			const stop = await cluster(health, "stop");
			assert.equal(stop.status, 0, stop.stderr);
			// Process exit is the correctness signal; the deadline only bounds cleanup.
			assert.ok(
				await pollUntil(
					async () =>
						children.every(
							(child) => child.exitCode !== null || child.signalCode !== null,
						),
					10_000,
					50,
				),
			);
			assert.equal(existsSync(join(cacheDir, "cluster.pids")), false);
			assert.equal(
				parseJson(await cluster("DOWN", "status", "--json")).status,
				"stopped",
			);
		});
	}

	test("successful recovery replaces stale failure metadata after survivors exit", async () => {
		await launcher(7);
		assert.equal((await cluster("UP", "start", "8.10.1")).status, 7);
		assert.equal(
			parseJson(await cluster("UP", "status", "--json")).status,
			"running after failed startup",
		);
		for (const child of children) {
			const exited = once(child, "exit");
			child.kill();
			await exited;
		}
		await launcher(0);
		const start = await cluster("UP", "start", "8.10.1");
		assert.equal(start.status, 0, start.stderr);
		const json = parseJson(await cluster("UP", "status", "--json"));
		assert.equal(json.status, "running");
		assert.equal(json.recovery, undefined);
		assert.doesNotMatch(
			readFileSync(join(cacheDir, "cluster.pids"), "utf8"),
			/"startupFailed":true/,
		);
		const stop = await cluster("DOWN", "stop");
		assert.equal(stop.status, 0, stop.stderr);
	});

	test("unknown startup outcome uses neutral recovery wording", async () => {
		await launcher(7);
		assert.equal((await cluster("UP", "start", "8.10.1")).status, 7);
		// Simulate a legacy record without startup-outcome metadata.
		const file = join(cacheDir, "cluster.pids");
		const record = parseJson({
			stdout: readFileSync(file, "utf8"),
			stderr: "",
			status: 0,
		});
		delete record.startupFailed;
		writeFileSync(file, JSON.stringify(record));
		for (const args of [["status"], ["status", "--json"]]) {
			const result = await cluster("UP", ...args);
			assert.match(result.stdout, /running \(untracked\)/);
			assert.match(result.stdout, /c8ctl cluster stop/);
			assert.doesNotMatch(result.stdout, /replaced|removed|failed startup/);
		}
	});
});
