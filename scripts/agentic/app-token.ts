import { sign } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// actions/create-github-app-token#231: its generated inputs omit Variables.
export const TOKEN_PERMISSIONS = {
	controller: {
		actions: "write",
		administration: "read",
		checks: "read",
		contents: "write",
		issues: "write",
		pull_requests: "write",
		statuses: "write",
		variables: "read",
	},
	maintenance: {
		actions: "read",
		contents: "write",
		pull_requests: "write",
		variables: "read",
		workflows: "write",
	},
} as const;

interface TokenOptions {
	repository: string;
	clientId: string;
	privateKey: string;
	role: keyof typeof TOKEN_PERMISSIONS;
	now?: () => number;
	fetch?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validToken(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_]{20,255}$/.test(value)) {
		throw new Error("GitHub returned an invalid installation token");
	}
	return value;
}

async function request({
	method,
	path,
	token,
	body,
	fetch: send,
}: {
	method: "GET" | "POST" | "DELETE";
	path: string;
	token: string;
	body?: unknown;
	fetch: typeof fetch;
}): Promise<unknown> {
	const response = await send(`https://api.github.com${path}`, {
		method,
		redirect: "error",
		signal: AbortSignal.timeout(30_000),
		headers: {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			"x-github-api-version": "2022-11-28",
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	if (!response.ok || (method === "DELETE" && response.status !== 204)) {
		throw new Error(`GitHub App token request failed: HTTP ${response.status}`);
	}
	if (method === "DELETE") return null;
	try {
		return await response.json();
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error("GitHub App token endpoint returned malformed JSON");
		}
		throw error;
	}
}

export async function revokeAppToken({
	token,
	fetch: send = fetch,
}: {
	token: string;
	fetch?: typeof fetch;
}): Promise<void> {
	await request({
		method: "DELETE",
		path: "/installation/token",
		token: validToken(token),
		fetch: send,
	});
}

export async function createAppToken({
	repository,
	clientId,
	privateKey,
	role,
	now = Date.now,
	fetch: send = fetch,
}: TokenOptions): Promise<string> {
	if (
		!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(
			repository,
		)
	) {
		throw new Error("Invalid repository for App token");
	}
	if (!/^[A-Za-z0-9]{1,128}$/.test(clientId) || !privateKey.trim()) {
		throw new Error("Set C8CTL_APP_CLIENT_ID and C8CTL_APP_PRIVATE_KEY");
	}
	const timestamp = Math.floor(now() / 1_000);
	const header = Buffer.from(
		JSON.stringify({ alg: "RS256", typ: "JWT" }),
	).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({
			iat: timestamp - 60,
			exp: timestamp + 540,
			iss: clientId,
		}),
	).toString("base64url");
	const unsigned = `${header}.${payload}`;
	const jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
	const installation = await request({
		method: "GET",
		path: `/repos/${repository}/installation`,
		token: jwt,
		fetch: send,
	});
	if (
		!isRecord(installation) ||
		!Number.isSafeInteger(installation.id) ||
		Number(installation.id) < 1
	) {
		throw new Error("GitHub returned an invalid repository installation");
	}
	const permissions = TOKEN_PERMISSIONS[role];
	const result = await request({
		method: "POST",
		path: `/app/installations/${installation.id}/access_tokens`,
		token: jwt,
		body: { repositories: [repository.split("/")[1]], permissions },
		fetch: send,
	});
	if (!isRecord(result))
		throw new Error("GitHub returned an invalid installation token response");
	const token = validToken(result.token);
	const granted = result.permissions;
	const expected: Record<string, string> = { ...permissions, metadata: "read" };
	if (
		!isRecord(granted) ||
		Object.entries(permissions).some(
			([key, value]) => granted[key] !== value,
		) ||
		Object.entries(granted).some(([key, value]) => expected[key] !== value)
	) {
		await revokeAppToken({ token, fetch: send });
		throw new Error(
			"GitHub returned an unexpected permission scope; token revoked",
		);
	}
	return token;
}

async function main(): Promise<void> {
	if (
		process.env.GITHUB_ACTIONS !== "true" ||
		process.env.GITHUB_API_URL !== "https://api.github.com"
	) {
		throw new Error(
			"App token commands run only in GitHub Actions on github.com",
		);
	}
	if (process.argv[2] === "revoke") {
		await revokeAppToken({ token: process.env.GH_TOKEN ?? "" });
		return;
	}
	const role = process.argv[3];
	const output = process.env.GITHUB_OUTPUT;
	if (
		process.argv[2] !== "create" ||
		(role !== "controller" && role !== "maintenance") ||
		!output
	) {
		throw new Error(
			"Usage: app-token.ts create controller|maintenance, or revoke",
		);
	}
	const token = await createAppToken({
		repository: process.env.GITHUB_REPOSITORY ?? "",
		clientId: process.env.C8CTL_APP_CLIENT_ID ?? "",
		privateKey: process.env.C8CTL_APP_PRIVATE_KEY ?? "",
		role,
	});
	console.log(`::add-mask::${token}`);
	try {
		appendFileSync(output, `token=${token}\n`, { mode: 0o600 });
	} catch (error) {
		await revokeAppToken({ token });
		throw error;
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((error: unknown) => {
		console.error(
			error instanceof Error ? error.message : "App token operation failed",
		);
		process.exitCode = 1;
	});
}
