/**
 * End-to-end tests for how the host delivers flags to the `cluster` default
 * plugin (#593).
 *
 * `cluster` used to be a bare-function plugin command, which only receives
 * parsed positionals — `--purge`, `--debug` and `--c8-version` were silently
 * dropped, and `cluster secrets` re-read `process.argv` to recover the flags
 * it forwards to c8run. It is now a passthrough command, so the host forwards
 * every non-global flag verbatim.
 *
 * These tests spawn the real CLI with a scratch c8run cache directory.
 */

import assert from "node:assert";
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
import { c8WithEnv } from "../utils/cli.ts";

let cacheDir: string;

before(() => {
	cacheDir = mkdtempSync(join(tmpdir(), "c8ctl-cluster-flags-"));
});

after(() => {
	rmSync(cacheDir, { recursive: true, force: true });
});

const cluster = (...args: string[]) =>
	c8WithEnv({ C8RUN_CACHE_DIR: cacheDir }, "cluster", ...args);

describe("cluster plugin: flags reach the handler (#593)", () => {
	test("`cluster status --purge` is rejected with the plugin's own message", async () => {
		const result = await cluster("status", "--purge");
		assert.strictEqual(result.status, 1, result.stdout + result.stderr);
		assert.ok(
			(result.stdout + result.stderr).includes(
				"--purge can only be used with the stop subcommand",
			),
			`expected the plugin's --purge guard to fire, got:\n${result.stdout}${result.stderr}`,
		);
	});

	test("the --purge guard covers every non-stop subcommand (class-scoped)", async () => {
		for (const sub of ["status", "list", "logs", "start", "install"]) {
			const result = await cluster(sub, "--purge");
			assert.strictEqual(result.status, 1, `cluster ${sub} --purge`);
			assert.ok(
				(result.stdout + result.stderr).includes(
					"--purge can only be used with the stop subcommand",
				),
				`cluster ${sub} --purge did not reach the plugin's guard`,
			);
		}
	});

	test("`cluster stop --purge` is accepted (flag arrives, no guard error)", async () => {
		const result = await cluster("stop", "--purge");
		const out = result.stdout + result.stderr;
		assert.ok(
			!out.includes("--purge can only be used"),
			`stop --purge must not trip the guard:\n${out}`,
		);
		// Nothing is running in the scratch cache dir; the purge branch is
		// reached and reports that it cannot pick a version to purge.
		assert.ok(
			out.includes("Cannot determine which version to purge"),
			`expected the purge branch to run, got:\n${out}`,
		);
	});

	test("--c8-version <value> arrives (and a missing value is reported by the plugin)", async () => {
		const missing = await cluster("delete", "--c8-version");
		assert.strictEqual(missing.status, 1);
		assert.ok(
			(missing.stdout + missing.stderr).includes(
				"Missing value for --c8-version",
			),
		);

		// With a value the plugin resolves it as the version to delete rather
		// than asking for one ("Please specify a version").
		const given = await cluster("delete", "--c8-version", "9.9.9");
		const out = given.stdout + given.stderr;
		assert.ok(!out.includes("Please specify a version"), out);
		assert.ok(out.includes("9.9.9"), out);
	});

	test("--c8-version=<value> arrives", async () => {
		const result = await cluster("delete", "--c8-version=9.9.9");
		const out = result.stdout + result.stderr;
		assert.ok(!out.includes("Please specify a version"), out);
		assert.ok(out.includes("9.9.9"), out);
	});

	test("--debug arrives and does not turn into a positional version", async () => {
		// If --debug were dropped or mis-parsed, `install --debug` would be asked
		// for a version just like a bare `install`. It must not be treated as
		// the version either: the "Please specify a version" error is expected.
		const result = await cluster("install", "--debug");
		assert.strictEqual(result.status, 1);
		assert.ok(
			(result.stdout + result.stderr).includes("Please specify a version"),
		);
	});
});

describe("cluster secrets: passthrough forwards c8run's flags", {
	skip: process.platform === "win32",
}, () => {
	let secretsCache: string;

	before(() => {
		secretsCache = mkdtempSync(join(tmpdir(), "c8ctl-cluster-secrets-"));
		// Fake c8run that prints the argv it was invoked with, one per line.
		const dir = join(secretsCache, "c8run-8.9", "c8run-8.9.1");
		mkdirSync(dir, { recursive: true });
		const bin = join(dir, "c8run");
		writeFileSync(bin, '#!/bin/sh\nfor a in "$@"; do echo "ARG:$a"; done\n');
		chmodSync(bin, 0o755);
	});

	after(() => {
		rmSync(secretsCache, { recursive: true, force: true });
	});

	const secrets = async (...args: string[]) => {
		const result = await c8WithEnv(
			{ C8RUN_CACHE_DIR: secretsCache },
			"cluster",
			"secrets",
			...args,
		);
		const forwarded = result.stdout
			.split("\n")
			.filter((l) => l.startsWith("ARG:"))
			.map((l) => l.slice("ARG:".length));
		return { result, forwarded };
	};

	test("non-global flags such as --stdin and --all reach c8run untouched", async () => {
		const a = await secrets("set", "API_KEY", "--stdin");
		assert.deepStrictEqual(a.forwarded, [
			"secrets",
			"set",
			"API_KEY",
			"--stdin",
		]);
		const b = await secrets("delete", "--all");
		assert.deepStrictEqual(b.forwarded, ["secrets", "delete", "--all"]);
	});

	test("`delete KEY --yes` still reaches c8run with --yes (global flag restored via ctx.yes)", async () => {
		const { forwarded, result } = await secrets("delete", "API_KEY", "--yes");
		assert.deepStrictEqual(
			forwarded,
			["secrets", "delete", "API_KEY", "--yes"],
			result.stderr,
		);
	});

	test("`delete KEY -y` reaches c8run as --yes", async () => {
		const { forwarded } = await secrets("delete", "API_KEY", "-y");
		assert.deepStrictEqual(forwarded, [
			"secrets",
			"delete",
			"API_KEY",
			"--yes",
		]);
	});

	test("other global flags are consumed by c8ctl and not forwarded", async () => {
		const { forwarded } = await secrets("list", "--profile", "x", "--json");
		assert.deepStrictEqual(forwarded, ["secrets", "list"]);
	});

	test("--c8-version pins the version and is not forwarded", async () => {
		const { forwarded } = await secrets("--c8-version", "8.9", "list");
		assert.deepStrictEqual(forwarded, ["secrets", "list"]);
	});
});
