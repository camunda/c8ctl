import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

// @ts-expect-error — JS plugin has no declaration file, as in cluster-plugin.test.ts
const plugin = await import("../../default-plugins/cluster/c8ctl-plugin.js");
const {
	parsePluginArgs,
	parseSecretsArgs,
	resolveSecretsPaths,
	withForwardedYes,
} = plugin;

import { c8WithEnv } from "../utils/cli.ts";

describe("physical tenant argument handling on all platforms", () => {
	test("startup flags are collected without changing the default launch", () => {
		assert.equal(parsePluginArgs(["start"]).startArgs, undefined);
		assert.deepEqual(
			parsePluginArgs([
				"start",
				"--physical-tenants=sales",
				"--physical-tenants",
				"hr",
			]).startArgs,
			["--physical-tenants=sales", "--physical-tenants", "hr"],
		);
	});
	test("tenant confirmations precede terminators and leave literal arguments alone", () => {
		assert.deepEqual(
			withForwardedYes(
				["--c8-version=8.10", "remove", "sales", "--", "--yes"],
				{ yes: true },
				"tenants",
			),
			["--c8-version=8.10", "remove", "sales", "--yes", "--", "--yes"],
		);
		assert.deepEqual(
			withForwardedYes(["--", "remove"], { yes: true }, "tenants"),
			["--", "remove"],
		);
	});
	test("every physical tenant command name restores confirmation", () => {
		for (const command of ["physical-tenants", "tenants", "pt"]) {
			assert.deepEqual(
				withForwardedYes(["remove", "sales"], { yes: true }, command),
				["remove", "sales", "--yes"],
			);
		}
	});
	test("secrets accept --physical-tenant and forward it as c8run's tenant selector", () => {
		for (const [selector, forwarded] of [
			[
				["--physical-tenant", "sales"],
				["--tenant", "sales"],
			],
			[["--physical-tenant=sales"], ["--tenant=sales"]],
			[
				["--tenant", "sales"],
				["--tenant", "sales"],
			],
		]) {
			const tail = [...selector, "delete", "KEY"];
			assert.deepEqual(withForwardedYes(tail, { yes: true }), [
				...tail,
				"--yes",
			]);
			assert.deepEqual(parseSecretsArgs(tail).passthrough, [
				...forwarded,
				"delete",
				"KEY",
			]);
		}
		assert.deepEqual(
			parseSecretsArgs(["set", "--", "--physical-tenant"]).passthrough,
			["set", "--", "--physical-tenant"],
		);
	});
	test("usage errors name the physical-tenants command", () => {
		assert.throws(
			() => parseSecretsArgs([], "physical-tenants"),
			/c8ctl cluster physical-tenants/,
		);
	});
	test("scoped imports resolve only the file and configured store paths", () => {
		const cwd = resolve("caller");
		const input = ["--tenant=hr", "import", "values.env"];
		const env = {
			C8RUN_TENANTS_FILE: "tenants.yaml",
			C8RUN_SECRETS_DIR: "secrets",
		};
		assert.deepEqual(resolveSecretsPaths(input, { cwd, env }), {
			passthrough: ["--tenant=hr", "import", resolve(cwd, "values.env")],
			env: {
				C8RUN_TENANTS_FILE: resolve(cwd, "tenants.yaml"),
				C8RUN_SECRETS_DIR: resolve(cwd, "secrets"),
			},
		});
		assert.equal(input[2], "values.env");
		assert.equal(env.C8RUN_TENANTS_FILE, "tenants.yaml");
		assert.deepEqual(
			resolveSecretsPaths(["import", "--", "values.env"], { cwd, env })
				.passthrough,
			["import", "--", "values.env"],
		);
	});
});

test("cluster help explains the physical tenant selector translation", async () => {
	for (const outputMode of ["text", "json"]) {
		const result = await c8WithEnv(
			{ C8CTL_OUTPUT_MODE: outputMode },
			"help",
			"cluster",
		);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /--physical-tenant is rewritten to --tenant/);
	}
});

describe("cluster physical tenants through the CLI", {
	skip: process.platform === "win32",
}, () => {
	let cacheDir: string;
	before(() => {
		cacheDir = mkdtempSync(join(tmpdir(), "c8ctl-tenants-"));
		for (const version of ["8.10.1", "8.11.0"]) {
			const dir = join(cacheDir, `c8run-${version}`);
			mkdirSync(dir);
			const binary = join(dir, "c8run");
			writeFileSync(
				binary,
				`#!/bin/sh
printf 'VERSION:${version}\\n'
for a in "$@"; do printf 'ARG:%s\\n' "$a"; done
printf 'TENANTS:%s\\nSECRETS:%s\\nCLI:%s\\n' "$C8RUN_TENANTS_FILE" "$C8RUN_SECRETS_DIR" "$C8RUN_CLI_NAME"
if [ "$1" = start ]; then exit 7; fi
if [ "$2" = unsupported ]; then printf 'unsupported operation: tenants\\n' >&2; exit 1; fi
if [ "$2" = failure ]; then printf 'tenant validation failed\\n' >&2; exit 3; fi
`,
			);
			chmodSync(binary, 0o755);
		}
	});
	after(() => rmSync(cacheDir, { recursive: true, force: true }));
	const cluster = (...args: string[]) =>
		c8WithEnv(
			{
				C8RUN_CACHE_DIR: cacheDir,
				C8RUN_TENANTS_FILE: "local tenants.yaml",
				C8RUN_SECRETS_DIR: "local secrets",
				C8CTL_OUTPUT_MODE: "text",
				C8CTL_C8RUN_DOWNLOAD_URL: "http://127.0.0.1:1/no-download",
			},
			"cluster",
			...args,
		);
	const argv = (stdout: string) =>
		stdout
			.split("\n")
			.filter((line) => line.startsWith("ARG:"))
			.map((line) => line.slice(4));

	test("delegates tenant operations and arbitrary flags to the highest installed version", async () => {
		for (const args of [
			["add", "sales", "hr", "--no-connectors"],
			["list"],
			["path"],
			["help"],
			["future-command", "--future-flag"],
		]) {
			const result = await cluster("tenants", ...args);
			assert.equal(result.status, 0, result.stderr);
			assert.deepEqual(argv(result.stdout), ["tenants", ...args]);
			assert.match(result.stdout, /VERSION:8\.11\.0/);
			assert.ok(
				result.stdout.includes(`TENANTS:${resolve("local tenants.yaml")}`),
			);
			assert.ok(result.stdout.includes(`SECRETS:${resolve("local secrets")}`));
			// c8run prints hints with this prefix, so users see commands they can run.
			assert.ok(result.stdout.includes("CLI:c8ctl cluster"));
		}
	});

	test("physical-tenants and pt are forwarded like tenants", async () => {
		for (const command of ["physical-tenants", "pt"]) {
			const result = await cluster(command, "add", "sales");
			assert.equal(result.status, 0, result.stderr);
			assert.deepEqual(argv(result.stdout), ["tenants", "add", "sales"]);
		}
	});

	test("secrets --physical-tenant is forwarded as c8run's tenant selector", async () => {
		const result = await cluster(
			"secrets",
			"--physical-tenant",
			"sales",
			"import",
			"values.env",
		);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(argv(result.stdout), [
			"secrets",
			"--tenant",
			"sales",
			"import",
			resolve("values.env"),
		]);
	});

	test("pins the version without forwarding c8ctl flags", async () => {
		for (const flags of [["--c8-version", "8.10.1"], ["--c8-version=8.10.1"]]) {
			const result = await cluster(
				"tenants",
				...flags,
				"add",
				"hr",
				"--username",
				"alice",
				"--password-stdin",
			);
			assert.deepEqual(argv(result.stdout), [
				"tenants",
				"add",
				"hr",
				"--username",
				"alice",
				"--password-stdin",
			]);
			assert.match(result.stdout, /VERSION:8\.10\.1/);
		}
	});

	test("restores confirmation only for operations accepting it", async () => {
		for (const operation of ["remove", "rm", "reset"]) {
			const result = await cluster("tenants", operation, "--yes");
			assert.deepEqual(argv(result.stdout), ["tenants", operation, "--yes"]);
		}
		const result = await cluster("tenants", "list", "--yes");
		assert.deepEqual(argv(result.stdout), ["tenants", "list"]);
	});

	test("prefers a live running version and ignores stale markers", async () => {
		writeFileSync(join(cacheDir, "cluster.active"), "running");
		writeFileSync(join(cacheDir, "cluster.version"), "8.10.1");
		const pidfile = join(cacheDir, "c8run-8.10.1", "camunda.process");
		writeFileSync(pidfile, String(process.pid));
		try {
			const running = await cluster("tenants", "list");
			assert.match(running.stdout, /VERSION:8\.10\.1/);
			rmSync(pidfile);
			const stale = await cluster("tenants", "list");
			assert.match(stale.stdout, /VERSION:8\.11\.0/);
		} finally {
			rmSync(pidfile, { force: true });
			rmSync(join(cacheDir, "cluster.active"), { force: true });
			rmSync(join(cacheDir, "cluster.version"), { force: true });
		}
	});

	test("preserves tenant-scoped secret imports and confirmation regardless of tenant flag position", async () => {
		for (const tenant of [["--tenant", "sales"], ["--tenant=sales"]]) {
			const result = await cluster(
				"secrets",
				...tenant,
				"import",
				"values.env",
			);
			assert.deepEqual(argv(result.stdout), [
				"secrets",
				...tenant,
				"import",
				resolve("values.env"),
			]);
			const deleted = await cluster(
				"secrets",
				...tenant,
				"delete",
				"KEY",
				"-y",
			);
			assert.deepEqual(argv(deleted.stdout), [
				"secrets",
				...tenant,
				"delete",
				"KEY",
				"--yes",
			]);
		}
		const result = await cluster(
			"secrets",
			"import",
			"--tenant",
			"sales",
			"values.env",
		);
		assert.deepEqual(argv(result.stdout), [
			"secrets",
			"import",
			"--tenant",
			"sales",
			resolve("values.env"),
		]);
	});

	test("preserves child failures and supplies a capability hint only for missing support", async () => {
		const failure = await cluster("tenants", "failure");
		assert.equal(failure.status, 3);
		assert.match(failure.stderr, /tenant validation failed/);
		assert.doesNotMatch(failure.stderr, /does not support/);
		const unsupported = await cluster("tenants", "unsupported");
		assert.equal(unsupported.status, 1);
		assert.match(
			unsupported.stderr,
			/8\.11\.0.*does not support.*physical-tenants/,
		);
	});

	test("forwards repeated and equals-form startup flags without interpreting IDs as versions", async () => {
		const result = await cluster(
			"start",
			"8.10.1",
			"--physical-tenants",
			"sales,hr",
			"--physical-tenants=ops",
		);
		assert.equal(result.status, 7);
		assert.match(
			result.stderr,
			/ARG:--physical-tenants\nARG:sales,hr\nARG:--physical-tenants=ops/,
		);
		assert.ok(
			result.stderr.includes(`TENANTS:${resolve("local tenants.yaml")}`),
		);
	});

	test("rejects missing tenant flag values and use outside start", async () => {
		for (const args of [
			["start", "8.10.1", "--physical-tenants"],
			["start", "8.10.1", "--physical-tenants", "--debug"],
			["status", "--physical-tenants=sales"],
		]) {
			const result = await cluster(...args);
			assert.equal(result.status, 1);
			assert.match(result.stderr, /--physical-tenants/);
			assert.doesNotMatch(result.stdout + result.stderr, /VERSION:/);
		}
	});

	test("a partial startup failure records surviving tenant connectors for later recovery", async () => {
		const child = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			{ stdio: "ignore" },
		);
		assert.ok(child.pid);
		const pidfile = join(cacheDir, "c8run-8.10.1", "connectors-hr.process");
		// The fake launcher creates a pidfile while starting, after the pre-start guard.
		const binary = join(cacheDir, "c8run-8.10.1", "c8run");
		const original = readFileSync(binary, "utf8");
		writeFileSync(
			binary,
			`#!/bin/sh\nprintf '${child.pid}' > connectors-hr.process\nexit 7\n`,
		);
		try {
			const result = await cluster("start", "8.10.1", "--physical-tenants=hr");
			assert.equal(result.status, 7);
			assert.match(
				readFileSync(join(cacheDir, "cluster.pids"), "utf8"),
				new RegExp(String(child.pid)),
			);
		} finally {
			writeFileSync(binary, original);
			rmSync(pidfile, { force: true });
			rmSync(join(cacheDir, "cluster.pids"), { force: true });
			child.kill();
			await new Promise<void>((resolveExit) =>
				child.once("exit", () => resolveExit()),
			);
		}
	});

	test("a startup failure with no survivors leaves no process record behind", async () => {
		rmSync(join(cacheDir, "cluster.pids"), { force: true });
		const result = await cluster("start", "8.10.1", "--physical-tenants=hr");
		assert.equal(result.status, 7);
		assert.equal(existsSync(join(cacheDir, "cluster.pids")), false);
	});

	test("dry-run never launches c8run or consumes password input", async () => {
		for (const args of [
			["tenants", "add", "hr", "--password-stdin"],
			["secrets", "--tenant=hr", "set", "KEY", "--stdin"],
			["start", "--physical-tenants=hr"],
		]) {
			const result = await cluster(...args, "--dry-run");
			assert.equal(result.status, 0, result.stderr);
			assert.doesNotMatch(result.stdout + result.stderr, /VERSION:/);
			assert.match(result.stdout, /"dryRun":\s*true/);
		}
	});

	test("dry-run reports the locally selected version without downloading", async () => {
		const implicit = await cluster("tenants", "list", "--dry-run");
		assert.match(implicit.stdout, /"version":"8\.11\.0"/);
		const pinned = await cluster(
			"secrets",
			"--c8-version",
			"8.10.1",
			"list",
			"--dry-run",
		);
		assert.match(pinned.stdout, /"version":"8\.10\.1"/);
	});

	test("start dry-run reports the locally resolved alias, not the alias name", async () => {
		const mapping = join(cacheDir, "alias-stable.resolved");
		writeFileSync(mapping, "8.10.1");
		try {
			const result = await cluster("start", "--dry-run");
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /"version":"8\.10\.1"/);
			assert.match(result.stdout, /"requestedVersion":"stable"/);
			assert.doesNotMatch(result.stdout + result.stderr, /VERSION:/);
		} finally {
			rmSync(mapping, { force: true });
		}
	});

	test("help and shell completion advertise physical tenants", async () => {
		const help = await c8WithEnv(
			{ C8CTL_OUTPUT_MODE: "text" },
			"help",
			"cluster",
		);
		assert.match(help.stdout, /cluster physical-tenants/);
		assert.match(help.stdout, /^ {2}physical-tenants\s+Manage/m);
		assert.match(help.stdout, /--physical-tenant /);
		assert.doesNotMatch(help.stdout, /cluster tenants /);
		assert.doesNotMatch(help.stdout, /secrets --tenant /);
		for (const shell of ["bash", "zsh", "fish"]) {
			const completion = await c8WithEnv({}, "completion", shell);
			assert.match(completion.stdout, /physical-tenants/);
		}
	});
});
