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
					"test-profile": { command: "npx", args: ["mcp-proxy"] },
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
});
