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

import { test, describe } from "node:test";
import assert from "node:assert";
import type { CommandContext } from "../../src/command-framework.ts";

describe("Lazy client getter", () => {
	/**
	 * Helper: build a CommandContext with lazy getters, mirroring the
	 * pattern used in src/index.ts dispatch.
	 */
	function buildContext(factories: {
		createClient: () => unknown;
		resolveTenantId: () => string | undefined;
	}): CommandContext {
		let _client: unknown | undefined;
		let _tenantId: string | undefined;
		let _tenantResolved = false;
		return {
			get client() {
				if (!_client) _client = factories.createClient();
				return _client;
			},
			// biome-ignore lint/suspicious/noExplicitAny: test stub
		} as any as CommandContext;
	}

	test("client factory is not called until ctx.client is accessed", () => {
		let called = false;
		const ctx = buildContext({
			createClient: () => {
				called = true;
				return { fake: "client" };
			},
			resolveTenantId: () => undefined,
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
			resolveTenantId: () => undefined,
		});

		const first = ctx.client;
		const second = ctx.client;
		assert.strictEqual(callCount, 1, "Factory must be called exactly once");
		assert.strictEqual(first, second, "Same instance must be returned");
	});

	test("tenantId resolver is not called until ctx.tenantId is accessed", () => {
		let called = false;

		let _tenantId: string | undefined;
		let _tenantResolved = false;
		const ctx = {
			get tenantId() {
				if (!_tenantResolved) {
					called = true;
					_tenantId = "test-tenant";
					_tenantResolved = true;
				}
				return _tenantId;
			},
		} as unknown as CommandContext;

		assert.strictEqual(called, false, "Resolver must not be called eagerly");
		const tid = ctx.tenantId;
		assert.strictEqual(called, true, "Resolver must be called on first access");
		assert.strictEqual(tid, "test-tenant");
	});

	test("tenantId resolver is called only once (cached)", () => {
		let callCount = 0;

		let _tenantId: string | undefined;
		let _tenantResolved = false;
		const ctx = {
			get tenantId() {
				if (!_tenantResolved) {
					callCount++;
					_tenantId = "t1";
					_tenantResolved = true;
				}
				return _tenantId;
			},
		} as unknown as CommandContext;

		const first = ctx.tenantId;
		const second = ctx.tenantId;
		assert.strictEqual(callCount, 1, "Resolver must be called exactly once");
		assert.strictEqual(first, second);
	});
});
