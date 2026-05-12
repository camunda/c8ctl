/**
 * Pure helpers for `c8ctl mcp install` (#293).
 *
 * Adapter contract + merge/unmerge semantics — pure functions, no
 * filesystem access. Class-scoped: every assertion iterates every
 * adapter so adding a fourth client cannot regress any of them.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { isRecord } from "../../src/logger.ts";
import {
	type AdapterEnv,
	buildProxyEnv,
	getAdapter,
	listSupportedClients,
	MCP_CLIENT_ADAPTERS,
	mergeMcpConfig,
	unmergeMcpConfig,
} from "../../src/mcp-install/adapters.ts";

const SAMPLE_PROFILE = {
	baseUrl: "https://example.zeebe.camunda.io/v2",
	clientId: "client-id-xyz",
	clientSecret: "client-secret-xyz",
	audience: "zeebe-audience",
	oAuthUrl: "https://login.example/oauth/token",
};

const FAKE_ENVS: Record<NodeJS.Platform, AdapterEnv> = {
	darwin: { HOME: "/Users/tester", platform: "darwin" },
	linux: { HOME: "/home/tester", platform: "linux" },
	win32: {
		HOME: "C:/Users/tester",
		APPDATA: "C:/Users/tester/AppData/Roaming",
		platform: "win32",
	},
	// Other platforms aren't exercised by tests but the type requires them;
	// reuse the linux entry as a stand-in.
	aix: { HOME: "/home/tester", platform: "aix" },
	freebsd: { HOME: "/home/tester", platform: "freebsd" },
	openbsd: { HOME: "/home/tester", platform: "openbsd" },
	sunos: { HOME: "/home/tester", platform: "sunos" },
	cygwin: { HOME: "C:/Users/tester", platform: "cygwin" },
	netbsd: { HOME: "/home/tester", platform: "netbsd" },
	android: { HOME: "/data/local", platform: "android" },
	haiku: { HOME: "/home/tester", platform: "haiku" },
};

describe("MCP client adapter contract (#293)", () => {
	test("registry exposes the three documented clients", () => {
		assert.deepStrictEqual(listSupportedClients(), [
			"claude-desktop",
			"cursor",
			"vscode",
		]);
	});

	test("every adapter declares a non-empty serversKey", () => {
		// Class-scoped: a typo in any adapter's serversKey breaks installs
		// silently — clients ignore unknown top-level keys. Pin it here.
		for (const adapter of MCP_CLIENT_ADAPTERS.values()) {
			assert.ok(
				adapter.serversKey.length > 0,
				`${adapter.id} must declare a non-empty serversKey`,
			);
		}
	});

	test("serversKey matches each client's documented schema", () => {
		// Locked individually because these are the values the user-facing
		// docs hand-edit defect was about (vscode uses 'servers', not
		// 'mcpServers').
		assert.strictEqual(getAdapter("claude-desktop").serversKey, "mcpServers");
		assert.strictEqual(getAdapter("cursor").serversKey, "mcpServers");
		assert.strictEqual(getAdapter("vscode").serversKey, "servers");
	});

	test("every adapter resolves a config path on every supported OS", () => {
		// Class-scoped: ensures no adapter throws or returns empty for
		// any of darwin/linux/win32 (the OSes c8ctl supports — Windows
		// only via WSL but path resolution is still expected to work).
		for (const adapter of MCP_CLIENT_ADAPTERS.values()) {
			for (const platform of ["darwin", "linux", "win32"] as const) {
				const path = adapter.configPath(FAKE_ENVS[platform]);
				assert.ok(
					path.length > 0,
					`${adapter.id} returned empty path for ${platform}`,
				);
				assert.ok(
					path.endsWith(".json"),
					`${adapter.id} on ${platform} returned non-.json path: ${path}`,
				);
			}
		}
	});

	test("configPath uses the documented platform-specific locations", () => {
		// Spot-check the macOS values to lock the user-facing paths.
		const mac = FAKE_ENVS.darwin;
		assert.strictEqual(
			getAdapter("claude-desktop").configPath(mac),
			"/Users/tester/Library/Application Support/Claude/claude_desktop_config.json",
		);
		assert.strictEqual(
			getAdapter("cursor").configPath(mac),
			"/Users/tester/.cursor/mcp.json",
		);
		assert.strictEqual(
			getAdapter("vscode").configPath(mac),
			"/Users/tester/Library/Application Support/Code/User/mcp.json",
		);
	});

	test("every adapter builds an entry that launches c8ctl mcp-proxy", () => {
		// Class-scoped: the entry must (a) invoke npx, (b) reference the
		// c8ctl package, (c) pass `mcp-proxy`, (d) forward `--profile`.
		for (const adapter of MCP_CLIENT_ADAPTERS.values()) {
			const entry = adapter.buildEntry({
				profile: SAMPLE_PROFILE,
				profileName: "prod",
			});
			assert.strictEqual(
				entry.command,
				"npx",
				`${adapter.id} should spawn via npx`,
			);
			assert.ok(
				entry.args.includes("mcp-proxy"),
				`${adapter.id} entry must invoke 'mcp-proxy' subcommand`,
			);
			assert.ok(
				entry.args.includes("--profile"),
				`${adapter.id} entry must forward --profile`,
			);
			assert.ok(
				entry.args.includes("prod"),
				`${adapter.id} entry must include the resolved profile name`,
			);
			assert.strictEqual(
				entry.env?.CAMUNDA_BASE_URL,
				SAMPLE_PROFILE.baseUrl,
				`${adapter.id} must embed CAMUNDA_BASE_URL in env`,
			);
		}
	});

	test("vscode adapter sets type='stdio' (its schema requires it)", () => {
		const entry = getAdapter("vscode").buildEntry({
			profile: SAMPLE_PROFILE,
			profileName: "prod",
		});
		assert.strictEqual(entry.type, "stdio");
	});

	test("claude/cursor adapters omit type (their schema doesn't expect it)", () => {
		for (const id of ["claude-desktop", "cursor"]) {
			const entry = getAdapter(id).buildEntry({
				profile: SAMPLE_PROFILE,
				profileName: "prod",
			});
			assert.strictEqual(
				entry.type,
				undefined,
				`${id} entry must NOT include a type field`,
			);
		}
	});

	test("buildProxyEnv omits unset credential fields (no 'undefined' literal)", () => {
		// Defect class: stringifying undefined into env would write the
		// literal string "undefined" — clients would then send broken
		// auth. Class-scoped: every optional field tested.
		const env = buildProxyEnv({ baseUrl: "http://x" });
		assert.deepStrictEqual(env, { CAMUNDA_BASE_URL: "http://x" });
	});

	test("getAdapter throws with the supported client list on miss", () => {
		assert.throws(() => getAdapter("zed"), /Supported clients:/);
	});
});

describe("mergeMcpConfig preserves unrelated state (#293)", () => {
	test("preserves top-level keys outside serversKey", () => {
		// Defect class: docs hand-edit historically wiped the user's
		// `preferences` block. Class-scoped over every adapter.
		for (const adapter of MCP_CLIENT_ADAPTERS.values()) {
			const existing = {
				preferences: { theme: "dark" },
				telemetry: false,
				[adapter.serversKey]: {},
			};
			const { merged } = mergeMcpConfig(
				existing,
				adapter.serversKey,
				"camunda",
				adapter.buildEntry({
					profile: SAMPLE_PROFILE,
					profileName: "prod",
				}),
			);
			assert.deepStrictEqual(
				merged.preferences,
				{ theme: "dark" },
				`${adapter.id}: preferences block must survive merge`,
			);
			assert.strictEqual(
				merged.telemetry,
				false,
				`${adapter.id}: unrelated boolean must survive merge`,
			);
		}
	});

	test("preserves sibling entries under serversKey", () => {
		for (const adapter of MCP_CLIENT_ADAPTERS.values()) {
			const otherEntry = { command: "other", args: [] };
			const existing = {
				[adapter.serversKey]: { other: otherEntry },
			};
			const { merged } = mergeMcpConfig(
				existing,
				adapter.serversKey,
				"camunda",
				adapter.buildEntry({
					profile: SAMPLE_PROFILE,
					profileName: "prod",
				}),
			);
			const servers = merged[adapter.serversKey];
			assert.ok(isRecord(servers));
			assert.deepStrictEqual(
				servers.other,
				otherEntry,
				`${adapter.id}: sibling 'other' entry must survive`,
			);
			assert.ok(
				servers.camunda,
				`${adapter.id}: 'camunda' entry must be added`,
			);
		}
	});

	test("treats absent existing config as empty object", () => {
		const { merged, existed } = mergeMcpConfig(null, "mcpServers", "camunda", {
			command: "npx",
			args: [],
		});
		assert.strictEqual(existed, false);
		assert.deepStrictEqual(merged, {
			mcpServers: { camunda: { command: "npx", args: [] } },
		});
	});

	test("reports existed=true when the alias already exists", () => {
		const { existed } = mergeMcpConfig(
			{ mcpServers: { camunda: { command: "old", args: [] } } },
			"mcpServers",
			"camunda",
			{ command: "new", args: [] },
		);
		assert.strictEqual(existed, true);
	});

	test("idempotent: re-running install reproduces the same merged output", () => {
		// A re-install should be a fixed point. Class-scoped over adapters.
		for (const adapter of MCP_CLIENT_ADAPTERS.values()) {
			const entry = adapter.buildEntry({
				profile: SAMPLE_PROFILE,
				profileName: "prod",
			});
			const first = mergeMcpConfig(
				{},
				adapter.serversKey,
				"camunda",
				entry,
			).merged;
			const second = mergeMcpConfig(
				first,
				adapter.serversKey,
				"camunda",
				entry,
			).merged;
			assert.deepStrictEqual(second, first, `${adapter.id}: not idempotent`);
		}
	});
});

describe("unmergeMcpConfig is symmetric with mergeMcpConfig (#293)", () => {
	test("removes only the named alias, leaves siblings intact", () => {
		for (const adapter of MCP_CLIENT_ADAPTERS.values()) {
			const otherEntry = { command: "other", args: [] };
			const existing = {
				preferences: { theme: "dark" },
				[adapter.serversKey]: {
					camunda: { command: "npx", args: ["mcp-proxy"] },
					other: otherEntry,
				},
			};
			const { merged, existed } = unmergeMcpConfig(
				existing,
				adapter.serversKey,
				"camunda",
			);
			assert.strictEqual(existed, true, `${adapter.id}: 'camunda' was present`);
			const servers = merged[adapter.serversKey];
			assert.ok(isRecord(servers));
			assert.strictEqual(
				servers.camunda,
				undefined,
				`${adapter.id}: 'camunda' alias must be removed`,
			);
			assert.deepStrictEqual(
				servers.other,
				otherEntry,
				`${adapter.id}: sibling alias must be preserved`,
			);
			assert.deepStrictEqual(
				merged.preferences,
				{ theme: "dark" },
				`${adapter.id}: unrelated top-level keys must be preserved`,
			);
		}
	});

	test("reports existed=false when alias is absent (idempotent uninstall)", () => {
		const { existed, merged } = unmergeMcpConfig(
			{ mcpServers: { other: {} } },
			"mcpServers",
			"camunda",
		);
		assert.strictEqual(existed, false);
		assert.deepStrictEqual(merged, { mcpServers: { other: {} } });
	});
});
