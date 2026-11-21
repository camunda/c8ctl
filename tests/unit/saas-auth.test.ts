/**
 * Unit tests for the saas plugin's Auth0 device-code and refresh flow.
 * A fake fetch records requests and replays queued responses.
 */

import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
	type AuthCfg,
	type DeviceCode,
	type FetchFn,
	getAccessToken,
	NotLoggedInError,
	pollForToken,
	requestDeviceCode,
	toStored,
} from "../../default-plugins/saas/auth.ts";
import {
	readToken,
	type StoredToken,
	tokenDir,
	writeToken,
} from "../../default-plugins/saas/tokens.ts";

const cfg: AuthCfg = {
	auth0Domain: "weblogin.cloud.camunda.io",
	audience: "cloud.camunda.io",
	clientId: "cid",
};

const dc: DeviceCode = {
	device_code: "dev-code",
	user_code: "ABCD-EFGH",
	verification_uri_complete: "https://weblogin.cloud.camunda.io/activate?x",
	expires_in: 600,
	interval: 5,
};

type Call = { url: string; body: string };

function fakeFetch(responses: (() => Promise<Response> | Response)[]): {
	fetchFn: FetchFn;
	calls: Call[];
} {
	const calls: Call[] = [];
	const fetchFn: FetchFn = async (input, init) => {
		calls.push({ url: String(input), body: String(init?.body ?? "") });
		const next = responses.shift();
		if (!next) throw new Error("unexpected fetch");
		return next();
	};
	return { fetchFn, calls };
}

const json = (status: number, body: unknown) => () =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

function fakeJwt(payload: Record<string, unknown>): string {
	return `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
}

const NOW = 1_000_000;
const freshDir = () =>
	tokenDir(mkdtempSync(join(tmpdir(), "c8ctl-saas-auth-")));

const stored = (expires_at: number): StoredToken => ({
	access_token: "old-access",
	refresh_token: "old-refresh",
	expires_at,
	sub: "auth0|1",
});

describe("saas auth0 device code", () => {
	test("requestDeviceCode posts client, audience and scope", async () => {
		const { fetchFn, calls } = fakeFetch([json(200, dc)]);
		const result = await requestDeviceCode(cfg, fetchFn);
		assert.deepStrictEqual(result, dc);
		assert.strictEqual(
			calls[0].url,
			"https://weblogin.cloud.camunda.io/oauth/device/code",
		);
		assert.match(calls[0].body, /scope=openid\+email\+offline_access/);
		assert.match(calls[0].body, /audience=cloud\.camunda\.io/);
		assert.match(calls[0].body, /client_id=cid/);
	});

	test("pollForToken waits through pending and slow_down", async () => {
		const sleeps: number[] = [];
		const { fetchFn, calls } = fakeFetch([
			json(400, { error: "authorization_pending" }),
			json(400, { error: "slow_down" }),
			json(200, { access_token: "a", refresh_token: "r", expires_in: 60 }),
		]);
		const result = await pollForToken(cfg, dc, {
			fetchFn,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		assert.strictEqual(result.access_token, "a");
		assert.deepStrictEqual(sleeps, [5000, 10000]);
		assert.match(
			calls[0].body,
			/grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/,
		);
	});

	test("pollForToken fails on expired_token", async () => {
		const { fetchFn } = fakeFetch([json(400, { error: "expired_token" })]);
		await assert.rejects(
			pollForToken(cfg, dc, { fetchFn, sleep: async () => {} }),
			/expired/,
		);
	});

	test("pollForToken fails on access_denied", async () => {
		const { fetchFn } = fakeFetch([json(403, { error: "access_denied" })]);
		await assert.rejects(
			pollForToken(cfg, dc, { fetchFn, sleep: async () => {} }),
			/denied/,
		);
	});
});

describe("saas toStored", () => {
	test("keeps the previous refresh token when Auth0 sends none", () => {
		const t = toStored(
			{ access_token: fakeJwt({ sub: "s" }), expires_in: 300 },
			NOW,
			stored(0),
		);
		assert.strictEqual(t.refresh_token, "old-refresh");
		assert.strictEqual(t.expires_at, NOW + 300);
	});

	test("takes the rotated refresh token and identity from id_token", () => {
		const t = toStored(
			{
				access_token: "opaque",
				refresh_token: "new-refresh",
				id_token: fakeJwt({ sub: "auth0|2", email: "me@example.com" }),
				expires_in: 300,
			},
			NOW,
		);
		assert.strictEqual(t.refresh_token, "new-refresh");
		assert.strictEqual(t.sub, "auth0|2");
		assert.strictEqual(t.email, "me@example.com");
	});

	test("throws without any refresh token", () => {
		assert.throws(() =>
			toStored({ access_token: fakeJwt({}), expires_in: 1 }, NOW),
		);
	});
});

describe("saas getAccessToken", () => {
	test("fresh token makes no request", async () => {
		const dir = freshDir();
		writeToken(dir, "prod", stored(NOW + 3600));
		const { fetchFn, calls } = fakeFetch([]);
		const token = await getAccessToken(dir, "prod", cfg, {
			fetchFn,
			now: () => NOW,
		});
		assert.strictEqual(token, "old-access");
		assert.strictEqual(calls.length, 0);
	});

	test("no token file rejects with the login hint", async () => {
		await assert.rejects(
			getAccessToken(freshDir(), "prod", cfg),
			(error: unknown) =>
				error instanceof NotLoggedInError &&
				/c8ctl saas login --stage prod/.test(error.message),
		);
	});

	test("invalid_grant deletes the token and asks to log in", async () => {
		const dir = freshDir();
		writeToken(dir, "prod", stored(NOW));
		const { fetchFn } = fakeFetch([json(403, { error: "invalid_grant" })]);
		await assert.rejects(
			getAccessToken(dir, "prod", cfg, { fetchFn, now: () => NOW }),
			NotLoggedInError,
		);
		assert.strictEqual(readToken(dir, "prod"), undefined);
	});

	test("concurrent getAccessToken refreshes once", async () => {
		const dir = freshDir();
		writeToken(dir, "prod", stored(NOW + 10));
		const newAccess = fakeJwt({ sub: "auth0|1", n: 2 });
		const { fetchFn, calls } = fakeFetch([
			async () => {
				await new Promise((r) => setTimeout(r, 50));
				return json(200, {
					access_token: newAccess,
					refresh_token: "new-refresh",
					expires_in: 3600,
				})();
			},
		]);
		const deps = { fetchFn, now: () => NOW };
		const results = await Promise.all([
			getAccessToken(dir, "prod", cfg, deps),
			getAccessToken(dir, "prod", cfg, deps),
		]);
		assert.deepStrictEqual(results, [newAccess, newAccess]);
		assert.strictEqual(calls.length, 1);
		assert.match(calls[0].body, /refresh_token=old-refresh/);
		assert.strictEqual(readToken(dir, "prod")?.refresh_token, "new-refresh");
	});
});
