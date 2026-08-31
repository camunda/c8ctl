/**
 * Tests for profile management features:
 * - env var conflict warning
 * - --from-file for add profile
 * - --from-env for add profile
 * - use profile --none
 * - --header / --exactBaseUrl for gateway-fronted profiles (#547)
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	addProfile,
	clearActiveProfile,
	envVarsToProfile,
	getProfile,
	hasCamundaEnvVars,
	loadSessionState,
	parseEnvFile,
	parseHeaderFlags,
	resolveClusterConfig,
} from "../../src/core/config.ts";
import { c8ctl } from "../../src/core/runtime.ts";

const CLI_ENTRY = join(process.cwd(), "src", "index.ts");

describe("Profile management", () => {
	describe("parseEnvFile", () => {
		test("parses simple KEY=VALUE pairs", () => {
			const result = parseEnvFile("FOO=bar\nBAZ=qux");
			assert.strictEqual(result.FOO, "bar");
			assert.strictEqual(result.BAZ, "qux");
		});

		test("ignores comments and blank lines", () => {
			const result = parseEnvFile("# comment\n\nFOO=bar\n  # another comment");
			assert.deepStrictEqual(Object.keys(result), ["FOO"]);
		});

		test("strips export prefix", () => {
			const result = parseEnvFile(
				"export CAMUNDA_BASE_URL=https://example.com",
			);
			assert.strictEqual(result.CAMUNDA_BASE_URL, "https://example.com");
		});

		test("strips single quotes", () => {
			const result = parseEnvFile("FOO='bar baz'");
			assert.strictEqual(result.FOO, "bar baz");
		});

		test("strips double quotes", () => {
			const result = parseEnvFile('FOO="bar baz"');
			assert.strictEqual(result.FOO, "bar baz");
		});

		test("handles values with = in them", () => {
			const result = parseEnvFile("FOO=bar=baz");
			assert.strictEqual(result.FOO, "bar=baz");
		});

		test("skips lines without =", () => {
			const result = parseEnvFile("INVALID_LINE\nFOO=bar");
			assert.deepStrictEqual(Object.keys(result), ["FOO"]);
		});
	});

	describe("envVarsToProfile", () => {
		test("maps CAMUNDA_* vars to profile fields", () => {
			const profile = envVarsToProfile("test", {
				CAMUNDA_BASE_URL: "https://example.com/v2",
				CAMUNDA_CLIENT_ID: "my-client",
				CAMUNDA_CLIENT_SECRET: "secret",
				CAMUNDA_OAUTH_URL: "https://auth.example.com/token",
				CAMUNDA_TOKEN_AUDIENCE: "zeebe.example.com",
				CAMUNDA_OAUTH_SCOPE: "api://my-app/.default",
				UNRELATED_VAR: "ignored",
			});
			assert.strictEqual(profile.name, "test");
			assert.strictEqual(profile.baseUrl, "https://example.com/v2");
			assert.strictEqual(profile.clientId, "my-client");
			assert.strictEqual(profile.clientSecret, "secret");
			assert.strictEqual(profile.oAuthUrl, "https://auth.example.com/token");
			assert.strictEqual(profile.audience, "zeebe.example.com");
			assert.strictEqual(profile.scope, "api://my-app/.default");
		});

		test("maps Basic auth vars", () => {
			const profile = envVarsToProfile("basic", {
				CAMUNDA_BASE_URL: "http://localhost:8080/v2",
				CAMUNDA_USERNAME: "demo",
				CAMUNDA_PASSWORD: "demo",
			});
			assert.strictEqual(profile.username, "demo");
			assert.strictEqual(profile.password, "demo");
		});

		test("maps tenant ID", () => {
			const profile = envVarsToProfile("tenant-test", {
				CAMUNDA_BASE_URL: "http://localhost:8080/v2",
				CAMUNDA_DEFAULT_TENANT_ID: "my-tenant",
			});
			assert.strictEqual(profile.defaultTenantId, "my-tenant");
		});

		test("ignores undefined values", () => {
			const profile = envVarsToProfile("sparse", {
				CAMUNDA_BASE_URL: "http://localhost:8080/v2",
				CAMUNDA_CLIENT_ID: undefined,
			});
			assert.strictEqual(profile.baseUrl, "http://localhost:8080/v2");
			assert.strictEqual(profile.clientId, undefined);
		});
	});

	describe("hasCamundaEnvVars", () => {
		let originalEnv: NodeJS.ProcessEnv;

		beforeEach(() => {
			originalEnv = { ...process.env };
		});

		afterEach(() => {
			process.env = originalEnv;
		});

		test("returns true when CAMUNDA_BASE_URL is set", () => {
			process.env.CAMUNDA_BASE_URL = "https://example.com";
			assert.strictEqual(hasCamundaEnvVars(), true);
		});

		test("returns true when CAMUNDA_CLIENT_ID is set", () => {
			process.env.CAMUNDA_CLIENT_ID = "my-client";
			assert.strictEqual(hasCamundaEnvVars(), true);
		});

		test("returns false when no CAMUNDA_* credential vars are set", () => {
			delete process.env.CAMUNDA_BASE_URL;
			delete process.env.CAMUNDA_CLIENT_ID;
			delete process.env.CAMUNDA_CLIENT_SECRET;
			delete process.env.CAMUNDA_USERNAME;
			delete process.env.CAMUNDA_PASSWORD;
			assert.strictEqual(hasCamundaEnvVars(), false);
		});
	});

	describe("env var conflict warning", () => {
		let testDataDir: string;
		let originalEnv: NodeJS.ProcessEnv;
		let consoleErrorSpy: string[];
		let consoleLogSpy: string[];
		let originalError: typeof console.error;
		let originalLog: typeof console.log;

		beforeEach(() => {
			testDataDir = join(tmpdir(), `c8ctl-conflict-${Date.now()}`);
			mkdirSync(testDataDir, { recursive: true });
			originalEnv = { ...process.env };
			process.env.C8CTL_DATA_DIR = testDataDir;
			consoleErrorSpy = [];
			consoleLogSpy = [];
			originalError = console.error;
			originalLog = console.log;
			console.error = (...args: unknown[]) => {
				consoleErrorSpy.push(args.join(" "));
			};
			console.log = (...args: unknown[]) => {
				consoleLogSpy.push(args.join(" "));
			};
			c8ctl.activeProfile = undefined;
			c8ctl.outputMode = "text";
		});

		afterEach(() => {
			console.error = originalError;
			console.log = originalLog;
			if (existsSync(testDataDir)) {
				rmSync(testDataDir, { recursive: true, force: true });
			}
			process.env = originalEnv;
			c8ctl.activeProfile = undefined;
		});

		test("warns when session profile active and CAMUNDA_BASE_URL is set", () => {
			addProfile({
				name: "my-profile",
				baseUrl: "https://profile-cluster.example.com",
				username: "admin",
				password: "secret",
			});
			c8ctl.activeProfile = "my-profile";
			process.env.CAMUNDA_BASE_URL = "https://env-cluster.example.com";

			const config = resolveClusterConfig();

			// Profile should win
			assert.strictEqual(config.baseUrl, "https://profile-cluster.example.com");
			// Warning on stderr, hints on stdout
			const allOutput = `${consoleErrorSpy.join("\n")}\n${consoleLogSpy.join("\n")}`;
			assert.ok(
				allOutput.includes(
					"Active profile 'my-profile' is overriding CAMUNDA_*",
				),
				`Expected env var conflict warning, got:\nstderr: ${consoleErrorSpy.join("\n")}\nstdout: ${consoleLogSpy.join("\n")}`,
			);
			assert.ok(
				allOutput.includes("use profile --none"),
				`Expected --none hint, got:\nstderr: ${consoleErrorSpy.join("\n")}\nstdout: ${consoleLogSpy.join("\n")}`,
			);
		});

		test("no warning when using --profile flag", () => {
			addProfile({
				name: "explicit",
				baseUrl: "https://explicit-cluster.example.com",
			});
			process.env.CAMUNDA_BASE_URL = "https://env-cluster.example.com";

			resolveClusterConfig("explicit");

			const allOutput = consoleErrorSpy.join("\n") + consoleLogSpy.join("\n");
			assert.ok(
				!allOutput.includes("overriding"),
				"Should not warn when --profile flag is used",
			);
		});

		test("no warning when no CAMUNDA_* env vars are present", () => {
			addProfile({
				name: "clean-profile",
				baseUrl: "https://clean-cluster.example.com",
			});
			c8ctl.activeProfile = "clean-profile";
			delete process.env.CAMUNDA_BASE_URL;
			delete process.env.CAMUNDA_CLIENT_ID;
			delete process.env.CAMUNDA_CLIENT_SECRET;
			delete process.env.CAMUNDA_USERNAME;
			delete process.env.CAMUNDA_PASSWORD;

			resolveClusterConfig();

			const allOutput = consoleErrorSpy.join("\n") + consoleLogSpy.join("\n");
			assert.ok(
				!allOutput.includes("overriding"),
				"Should not warn when no env vars conflict",
			);
		});
	});

	describe("clearActiveProfile", () => {
		let testDataDir: string;
		let originalEnv: NodeJS.ProcessEnv;

		beforeEach(() => {
			testDataDir = join(tmpdir(), `c8ctl-clear-${Date.now()}`);
			mkdirSync(testDataDir, { recursive: true });
			originalEnv = { ...process.env };
			process.env.C8CTL_DATA_DIR = testDataDir;
			c8ctl.activeProfile = undefined;
		});

		afterEach(() => {
			if (existsSync(testDataDir)) {
				rmSync(testDataDir, { recursive: true, force: true });
			}
			process.env = originalEnv;
			c8ctl.activeProfile = undefined;
		});

		test("clears the active profile", () => {
			loadSessionState();
			c8ctl.activeProfile = "my-profile";
			clearActiveProfile();
			assert.strictEqual(c8ctl.activeProfile, undefined);
		});
	});

	describe("CLI: c8 add profile --from-file", () => {
		test("creates a profile from a .env file", () => {
			const testDataDir = join(tmpdir(), `c8ctl-envfile-${Date.now()}`);
			const envFilePath = join(testDataDir, ".env.test");
			mkdirSync(testDataDir, { recursive: true });
			writeFileSync(
				envFilePath,
				[
					"CAMUNDA_BASE_URL=https://staging.example.com/v2",
					"CAMUNDA_CLIENT_ID=staging-client",
					"CAMUNDA_CLIENT_SECRET=staging-secret",
					"CAMUNDA_OAUTH_URL=https://auth.example.com/token",
				].join("\n"),
			);

			const result = spawnSync(
				"node",
				[
					"--experimental-strip-types",
					CLI_ENTRY,
					"add",
					"profile",
					"staging-test",
					`--from-file=${envFilePath}`,
				],
				{
					encoding: "utf-8",
					timeout: 5000,
					env: { ...process.env, C8CTL_DATA_DIR: testDataDir },
				},
			);

			const output = (result.stdout ?? "") + (result.stderr ?? "");
			assert.ok(
				output.includes("Profile 'staging-test' added"),
				`Expected success, got: ${output}`,
			);
			assert.match(
				output,
				/Base URL: https:\/\/staging\.example\.com\/v2/,
				`Expected base URL in output, got: ${output}`,
			);
			assert.ok(
				output.includes("OAuth"),
				`Expected auth type in output, got: ${output}`,
			);
			assert.strictEqual(result.status, 0);

			rmSync(testDataDir, { recursive: true, force: true });
		});

		test("errors when .env file is missing", () => {
			const testDataDir = join(tmpdir(), `c8ctl-envfile-missing-${Date.now()}`);
			mkdirSync(testDataDir, { recursive: true });

			const result = spawnSync(
				"node",
				[
					"--experimental-strip-types",
					CLI_ENTRY,
					"add",
					"profile",
					"missing-test",
					"--from-file=/nonexistent/.env",
				],
				{
					encoding: "utf-8",
					timeout: 5000,
					env: { ...process.env, C8CTL_DATA_DIR: testDataDir },
				},
			);

			const output = (result.stdout ?? "") + (result.stderr ?? "");
			assert.ok(
				output.includes("File not found"),
				`Expected file-not-found error, got: ${output}`,
			);
			assert.notStrictEqual(result.status, 0);

			rmSync(testDataDir, { recursive: true, force: true });
		});

		test("errors when .env file lacks CAMUNDA_BASE_URL", () => {
			const testDataDir = join(tmpdir(), `c8ctl-envfile-nourl-${Date.now()}`);
			const envFilePath = join(testDataDir, ".env.nourl");
			mkdirSync(testDataDir, { recursive: true });
			writeFileSync(envFilePath, "CAMUNDA_CLIENT_ID=some-client\n");

			const result = spawnSync(
				"node",
				[
					"--experimental-strip-types",
					CLI_ENTRY,
					"add",
					"profile",
					"nourl-test",
					`--from-file=${envFilePath}`,
				],
				{
					encoding: "utf-8",
					timeout: 5000,
					env: { ...process.env, C8CTL_DATA_DIR: testDataDir },
				},
			);

			const output = (result.stdout ?? "") + (result.stderr ?? "");
			assert.ok(
				output.includes("CAMUNDA_BASE_URL not found"),
				`Expected missing URL error, got: ${output}`,
			);
			assert.notStrictEqual(result.status, 0);

			rmSync(testDataDir, { recursive: true, force: true });
		});
	});

	describe("CLI: c8 add profile --from-env", () => {
		test("creates a profile from current environment", () => {
			const testDataDir = join(tmpdir(), `c8ctl-fromenv-${Date.now()}`);
			mkdirSync(testDataDir, { recursive: true });

			const result = spawnSync(
				"node",
				[
					"--experimental-strip-types",
					CLI_ENTRY,
					"add",
					"profile",
					"env-test",
					"--from-env",
				],
				{
					encoding: "utf-8",
					timeout: 5000,
					env: {
						...process.env,
						C8CTL_DATA_DIR: testDataDir,
						CAMUNDA_BASE_URL: "https://from-env.example.com/v2",
						CAMUNDA_USERNAME: "admin",
						CAMUNDA_PASSWORD: "secret",
					},
				},
			);

			const output = (result.stdout ?? "") + (result.stderr ?? "");
			assert.ok(
				output.includes("Profile 'env-test' added"),
				`Expected success, got: ${output}`,
			);
			assert.match(
				output,
				/Base URL: https:\/\/from-env\.example\.com\/v2/,
				`Expected base URL, got: ${output}`,
			);
			assert.ok(
				output.includes("Basic"),
				`Expected Basic auth type, got: ${output}`,
			);
			assert.strictEqual(result.status, 0);

			rmSync(testDataDir, { recursive: true, force: true });
		});

		test("errors when CAMUNDA_BASE_URL is not in environment", () => {
			const testDataDir = join(tmpdir(), `c8ctl-fromenv-nourl-${Date.now()}`);
			mkdirSync(testDataDir, { recursive: true });

			// Strip all CAMUNDA_* vars from the child env
			const childEnv: NodeJS.ProcessEnv = {
				...process.env,
				C8CTL_DATA_DIR: testDataDir,
			};
			delete childEnv.CAMUNDA_BASE_URL;
			delete childEnv.CAMUNDA_CLIENT_ID;
			delete childEnv.CAMUNDA_CLIENT_SECRET;
			delete childEnv.CAMUNDA_USERNAME;
			delete childEnv.CAMUNDA_PASSWORD;

			const result = spawnSync(
				"node",
				[
					"--experimental-strip-types",
					CLI_ENTRY,
					"add",
					"profile",
					"fromenv-nourl",
					"--from-env",
				],
				{
					encoding: "utf-8",
					timeout: 5000,
					env: childEnv,
				},
			);

			const output = (result.stdout ?? "") + (result.stderr ?? "");
			assert.ok(
				output.includes("CAMUNDA_BASE_URL not set"),
				`Expected missing URL error, got: ${output}`,
			);
			assert.notStrictEqual(result.status, 0);

			rmSync(testDataDir, { recursive: true, force: true });
		});
	});

	describe("CLI: c8 use profile --none", () => {
		test("clears the active session profile", () => {
			const testDataDir = join(tmpdir(), `c8ctl-none-${Date.now()}`);
			mkdirSync(testDataDir, { recursive: true });

			// First set a profile
			spawnSync(
				"node",
				["--experimental-strip-types", CLI_ENTRY, "use", "profile", "local"],
				{
					encoding: "utf-8",
					timeout: 5000,
					env: { ...process.env, C8CTL_DATA_DIR: testDataDir },
				},
			);

			// Then clear it
			const result = spawnSync(
				"node",
				["--experimental-strip-types", CLI_ENTRY, "use", "profile", "--none"],
				{
					encoding: "utf-8",
					timeout: 5000,
					env: { ...process.env, C8CTL_DATA_DIR: testDataDir },
				},
			);

			const output = (result.stdout ?? "") + (result.stderr ?? "");
			assert.ok(
				output.includes("Session profile cleared"),
				`Expected profile cleared message, got: ${output}`,
			);
			assert.strictEqual(result.status, 0);

			// Verify which profile now shows default
			const whichResult = spawnSync(
				"node",
				["--experimental-strip-types", CLI_ENTRY, "which", "profile"],
				{
					encoding: "utf-8",
					timeout: 5000,
					env: { ...process.env, C8CTL_DATA_DIR: testDataDir },
				},
			);
			const whichOutput =
				(whichResult.stdout ?? "") + (whichResult.stderr ?? "");
			assert.ok(
				whichOutput.includes("local (default)"),
				`Expected default profile shown, got: ${whichOutput}`,
			);

			rmSync(testDataDir, { recursive: true, force: true });
		});
	});

	describe("parseHeaderFlags", () => {
		test("parses a single 'Name: value' entry", () => {
			const headers = parseHeaderFlags(["X-Api-Key: secret"]);
			assert.deepStrictEqual(headers, { "X-Api-Key": "secret" });
		});

		test("parses multiple entries", () => {
			const headers = parseHeaderFlags([
				"X-Api-Key: secret",
				"X-Correlation-Id: abc-123",
			]);
			assert.deepStrictEqual(headers, {
				"X-Api-Key": "secret",
				"X-Correlation-Id": "abc-123",
			});
		});

		test("trims whitespace around name and value", () => {
			const headers = parseHeaderFlags(["  X-Api-Key  :  secret  "]);
			assert.deepStrictEqual(headers, { "X-Api-Key": "secret" });
		});

		test("splits on the first colon only, preserving colons in the value", () => {
			const headers = parseHeaderFlags(["Authorization: Bearer abc:def"]);
			assert.deepStrictEqual(headers, { Authorization: "Bearer abc:def" });
		});

		test("throws when a header is missing its colon separator", () => {
			assert.throws(
				() => parseHeaderFlags(["NoColonHere"]),
				/Invalid --header "NoColonHere"/,
			);
		});

		test("throws when the header name is empty", () => {
			assert.throws(
				() => parseHeaderFlags([": value"]),
				/header name must not be empty/,
			);
		});

		test("allows an empty value", () => {
			const headers = parseHeaderFlags(["X-Empty:"]);
			assert.deepStrictEqual(headers, { "X-Empty": "" });
		});

		test("a later --header replaces an earlier one differing only in case", () => {
			// HTTP header names are case-insensitive — persisting both
			// "Authorization" and "authorization" would be confusing and
			// redundant, and the last one supplied should win.
			const headers = parseHeaderFlags([
				"Authorization: Bearer old",
				"authorization: Bearer new",
			]);
			assert.deepStrictEqual(headers, { authorization: "Bearer new" });
		});

		test("accepts every character allowed in an HTTP header token", () => {
			const headers = parseHeaderFlags(["X-Api!#$%&'*+-.^_`|~Key: secret"]);
			assert.deepStrictEqual(headers, {
				"X-Api!#$%&'*+-.^_`|~Key": "secret",
			});
		});

		test("throws when the header name contains a space", () => {
			assert.throws(
				() => parseHeaderFlags(["Bad Name: value"]),
				/Invalid --header "Bad Name: value" — header name "Bad Name" is not a valid HTTP token/,
			);
		});

		test("throws when the header name contains a colon-illegal character", () => {
			assert.throws(
				() => parseHeaderFlags(['X-"Quoted": value']),
				/is not a valid HTTP token/,
			);
		});

		test("throws when the header value contains a line break", () => {
			// The offending entry itself contains \r\n, so the thrown
			// message spans multiple lines — match with [\s\S] instead of
			// "." (which doesn't cross a newline by default).
			assert.throws(
				() => parseHeaderFlags(["X-Foo: bar\r\nEvil: 1"]),
				/Invalid --header [\s\S]* — header value must not contain a line break/,
			);
		});

		test("throws when the header value contains only a newline", () => {
			assert.throws(
				() => parseHeaderFlags(["X-Foo: bar\nEvil: 1"]),
				/header value must not contain a line break/,
			);
		});
	});

	/**
	 * Read a persisted profile from a specific data dir. Restores whatever
	 * C8CTL_DATA_DIR held before (via `finally`) even if getProfile() throws,
	 * so a failed assertion can't leak the override into later tests running
	 * in this same process.
	 */
	function getProfileFromDataDir(
		dataDir: string,
		name: string,
	): ReturnType<typeof getProfile> {
		const original = process.env.C8CTL_DATA_DIR;
		process.env.C8CTL_DATA_DIR = dataDir;
		try {
			return getProfile(name);
		} finally {
			if (original === undefined) {
				delete process.env.C8CTL_DATA_DIR;
			} else {
				process.env.C8CTL_DATA_DIR = original;
			}
		}
	}

	describe("CLI: c8 add profile --header / --exactBaseUrl (#547)", () => {
		let testDataDir: string;

		beforeEach(() => {
			// mkdtempSync (not a Date.now()-suffixed name) avoids a directory
			// collision if another test file's worker process happens to
			// create its own temp dir in the same millisecond.
			testDataDir = mkdtempSync(join(tmpdir(), "c8ctl-gateway-"));
		});

		afterEach(() => {
			if (existsSync(testDataDir)) {
				rmSync(testDataDir, { recursive: true, force: true });
			}
		});

		test("stores a single --header on the profile", () => {
			const result = spawnSync(
				"node",
				[
					"--experimental-strip-types",
					CLI_ENTRY,
					"add",
					"profile",
					"gateway",
					"--baseUrl=https://gateway.example.com/camunda-api",
					"--header",
					"X-Api-Key: secret",
				],
				{
					encoding: "utf-8",
					timeout: 5000,
					env: { ...process.env, C8CTL_DATA_DIR: testDataDir },
				},
			);

			assert.strictEqual(
				result.status,
				0,
				`stdout: ${result.stdout}\nstderr: ${result.stderr}`,
			);
			assert.ok(
				(result.stdout ?? "").includes("Headers: X-Api-Key"),
				`Expected header name in output, got: ${result.stdout}`,
			);

			const profile = getProfileFromDataDir(testDataDir, "gateway");

			assert.ok(profile);
			assert.deepStrictEqual(profile.headers, { "X-Api-Key": "secret" });
		});

		test("repeating --header collects every value", () => {
			const result = spawnSync(
				"node",
				[
					"--experimental-strip-types",
					CLI_ENTRY,
					"add",
					"profile",
					"gateway-multi",
					"--baseUrl=https://gateway.example.com/camunda-api",
					"--header",
					"X-Api-Key: secret",
					"--header",
					"X-Correlation-Id: abc-123",
				],
				{
					encoding: "utf-8",
					timeout: 5000,
					env: { ...process.env, C8CTL_DATA_DIR: testDataDir },
				},
			);

			assert.strictEqual(
				result.status,
				0,
				`stdout: ${result.stdout}\nstderr: ${result.stderr}`,
			);

			const profile = getProfileFromDataDir(testDataDir, "gateway-multi");

			assert.ok(profile);
			assert.deepStrictEqual(profile.headers, {
				"X-Api-Key": "secret",
				"X-Correlation-Id": "abc-123",
			});
		});

		test("--exactBaseUrl is stored on the profile", () => {
			const result = spawnSync(
				"node",
				[
					"--experimental-strip-types",
					CLI_ENTRY,
					"add",
					"profile",
					"gateway-exact",
					"--baseUrl=https://gateway.example.com/camunda-api",
					"--exactBaseUrl",
				],
				{
					encoding: "utf-8",
					timeout: 5000,
					env: { ...process.env, C8CTL_DATA_DIR: testDataDir },
				},
			);

			assert.strictEqual(
				result.status,
				0,
				`stdout: ${result.stdout}\nstderr: ${result.stderr}`,
			);
			assert.ok(
				(result.stdout ?? "").includes("used exactly as given"),
				`Expected exact-base-url note in output, got: ${result.stdout}`,
			);

			const profile = getProfileFromDataDir(testDataDir, "gateway-exact");

			assert.ok(profile);
			assert.strictEqual(profile.exactBaseUrl, true);
			assert.strictEqual(
				profile.baseUrl,
				"https://gateway.example.com/camunda-api",
			);
		});

		test("errors on a malformed --header value", () => {
			const result = spawnSync(
				"node",
				[
					"--experimental-strip-types",
					CLI_ENTRY,
					"add",
					"profile",
					"gateway-bad-header",
					"--baseUrl=https://gateway.example.com/camunda-api",
					"--header",
					"NoColonHere",
				],
				{
					encoding: "utf-8",
					timeout: 5000,
					env: { ...process.env, C8CTL_DATA_DIR: testDataDir },
				},
			);

			assert.notStrictEqual(result.status, 0);
			const output = (result.stdout ?? "") + (result.stderr ?? "");
			assert.ok(
				output.includes("Invalid --header"),
				`Expected invalid header error, got: ${output}`,
			);

			const profile = getProfileFromDataDir(testDataDir, "gateway-bad-header");
			assert.strictEqual(
				profile,
				undefined,
				"Profile must not be persisted when --header is invalid",
			);
		});

		test("profiles without --header or --exactBaseUrl behave exactly as before", () => {
			const result = spawnSync(
				"node",
				[
					"--experimental-strip-types",
					CLI_ENTRY,
					"add",
					"profile",
					"plain",
					"--baseUrl=https://plain.example.com/v2",
				],
				{
					encoding: "utf-8",
					timeout: 5000,
					env: { ...process.env, C8CTL_DATA_DIR: testDataDir },
				},
			);

			assert.strictEqual(result.status, 0);
			const output = (result.stdout ?? "") + (result.stderr ?? "");
			assert.ok(!output.includes("Headers:"));
			assert.ok(!output.includes("used exactly as given"));

			const profile = getProfileFromDataDir(testDataDir, "plain");

			assert.ok(profile);
			assert.strictEqual(profile.headers, undefined);
			assert.strictEqual(profile.exactBaseUrl, undefined);
		});
	});
});
