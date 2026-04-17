/**
 * Unit tests for lazy client/tenantId getters in the dispatch loop.
 *
 * The dispatcher in src/index.ts constructs CommandContext with lazy
 * getters for `client` and `tenantId` so that commands which never
 * access them (e.g. session/profile management) skip config resolution
 * and client creation entirely.
 *
 * These tests verify the lazy getter pattern used in the dispatcher.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import type { CommandContext } from "../../src/command-framework.ts";

describe("Lazy client getter", () => {
	/**
	 * Helper: build a CommandContext with lazy getters, mirroring the
	 * pattern used in src/index.ts dispatch.
	 */
	function buildContext(factories: {
		createClient: () => unknown;
		resolveTenantId: () => string;
	}): CommandContext {
		let _client: unknown | undefined;
		let _tenantId: string | undefined;
		let _tenantResolved = false;
		const stub = {
			get client() {
				if (!_client) _client = factories.createClient();
				return _client;
			},
			get tenantId() {
				if (!_tenantResolved) {
					_tenantId = factories.resolveTenantId();
					_tenantResolved = true;
				}
				return _tenantId;
			},
		};
		// biome-ignore lint/plugin: test stub for CommandContext with only lazy getters populated
		return stub as unknown as CommandContext;
	}

	test("client factory is not called until ctx.client is accessed", () => {
		let called = false;
		const ctx = buildContext({
			createClient: () => {
				called = true;
				return { fake: "client" };
			},
			resolveTenantId: () => "",
		});

		assert.strictEqual(called, false, "Factory must not be called eagerly");
		const _client = ctx.client;
		assert.strictEqual(called, true, "Factory must be called on first access");
	});

	test("client factory is called only once (cached)", () => {
		let callCount = 0;
		const ctx = buildContext({
			createClient: () => {
				callCount++;
				return { fake: "client" };
			},
			resolveTenantId: () => "",
		});

		const first = ctx.client;
		const second = ctx.client;
		assert.strictEqual(callCount, 1, "Factory must be called exactly once");
		assert.strictEqual(first, second, "Same instance must be returned");
	});

	test("tenantId resolver is not called until ctx.tenantId is accessed", () => {
		let called = false;
		const ctx = buildContext({
			createClient: () => ({ fake: "client" }),
			resolveTenantId: () => {
				called = true;
				return "test-tenant";
			},
		});

		assert.strictEqual(called, false, "Resolver must not be called eagerly");
		const tid = ctx.tenantId;
		assert.strictEqual(called, true, "Resolver must be called on first access");
		assert.strictEqual(tid, "test-tenant");
	});

	test("tenantId resolver is called only once (cached)", () => {
		let callCount = 0;
		const ctx = buildContext({
			createClient: () => ({ fake: "client" }),
			resolveTenantId: () => {
				callCount++;
				return "t1";
			},
		});

		const first = ctx.tenantId;
		const second = ctx.tenantId;
		assert.strictEqual(callCount, 1, "Resolver must be called exactly once");
		assert.strictEqual(first, second);
	});
});

// ─── Dispatch-level behavioural test ─────────────────────────────────────────

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asyncSpawn } from "../utils/spawn.ts";

const CLI = "src/index.ts";

/**
 * Node 22.6+ supports --experimental-strip-types; older versions don't.
 * package.json requires >=22.18.0, but local dev may use older versions.
 */
const [major, minor] = process.versions.node.split(".").map(Number);
const canStripTypes = major > 22 || (major === 22 && minor >= 6);

describe("Lazy client dispatch integration", () => {
	test("clientless command does not emit env-var override warning", {
		skip: canStripTypes
			? false
			: "requires Node 22.6+ for --experimental-strip-types",
	}, async () => {
		// Set up a test data dir with an active profile AND CAMUNDA_BASE_URL.
		// Before the lazy getter fix, this combination would trigger:
		//   "Active profile 'test-profile' is overriding CAMUNDA_* environment variables."
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-lazy-test-"));
		try {
			writeFileSync(
				join(dataDir, "profiles.json"),
				JSON.stringify([
					{ name: "test-profile", baseUrl: "http://localhost:8080/v2" },
				]),
			);
			writeFileSync(
				join(dataDir, "session.json"),
				JSON.stringify({
					activeProfile: "test-profile",
					outputMode: "text",
				}),
			);

			const result = await asyncSpawn(
				"node",
				["--experimental-strip-types", CLI, "which", "profile"],
				{
					env: {
						...process.env,
						CAMUNDA_BASE_URL: "http://other-cluster/v2",
						C8CTL_DATA_DIR: dataDir,
						HOME: "/tmp/c8ctl-lazy-test-home",
					},
				},
			);

			assert.strictEqual(
				result.status,
				0,
				`exit=${result.status} stdout: ${result.stdout} stderr: ${result.stderr}`,
			);
			assert.ok(
				!result.stderr.includes("overriding"),
				`Expected no override warning, got stderr: ${result.stderr}`,
			);
			assert.ok(
				!result.stdout.includes("overriding"),
				`Expected no override warning, got stdout: ${result.stdout}`,
			);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
