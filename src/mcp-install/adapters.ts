/**
 * MCP client adapters and config-merge helpers (#293).
 *
 * `c8ctl mcp install <client>` writes a `c8ctl mcp-proxy` server entry into
 * the named client's MCP config file so the client can launch the proxy
 * with the active profile's credentials. The defect class this kills is
 * the docs-driven hand-edit: the JSON top-level key name varies per
 * client (`mcpServers` vs `servers`) and a typo silently disables the
 * server. Adapters own the key name; a class-scoped test guarantees
 * every adapter declares one.
 *
 * Adapters are intentionally tiny — one per client — so adding a new
 * client (Zed, Windsurf, ...) is a single object literal plus a fixture
 * row in the adapter contract test.
 */

import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { isRecord } from "../logger.ts";

/** Server entry shape that c8ctl writes into a client's MCP config. */
export interface McpServerEntry {
	command: string;
	args: string[];
	env?: Record<string, string>;
	/** VS Code's MCP schema requires a `type` field; other clients omit it. */
	type?: "stdio";
}

/** Inputs an adapter needs to build a c8ctl-flavoured server entry. */
export interface BuildEntryInputs {
	/** Resolved cluster credentials for the active or named profile. */
	profile: {
		baseUrl: string;
		clientId?: string;
		clientSecret?: string;
		audience?: string;
		oAuthUrl?: string;
		username?: string;
		password?: string;
	};
	/** Profile name to forward to `c8ctl mcp-proxy --profile <name>`. */
	profileName: string;
}

/** Per-client adapter. One file change == one new client. */
export interface McpClientAdapter {
	/** Stable lowercase id used as the CLI argument and in `mcp list` output. */
	id: string;
	/** Human-friendly name shown in confirmation messages and `mcp list`. */
	displayName: string;
	/**
	 * Resolve the absolute path to this client's MCP config file.
	 *
	 * Pure: depends only on the supplied env (`HOME`, `APPDATA`, platform)
	 * so tests can pin a temp directory by passing a mocked env without
	 * touching the real filesystem.
	 */
	configPath(env?: AdapterEnv): string;
	/**
	 * Top-level JSON key under which MCP server entries live.
	 * Claude / Cursor: `mcpServers`. VS Code: `servers`.
	 *
	 * Locked by `tests/unit/mcp-install-adapters.test.ts` so a typo
	 * surfaces as a test failure, not a silent user-facing breakage.
	 */
	serversKey: string;
	/** Build the server entry that points at `c8ctl mcp-proxy`. */
	buildEntry(inputs: BuildEntryInputs): McpServerEntry;
}

/**
 * Subset of `process.env` that adapters consult. Tests pass a frozen
 * record so per-OS path resolution is deterministic regardless of the
 * runner's environment.
 */
export interface AdapterEnv {
	HOME?: string;
	APPDATA?: string;
	XDG_CONFIG_HOME?: string;
	platform: NodeJS.Platform;
}

function defaultEnv(): AdapterEnv {
	return {
		HOME: process.env.HOME ?? homedir(),
		APPDATA: process.env.APPDATA,
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		platform: osPlatform(),
	};
}

/**
 * Build the env block for `c8ctl mcp-proxy`.
 *
 * Embeds the active profile's credentials so the spawned proxy runs
 * with the correct authentication regardless of the MCP client's own
 * environment. Only defined fields are included — undefined values
 * never appear as the literal string "undefined" in the written JSON.
 */
export function buildProxyEnv(
	profile: BuildEntryInputs["profile"],
): Record<string, string> {
	const env: Record<string, string> = {
		CAMUNDA_BASE_URL: profile.baseUrl,
	};
	if (profile.clientId) env.CAMUNDA_CLIENT_ID = profile.clientId;
	if (profile.clientSecret) env.CAMUNDA_CLIENT_SECRET = profile.clientSecret;
	if (profile.oAuthUrl) env.CAMUNDA_OAUTH_URL = profile.oAuthUrl;
	if (profile.audience) env.CAMUNDA_TOKEN_AUDIENCE = profile.audience;
	// Use CAMUNDA_USERNAME / CAMUNDA_PASSWORD (not CAMUNDA_BASIC_AUTH_*)
	// to match the env vars resolveClusterConfig actually reads in src/config.ts.
	if (profile.username) env.CAMUNDA_USERNAME = profile.username;
	if (profile.password) env.CAMUNDA_PASSWORD = profile.password;
	return env;
}

/**
 * Common entry shape used by Claude Desktop and Cursor: spawn the c8ctl
 * MCP proxy with the named profile via `npx`. Forwarding `--profile`
 * makes the entry self-describing — re-running `mcp install` for a
 * different profile produces a different alias, not a silent overwrite.
 */
function buildNpxProxyEntry(inputs: BuildEntryInputs): McpServerEntry {
	return {
		command: "npx",
		args: ["-y", "@camunda8/cli", "mcp-proxy", "--profile", inputs.profileName],
		env: buildProxyEnv(inputs.profile),
	};
}

const claudeDesktopAdapter: McpClientAdapter = {
	id: "claude-desktop",
	displayName: "Claude Desktop",
	serversKey: "mcpServers",
	configPath(env = defaultEnv()): string {
		// macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
		// Windows: `%APPDATA%/Claude/claude_desktop_config.json`
		// Linux: `~/.config/Claude/claude_desktop_config.json` (Claude Desktop is
		// not officially distributed on Linux but the config layout is consistent
		// when run via Wine/Bottles; XDG_CONFIG_HOME is honoured for parity with
		// other Linux apps).
		if (env.platform === "darwin") {
			return join(
				home(env),
				"Library",
				"Application Support",
				"Claude",
				"claude_desktop_config.json",
			);
		}
		if (env.platform === "win32") {
			const appdata = env.APPDATA ?? join(home(env), "AppData", "Roaming");
			return join(appdata, "Claude", "claude_desktop_config.json");
		}
		const xdg = env.XDG_CONFIG_HOME ?? join(home(env), ".config");
		return join(xdg, "Claude", "claude_desktop_config.json");
	},
	buildEntry: buildNpxProxyEntry,
};

const cursorAdapter: McpClientAdapter = {
	id: "cursor",
	displayName: "Cursor",
	serversKey: "mcpServers",
	configPath(env = defaultEnv()): string {
		// Cursor: `~/.cursor/mcp.json` on every platform.
		return join(home(env), ".cursor", "mcp.json");
	},
	buildEntry: buildNpxProxyEntry,
};

const vscodeAdapter: McpClientAdapter = {
	id: "vscode",
	displayName: "VS Code",
	// VS Code's MCP user config uses `servers` (NOT `mcpServers`) — this is
	// the exact docs defect that #293 originated from. Locked by the
	// adapter contract test.
	serversKey: "servers",
	configPath(env = defaultEnv()): string {
		// macOS: `~/Library/Application Support/Code/User/mcp.json`
		// Windows: `%APPDATA%/Code/User/mcp.json`
		// Linux: `~/.config/Code/User/mcp.json`
		if (env.platform === "darwin") {
			return join(
				home(env),
				"Library",
				"Application Support",
				"Code",
				"User",
				"mcp.json",
			);
		}
		if (env.platform === "win32") {
			const appdata = env.APPDATA ?? join(home(env), "AppData", "Roaming");
			return join(appdata, "Code", "User", "mcp.json");
		}
		const xdg = env.XDG_CONFIG_HOME ?? join(home(env), ".config");
		return join(xdg, "Code", "User", "mcp.json");
	},
	buildEntry(inputs: BuildEntryInputs): McpServerEntry {
		return {
			type: "stdio",
			command: "npx",
			args: [
				"-y",
				"@camunda8/cli",
				"mcp-proxy",
				"--profile",
				inputs.profileName,
			],
			env: buildProxyEnv(inputs.profile),
		};
	},
};

/**
 * Registry of every supported MCP client. Adding a new adapter here
 * automatically wires it into install / uninstall / list and into the
 * adapter contract test (`tests/unit/mcp-install-adapters.test.ts`).
 */
export const MCP_CLIENT_ADAPTERS: ReadonlyMap<string, McpClientAdapter> =
	new Map([
		[claudeDesktopAdapter.id, claudeDesktopAdapter],
		[cursorAdapter.id, cursorAdapter],
		[vscodeAdapter.id, vscodeAdapter],
	]);

/** Helper: list of supported client IDs in stable, documented order. */
export function listSupportedClients(): readonly string[] {
	return Array.from(MCP_CLIENT_ADAPTERS.keys());
}

/** Look up an adapter by id; throws with a helpful message on miss. */
export function getAdapter(id: string): McpClientAdapter {
	const adapter = MCP_CLIENT_ADAPTERS.get(id);
	if (!adapter) {
		const supported = listSupportedClients().join(", ");
		throw new Error(
			`Unknown MCP client: '${id}'. Supported clients: ${supported}.`,
		);
	}
	return adapter;
}

function home(env: AdapterEnv): string {
	if (env.HOME && env.HOME.length > 0) return env.HOME;
	throw new Error(
		"Cannot resolve MCP client config path: HOME is not set in the environment.",
	);
}

// ─── Config merge helpers ────────────────────────────────────────────────────

/**
 * Result of merging an MCP server entry into an existing client config.
 * Returned as a plain object so callers can stringify, write, or render
 * it without further mutation. `existed` distinguishes "added new" from
 * "overwrote prior alias" so install can warn on the latter.
 */
export interface MergeResult {
	merged: Record<string, unknown>;
	existed: boolean;
}

/**
 * Merge a server entry into a parsed client-config object.
 *
 * Contract:
 * - Preserve every top-level key that is not the adapter's `serversKey`
 *   (e.g. Claude's `preferences`).
 * - Preserve every existing entry under `serversKey` other than `alias`.
 * - Replace (not deep-merge) the entry at `alias` so the user can
 *   re-run `mcp install` to refresh credentials.
 *
 * Pure — does not touch the filesystem.
 */
export function mergeMcpConfig(
	existing: unknown,
	serversKey: string,
	alias: string,
	entry: McpServerEntry,
): MergeResult {
	const base: Record<string, unknown> = isRecord(existing) ? existing : {};
	const priorServers = isRecord(base[serversKey]) ? base[serversKey] : {};
	const existed = Object.hasOwn(priorServers, alias);
	const nextServers = { ...priorServers, [alias]: entry };
	return {
		merged: { ...base, [serversKey]: nextServers },
		existed,
	};
}

/**
 * Remove the entry at `alias` from a client config. Returns the new
 * config plus whether the alias was actually present (`existed`). When
 * removing the last entry, the `serversKey` map is left as an empty
 * object rather than deleted, so a downstream `mcp install` always
 * finds a place to write.
 */
export function unmergeMcpConfig(
	existing: unknown,
	serversKey: string,
	alias: string,
): MergeResult {
	const base: Record<string, unknown> = isRecord(existing) ? existing : {};
	const priorServers = isRecord(base[serversKey]) ? base[serversKey] : {};
	const existed = Object.hasOwn(priorServers, alias);
	if (!existed) {
		return { merged: base, existed: false };
	}
	const nextServers: Record<string, unknown> = { ...priorServers };
	delete nextServers[alias];
	return {
		merged: { ...base, [serversKey]: nextServers },
		existed: true,
	};
}
