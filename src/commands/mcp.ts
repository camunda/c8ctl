/**
 * `c8ctl mcp install|uninstall|list <client>` (#293).
 *
 * Configures third-party MCP clients (Claude Desktop, Cursor, VS Code)
 * to launch `c8ctl mcp-proxy` with the active profile's credentials.
 *
 * Boundary: this verb is the *configurator*. The `mcp-proxy` verb is
 * the runtime it points clients at. They are intentionally separate
 * commands so users can re-run `mcp install` without restarting any
 * proxy process.
 */

import { existsSync } from "node:fs";
import { defineCommand } from "../command-framework.ts";
import { getAllProfiles, getProfile, resolveClusterConfig } from "../config.ts";
import {
	getAdapter,
	listSupportedClients,
	type McpClientAdapter,
	type McpServerEntry,
	mergeMcpConfig,
	unmergeMcpConfig,
} from "../mcp-install/adapters.ts";
import { readJsonFileOrNull, writeJsonAtomic } from "../mcp-install/fs.ts";
import { c8ctl } from "../runtime.ts";

/**
 * Default alias for an installed MCP entry. Falls back to the literal
 * "camunda" when no profile is active so the entry still has a name.
 */
function defaultAlias(profileName: string | undefined): string {
	return profileName && profileName.length > 0 ? profileName : "camunda";
}

/**
 * Resolve the profile that the installed MCP entry will reference.
 * Throws when an explicit `--profile` names an unknown profile so the
 * defect class "wrote a working entry pointing at a profile that
 * doesn't exist" cannot occur.
 */
function resolveProfileName(profileFlag: string | undefined): string {
	if (profileFlag) {
		if (!getProfile(profileFlag)) {
			throw new Error(
				`Profile '${profileFlag}' not found. Run 'c8ctl list profile' to see available profiles.`,
			);
		}
		return profileFlag;
	}
	if (c8ctl.activeProfile) return c8ctl.activeProfile;
	// Fall back to the first defined profile rather than emitting an
	// entry with no `--profile` arg — that would silently reuse env vars
	// at proxy-spawn time, breaking the "what you installed is what runs"
	// contract.
	const profiles = getAllProfiles();
	const first = profiles[0];
	if (first) return first.name;
	throw new Error(
		"No profile available. Create one with 'c8ctl add profile <name>' before running 'c8ctl mcp install'.",
	);
}

/**
 * `c8ctl mcp install <client> [--profile <name>] [--alias <name>]`
 */
export const mcpInstallCommand = defineCommand(
	"mcp",
	"install",
	async (ctx, flags) => {
		const { logger } = ctx;
		const clientId = ctx.positionals[0];
		if (!clientId) {
			throw new Error(
				`Missing MCP client name. Supported clients: ${listSupportedClients().join(", ")}.`,
			);
		}
		const adapter = getAdapter(clientId);
		const profileName = resolveProfileName(flags.profile);
		const alias =
			flags.alias && flags.alias.length > 0
				? flags.alias
				: defaultAlias(profileName);
		const profile = resolveClusterConfig(profileName);
		const entry: McpServerEntry = adapter.buildEntry({
			profile,
			profileName,
		});
		const configPath = adapter.configPath();
		const existing = readJsonFileOrNull(configPath);
		const { merged, existed } = mergeMcpConfig(
			existing,
			adapter.serversKey,
			alias,
			entry,
		);

		if (c8ctl.dryRun) {
			return {
				kind: "dryRun",
				info: {
					dryRun: true,
					command: `mcp install ${clientId}`,
					action: "write-mcp-config",
					client: clientId,
					configPath,
					alias,
					profile: profileName,
					wouldOverwrite: existed,
					content: merged,
				},
			};
		}

		writeJsonAtomic(configPath, merged);
		const verb = existed ? "Updated" : "Installed";
		const restartHint = restartHintFor(adapter);
		logger.info(
			`${verb} ${alias} → ${adapter.displayName}\n` +
				`  Config: ${configPath}\n` +
				`  Profile: ${profileName}\n` +
				`  ${restartHint}`,
		);
		return { kind: "none" };
	},
);

/**
 * `c8ctl mcp uninstall <client> [--alias <name>]`
 */
export const mcpUninstallCommand = defineCommand(
	"mcp",
	"uninstall",
	async (ctx, flags) => {
		const { logger } = ctx;
		const clientId = ctx.positionals[0];
		if (!clientId) {
			throw new Error(
				`Missing MCP client name. Supported clients: ${listSupportedClients().join(", ")}.`,
			);
		}
		const adapter = getAdapter(clientId);
		const alias =
			flags.alias && flags.alias.length > 0
				? flags.alias
				: defaultAlias(c8ctl.activeProfile);
		const configPath = adapter.configPath();
		const existing = readJsonFileOrNull(configPath);
		const { merged, existed } = unmergeMcpConfig(
			existing,
			adapter.serversKey,
			alias,
		);
		if (!existed) {
			// Idempotent: removing an absent alias is not an error.
			logger.info(
				`No '${alias}' entry under ${adapter.displayName}; nothing to uninstall.`,
			);
			return { kind: "none" };
		}
		if (c8ctl.dryRun) {
			return {
				kind: "dryRun",
				info: {
					dryRun: true,
					command: `mcp uninstall ${clientId}`,
					action: "remove-mcp-entry",
					client: clientId,
					configPath,
					alias,
					content: merged,
				},
			};
		}
		writeJsonAtomic(configPath, merged);
		logger.info(
			`Uninstalled ${alias} from ${adapter.displayName}\n` +
				`  Config: ${configPath}`,
		);
		return { kind: "none" };
	},
);

/**
 * `c8ctl mcp list` — show every c8ctl-managed entry across known clients.
 *
 * Renders as a list so the framework picks the right output format for
 * text/json. Items are flat objects (Client / Alias / Profile / Config)
 * to match other `list` commands.
 */
export const mcpListCommand = defineCommand(
	"mcp",
	"list",
	async (_ctx, _flags) => {
		const items: Record<string, unknown>[] = [];
		for (const adapter of listSupportedClients().map(getAdapter)) {
			const path = adapter.configPath();
			if (!existsSync(path)) continue;
			let parsed: unknown;
			try {
				parsed = readJsonFileOrNull(path);
			} catch {
				// A corrupt config file is reported in the row itself rather
				// than aborting the whole listing — users with one broken
				// file still want to see their other clients.
				items.push({
					Client: adapter.displayName,
					Alias: "—",
					Profile: "—",
					Config: `${path} (parse error)`,
				});
				continue;
			}
			const servers = extractServerEntries(parsed, adapter.serversKey);
			for (const [alias, entry] of servers) {
				items.push({
					Client: adapter.displayName,
					Alias: alias,
					Profile: extractProfileName(entry) ?? "—",
					Config: path,
				});
			}
		}
		return {
			kind: "list",
			items,
			emptyMessage:
				"No MCP entries found. Run 'c8ctl mcp install <client>' to add one.",
		};
	},
);

function extractServerEntries(
	parsed: unknown,
	serversKey: string,
): [string, unknown][] {
	if (!isRecordLike(parsed)) return [];
	const servers = parsed[serversKey];
	if (!isRecordLike(servers)) return [];
	return Object.entries(servers);
}

function extractProfileName(entry: unknown): string | undefined {
	if (!isRecordLike(entry)) return undefined;
	const args = entry.args;
	if (!Array.isArray(args)) return undefined;
	// `["-y", "@camunda8/cli", "mcp-proxy", "--profile", "<name>"]`
	const idx = args.indexOf("--profile");
	if (idx < 0 || idx === args.length - 1) return undefined;
	const value = args[idx + 1];
	return typeof value === "string" ? value : undefined;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function restartHintFor(adapter: McpClientAdapter): string {
	switch (adapter.id) {
		case "claude-desktop":
			return "Restart Claude Desktop to activate.";
		case "cursor":
			return "Restart Cursor to activate.";
		case "vscode":
			return "Reload the VS Code window (Cmd/Ctrl+Shift+P → 'Reload Window') to activate.";
		default:
			return `Restart ${adapter.displayName} to activate.`;
	}
}
