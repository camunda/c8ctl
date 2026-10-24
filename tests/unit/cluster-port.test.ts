import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

// @ts-expect-error — JS plugin has no declaration file, as in cluster-plugin.test.ts
const plugin = await import("../../default-plugins/cluster/c8ctl-plugin.js");
const { parsePluginArgs, clusterUrls, readClusterPort } = plugin;

import { c8WithEnv } from "../utils/cli.ts";

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
