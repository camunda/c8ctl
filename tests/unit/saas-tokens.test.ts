/**
 * Unit tests for the saas plugin's token store and per-stage lock.
 */

import assert from "node:assert";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
	deleteToken,
	needsRefresh,
	readToken,
	type StoredToken,
	tokenDir,
	withLock,
	writeToken,
} from "../../default-plugins/saas/tokens.ts";

const sample: StoredToken = {
	access_token: "a",
	refresh_token: "r",
	expires_at: 1000,
	sub: "auth0|1",
	email: "x@example.com",
};

function freshDir(): string {
	return tokenDir(mkdtempSync(join(tmpdir(), "c8ctl-saas-tokens-")));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("saas token store", () => {
	test("writeToken then readToken round-trips with private modes", () => {
		const dir = freshDir();
		writeToken(dir, "prod", sample);
		assert.deepStrictEqual(readToken(dir, "prod"), sample);
		if (process.platform !== "win32") {
			assert.strictEqual(statSync(join(dir, "prod.json")).mode & 0o777, 0o600);
			assert.strictEqual(statSync(dir).mode & 0o777, 0o700);
		}
	});

	test("readToken returns undefined when no file", () => {
		assert.strictEqual(readToken(freshDir(), "int"), undefined);
	});

	test("readToken returns undefined for corrupt file", () => {
		const dir = freshDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "prod.json"), "{not json");
		assert.strictEqual(readToken(dir, "prod"), undefined);
	});

	test("readToken returns undefined when refresh_token is missing", () => {
		const dir = freshDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "prod.json"),
			JSON.stringify({ access_token: "a" }),
		);
		assert.strictEqual(readToken(dir, "prod"), undefined);
	});

	test("deleteToken reports whether a file was removed", () => {
		const dir = freshDir();
		writeToken(dir, "dev", sample);
		assert.strictEqual(deleteToken(dir, "dev"), true);
		assert.strictEqual(deleteToken(dir, "dev"), false);
	});

	test("needsRefresh when less than 60s are left", () => {
		assert.strictEqual(needsRefresh(sample, 940), false);
		assert.strictEqual(needsRefresh(sample, 942), true);
	});
});

describe("saas token lock", () => {
	test("withLock serialises concurrent callers", async () => {
		const dir = freshDir();
		const events: string[] = [];
		const job = () =>
			withLock(dir, "prod", async () => {
				events.push("start");
				await sleep(50);
				events.push("end");
			});
		await Promise.all([job(), job()]);
		assert.deepStrictEqual(events, ["start", "end", "start", "end"]);
	});

	test("withLock steals a stale lock", async () => {
		const dir = freshDir();
		mkdirSync(dir, { recursive: true });
		const lock = join(dir, "prod.lock");
		writeFileSync(lock, "");
		const old = new Date(Date.now() - 60_000);
		utimesSync(lock, old, old);
		const started = Date.now();
		const result = await withLock(dir, "prod", async () => 42, {
			staleMs: 1000,
		});
		assert.strictEqual(result, 42);
		assert.ok(Date.now() - started < 1000);
	});

	test("withLock releases the lock when fn throws", async () => {
		const dir = freshDir();
		await assert.rejects(
			withLock(dir, "prod", async () => {
				throw new Error("boom");
			}),
			/boom/,
		);
		assert.strictEqual(existsSync(join(dir, "prod.lock")), false);
	});

	test("withLock times out on a fresh foreign lock", async () => {
		const dir = freshDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "prod.lock"), "");
		await assert.rejects(
			withLock(dir, "prod", async () => 1, { timeoutMs: 200, retryMs: 20 }),
			/Timed out waiting for SaaS token lock/,
		);
	});
});

describe("saas lock timing", () => {
	test("auth0 timeout < stale window < lock wait", async () => {
		const { AUTH0_TIMEOUT_MS } = await import(
			"../../default-plugins/saas/auth.ts"
		);
		const { LOCK_DEFAULTS } = await import(
			"../../default-plugins/saas/tokens.ts"
		);
		// A refresh must finish before others may call its lock stale, and a
		// waiter must outlive the stale window of a lock left by a killed process.
		assert.ok(AUTH0_TIMEOUT_MS < LOCK_DEFAULTS.staleMs);
		assert.ok(LOCK_DEFAULTS.staleMs < LOCK_DEFAULTS.timeoutMs);
	});
});
