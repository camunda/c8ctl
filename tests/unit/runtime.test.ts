/**
 * Unit tests for c8ctl runtime object
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import {
	c8ctl,
	type NpmRunOptionsWithOutput,
	type NpmRunOptionsWithoutOutput,
} from "../../src/core/runtime.ts";

/** Args every `npmStub` invocation was called with, newest last. */
const npmCalls: string[][] = [];

/** Stands in for the real cross-platform npm runner injected by the composition root. */
function npmStub(options: NpmRunOptionsWithOutput): { stdout: string };
function npmStub(options: NpmRunOptionsWithoutOutput): undefined;
function npmStub({
	args,
	...opts
}: NpmRunOptionsWithOutput | NpmRunOptionsWithoutOutput):
	| { stdout: string }
	| undefined {
	npmCalls.push([...args]);
	return opts.stdout ? { stdout: "<stub-stdout>" } : undefined;
}

describe("c8ctl Runtime", () => {
	test("should have env property", () => {
		assert.ok(c8ctl.env, "c8ctl.env exists");
	});

	test("env should contain version", () => {
		assert.ok(typeof c8ctl.env.version === "string", "version is a string");
	});

	test("env should contain nodeVersion", () => {
		assert.ok(c8ctl.env.nodeVersion, "nodeVersion exists");
		assert.ok(
			c8ctl.env.nodeVersion.startsWith("v"),
			"nodeVersion starts with v",
		);
	});

	test("env should contain platform", () => {
		assert.ok(c8ctl.env.platform, "platform exists");
		assert.ok(
			["darwin", "linux", "win32"].includes(c8ctl.env.platform),
			"platform is valid",
		);
	});

	test("env should contain arch", () => {
		assert.ok(c8ctl.env.arch, "arch exists");
	});

	test("env should contain cwd", () => {
		assert.ok(c8ctl.env.cwd, "cwd exists");
		assert.strictEqual(
			c8ctl.env.cwd,
			process.cwd(),
			"cwd matches process.cwd()",
		);
	});

	test("env should contain rootDir", () => {
		assert.ok(c8ctl.env.rootDir, "rootDir exists");
	});

	test("should have activeProfile property with undefined default", () => {
		// Note: This property may have been set by previous tests in the same process
		// We just verify it's the correct type
		const profile = c8ctl.activeProfile;
		assert.ok(
			profile === undefined || typeof profile === "string",
			"activeProfile is undefined or string",
		);
	});

	test("should be able to set and get activeProfile", () => {
		const testProfile = "test-profile";
		c8ctl.activeProfile = testProfile;
		assert.strictEqual(
			c8ctl.activeProfile,
			testProfile,
			"activeProfile can be set and retrieved",
		);

		// Clean up
		c8ctl.activeProfile = undefined;
	});

	test("should have activeTenant property with undefined default", () => {
		// Note: This property may have been set by previous tests in the same process
		// We just verify it's the correct type
		const tenant = c8ctl.activeTenant;
		assert.ok(
			tenant === undefined || typeof tenant === "string",
			"activeTenant is undefined or string",
		);
	});

	test("should be able to set and get activeTenant", () => {
		const testTenant = "test-tenant";
		c8ctl.activeTenant = testTenant;
		assert.strictEqual(
			c8ctl.activeTenant,
			testTenant,
			"activeTenant can be set and retrieved",
		);

		// Clean up
		c8ctl.activeTenant = undefined;
	});

	test("should have outputMode property", () => {
		// Verify outputMode is always set to either 'text' or 'json'
		assert.ok(
			c8ctl.outputMode === "text" || c8ctl.outputMode === "json",
			"outputMode is text or json",
		);
	});

	test("should be able to set and get outputMode", () => {
		c8ctl.outputMode = "json";
		assert.strictEqual(
			c8ctl.outputMode,
			"json",
			"outputMode can be set to json",
		);

		c8ctl.outputMode = "text";
		assert.strictEqual(
			c8ctl.outputMode,
			"text",
			"outputMode can be set back to text",
		);
	});
});

/**
 * Injected-dependency seam.
 *
 * `core/` may not import `utils/`, so the cross-platform npm runner reaches
 * the runtime through `init()` like every other injected capability. These
 * tests pin both halves of that seam: the pre-init guard and the delegation.
 *
 * Order matters — `init()` may only be called once per process, so the
 * pre-init assertion has to run first. Unit tests use per-file process
 * isolation, so this file owns a fresh, uninitialised singleton.
 */
describe("c8ctl.npm (injected dependency)", () => {
	const stubDeps = {
		createClient: () => {
			throw new Error("not used by these tests");
		},
		resolveTenantId: () => "<test-tenant>",
		getLogger: () => {
			throw new Error("not used by these tests");
		},
		getUserDataDir: () => "/tmp/c8ctl-runtime-test",
		npm: npmStub,
	};

	test("throws a pointed error before init()", () => {
		assert.throws(
			() => c8ctl.npm({ args: ["--version"], stdout: true }),
			/init\(\) must be called before npm\(\)/,
			"npm() names the missing init() call rather than failing on undefined",
		);
	});

	test("delegates to the injected runner and returns its stdout", () => {
		c8ctl.init(stubDeps);
		npmCalls.length = 0;

		const result = c8ctl.npm({ args: ["--version"], stdout: true });

		assert.deepStrictEqual(
			npmCalls,
			[["--version"]],
			"args are passed through",
		);
		assert.strictEqual(result.stdout, "<stub-stdout>", "stdout is returned");
	});

	test("delegates the no-output overload and returns undefined", () => {
		npmCalls.length = 0;

		const result = c8ctl.npm({ args: ["install", "pkg"], stdio: "ignore" });

		assert.deepStrictEqual(npmCalls, [["install", "pkg"]]);
		assert.strictEqual(result, undefined);
	});
});
