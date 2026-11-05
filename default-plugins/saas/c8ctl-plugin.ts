/**
 * c8ctl-plugin-saas (prototype)
 *
 * Log in to Camunda SaaS as a person (Auth0 device code) and use that login
 * for read-only calls.
 *
 * Usage:
 *   c8ctl saas login|logout|status|token [--stage prod|int|dev]
 */

import { spawn } from "node:child_process";
import type {} from "../../src/core/runtime.ts";
import type {
	PluginCommands,
	PluginCtx,
	PluginMetadata,
} from "../../src/framework/plugins/plugin-loader.ts";
import {
	type AuthCfg,
	getAccessToken,
	pollForToken,
	requestDeviceCode,
	toStored,
} from "./auth.ts";
import {
	clientIdFor,
	parseStage,
	STAGES,
	type Stage,
	type StageConfig,
} from "./stages.ts";
import { deleteToken, readToken, tokenDir, writeToken } from "./tokens.ts";

if (!globalThis.c8ctl) throw new Error("c8ctl runtime not initialised");
const c8ctl = globalThis.c8ctl;

export interface SaasCmdCtx {
	stage: Stage;
	cfg: StageConfig;
	dir: string;
	flags: Record<string, unknown>;
	ctx: PluginCtx | undefined;
}

export function authCfg(stage: Stage): AuthCfg {
	const { auth0Domain, audience } = STAGES[stage];
	return { auth0Domain, audience, clientId: clientIdFor(stage) };
}

const logger = () => c8ctl.getLogger();
const nowSec = () => Math.floor(Date.now() / 1000);

function openBrowser(url: string): void {
	const [cmd, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", '""', url]]
				: ["xdg-open", [url]];
	try {
		const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
		child.on("error", () => {}); // the URL is printed anyway
		child.unref();
	} catch {
		// ignore: the URL is printed anyway
	}
}

async function login(c: SaasCmdCtx): Promise<void> {
	const cfg = authCfg(c.stage);
	const dc = await requestDeviceCode(cfg);
	const log = logger();
	log.info(`Open ${dc.verification_uri_complete}`, { stream: "stderr" });
	log.info(`Code: ${dc.user_code}`, { stream: "stderr" });
	if (c.flags["no-browser"] !== true) openBrowser(dc.verification_uri_complete);
	const resp = await pollForToken(cfg, dc);
	const token = toStored(resp, nowSec());
	writeToken(c.dir, c.stage, token);
	if (log.mode === "json") {
		log.json({
			stage: c.stage,
			sub: token.sub,
			email: token.email,
			expires_at: token.expires_at,
		});
	} else {
		log.success(
			`Logged in to SaaS (${c.stage}) as ${token.email ?? token.sub}`,
		);
	}
}

async function logout(c: SaasCmdCtx): Promise<void> {
	const removed = deleteToken(c.dir, c.stage);
	logger().info(
		removed
			? `Logged out of SaaS (${c.stage})`
			: `Not logged in to SaaS (${c.stage})`,
	);
}

async function status(c: SaasCmdCtx): Promise<void> {
	const rows = (["prod", "int", "dev"] as const).map((stage) => {
		const t = readToken(c.dir, stage);
		return {
			stage,
			loggedIn: Boolean(t),
			user: t ? (t.email ?? t.sub) : "",
			expiresAt: t ? new Date(t.expires_at * 1000).toISOString() : "",
		};
	});
	const log = logger();
	if (log.mode === "json") log.json(rows);
	else log.table(rows);
}

async function token(c: SaasCmdCtx): Promise<void> {
	const { auth0Domain, audience } = STAGES[c.stage];
	// clientId is only needed when a refresh happens; resolve it lazily.
	const cfg: AuthCfg = {
		auth0Domain,
		audience,
		get clientId() {
			return clientIdFor(c.stage);
		},
	};
	logger().output(await getAccessToken(c.dir, c.stage, cfg));
}

const SUBCOMMANDS: Record<string, (c: SaasCmdCtx) => Promise<void>> = {
	login,
	logout,
	status,
	token,
};

async function saasHandler(
	args: string[] | undefined,
	flags?: Record<string, unknown>,
	ctx?: PluginCtx,
): Promise<void> {
	const sub = args?.[0];
	const run = sub ? SUBCOMMANDS[sub] : undefined;
	if (!run) {
		const lead = sub
			? `Unknown subcommand '${sub}'.`
			: "c8ctl saas requires a subcommand.";
		logger().info(`${lead} Available: ${Object.keys(SUBCOMMANDS).join(", ")}`);
		logger().info("Run 'c8ctl saas --help' for full usage.");
		process.exitCode = 1;
		return;
	}
	try {
		const stage = parseStage(flags?.stage);
		await run({
			stage,
			cfg: STAGES[stage],
			dir: tokenDir(c8ctl.getUserDataDir()),
			flags: flags ?? {},
			ctx,
		});
	} catch (error) {
		logger().error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

// ---------------------------------------------------------------------------
// Plugin API
// ---------------------------------------------------------------------------

export const metadata = {
	name: "saas",
	description: "Log in to Camunda SaaS as a user (prototype)",
	commands: {
		saas: {
			description:
				"Log in to Camunda SaaS and list orgs, clusters, Hub projects",
			subcommands: [
				{ name: "login", description: "Log in with the browser (device code)" },
				{ name: "logout", description: "Forget the login of a stage" },
				{ name: "status", description: "Show login state of all stages" },
				{ name: "token", description: "Print a valid access token" },
			],
			examples: [
				{ command: "c8ctl saas login", description: "Log in to SaaS prod" },
				{
					command: "c8ctl saas login --stage int --no-browser",
					description: "Log in to int, open the URL yourself",
				},
				{ command: "c8ctl saas status", description: "Show login state" },
			],
		},
	},
} as const satisfies PluginMetadata;

export const commands = {
	saas: {
		flags: {
			stage: {
				type: "string",
				description: "SaaS stage: prod (default), int or dev",
			},
			org: {
				type: "string",
				description: "Organisation id (default: first org of your login)",
			},
			"no-browser": {
				type: "boolean",
				description: "Do not open the browser on login",
			},
		},
		handler: saasHandler,
	},
} satisfies PluginCommands;
