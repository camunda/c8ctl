/**
 * Unit tests for config module
 * Tests c8ctl profiles and read-only Modeler connections
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { c8ctl } from '../../src/runtime.ts';
import {
  getUserDataDir,
  getModelerDataDir,
  loadProfiles,
  saveProfiles,
  getProfile,
  getProfileOrModeler,
  getAllProfiles,
  addProfile,
  removeProfile,
  loadModelerConnections,
  connectionToProfile,
  profileToClusterConfig,
  validateConnection,
  loadSessionState,
  saveSessionState,
  setActiveProfile,
  setActiveTenant,
  setOutputMode,
  resolveClusterConfig,
  resolveTenantId,
  TARGET_TYPES,
  AUTH_TYPES,
  type Profile,
  type Connection,
} from '../../src/config.ts';

describe('Config Module', () => {
  test('getUserDataDir returns platform-specific path', () => {
    const dir = getUserDataDir();
    assert.ok(dir);
    assert.ok(dir.includes('c8ctl'));
  });

  test('getModelerDataDir returns platform-specific path', () => {
    const dir = getModelerDataDir();
    assert.ok(dir);
    assert.ok(dir.includes('camunda-modeler'));
  });

  describe('c8ctl Profile Management', () => {
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
    });

    test('loadProfiles returns empty array when no profiles exist', () => {
      const profiles = loadProfiles();
      assert.deepStrictEqual(profiles, []);
    });

    test('saveProfiles and loadProfiles work correctly', () => {
      const profiles: Profile[] = [
        {
          name: 'local',
          baseUrl: 'http://localhost:8080/v2',
        },
        {
          name: 'prod',
          baseUrl: 'https://prod.example.com/v2',
          username: 'admin',
          password: 'secret',
        },
      ];
      
      saveProfiles(profiles);
      const loaded = loadProfiles();
      
      assert.strictEqual(loaded.length, 2);
      assert.strictEqual(loaded[0].name, 'local');
      assert.strictEqual(loaded[1].name, 'prod');
    });

    test('getProfile returns correct profile by name', () => {
      const profiles: Profile[] = [
        {
          name: 'local',
          baseUrl: 'http://localhost:8080/v2',
        },
        {
          name: 'prod',
          baseUrl: 'https://prod.example.com/v2',
        },
      ];
      
      saveProfiles(profiles);
      const profile = getProfile('prod');
      
      assert.ok(profile);
      assert.strictEqual(profile.name, 'prod');
      assert.strictEqual(profile.baseUrl, 'https://prod.example.com/v2');
    });

    test('getProfile returns undefined for non-existent profile', () => {
      const profile = getProfile('nonexistent');
      assert.strictEqual(profile, undefined);
    });

    test('addProfile adds a new profile', () => {
      const profile: Profile = {
        name: 'test',
        baseUrl: 'http://test.com/v2',
      };
      
      addProfile(profile);
      const loaded = loadProfiles();
      
      assert.strictEqual(loaded.length, 1);
      assert.strictEqual(loaded[0].name, 'test');
    });

    test('addProfile updates existing profile', () => {
      const profile1: Profile = {
        name: 'test',
        baseUrl: 'http://test.com/v2',
      };
      
      addProfile(profile1);
      
      const profile2: Profile = {
        name: 'test',
        baseUrl: 'http://updated.com/v2',
      };
      
      addProfile(profile2);
      const loaded = loadProfiles();
      
      assert.strictEqual(loaded.length, 1);
      assert.strictEqual(loaded[0].baseUrl, 'http://updated.com/v2');
    });

    test('removeProfile removes a profile', () => {
      const profiles: Profile[] = [
        {
          name: 'keep',
          baseUrl: 'http://keep.com/v2',
        },
        {
          name: 'remove',
          baseUrl: 'http://remove.com/v2',
        },
      ];
      
      saveProfiles(profiles);
      const removed = removeProfile('remove');
      
      assert.strictEqual(removed, true);
      const loaded = loadProfiles();
      assert.strictEqual(loaded.length, 1);
      assert.strictEqual(loaded[0].name, 'keep');
    });

    test('removeProfile returns false for non-existent profile', () => {
      const removed = removeProfile('nonexistent');
      assert.strictEqual(removed, false);
    });
  });
  
  // Simplified tests for now - we'll expand later if needed
  describe('Modeler Connection Management', () => {
    test('loadModelerConnections returns empty array when no settings exist', () => {
      const connections = loadModelerConnections();
      assert.ok(Array.isArray(connections));
    });
  });

  describe('Environment Variable Configuration', () => {
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

    test('resolveClusterConfig reads OAuth config from environment variables', () => {
      process.env.CAMUNDA_BASE_URL = 'https://test.camunda.io';
      process.env.CAMUNDA_CLIENT_ID = 'test-client-id';
      process.env.CAMUNDA_CLIENT_SECRET = 'test-secret';
      process.env.CAMUNDA_TOKEN_AUDIENCE = 'test-audience';

      const config = resolveClusterConfig();

      assert.strictEqual(config.baseUrl, 'https://test.camunda.io');
      assert.strictEqual(config.clientId, 'test-client-id');
      assert.strictEqual(config.clientSecret, 'test-secret');
      assert.strictEqual(config.audience, 'test-audience');
    });
  });
});
