import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
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
import { c8WithEnv, c8WithOptions, parseJson } from "../utils/cli.ts";
import { asRecord } from "../utils/guards.ts";
import { pollUntil } from "../utils/polling.ts";

describe("cluster startup outcomes through the CLI", () => {
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
			`import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const spawn = childProcess.spawn;
const installDir = join(process.env.C8RUN_CACHE_DIR, 'c8run-8.10.1');
const binary = join(installDir, process.platform === 'win32' ? 'c8run.exe' : 'c8run');
// Replace only the fixture executable; PID identity and cleanup use real OS processes.
childProcess.spawn = (command, args, options) => command === binary
  ? spawn(process.execPath, [join(installDir, 'launcher.mjs'), ...args], options)
  : spawn(command, args, options);
syncBuiltinESMExports();
const now = Date.now;
let elapsed = 0;
Date.now = () => now() + elapsed;
globalThis.fetch = async () => {
  // Advance past readiness's deadline after an unsuccessful probe, without a wall-clock race.
  if (process.env.TEST_HEALTH === 'TIMEOUT') elapsed += 120001;
  return new Response(JSON.stringify({ status: process.env.TEST_HEALTH }), { status: 200 });
};`,
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
		const binary = join(
			installDir,
			process.platform === "win32" ? "c8run.exe" : "c8run",
		);
		writeFileSync(binary, "fixture executable redirected by preload");
		writeFileSync(
			join(installDir, "launcher.mjs"),
			`import { copyFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
appendFileSync('invocations.log', process.argv[2] + '\\n');
if (process.argv[2] === 'start') {
  for (const name of ['camunda', 'connectors', 'connectors-sales']) {
    copyFileSync('../' + name + '.pid', name + '.process');
  }
  if (${exitCode} !== 0) console.error('sales NOT READY');
  process.exitCode = ${exitCode};
}
if (process.argv[2] === 'stop') {
  // Mimic c8run stop: signal the processes its .process pidfiles track, then
  // remove those pidfiles. A process NOT tracked by a pidfile (the survivor the
  // test adds directly to the durable record) is left running.
  for (const name of ['camunda', 'connectors', 'connectors-sales']) {
    try { process.kill(Number(readFileSync(name + '.process', 'utf8').trim())); } catch {}
    try { rmSync(name + '.process'); } catch {}
  }
}
`,
		);
	}

	// A launcher whose `start` writes its .process pidfiles (so the cluster is
	// live and tracked) but then never exits — simulating c8run still starting
	// the Java services when c8ctl is interrupted. The CLI's spawn-helper
	// timeout SIGTERMs it mid-start, before any success/failure port write.
	async function hangingLauncher() {
		const binary = join(
			installDir,
			process.platform === "win32" ? "c8run.exe" : "c8run",
		);
		writeFileSync(binary, "fixture executable redirected by preload");
		writeFileSync(
			join(installDir, "launcher.mjs"),
			`import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
if (process.argv[2] === 'start') {
  // Launch + pidfile the cluster processes, then hang (never exit) so the
  // parent c8ctl is interrupted while we are still "starting".
  for (const name of ['camunda', 'connectors', 'connectors-sales']) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    child.on('spawn', () => writeFileSync(name + '.process', String(child.pid)));
    child.unref();
  }
  setInterval(() => {}, 1000);
}
`,
		);
	}

	for (const { health, exitCode, expectedCode, error } of [
		{ health: "UP", exitCode: 7, expectedCode: 7, error: /sales NOT READY/ },
		{ health: "DOWN", exitCode: 7, expectedCode: 7, error: /sales NOT READY/ },
		{
			health: "TIMEOUT",
			exitCode: 0,
			expectedCode: 1,
			error: /Cluster failed to start within timeout/,
		},
	]) {
		test(`failed startup remains degraded with shared health ${health}, then stops all survivors`, async () => {
			await launcher(exitCode);
			const start = await cluster(
				health,
				"start",
				"8.10.1",
				"--physical-tenants=sales",
			);
			assert.equal(start.status, expectedCode);
			assert.match(start.stderr, error);
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

	for (const outcome of ["failed", "unknown", "pidfiles only"]) {
		test(`retry with live survivors and ${outcome} outcome fails without launching or replacing records`, async () => {
			await launcher(7);
			assert.equal((await cluster("UP", "start", "8.10.1")).status, 7);
			const file = join(cacheDir, "cluster.pids");
			if (outcome === "unknown") {
				const record = parseJson({
					stdout: readFileSync(file, "utf8"),
					stderr: "",
					status: 0,
				});
				delete record.startupFailed;
				writeFileSync(file, JSON.stringify(record));
			} else if (outcome === "pidfiles only") {
				rmSync(file);
			}
			const recordBefore = existsSync(file) ? readFileSync(file, "utf8") : null;
			const retry = await cluster("UP", "start", "8.10.1");
			assert.equal(retry.status, 1, retry.stdout + retry.stderr);
			assert.match(retry.stdout + retry.stderr, /c8ctl cluster stop/);
			assert.equal(
				readFileSync(join(installDir, "invocations.log"), "utf8"),
				"start\n",
			);
			assert.equal(
				existsSync(file) ? readFileSync(file, "utf8") : null,
				recordBefore,
			);
			assert.equal(existsSync(join(cacheDir, "cluster.active")), false);
			assert.equal((await cluster("DOWN", "stop")).status, 0);
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

	test("a failed custom-port start persists the port so status serves its URLs", async () => {
		await launcher(7);
		const start = await cluster("UP", "start", "8.10.1", "--port=9091");
		assert.equal(start.status, 7);
		// The port is recorded even though the start failed and no active
		// marker was written — the survivors serve on it.
		assert.equal(
			readFileSync(join(cacheDir, "cluster.port"), "utf8").trim(),
			"9091",
		);
		assert.equal(existsSync(join(cacheDir, "cluster.active")), false);
		const status = await cluster("UP", "status");
		assert.match(status.stdout, /running after failed startup/);
		assert.match(status.stdout, /Operate:\s+http:\/\/localhost:9091\/operate/);
		assert.match(status.stdout, /Zeebe REST:\s+http:\/\/localhost:9091\/v2\//);
		assert.doesNotMatch(status.stdout, /localhost:8080/);
		const json = parseJson(await cluster("UP", "status", "--json"));
		assert.equal(
			asRecord(json.urls, "status urls").operate,
			"http://localhost:9091/operate",
		);
		// Stop clears the recorded port along with the survivors.
		assert.equal((await cluster("DOWN", "stop")).status, 0);
		assert.equal(existsSync(join(cacheDir, "cluster.port")), false);
	});

	test("status recovers the recorded port when the active marker is missing", async () => {
		await launcher(0);
		assert.equal(
			(await cluster("UP", "start", "8.10.1", "--port=9091")).status,
			0,
		);
		// Marker loss (e.g. a crash between marker writes) must not make
		// status advertise the default port while the cluster is tracked.
		rmSync(join(cacheDir, "cluster.active"));
		const status = await cluster("UP", "status");
		assert.match(status.stdout, /running \(untracked\)/);
		assert.match(status.stdout, /Operate:\s+http:\/\/localhost:9091\/operate/);
		assert.doesNotMatch(status.stdout, /localhost:8080/);
		const json = parseJson(await cluster("UP", "status", "--json"));
		assert.equal(
			asRecord(json.urls, "status urls").operate,
			"http://localhost:9091/operate",
		);
		assert.equal((await cluster("DOWN", "stop")).status, 0);
	});

	test("a failed stop keeps the recorded port while pidfile-only survivors remain", async () => {
		await launcher(0);
		assert.equal(
			(await cluster("UP", "start", "8.10.1", "--port=9091")).status,
			0,
		);
		// A process c8run tracks ONLY through a .process pidfile — the durable
		// PID record never captured it. Its liveness is real (a live child), so
		// hasRunningClusterPidfiles sees it even after the recorded PIDs exit.
		const survivor = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			{ stdio: "ignore" },
		);
		children.push(survivor);
		await once(survivor, "spawn");
		assert.ok(survivor.pid);
		const survivorPid = survivor.pid;
		writeFileSync(join(installDir, "survivor.process"), String(survivorPid));

		// c8run stop signals + reaps the three recorded processes (the launcher
		// removes their pidfiles), but the pidfile-only survivor stays alive.
		const stop = await cluster("DOWN", "stop");
		assert.equal(stop.status, 0, stop.stderr);
		assert.ok(
			await pollUntil(
				async () =>
					children
						.filter((c) => c !== survivor)
						.every((c) => c.exitCode !== null || c.signalCode !== null),
				10_000,
				50,
			),
		);

		// The port record must survive: the survivor still serves on 9091, so a
		// later status must not fall back to advertising the default port.
		assert.equal(
			readFileSync(join(cacheDir, "cluster.port"), "utf8").trim(),
			"9091",
		);
		const status = await cluster("UP", "status");
		assert.match(status.stdout, /Operate:\s+http:\/\/localhost:9091\/operate/);
		assert.doesNotMatch(status.stdout, /localhost:8080/);

		// Once the last tracked process exits, stop clears the port record. Wait
		// for the survivor to actually die (kill is async) before removing its
		// pidfile, so the next stop sees no live process and no pidfile.
		const exited = once(survivor, "exit");
		survivor.kill();
		await exited;
		assert.ok(
			await pollUntil(
				async () => {
					try {
						process.kill(survivorPid, 0);
						return false;
					} catch {
						return true;
					}
				},
				10_000,
				50,
			),
		);
		rmSync(join(installDir, "survivor.process"), { force: true });
		assert.equal((await cluster("DOWN", "stop")).status, 0);
		assert.equal(existsSync(join(cacheDir, "cluster.port")), false);
	});

	test("an interrupted start persists the port so status serves its URLs", async () => {
		await hangingLauncher();
		// The launcher writes its .process pidfiles then hangs; the spawn-helper
		// timeout SIGTERMs c8ctl mid-start, before any success/failure port write.
		const start = await c8WithOptions(
			{
				env: {
					C8RUN_CACHE_DIR: cacheDir,
					C8CTL_OUTPUT_MODE: "text",
					NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
					TEST_HEALTH: "UP",
				},
				timeout: 5_000,
			},
			"cluster",
			"start",
			"8.10.1",
			"--port=9091",
		);
		assert.equal(start.timedOut, true, start.stderr);

		// The interrupted start left live .process pidfiles behind; the port must
		// already be recorded so status serves the custom-port URLs, not 8080.
		assert.equal(
			readFileSync(join(cacheDir, "cluster.port"), "utf8").trim(),
			"9091",
		);
		const status = await cluster("UP", "status");
		assert.match(status.stdout, /Operate:\s+http:\/\/localhost:9091\/operate/);
		assert.doesNotMatch(status.stdout, /localhost:8080/);
	});
});
