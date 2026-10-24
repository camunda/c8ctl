import assert from "node:assert/strict";
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
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";

// @ts-expect-error — JS plugin has no declaration file, as in cluster-plugin.test.ts
const plugin = await import("../../default-plugins/cluster/c8ctl-plugin.js");
const { parsePluginArgs, clusterUrls, readClusterPort, buildC8RunLaunchEnv } =
	plugin;

import { c8WithEnv, parseJson } from "../utils/cli.ts";
import { asRecord } from "../utils/guards.ts";

describe("cluster start --port argument handling", () => {
	test("both flag forms set the port and forward it to c8run", () => {
		for (const args of [
			["start", "--port", "9091"],
			["start", "--port=9091"],
		]) {
			const parsed = parsePluginArgs(args);
			assert.equal(parsed.port, 9091);
			assert.deepEqual(parsed.startArgs, ["--port", "9091"]);
		}
	});

	test("a port value is not mistaken for a version", () => {
		const parsed = parsePluginArgs(["start", "--port", "9091", "8.10"]);
		assert.equal(parsed.port, 9091);
		assert.equal(parsed.version, "8.10");
	});

	test("the default launch carries no port", () => {
		const parsed = parsePluginArgs(["start"]);
		assert.equal(parsed.port, undefined);
		assert.equal(parsed.startArgs, undefined);
	});

	test("rejects missing, non-numeric and out-of-range values", () => {
		for (const args of [
			["start", "--port"],
			["start", "--port", "--debug"],
			["start", "--port="],
			["start", "--port", "abc"],
			["start", "--port", "9091abc"],
			["start", "--port", "80.5"],
			["start", "--port", "0"],
			["start", "--port", "65536"],
		]) {
			assert.throws(() => parsePluginArgs(args), /--port/, args.join(" "));
		}
	});

	test("rejects --port outside the start subcommand", () => {
		for (const sub of ["stop", "status", "install"]) {
			assert.throws(
				() => parsePluginArgs([sub, "--port", "9091"]),
				/--port can only be used with the start subcommand/,
			);
		}
	});
});

describe("cluster URLs follow the HTTP port", () => {
	test("defaults to 8080", () => {
		const urls = clusterUrls();
		assert.equal(urls.operate, "http://localhost:8080/operate");
		assert.equal(urls.zeebeRest, "http://localhost:8080/v2/");
	});

	test("a custom port moves only the HTTP endpoints", () => {
		const urls = clusterUrls(9091);
		assert.equal(urls.operate, "http://localhost:9091/operate");
		assert.equal(urls.tasklist, "http://localhost:9091/tasklist");
		assert.equal(urls.zeebeRest, "http://localhost:9091/v2/");
		assert.equal(urls.zeebeGrpc, "localhost:26500");
		assert.equal(urls.health, "http://localhost:9600/actuator/health");
	});

	test("the recorded port is read back, falling back to 8080", () => {
		const dir = mkdtempSync(join(tmpdir(), "c8ctl-port-"));
		try {
			assert.equal(readClusterPort(dir), 8080);
			writeFileSync(join(dir, "cluster.port"), "9091\n");
			assert.equal(readClusterPort(dir), 9091);
			writeFileSync(join(dir, "cluster.port"), "garbage");
			assert.equal(readClusterPort(dir), 8080);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("c8run launch environment strips SERVER_PORT", () => {
	test("drops the exact-case SERVER_PORT on every platform", () => {
		for (const platform of ["linux", "darwin", "win32"]) {
			const env = buildC8RunLaunchEnv(
				{ SERVER_PORT: "9091", PATH: "/bin", FOO: "bar" },
				platform,
			);
			assert.equal(env.SERVER_PORT, undefined, platform);
			assert.equal(env.PATH, "/bin", platform);
			assert.equal(env.FOO, "bar", platform);
		}
	});

	test("on Windows the exclusion is case-insensitive (env-var names are case-insensitive there)", () => {
		for (const name of [
			"SERVER_PORT",
			"Server_Port",
			"server_port",
			"sErVeR_pOrT",
		]) {
			const env = buildC8RunLaunchEnv(
				{ [name]: "9091", PATH: "/bin" },
				"win32",
			);
			assert.equal(env[name], undefined, `win32 should strip ${name}`);
			assert.equal(env.PATH, "/bin", `win32 should keep PATH (${name})`);
		}
	});

	test("off Windows a differently-cased name is a distinct variable and is left alone", () => {
		for (const platform of ["linux", "darwin"]) {
			const env = buildC8RunLaunchEnv(
				{ server_port: "9091", Server_Port: "9092", PATH: "/bin" },
				platform,
			);
			assert.equal(env.server_port, "9091", platform);
			assert.equal(env.Server_Port, "9092", platform);
			assert.equal(env.PATH, "/bin", platform);
		}
	});

	test("strips every case variant at once on Windows, not just the first", () => {
		const env = buildC8RunLaunchEnv(
			{ SERVER_PORT: "1", server_port: "2", Server_Port: "3", KEEP: "x" },
			"win32",
		);
		assert.deepEqual(env, { KEEP: "x" });
	});
});

describe("cluster start --port through the CLI", {
	skip: process.platform === "win32",
}, () => {
	let cacheDir: string;
	before(() => {
		cacheDir = mkdtempSync(join(tmpdir(), "c8ctl-port-cli-"));
		const dir = join(cacheDir, "c8run-8.10.1");
		mkdirSync(dir);
		const binary = join(dir, "c8run");
		// Exits non-zero so the plugin never waits for cluster readiness.
		writeFileSync(
			binary,
			`#!/bin/sh
for a in "$@"; do printf 'ARG:%s\\n' "$a"; done
printf 'SERVER_PORT:%s\\n' "$SERVER_PORT"
case "$*" in *legacy*) printf 'flag provided but not defined: -port\\n';; esac
exit 7
`,
		);
		chmodSync(binary, 0o755);
	});
	after(() => rmSync(cacheDir, { recursive: true, force: true }));

	const cluster = (env: Record<string, string>, ...args: string[]) =>
		c8WithEnv(
			{
				C8RUN_CACHE_DIR: cacheDir,
				C8CTL_OUTPUT_MODE: "text",
				C8CTL_C8RUN_DOWNLOAD_URL: "http://127.0.0.1:1/no-download",
				...env,
			},
			"cluster",
			...args,
		);

	test("forwards --port to c8run start", async () => {
		const result = await cluster({}, "start", "8.10.1", "--port=9091");
		assert.equal(result.status, 7);
		assert.match(result.stderr, /ARG:start\nARG:--port\nARG:9091\n/);
	});

	test("never leaks an inherited SERVER_PORT into c8run, which would also move Connectors onto the Camunda port", async () => {
		const result = await cluster({ SERVER_PORT: "9091" }, "start", "8.10.1");
		assert.equal(result.status, 7);
		assert.match(result.stderr, /SERVER_PORT:\n/);
	});

	test("explains when the cached c8run does not support --port", async () => {
		const result = await cluster(
			{},
			"start",
			"8.10.1",
			"--port",
			"9091",
			"--physical-tenants=legacy",
		);
		assert.equal(result.status, 7);
		assert.match(result.stderr, /does not support --port/);
	});
});

describe("successful custom-port lifecycle through the CLI", {
	skip: process.platform === "win32",
}, () => {
	let cacheDir: string;
	let installDir: string;
	let preload: string;

	before(() => {
		cacheDir = mkdtempSync(join(tmpdir(), "c8ctl-port-lifecycle-"));
		installDir = join(cacheDir, "c8run-8.10.1");
		mkdirSync(installDir);
		// Same mocked-health pattern as cluster-startup-outcome.test.ts: the
		// preload redirects the spawn of the fixture binary to launcher.mjs and
		// answers every readiness/health probe — no real cluster needed.
		preload = join(cacheDir, "health.mjs");
		writeFileSync(
			preload,
			`import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const spawn = childProcess.spawn;
const installDir = join(process.env.C8RUN_CACHE_DIR, 'c8run-8.10.1');
const binary = join(installDir, 'c8run');
childProcess.spawn = (command, args, options) => command === binary
  ? spawn(process.execPath, [join(installDir, 'launcher.mjs'), ...args], options)
  : spawn(command, args, options);
syncBuiltinESMExports();
globalThis.fetch = async () => new Response(JSON.stringify({ status: process.env.TEST_HEALTH }), { status: 200 });`,
		);
		const binary = join(installDir, "c8run");
		writeFileSync(binary, "fixture executable redirected by preload");
		chmodSync(binary, 0o755);
		// A successful start: prints a c8run-like summary and exits 0. The
		// readiness probe is mocked UP, so no real processes or ports exist.
		writeFileSync(
			join(installDir, "launcher.mjs"),
			`if (process.argv[2] === 'start') console.log('Camunda 8 Run started');
`,
		);
	});
	after(() => rmSync(cacheDir, { recursive: true, force: true }));

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

	test("start persists the port, status serves its URLs, and stop removes it", async () => {
		const start = await cluster("UP", "start", "8.10.1", "--port=9091");
		assert.equal(start.status, 0, start.stderr);
		assert.match(start.stdout, /Operate:\s+http:\/\/localhost:9091\/operate/);
		// The built-in 'local' profile still targets 8080, so start prints the
		// connection guidance for the custom port.
		assert.match(
			start.stdout,
			/add profile local-9091 --baseUrl=http:\/\/localhost:9091\/v2/,
		);
		assert.match(start.stdout, /CAMUNDA_BASE_URL=http:\/\/localhost:9091\/v2/);
		// The port is persisted by start itself, not by test scaffolding.
		assert.equal(
			readFileSync(join(cacheDir, "cluster.port"), "utf8").trim(),
			"9091",
		);

		const status = await cluster("UP", "status");
		assert.equal(status.status, 0, status.stderr);
		assert.match(status.stdout, /Cluster status: running/);
		assert.match(status.stdout, /Operate:\s+http:\/\/localhost:9091\/operate/);
		assert.match(status.stdout, /Zeebe REST:\s+http:\/\/localhost:9091\/v2\//);
		// gRPC and health stay on their fixed ports.
		assert.match(status.stdout, /Zeebe GRPC:\s+localhost:26500/);
		assert.match(
			status.stdout,
			/Health:\s+http:\/\/localhost:9600\/actuator\/health/,
		);

		const json = parseJson(await cluster("UP", "status", "--json"));
		assert.equal(json.status, "running");
		const urls = asRecord(json.urls, "status urls");
		assert.equal(urls.operate, "http://localhost:9091/operate");
		assert.equal(urls.zeebeRest, "http://localhost:9091/v2/");

		const stop = await cluster("DOWN", "stop");
		assert.equal(stop.status, 0, stop.stderr);
		// Stop reaps the marker set, including the recorded port.
		assert.equal(existsSync(join(cacheDir, "cluster.port")), false);
		assert.equal(existsSync(join(cacheDir, "cluster.active")), false);
		const stopped = parseJson(await cluster("DOWN", "status", "--json"));
		assert.equal(stopped.status, "stopped");
	});
});
