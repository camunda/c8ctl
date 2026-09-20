import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";

const moduleUrl = new URL(
	"../../scripts/agentic/app-token.ts",
	import.meta.url,
);
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey
	.export({ type: "pkcs8", format: "pem" })
	.toString();
const now = Date.parse("2026-09-17T12:00:00Z");
const token = `ghs_${"x".repeat(40)}`;

async function implementation() {
	assert.ok(
		existsSync(moduleUrl),
		"native repository-scoped App token issuer must exist",
	);
	return import("../../scripts/agentic/app-token.ts");
}

describe("agentic App token attenuation", () => {
	it("signs a short-lived JWT and requests only controller permissions for this repository", async () => {
		const { createAppToken, TOKEN_PERMISSIONS } = await implementation();
		const calls: string[] = [];
		const result = await createAppToken({
			repository: "camunda/c8ctl",
			clientId: "Iv1234567890",
			privateKey,
			role: "controller",
			now: () => now,
			fetch: async (input, options) => {
				const url = String(input);
				calls.push(url);
				assert.equal(options?.redirect, "error");
				const auth = new Headers(options?.headers).get("authorization");
				assert.ok(auth);
				assert.ok(auth.startsWith("Bearer "));
				const jwt = auth.slice(7);
				const parts = jwt.split(".");
				assert.equal(parts.length, 3);
				assert.ok(parts[1] && parts[2]);
				assert.ok(
					verify(
						"RSA-SHA256",
						Buffer.from(`${parts[0]}.${parts[1]}`),
						keys.publicKey,
						Buffer.from(parts[2], "base64url"),
					),
				);
				assert.deepEqual(
					JSON.parse(Buffer.from(parts[1], "base64url").toString()),
					{
						iat: now / 1_000 - 60,
						exp: now / 1_000 + 540,
						iss: "Iv1234567890",
					},
				);
				if (url.endsWith("/installation")) {
					assert.equal(options?.method, "GET");
					return Response.json({ id: 123 });
				}
				assert.equal(
					url,
					"https://api.github.com/app/installations/123/access_tokens",
				);
				assert.equal(options?.method, "POST");
				assert.equal(typeof options.body, "string");
				assert.deepEqual(JSON.parse(String(options.body)), {
					repositories: ["c8ctl"],
					permissions: TOKEN_PERMISSIONS.controller,
				});
				return Response.json({
					token,
					permissions: { ...TOKEN_PERMISSIONS.controller, metadata: "read" },
				});
			},
		});
		assert.equal(result, token);
		assert.equal(calls.length, 2);
		assert.equal(TOKEN_PERMISSIONS.controller.variables, "read");
		assert.equal("workflows" in TOKEN_PERMISSIONS.controller, false);
		assert.equal(TOKEN_PERMISSIONS.maintenance.workflows, "write");
		assert.equal(TOKEN_PERMISSIONS.maintenance.variables, "read");
		assert.equal("administration" in TOKEN_PERMISSIONS.maintenance, false);
	});

	it("rejects invalid configuration before sending private credentials", async () => {
		const { createAppToken } = await implementation();
		for (const repository of [
			"../c8ctl",
			"camunda/c8ctl/../../other",
			"camunda/c8ctl\n",
		]) {
			await assert.rejects(
				createAppToken({
					repository,
					clientId: "Iv1234567890",
					privateKey,
					role: "controller",
					fetch: async () => assert.fail("must not send credentials"),
				}),
				/repository/i,
			);
		}
	});

	it("rejects overprivileged responses and never echoes upstream secret-bearing errors", async () => {
		const { createAppToken, TOKEN_PERMISSIONS } = await implementation();
		const options = {
			repository: "camunda/c8ctl",
			clientId: "Iv1234567890",
			privateKey,
			role: "controller" as const,
		};
		await assert.rejects(
			createAppToken({
				...options,
				fetch: async (url, init) =>
					init?.method === "DELETE"
						? new Response(null, { status: 204 })
						: String(url).endsWith("/installation")
							? Response.json({ id: 123 })
							: Response.json({
									token,
									permissions: {
										...TOKEN_PERMISSIONS.controller,
										workflows: "write",
									},
								}),
			}),
			/unexpected permission/,
		);
		await assert.rejects(
			createAppToken({
				...options,
				fetch: async () => new Response(`private ${token}`, { status: 403 }),
			}),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /HTTP 403/);
				assert.ok(!error.message.includes(token));
				return true;
			},
		);
	});

	it("revokes the token without following redirects or accepting an unsuccessful response", async () => {
		const { revokeAppToken } = await implementation();
		await revokeAppToken({
			token,
			fetch: async (url, options) => {
				assert.equal(url, "https://api.github.com/installation/token");
				assert.equal(options?.method, "DELETE");
				assert.equal(options?.redirect, "error");
				assert.equal(
					new Headers(options?.headers).get("authorization"),
					`Bearer ${token}`,
				);
				return new Response(null, { status: 204 });
			},
		});
		await assert.rejects(
			revokeAppToken({
				token,
				fetch: async () => new Response(null, { status: 403 }),
			}),
			/HTTP 403/,
		);
	});
});
