/**
 * Behavioural tests for the saas default plugin (default-plugins/saas/),
 * driven through the CLI as a subprocess. No network: every case fails or
 * finishes before an HTTP call.
 */

import assert from "node:assert";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { tokenDir, writeToken } from "../../default-plugins/saas/tokens.ts";
import { c8WithOptions } from "../utils/cli.ts";

function dataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "c8ctl-saas-plugin-"));
	writeFileSync(
		join(dir, "session.json"),
		JSON.stringify({ outputMode: "json" }),
	);
	return dir;
}

function saas(dir: string, ...args: string[]) {
	return c8WithOptions(
		{ env: { C8CTL_DATA_DIR: dir, C8CTL_SAAS_CLIENT_ID: undefined } },
		"saas",
		...args,
	);
}

describe("saas plugin", () => {
	test("no subcommand lists the subcommands and exits 1", async () => {
		const r = await saas(dataDir());
		assert.strictEqual(r.status, 1);
		assert.match(r.stdout + r.stderr, /login/);
	});

	test("status without tokens shows all stages logged out", async () => {
		const r = await saas(dataDir(), "status");
		assert.strictEqual(r.status, 0, r.stderr);
		const rows = JSON.parse(r.stdout);
		assert.strictEqual(rows.length, 3);
		assert.ok(rows.every((row: { loggedIn: boolean }) => !row.loggedIn));
	});

	test("token without login exits 1 with the login hint", async () => {
		const r = await saas(dataDir(), "token");
		assert.strictEqual(r.status, 1);
		assert.match(r.stderr, /c8ctl saas login --stage prod/);
	});

	test("unknown stage is rejected", async () => {
		const r = await saas(dataDir(), "login", "--stage", "foo");
		assert.strictEqual(r.status, 1);
		assert.match(r.stdout + r.stderr, /Use one of: prod, int, dev/);
	});

	test("login without a client id asks for C8CTL_SAAS_CLIENT_ID", async () => {
		const r = await saas(dataDir(), "login");
		assert.strictEqual(r.status, 1);
		assert.match(r.stdout + r.stderr, /C8CTL_SAAS_CLIENT_ID/);
	});

	test("logout removes the stored token", async () => {
		const dir = dataDir();
		writeToken(tokenDir(dir), "int", {
			access_token: "a",
			refresh_token: "r",
			expires_at: 1,
			sub: "s",
		});
		const r = await saas(dir, "logout", "--stage", "int");
		assert.strictEqual(r.status, 0, r.stderr);
		assert.strictEqual(existsSync(join(tokenDir(dir), "int.json")), false);
	});
});
