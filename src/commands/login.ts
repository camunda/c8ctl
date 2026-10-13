/**
 * `login` / `logout` — interactive sign-in for OIDC profiles.
 *
 * Implements the native-app flow from RFC 8252: authorization code + PKCE
 * (RFC 7636) with a one-shot HTTP server on the loopback interface as the
 * redirect target. Tokens are stored by `src/core/oidc.ts`, and
 * `createClient` attaches (and refreshes) them on every request.
 */

import { createServer, type Server } from "node:http";
import {
	buildAuthorizationUrl,
	createPkcePair,
	createState,
	decodeJwtClaims,
	deleteOidcTokens,
	discoverOidc,
	exchangeAuthorizationCode,
	getLoginSettings,
	type OidcSettings,
	resolveClusterConfig,
	resolveLogin,
	revokeTokens,
	saveOidcTokens,
} from "../core/index.ts";
import { defineCommand } from "../framework/index.ts";
import { openUrl } from "../utils/index.ts";

/**
 * c8ctl owns its redirect: always http://127.0.0.1:<port>/callback. The IP
 * literal rather than "localhost" follows RFC 8252 §8.3; the port is
 * random unless --port is given (IdPs must allow any loopback port, §7.3).
 */
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
const LOGIN_TIMEOUT_MS = 5 * 60_000;

const DONE_PAGE = (heading: string, detail: string) =>
	`<!doctype html><html><head><meta charset="utf-8"><title>c8ctl</title></head>` +
	`<body style="font-family:system-ui,sans-serif;margin:4rem auto;max-width:32rem;text-align:center">` +
	`<h1>${heading}</h1><p>${detail}</p></body></html>`;

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			] ?? c,
	);
}

function requireOidcSettings(profile: string | undefined): OidcSettings {
	const config = resolveClusterConfig(profile);
	const settings = getLoginSettings(config);
	if (!settings) {
		throw new Error(
			"The selected profile authenticates with client credentials or " +
				"Basic auth, so interactive login does not apply. Use a profile " +
				"with just a base URL: c8ctl add profile <name> --baseUrl <url>",
		);
	}
	return settings;
}

function parsePort(value: string | undefined): number {
	if (value === undefined) return 0;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`Invalid --port: ${value}`);
	}
	return port;
}

function listenOnLoopback(server: Server, port: number): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, CALLBACK_HOST, () => {
			server.off("error", reject);
			const address = server.address();
			if (address && typeof address === "object") {
				resolve(address.port);
			} else {
				reject(new Error("Could not determine the loopback port"));
			}
		});
	});
}

/**
 * Resolve with the authorization code from the first valid redirect to
 * `callbackPath`. Rejects on an IdP error, a state mismatch, or timeout.
 */
function waitForAuthorizationCode(
	server: Server,
	callbackPath: string,
	expectedState: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("Timed out waiting for the browser sign-in")),
			LOGIN_TIMEOUT_MS,
		);
		const finish = (fn: () => void) => {
			clearTimeout(timer);
			fn();
		};

		server.on("request", (req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (url.pathname !== callbackPath) {
				res.writeHead(404).end();
				return;
			}
			const params = url.searchParams;
			const respond = (status: number, heading: string, detail: string) => {
				res
					.writeHead(status, { "Content-Type": "text/html; charset=utf-8" })
					.end(DONE_PAGE(heading, escapeHtml(detail)));
			};

			if (params.get("state") !== expectedState) {
				respond(400, "Sign-in failed", "Invalid state. Please retry.");
				finish(() =>
					reject(new Error("Login callback had an invalid state parameter")),
				);
				return;
			}
			const error = params.get("error");
			if (error) {
				const description = params.get("error_description");
				const detail = description ? `${error}: ${description}` : error;
				respond(400, "Sign-in failed", detail);
				finish(() => reject(new Error(`Sign-in was rejected (${detail})`)));
				return;
			}
			const code = params.get("code");
			if (!code) {
				respond(400, "Sign-in failed", "No authorization code received.");
				finish(() => reject(new Error("Login callback had no code")));
				return;
			}
			respond(
				200,
				"Signed in to c8ctl",
				"You can close this tab and return to the terminal.",
			);
			finish(() => resolve(code));
		});
	});
}

function describeUser(tokens: {
	idToken?: string;
	accessToken: string;
}): string | undefined {
	const claims =
		decodeJwtClaims(tokens.idToken) ?? decodeJwtClaims(tokens.accessToken);
	const name =
		claims?.preferred_username ?? claims?.email ?? claims?.name ?? claims?.sub;
	return typeof name === "string" ? name : undefined;
}

export const loginCommand = defineCommand("login", "", async (ctx, flags) => {
	const profileSettings = requireOidcSettings(ctx.profile);
	const settings = {
		...profileSettings,
		scope: flags.scope ?? profileSettings.scope,
	};
	const port = parsePort(flags.port);

	const login = await resolveLogin(settings);
	if (login.source !== "profile") {
		ctx.logger.info(
			`Discovered identity provider: ${login.issuer} (client ${login.clientId}, scopes "${login.scope}")`,
		);
	}
	const endpoints = await discoverOidc(login.issuer);
	const { verifier, challenge } = createPkcePair();
	const state = createState();

	const server = createServer();
	try {
		const boundPort = await listenOnLoopback(server, port);
		const redirectUri = `http://${CALLBACK_HOST}:${boundPort}${CALLBACK_PATH}`;
		const authUrl = buildAuthorizationUrl({
			endpoints,
			login,
			redirectUri,
			challenge,
			state,
		});
		const codePromise = waitForAuthorizationCode(server, CALLBACK_PATH, state);

		if (flags["no-browser"]) {
			ctx.logger.info("Open this URL in a browser on this machine to sign in:");
		} else {
			ctx.logger.info(
				"Opening the browser to sign in. If it does not open, visit:",
			);
			openUrl(authUrl);
		}
		ctx.logger.info(`  ${authUrl}`);

		const code = await codePromise;
		const tokens = await exchangeAuthorizationCode({
			endpoints,
			login,
			code,
			verifier,
			redirectUri,
		});
		saveOidcTokens(settings, tokens);

		const user = describeUser(tokens);
		const expiry = tokens.expiresAt
			? `, token valid until ${new Date(tokens.expiresAt).toLocaleTimeString()}`
			: "";
		const refresh = tokens.refreshToken ? ", auto-refresh enabled" : "";
		return {
			kind: "success",
			message: `Logged in to ${settings.baseUrl}${user ? ` as ${user}` : ""}${expiry}${refresh}`,
		};
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

export const logoutCommand = defineCommand("logout", "", async (ctx) => {
	const settings = requireOidcSettings(ctx.profile);
	const tokens = deleteOidcTokens(settings);
	if (!tokens) {
		return {
			kind: "success",
			message: `Not logged in to ${settings.baseUrl}`,
		};
	}
	const revoked = await revokeTokens(settings, tokens);
	return {
		kind: "success",
		message: `Logged out of ${settings.baseUrl}${revoked ? " (tokens revoked)" : ""}`,
	};
});
