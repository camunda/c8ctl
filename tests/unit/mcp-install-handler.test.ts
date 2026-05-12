/**
 * `c8ctl mcp install/uninstall/list` end-to-end tests (#293).
 *
 * Spawns the real CLI in a temp HOME so adapter path resolution is
 * deterministic and the test runner's actual MCP configs can't be
 * touched. Class-scoped invariants iterate every supported client.
 */

import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { isRecord } from "../../src/logger.ts";
import {
	type AdapterEnv,
	getAdapter,
	listSupportedClients,
} from "../../src/mcp-install/adapters.ts";
import { asyncSpawn, type SpawnResult } from "../utils/spawn.ts";

let tempHome: string;
let tempDataDir: string;

/** Match the resolution the CLI subprocess sees (HOME=tempHome). */
function adapterEnv(): AdapterEnv {
	return { HOME: tempHome, platform: process.platform };
}

function configPathFor(clientId: string): string {
	return getAdapter(clientId).configPath(adapterEnv());
}

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "c8ctl-mcp-home-"));
	tempDataDir = mkdtempSync(join(tmpdir(), "c8ctl-mcp-data-"));
	// Seed a profile so install has credentials to embed. profiles.json
	// is parsed as `{ profiles: Profile[] }` (see src/config.ts loadProfiles()).
	writeFileSync(
		join(tempDataDir, "profiles.json"),
		JSON.stringify({
			profiles: [
				{
					name: "test-profile",
					baseUrl: "https://test.zeebe.camunda.io/v2",
					clientId: "cid",
					clientSecret: "csecret",
					audience: "zeebe-audience",
					oAuthUrl: "https://login.test/oauth/token",
				},
			],
		}),
	);
	// Persist the active profile so the handler picks it up without --profile.
	writeFileSync(
		join(tempDataDir, "session.json"),
		JSON.stringify({ activeProfile: "test-profile", outputMode: "json" }),
	);
});

afterEach(() => {
	rmSync(tempHome, { recursive: true, force: true });
	rmSync(tempDataDir, { recursive: true, force: true });
});

async function c8(...args: string[]): Promise<SpawnResult> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: tempHome,
		C8CTL_DATA_DIR: tempDataDir,
	};
	delete env.DEBUG;
	delete env.C8CTL_DEBUG;
	delete env.NODE_DEBUG;
	delete env.NODE_OPTIONS;
	delete env.CAMUNDA_BASE_URL;
	delete env.CAMUNDA_CLIENT_ID;
	delete env.CAMUNDA_CLIENT_SECRET;
	return asyncSpawn(
		"node",
		["--experimental-strip-types", "src/index.ts", ...args],
		{ env, timeout: 15_000 },
	);
}

function readJson(path: string): unknown {
	// biome-ignore lint/plugin: runtime contract boundary for parsed JSON
	return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

describe("c8ctl mcp install (#293)", () => {
	test("class-scoped: install writes a c8ctl mcp-proxy entry for every supported client", async () => {
		// Defect class: any adapter regression that prevents writing the
		// configured serversKey/path is caught by iterating all clients.
		for (const clientId of listSupportedClients()) {
			const adapter = getAdapter(clientId);
			const result = await c8("mcp", "install", clientId);
			assert.strictEqual(
				result.status,
				0,
				`mcp install ${clientId} exited ${result.status}: ${result.stderr}`,
			);
			const written = readJson(configPathFor(clientId));
			assert.ok(
				isRecord(written),
				`${clientId}: written config must be an object`,
			);
			const servers = written[adapter.serversKey];
			assert.ok(
				isRecord(servers),
				`${clientId}: written config must contain '${adapter.serversKey}'`,
			);
			assert.ok(
				servers["test-profile"],
				`${clientId}: must contain entry under default alias 'test-profile'`,
			);
		}
	});

	test("preserves unrelated top-level keys in the existing client config", async () => {
		const clientId = "claude-desktop";
		const path = configPathFor(clientId);
		// Pre-seed a config with a `preferences` block and an unrelated MCP entry.
		const fs = await import("node:fs");
		fs.mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				preferences: { theme: "dark" },
				mcpServers: {
					other: { command: "other-cmd", args: ["a", "b"] },
				},
			}),
		);

		const result = await c8("mcp", "install", clientId);
		assert.strictEqual(result.status, 0, result.stderr);

		const written = readJson(path);
		assert.ok(isRecord(written));
		assert.deepStrictEqual(
			written.preferences,
			{ theme: "dark" },
			"preferences block must survive install",
		);
		assert.ok(isRecord(written.mcpServers));
		assert.deepStrictEqual(
			written.mcpServers.other,
			{ command: "other-cmd", args: ["a", "b"] },
			"sibling MCP entry must survive install",
		);
		assert.ok(
			written.mcpServers["test-profile"],
			"new c8ctl entry must be added",
		);
	});

	test("--dry-run does not touch the filesystem", async () => {
		const clientId = "cursor";
		const result = await c8("mcp", "install", clientId, "--dry-run");
		assert.strictEqual(result.status, 0, result.stderr);

		assert.throws(
			() => readFileSync(configPathFor(clientId), "utf8"),
			/ENOENT/,
			"--dry-run must NOT write to disk",
		);
		// stdout (json mode) should describe the would-be content.
		assert.ok(
			result.stdout.includes("write-mcp-config"),
			`dry-run output must describe the action; got: ${result.stdout}`,
		);
	});

	test("--profile <name> with unknown profile fails with a helpful error", async () => {
		const result = await c8(
			"mcp",
			"install",
			"claude-desktop",
			"--profile",
			"does-not-exist",
		);
		assert.notStrictEqual(result.status, 0, "must exit non-zero");
		assert.match(
			`${result.stdout}\n${result.stderr}`,
			/does-not-exist/,
			"error must name the missing profile",
		);
	});

	test("install is idempotent (re-running produces byte-identical output)", async () => {
		const clientId = "vscode";
		const first = await c8("mcp", "install", clientId);
		assert.strictEqual(first.status, 0, first.stderr);
		const afterFirst = readFileSync(configPathFor(clientId), "utf8");
		const second = await c8("mcp", "install", clientId);
		assert.strictEqual(second.status, 0, second.stderr);
		const afterSecond = readFileSync(configPathFor(clientId), "utf8");
		assert.strictEqual(afterFirst, afterSecond, "install must be idempotent");
	});
});

describe("c8ctl mcp uninstall (#293)", () => {
	test("removes only the named alias and preserves siblings", async () => {
		const clientId = "claude-desktop";
		const path = configPathFor(clientId);
		const fs = await import("node:fs");
		fs.mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				preferences: { theme: "dark" },
				mcpServers: {
					"test-profile": {
						command: "npx",
						args: [
							"-y",
							"@camunda8/cli",
							"mcp-proxy",
							"--profile",
							"test-profile",
						],
					},
					other: { command: "other", args: [] },
				},
			}),
		);

		const result = await c8("mcp", "uninstall", "claude-desktop");
		assert.strictEqual(result.status, 0, result.stderr);

		const written = readJson(path);
		assert.ok(isRecord(written));
		assert.deepStrictEqual(written.preferences, { theme: "dark" });
		assert.ok(isRecord(written.mcpServers));
		assert.strictEqual(
			written.mcpServers["test-profile"],
			undefined,
			"named alias must be removed",
		);
		assert.deepStrictEqual(
			written.mcpServers.other,
			{ command: "other", args: [] },
			"sibling alias must survive",
		);
	});

	test("uninstalling a missing alias is a no-op (exit 0)", async () => {
		const result = await c8(
			"mcp",
			"uninstall",
			"vscode",
			"--alias",
			"never-installed",
		);
		assert.strictEqual(
			result.status,
			0,
			`uninstall of absent alias must succeed; stderr: ${result.stderr}`,
		);
	});

	test("refuses to remove a non-c8ctl entry without --force", async () => {
		// Defect class: a user with their own MCP server registered under
		// the same alias the c8ctl default would pick must not have it
		// silently deleted by `c8ctl mcp uninstall`.
		const clientId = "claude-desktop";
		const path = configPathFor(clientId);
		const fs = await import("node:fs");
		fs.mkdirSync(join(path, ".."), { recursive: true });
		const foreignEntry = {
			command: "node",
			args: ["/opt/my-other-mcp/server.js"],
		};
		writeFileSync(
			path,
			JSON.stringify({
				mcpServers: { "test-profile": foreignEntry },
			}),
		);

		const refused = await c8("mcp", "uninstall", "claude-desktop");
		assert.notStrictEqual(
			refused.status,
			0,
			"uninstall must refuse non-c8ctl entry without --force",
		);
		assert.match(refused.stderr, /not installed by c8ctl/);
		const stillThere = readJson(path);
		assert.ok(isRecord(stillThere));
		assert.ok(isRecord(stillThere.mcpServers));
		assert.deepStrictEqual(
			stillThere.mcpServers["test-profile"],
			foreignEntry,
			"foreign entry must remain on disk after refusal",
		);

		const forced = await c8("mcp", "uninstall", "claude-desktop", "--force");
		assert.strictEqual(
			forced.status,
			0,
			`--force must allow removal of foreign entry; stderr: ${forced.stderr}`,
		);
		const after = readJson(path);
		assert.ok(isRecord(after));
		assert.ok(isRecord(after.mcpServers));
		assert.strictEqual(after.mcpServers["test-profile"], undefined);
	});
});

describe("c8ctl mcp list (#293)", () => {
	test("aggregates entries across known clients", async () => {
		// Install into two of three clients; list should report both.
		const installA = await c8("mcp", "install", "claude-desktop");
		assert.strictEqual(installA.status, 0, installA.stderr);
		const installB = await c8("mcp", "install", "vscode");
		assert.strictEqual(installB.status, 0, installB.stderr);

		const result = await c8("mcp", "list");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /Claude Desktop/);
		assert.match(result.stdout, /VS Code/);
		assert.match(result.stdout, /test-profile/);
	});

	test("omits foreign (non-c8ctl) MCP servers from the listing", async () => {
		// Defect class: `mcp list` is scoped to c8ctl-managed entries
		// ("manage c8ctl mcp-proxy entries"). Pre-existing third-party MCP
		// servers in the same config file must not leak into the listing.
		const clientId = "claude-desktop";
		const path = configPathFor(clientId);
		const fs = await import("node:fs");
		fs.mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				mcpServers: {
					filesystem: {
						command: "npx",
						args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
					},
					custom: { command: "node", args: ["/opt/me/server.js"] },
				},
			}),
		);
		const install = await c8("mcp", "install", "claude-desktop");
		assert.strictEqual(install.status, 0, install.stderr);

		const result = await c8("mcp", "list");
		assert.strictEqual(result.status, 0, result.stderr);
		// JSON outputMode is set in session.json — `logger.table` emits the
		// items array directly in JSON mode.
		const payload: unknown = JSON.parse(result.stdout);
		assert.ok(Array.isArray(payload), "list output must be an array");
		const aliases = payload.map((it: unknown) =>
			isRecord(it) && typeof it.Alias === "string" ? it.Alias : undefined,
		);
		assert.ok(
			aliases.includes("test-profile"),
			`c8ctl-installed alias must appear; got ${JSON.stringify(aliases)}`,
		);
		assert.ok(
			!aliases.includes("filesystem"),
			"foreign npx-based MCP server must NOT appear in c8ctl mcp list",
		);
		assert.ok(
			!aliases.includes("custom"),
			"foreign custom MCP server must NOT appear in c8ctl mcp list",
		);
	});
});

describe("c8ctl mcp install collision protection (#293)", () => {
	test("refuses to overwrite a non-c8ctl entry without --force", async () => {
		// Defect class: install must not silently clobber a third-party
		// MCP server entry that happens to share an alias with the c8ctl
		// default (e.g. user already had `test-profile` registered for
		// some other purpose).
		const clientId = "claude-desktop";
		const path = configPathFor(clientId);
		const fs = await import("node:fs");
		fs.mkdirSync(join(path, ".."), { recursive: true });
		const foreignEntry = {
			command: "node",
			args: ["/opt/my-other-mcp/server.js"],
		};
		writeFileSync(
			path,
			JSON.stringify({
				mcpServers: { "test-profile": foreignEntry },
			}),
		);

		const refused = await c8("mcp", "install", "claude-desktop");
		assert.notStrictEqual(
			refused.status,
			0,
			"install must refuse to clobber non-c8ctl entry without --force",
		);
		assert.match(refused.stderr, /not installed by c8ctl/);
		const untouched = readJson(path);
		assert.ok(isRecord(untouched));
		assert.ok(isRecord(untouched.mcpServers));
		assert.deepStrictEqual(
			untouched.mcpServers["test-profile"],
			foreignEntry,
			"foreign entry must remain unchanged after refusal",
		);

		const forced = await c8("mcp", "install", "claude-desktop", "--force");
		assert.strictEqual(
			forced.status,
			0,
			`--force must allow overwrite; stderr: ${forced.stderr}`,
		);
		const after = readJson(path);
		assert.ok(isRecord(after));
		assert.ok(isRecord(after.mcpServers));
		const entry = after.mcpServers["test-profile"];
		assert.ok(isRecord(entry));
		assert.ok(
			Array.isArray(entry.args) && entry.args.includes("@camunda8/cli"),
			"after --force, entry must be the c8ctl-managed shape",
		);
	});

	test("re-running install on an existing c8ctl entry needs no --force", async () => {
		// Idempotency: install must NOT require --force when the existing
		// entry was itself installed by c8ctl. Otherwise users would have
		// to remember --force on every credential refresh.
		const first = await c8("mcp", "install", "claude-desktop");
		assert.strictEqual(first.status, 0, first.stderr);
		const second = await c8("mcp", "install", "claude-desktop");
		assert.strictEqual(
			second.status,
			0,
			`re-install of c8ctl entry must not require --force; stderr: ${second.stderr}`,
		);
	});
});
