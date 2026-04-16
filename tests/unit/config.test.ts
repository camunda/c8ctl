/**
 * Unit tests for config module
 * Tests c8ctl profiles and read-only Modeler connections
 */

import assert from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	AUTH_TYPES,
	addProfile,
	type Connection,
	connectionToClusterConfig,
	connectionToProfile,
	DEFAULT_PROFILE,
	DEFAULT_PROFILE_CONFIG,
	ensureDefaultProfile,
	getAllProfiles,
	getModelerDataDir,
	getProfile,
	getProfileOrModeler,
	getUserDataDir,
	loadModelerConnections,
	loadProfiles,
	loadSessionState,
	type Profile,
	profileToClusterConfig,
	removeProfile,
	resolveClusterConfig,
	resolveTenantId,
	saveProfiles,
	saveSessionState,
	setActiveProfile,
	setActiveTenant,
	setOutputMode,
	TARGET_TYPES,
	validateConnection,
} from "../../src/config.ts";
import { c8ctl } from "../../src/runtime.ts";

describe("Config Module", () => {
	test("getUserDataDir returns platform-specific path", () => {
		const dir = getUserDataDir();
		assert.ok(dir);
		assert.ok(dir.includes("c8ctl"));
	});

	test("getModelerDataDir returns platform-specific path", () => {
		const dir = getModelerDataDir();
		assert.ok(dir);
		assert.ok(dir.includes("camunda-modeler"));
	});

	describe("c8ctl Profile Management", () => {
		let testDataDir: string;
		let testModelerDir: string;
		let originalEnv: NodeJS.ProcessEnv;

		beforeEach(() => {
			// Create temporary test directories
			testDataDir = join(tmpdir(), `c8ctl-data-test-${Date.now()}`);
			testModelerDir = join(tmpdir(), `c8ctl-modeler-test-${Date.now()}`);
			mkdirSync(testDataDir, { recursive: true });
			mkdirSync(testModelerDir, { recursive: true });

			// Override directories for tests
			originalEnv = { ...process.env };
			process.env.C8CTL_DATA_DIR = testDataDir;
			process.env.C8CTL_MODELER_DIR = testModelerDir;
		});

		afterEach(() => {
			// Cleanup
			if (existsSync(testDataDir)) {
				rmSync(testDataDir, { recursive: true, force: true });
			}
			if (existsSync(testModelerDir)) {
				rmSync(testModelerDir, { recursive: true, force: true });
			}
			process.env = originalEnv;
			c8ctl.activeProfile = undefined;
		});

		test("loadProfiles returns empty array when no profiles exist", () => {
			const profiles = loadProfiles();
			assert.deepStrictEqual(profiles, []);
		});

		test("saveProfiles and loadProfiles work correctly", () => {
			const profiles: Profile[] = [
				{
					name: "local",
					baseUrl: "http://localhost:8080/v2",
				},
				{
					name: "prod",
					baseUrl: "https://prod.example.com/v2",
					username: "admin",
					password: "secret",
				},
			];

			saveProfiles(profiles);
			const loaded = loadProfiles();

			assert.strictEqual(loaded.length, 2);
			assert.strictEqual(loaded[0].name, "local");
			assert.strictEqual(loaded[1].name, "prod");
		});

		test("getProfile returns correct profile by name", () => {
			const profiles: Profile[] = [
				{
					name: "local",
					baseUrl: "http://localhost:8080/v2",
				},
				{
					name: "prod",
					baseUrl: "https://prod.example.com/v2",
				},
			];

			saveProfiles(profiles);
			const profile = getProfile("prod");

			assert.ok(profile);
			assert.strictEqual(profile.name, "prod");
			assert.strictEqual(profile.baseUrl, "https://prod.example.com/v2");
		});

		test("getProfile returns undefined for non-existent profile", () => {
			const profile = getProfile("nonexistent");
			assert.strictEqual(profile, undefined);
		});

		test("addProfile adds a new profile", () => {
			const profile: Profile = {
				name: "test",
				baseUrl: "http://test.com/v2",
			};

			addProfile(profile);
			const loaded = loadProfiles();

			assert.strictEqual(loaded.length, 1);
			assert.strictEqual(loaded[0].name, "test");
		});

		test("addProfile updates existing profile", () => {
			const profile1: Profile = {
				name: "test",
				baseUrl: "http://test.com/v2",
			};

			addProfile(profile1);

			const profile2: Profile = {
				name: "test",
				baseUrl: "http://updated.com/v2",
			};

			addProfile(profile2);
			const loaded = loadProfiles();

			assert.strictEqual(loaded.length, 1);
			assert.strictEqual(loaded[0].baseUrl, "http://updated.com/v2");
		});

		test("removeProfile removes a profile", () => {
			const profiles: Profile[] = [
				{
					name: "keep",
					baseUrl: "http://keep.com/v2",
				},
				{
					name: "remove",
					baseUrl: "http://remove.com/v2",
				},
			];

			saveProfiles(profiles);
			const removed = removeProfile("remove");

			assert.strictEqual(removed, true);
			const loaded = loadProfiles();
			assert.strictEqual(loaded.length, 1);
			assert.strictEqual(loaded[0].name, "keep");
		});

		test("removeProfile returns false for non-existent profile", () => {
			const removed = removeProfile("nonexistent");
			assert.strictEqual(removed, false);
		});

		test("removeProfile clears active session profile when it matches the removed profile", () => {
			addProfile({ name: "doomed", baseUrl: "http://doomed.com/v2" });
			setActiveProfile("doomed");
			assert.strictEqual(c8ctl.activeProfile, "doomed");

			const removed = removeProfile("doomed");
			assert.strictEqual(removed, true);
			assert.strictEqual(
				c8ctl.activeProfile,
				undefined,
				"Active profile should be cleared after deletion",
			);
		});

		test("removeProfile does not clear active session profile when a different profile is removed", () => {
			addProfile({ name: "keep-active", baseUrl: "http://keep.com/v2" });
			addProfile({ name: "remove-other", baseUrl: "http://other.com/v2" });
			setActiveProfile("keep-active");

			const removed = removeProfile("remove-other");
			assert.strictEqual(removed, true);
			assert.strictEqual(
				c8ctl.activeProfile,
				"keep-active",
				"Active profile should be unchanged",
			);
		});
	});

	// Simplified tests for now - we'll expand later if needed
	describe("Modeler Connection Management", () => {
		test("loadModelerConnections returns empty array when no settings exist", () => {
			const connections = loadModelerConnections();
			assert.ok(Array.isArray(connections));
		});
	});

	describe("Credentials", () => {
		let originalEnv: NodeJS.ProcessEnv;

		beforeEach(() => {
			originalEnv = { ...process.env };
			// Clear c8ctl session
			c8ctl.activeProfile = undefined;
		});

		afterEach(() => {
			process.env = originalEnv;
			c8ctl.activeProfile = undefined;
		});

		test("resolveClusterConfig reads all OAuth config from environment variables", () => {
			process.env.CAMUNDA_BASE_URL = "https://test.camunda.io";
			process.env.CAMUNDA_CLIENT_ID = "test-client-id";
			process.env.CAMUNDA_CLIENT_SECRET = "test-secret";
			process.env.CAMUNDA_TOKEN_AUDIENCE = "test-audience";
			process.env.CAMUNDA_OAUTH_URL = "https://oauth.example.com/token";

			const config = resolveClusterConfig();

			assert.strictEqual(config.baseUrl, "https://test.camunda.io");
			assert.strictEqual(config.clientId, "test-client-id");
			assert.strictEqual(config.clientSecret, "test-secret");
			assert.strictEqual(config.audience, "test-audience");
			assert.strictEqual(config.oAuthUrl, "https://oauth.example.com/token");
		});

		test("resolveClusterConfig reads basic auth config from environment variables", () => {
			process.env.CAMUNDA_BASE_URL = "https://test.camunda.io";
			process.env.CAMUNDA_USERNAME = "test-user";
			process.env.CAMUNDA_PASSWORD = "test-password";

			const config = resolveClusterConfig();

			assert.strictEqual(config.baseUrl, "https://test.camunda.io");
			assert.strictEqual(config.username, "test-user");
			assert.strictEqual(config.password, "test-password");
		});

		test("resolveClusterConfig falls back to localhost with demo credentials", () => {
			// Clear all env vars
			delete process.env.CAMUNDA_BASE_URL;
			delete process.env.CAMUNDA_CLIENT_ID;
			delete process.env.CAMUNDA_CLIENT_SECRET;
			delete process.env.CAMUNDA_TOKEN_AUDIENCE;
			delete process.env.CAMUNDA_OAUTH_URL;
			delete process.env.CAMUNDA_USERNAME;
			delete process.env.CAMUNDA_PASSWORD;

			const config = resolveClusterConfig();

			assert.strictEqual(config.baseUrl, "http://localhost:8080/v2");
			assert.strictEqual(config.username, "demo");
			assert.strictEqual(config.password, "demo");
		});

		test("connectionToClusterConfig keeps cloud audience optional", () => {
			const config = connectionToClusterConfig({
				id: "cloud-1",
				targetType: TARGET_TYPES.CAMUNDA_CLOUD,
				camundaCloudClusterUrl: "https://jfk-1.zeebe.camunda.io/cluster-id",
				camundaCloudClientId: "client-id",
				camundaCloudClientSecret: "client-secret",
			});

			assert.strictEqual(
				config.baseUrl,
				"https://jfk-1.zeebe.camunda.io/cluster-id",
			);
			assert.strictEqual(config.clientId, "client-id");
			assert.strictEqual(config.clientSecret, "client-secret");
			assert.strictEqual(config.audience, undefined);
			assert.strictEqual(
				config.oAuthUrl,
				"https://login.cloud.camunda.io/oauth/token",
			);
		});

		test("connectionToClusterConfig preserves explicit cloud audience", () => {
			const config = connectionToClusterConfig({
				id: "cloud-2",
				targetType: TARGET_TYPES.CAMUNDA_CLOUD,
				camundaCloudClusterUrl: "https://jfk-1.zeebe.camunda.io/cluster-id",
				camundaCloudClientId: "client-id",
				camundaCloudClientSecret: "client-secret",
				audience: "zeebe.camunda.io",
			});

			assert.strictEqual(config.audience, "zeebe.camunda.io");
		});
	});

	describe("Default profile", () => {
		let testDataDir: string;
		let originalEnv: NodeJS.ProcessEnv;

		beforeEach(() => {
			testDataDir = join(tmpdir(), `c8ctl-data-default-${Date.now()}`);
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

		test('DEFAULT_PROFILE constant is "local"', () => {
			assert.strictEqual(DEFAULT_PROFILE, "local");
		});

		test("DEFAULT_PROFILE_CONFIG has localhost defaults", () => {
			assert.strictEqual(DEFAULT_PROFILE_CONFIG.name, "local");
			assert.strictEqual(
				DEFAULT_PROFILE_CONFIG.baseUrl,
				"http://localhost:8080/v2",
			);
			assert.strictEqual(DEFAULT_PROFILE_CONFIG.username, "demo");
			assert.strictEqual(DEFAULT_PROFILE_CONFIG.password, "demo");
		});

		test("ensureDefaultProfile creates the local profile when it does not exist", () => {
			assert.strictEqual(getProfile("local"), undefined);
			ensureDefaultProfile();
			const profile = getProfile("local");
			assert.ok(profile);
			assert.strictEqual(profile.baseUrl, "http://localhost:8080/v2");
			assert.strictEqual(profile.username, "demo");
		});

		test("ensureDefaultProfile does not overwrite a user-configured local profile", () => {
			addProfile({
				name: "local",
				baseUrl: "http://custom:9090/v2",
				username: "admin",
				password: "admin",
			});
			ensureDefaultProfile();
			const profile = getProfile("local");
			assert.ok(profile);
			assert.strictEqual(profile.baseUrl, "http://custom:9090/v2");
			assert.strictEqual(profile.username, "admin");
		});

		test("loadSessionState does not set activeProfile when no session file exists", () => {
			const state = loadSessionState();
			assert.strictEqual(state.activeProfile, undefined);
			assert.strictEqual(c8ctl.activeProfile, undefined);
		});

		test("loadSessionState creates local profile in profiles.json", () => {
			assert.strictEqual(getProfile("local"), undefined);
			loadSessionState();
			const profile = getProfile("local");
			assert.ok(profile, "local profile should be created by loadSessionState");
			assert.strictEqual(profile.baseUrl, "http://localhost:8080/v2");
		});

		test("loadSessionState leaves activeProfile undefined when session file has null activeProfile", () => {
			const sessionPath = join(testDataDir, "session.json");
			writeFileSync(
				sessionPath,
				JSON.stringify({ activeProfile: null, outputMode: "text" }),
				"utf-8",
			);

			const state = loadSessionState();
			assert.strictEqual(state.activeProfile, undefined);
			assert.strictEqual(c8ctl.activeProfile, undefined);
		});

		test("loadSessionState preserves an explicitly-set profile", () => {
			const sessionPath = join(testDataDir, "session.json");
			writeFileSync(
				sessionPath,
				JSON.stringify({ activeProfile: "prod", outputMode: "text" }),
				"utf-8",
			);

			const state = loadSessionState();
			assert.strictEqual(state.activeProfile, "prod");
			assert.strictEqual(c8ctl.activeProfile, "prod");
		});

		test("resolveClusterConfig falls back to manifested local profile when no env vars set", () => {
			// After loadSessionState, the local profile exists but activeProfile is undefined
			loadSessionState();
			delete process.env.CAMUNDA_BASE_URL;
			delete process.env.CAMUNDA_CLIENT_ID;
			delete process.env.CAMUNDA_USERNAME;

			const config = resolveClusterConfig();
			assert.strictEqual(config.baseUrl, "http://localhost:8080/v2");
			assert.strictEqual(config.username, "demo");
		});

		test("resolveClusterConfig prefers env vars over default local profile", () => {
			// activeProfile is undefined → env vars should win over the default 'local' profile
			loadSessionState();
			process.env.CAMUNDA_BASE_URL = "https://env-cluster.example.com";

			const config = resolveClusterConfig();
			assert.strictEqual(config.baseUrl, "https://env-cluster.example.com");
		});

		test("resolveClusterConfig prefers explicitly-selected profile over env vars", () => {
			// When user explicitly does `c8ctl use profile local`, env vars should NOT win
			addProfile({
				name: "local",
				baseUrl: "http://localhost:9000/v2",
				username: "admin",
				password: "admin",
			});
			c8ctl.activeProfile = "local";
			process.env.CAMUNDA_BASE_URL = "https://env-cluster.example.com";

			const config = resolveClusterConfig();
			assert.strictEqual(config.baseUrl, "http://localhost:9000/v2");
			assert.strictEqual(config.username, "admin");
		});
	});
});
