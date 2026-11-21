/**
 * Unit tests for the saas default plugin's stage table and JWT org helpers.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import {
	decodeJwtPayload,
	defaultOrgId,
	ORG_CLAIM,
	tokenOrgs,
} from "../../default-plugins/saas/jwt.ts";
import {
	clientIdFor,
	parseStage,
	STAGES,
} from "../../default-plugins/saas/stages.ts";

function fakeJwt(payload: Record<string, unknown>): string {
	return `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
}

describe("saas stages", () => {
	test("parseStage defaults to prod", () => {
		assert.strictEqual(parseStage(undefined), "prod");
	});

	test("parseStage accepts a known stage", () => {
		assert.strictEqual(parseStage("int"), "int");
	});

	test("parseStage rejects an unknown stage", () => {
		assert.throws(() => parseStage("foo"), /Use one of: prod, int, dev/);
	});

	test("STAGES hold the hosts from the spec", () => {
		assert.strictEqual(STAGES.prod.auth0Domain, "weblogin.cloud.camunda.io");
		assert.strictEqual(STAGES.prod.audience, "cloud.camunda.io");
		assert.strictEqual(STAGES.dev.hub, "https://hub.dev.ultrawombat.com");
		assert.strictEqual(
			STAGES.int.accounts,
			"https://accounts.cloud.ultrawombat.com",
		);
	});

	test("clientIdFor prefers C8CTL_SAAS_CLIENT_ID", () => {
		assert.strictEqual(
			clientIdFor("prod", { C8CTL_SAAS_CLIENT_ID: "abc" }),
			"abc",
		);
	});

	test("clientIdFor without env or hardcoded id throws", () => {
		assert.throws(() => clientIdFor("prod", {}), /C8CTL_SAAS_CLIENT_ID/);
	});
});

describe("saas jwt helpers", () => {
	test("defaultOrgId is the first org of the claim", () => {
		const token = fakeJwt({
			[ORG_CLAIM]: [
				{ id: "o1", roles: ["owner"] },
				{ id: "o2", roles: [] },
			],
		});
		assert.strictEqual(defaultOrgId(token), "o1");
		assert.deepStrictEqual(tokenOrgs(token), [
			{ id: "o1", roles: ["owner"] },
			{ id: "o2", roles: [] },
		]);
	});

	test("defaultOrgId undefined without claim", () => {
		assert.strictEqual(defaultOrgId(fakeJwt({ sub: "x" })), undefined);
		assert.deepStrictEqual(tokenOrgs(fakeJwt({ [ORG_CLAIM]: "nope" })), []);
	});

	test("tokenOrgs drops entries without a string id", () => {
		const token = fakeJwt({ [ORG_CLAIM]: [{ roles: [] }, { id: "o3" }] });
		assert.deepStrictEqual(tokenOrgs(token), [{ id: "o3", roles: [] }]);
	});

	test("decodeJwtPayload rejects a malformed token", () => {
		assert.throws(() => decodeJwtPayload("not-a-jwt"));
	});
});
