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
import {
	DEFAULT_PROFILE,
	getProfile,
	getProfileOrModeler,
	resolveClusterConfig,
} from "../config.ts";
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
 * Profile name install/uninstall use as the default alias when neither
 * `--profile` nor `--alias` is given. Mirrors `resolveClusterConfig`'s
 * profile chain (active profile → bootstrap 'local' default) so install
 * and uninstall agree on which entry the user means without `--alias`.
 * Returns `undefined` when nothing is available; callers fall back to
 * the literal "camunda".
 */
function defaultProfileNameForAlias(): string | undefined {
	if (c8ctl.activeProfile) return c8ctl.activeProfile;
	if (getProfile(DEFAULT_PROFILE)) return DEFAULT_PROFILE;
	return undefined;
}

/**
 * Resolve the profile that the installed MCP entry will reference.
 * Throws when an explicit `--profile` names an unknown profile so the
 * defect class "wrote a working entry pointing at a profile that
 * doesn't exist" cannot occur. Accepts `modeler:<name>` via
 * `getProfileOrModeler` so Modeler connections work the same as in
 * every other command.
 */
function resolveProfileName(profileFlag: string | undefined): string {
	if (profileFlag) {
		if (!getProfileOrModeler(profileFlag)) {
			throw new Error(
				`Profile '${profileFlag}' not found. Run 'c8ctl list profile' to see available profiles.`,
			);
		}
		return profileFlag;
	}
	const defaulted = defaultProfileNameForAlias();
	if (defaulted) return defaulted;
	throw new Error(
		"No profile available. Create one with 'c8ctl add profile <name>' or pass --profile before running 'c8ctl mcp install'.",
	);
}

/**
 * `c8ctl mcp install <client> [--profile <name>] [--alias <name>]`
 */
export const mcpInstallCommand = defineCommand(
	"mcp",
	"install",
	async (ctx, flags, args) => {
		const { logger } = ctx;
		const clientId = args.client;
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
		// Refuse to clobber a third-party MCP server that happens to share
		// this alias. The verb's contract is "manage c8ctl mcp-proxy entries",
		// so silently overwriting an unrelated entry would violate it.
		// `--force` is the explicit escape hatch for users who really do want
		// to take over the alias.
		const existingEntry = lookupExistingEntry(
			existing,
			adapter.serversKey,
			alias,
		);
		if (
			existingEntry !== undefined &&
			!isC8ctlManagedEntry(existingEntry) &&
			!flags.force
		) {
			throw new Error(
				`Refusing to overwrite '${alias}' under ${adapter.displayName}: ` +
					"the existing entry was not installed by c8ctl. " +
					"Pass --force to overwrite, or use --alias <other-name> to install alongside it.",
			);
		}
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
	async (ctx, flags, args) => {
		const { logger } = ctx;
		const clientId = args.client;
		const adapter = getAdapter(clientId);
		// Default alias must match install's default — both fall back through
		// the same `defaultProfileNameForAlias()` chain so `mcp uninstall <client>`
		// always removes what `mcp install <client>` created.
		const alias =
			flags.alias && flags.alias.length > 0
				? flags.alias
				: defaultAlias(defaultProfileNameForAlias());
		const configPath = adapter.configPath();
		const existing = readJsonFileOrNull(configPath);
		// Refuse to remove an unrelated MCP server entry that just happens
		// to share this alias. Same reasoning as install: this verb manages
		// c8ctl-shaped entries, not arbitrary ones. `--force` overrides.
		const existingEntry = lookupExistingEntry(
			existing,
			adapter.serversKey,
			alias,
		);
		if (
			existingEntry !== undefined &&
			!isC8ctlManagedEntry(existingEntry) &&
			!flags.force
		) {
			throw new Error(
				`Refusing to remove '${alias}' from ${adapter.displayName}: ` +
					"the entry was not installed by c8ctl. Pass --force to remove anyway.",
			);
		}
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
				// Only surface c8ctl-managed entries so the listing matches
				// the verb's contract. Users with their own unrelated MCP
				// servers in the same config see them via the third-party
				// client's own UI; this command is intentionally scoped.
				if (!isC8ctlManagedEntry(entry)) continue;
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

/**
 * Look up a single entry under `serversKey/alias` in a parsed config
 * tree. Returns `undefined` when the path is absent so callers can use
 * triple-equals to distinguish "not present" from "present but empty".
 */
function lookupExistingEntry(
	parsed: unknown,
	serversKey: string,
	alias: string,
): unknown {
	if (!isRecordLike(parsed)) return undefined;
	const servers = parsed[serversKey];
	if (!isRecordLike(servers)) return undefined;
	if (!Object.hasOwn(servers, alias)) return undefined;
	return servers[alias];
}

/**
 * Recognise an entry that c8ctl would have written. The check is the
 * minimum signature that distinguishes a c8ctl-managed proxy entry
 * from any other MCP server: the `args` array references the published
 * `@camunda8/cli` package *and* the `mcp-proxy` subcommand. We do not
 * lock the predicate to `command === "npx"` because users (and future
 * c8ctl versions) may legitimately swap the runner (`bunx`, `npx -y`,
 * a wrapper script) without changing the entry's identity — the args
 * pair is the stable c8ctl fingerprint, the runner is not.
 *
 * Kept deliberately narrow: install/uninstall must only round-trip
 * entries this predicate recognises, and `mcp list` must only surface
 * those.
 */
function isC8ctlManagedEntry(entry: unknown): boolean {
	if (!isRecordLike(entry)) return false;
	const args = entry.args;
	if (!Array.isArray(args)) return false;
	return args.includes("@camunda8/cli") && args.includes("mcp-proxy");
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
