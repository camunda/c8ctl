/**
 * Unit tests for the saas plugin's API helper and org resolution.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { apiGet, resolveOrg } from "../../default-plugins/saas/api.ts";
import {
	type FetchFn,
	NotLoggedInError,
} from "../../default-plugins/saas/auth.ts";
import { ORG_CLAIM } from "../../default-plugins/saas/jwt.ts";

function fakeJwt(payload: Record<string, unknown>): string {
	return `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
}

function respond(status: number, body: string) {
	const headers: Record<string, string>[] = [];
	const fetchFn: FetchFn = async (_input, init) => {
		headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
		return new Response(body, { status });
	};
	return { fetchFn, headers };
}

const URL_ = "https://console.cloud.camunda.io/api/orgs/o1/clusters";

describe("saas apiGet", () => {
	test("sends the bearer token and unwraps data", async () => {
		const { fetchFn, headers } = respond(200, '{"data":[1]}');
		assert.deepStrictEqual(await apiGet(URL_, "t", "prod", fetchFn), [1]);
		assert.strictEqual(headers[0].authorization, "Bearer t");
	});

	test("returns a bare body as is", async () => {
		const { fetchFn } = respond(200, "[2]");
		assert.deepStrictEqual(await apiGet(URL_, "t", "prod", fetchFn), [2]);
	});

	test("401 asks to log in again for the stage", async () => {
		const { fetchFn } = respond(401, "nope");
		await assert.rejects(
			apiGet(URL_, "t", "int", fetchFn),
			(error: unknown) =>
				error instanceof NotLoggedInError &&
				/c8ctl saas login --stage int/.test(error.message),
		);
	});

	test("other errors show status and a short body, never the token", async () => {
		const { fetchFn } = respond(500, "x".repeat(1000));
		await assert.rejects(
			apiGet(URL_, "secret-token", "prod", fetchFn),
			(error: unknown) =>
				error instanceof Error &&
				error.message.includes("500") &&
				error.message.includes("/api/orgs/o1/clusters") &&
				error.message.length < 400 &&
				!error.message.includes("secret-token"),
		);
	});
});

describe("saas resolveOrg", () => {
	const withOrgs = fakeJwt({ [ORG_CLAIM]: [{ id: "o1", roles: [] }] });
	const withoutOrgs = fakeJwt({ sub: "s" });

	test("--org wins", () => {
		assert.strictEqual(resolveOrg("o9", withOrgs), "o9");
	});

	test("falls back to the first org of the token", () => {
		assert.strictEqual(resolveOrg(undefined, withOrgs), "o1");
	});

	test("fails without org flag or claim", () => {
		assert.throws(
			() => resolveOrg(undefined, withoutOrgs),
			/no organisation on this account/,
		);
	});
});
