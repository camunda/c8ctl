/**
 * The CLI process must return to the prompt immediately however the npm
 * registry is blocked. A DNS lookup or TCP connect that never answers can't
 * be cancelled in-process and holds the event loop open, so the CLI must not
 * make one: the check runs in a detached worker.
 *
 * The preload (passed via NODE_OPTIONS, so the worker inherits it) makes any
 * registry lookup in the CLI process hang on a ref'd timer — the same shape
 * as a resolver that never answers. In the worker it only records that the
 * worker was launched, then exits, so no real network call is made.
 */

import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { asyncSpawn } from "../utils/spawn.ts";

test("CLI exits promptly and leaves the check to the worker when the registry hangs", async () => {
	const dir = mkdtempSync(join(tmpdir(), "c8ctl-update-cli-"));
	const workerMarker = join(dir, "worker-launched");
	const preload = join(dir, "preload.mjs");
	const runtimeUrl = pathToFileURL(resolve("src/core/runtime.ts")).href;
	writeFileSync(
		preload,
		[
			'import dns from "node:dns";',
			'import { writeFileSync } from "node:fs";',
			'import { syncBuiltinESMExports } from "node:module";',
			'if (process.argv[1]?.includes("update-check-worker")) {',
			`	writeFileSync(${JSON.stringify(workerMarker)}, process.argv[2] ?? "");`,
			"	process.exit(0);",
			"}",
			"const lookup = dns.lookup;",
			"dns.lookup = function (host, ...rest) {",
			'	if (host !== "registry.npmjs.org") return lookup.call(this, host, ...rest);',
			'	process.stderr.write("[registry-lookup]\\n");',
			"	setTimeout(() => {}, 60_000);",
			"};",
			"syncBuiltinESMExports();",
			// Pretend to be a released build so the check runs at all.
			`const { c8ctl } = await import(${JSON.stringify(runtimeUrl)});`,
			'c8ctl.env.version = "1.0.0";',
		].join("\n"),
	);

	const start = Date.now();
	const result = await asyncSpawn("node", ["src/index.ts", "--version"], {
		env: {
			...process.env,
			C8CTL_DATA_DIR: dir,
			CI: "",
			NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
		},
		// Safety net only; the assertion below is the correctness signal.
		timeout: 30_000,
	});
	const elapsed = Date.now() - start;

	assert.strictEqual(result.status, 0, result.stderr);
	assert.match(result.stdout, /c8ctl v/);
	assert.doesNotMatch(result.stderr, /\[registry-lookup\]/);
	assert.ok(elapsed < 3000, `exit took ${elapsed}ms`);

	// The worker is detached, so it may still be starting.
	const deadline = Date.now() + 10_000;
	while (!existsSync(workerMarker) && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.ok(existsSync(workerMarker), "worker was not launched");
});

test("worker process records the registry's version", async () => {
	// A slow-ish registry: the worker must stay alive until it answers,
	// even though the transport unrefs its socket.
	const server = createServer((_req, res) => {
		setTimeout(() => {
			res.end(JSON.stringify({ "dist-tags": { latest: "9.9.9" } }));
		}, 200);
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const address = server.address();
	assert.ok(address && typeof address === "object");

	const dir = mkdtempSync(join(tmpdir(), "c8ctl-update-worker-"));
	const preload = join(dir, "preload.mjs");
	writeFileSync(
		preload,
		[
			'import http from "node:http";',
			'import https from "node:https";',
			'import { syncBuiltinESMExports } from "node:module";',
			`https.get = (_url, ...rest) => http.get("http://127.0.0.1:${address.port}/", ...rest);`,
			"syncBuiltinESMExports();",
		].join("\n"),
	);

	try {
		const result = await asyncSpawn(
			"node",
			[
				"--import",
				pathToFileURL(preload).href,
				"src/core/update-check-worker.ts",
				"latest",
			],
			{ env: { ...process.env, C8CTL_DATA_DIR: dir }, timeout: 30_000 },
		);
		assert.strictEqual(result.status, 0, result.stderr);
		const state = JSON.parse(
			readFileSync(join(dir, "update-check.json"), "utf-8"),
		);
		assert.deepStrictEqual(state.versions, { latest: "9.9.9" });
	} finally {
		await new Promise((r) => server.close(r));
	}
});
