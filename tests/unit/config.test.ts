/**
 * Unit tests for config module
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getUserDataDir,
  loadProfiles,
  saveProfiles,
  getProfile,
  addProfile,
  removeProfile,
  loadSessionState,
  saveSessionState,
  setActiveProfile,
  setActiveTenant,
  setOutputMode,
  resolveClusterConfig,
  resolveTenantId,
} from '../../src/config.ts';

describe('Config Module', () => {
  test('getUserDataDir returns platform-specific path', () => {
    const dir = getUserDataDir();
    assert.ok(dir);
    assert.ok(dir.includes('c8ctl'));
  });

  describe('Profile Management', () => {
    let testDir: string;
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      // Create temporary test directory
      testDir = join(tmpdir(), `c8ctl-test-${Date.now()}`);
      mkdirSync(testDir, { recursive: true });
      
      // Override data directory for tests
      originalEnv = { ...process.env };
      process.env.C8CTL_DATA_DIR = testDir;
    });

    afterEach(() => {
      // Cleanup
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
      process.env = originalEnv;
    });

    test('loadProfiles returns empty array when no profiles exist', () => {
      const profiles = loadProfiles();
      assert.deepStrictEqual(profiles, []);
    });

    test('saveProfiles and loadProfiles work correctly', () => {
      const profiles = [
        { name: 'test', baseUrl: 'http://localhost:8080' },
        { name: 'prod', baseUrl: 'https://prod.example.com', clientId: 'client123' },
      ];
      
      saveProfiles(profiles);
      const loaded = loadProfiles();
      
      assert.deepStrictEqual(loaded, profiles);
    });

    test('getProfile returns correct profile', () => {
      const profiles = [
        { name: 'test', baseUrl: 'http://localhost:8080' },
        { name: 'prod', baseUrl: 'https://prod.example.com' },
      ];
      
      saveProfiles(profiles);
      const profile = getProfile('prod');
      
      assert.ok(profile);
      assert.strictEqual(profile.name, 'prod');
      assert.strictEqual(profile.baseUrl, 'https://prod.example.com');
    });

    test('getProfile returns undefined for non-existent profile', () => {
      const profile = getProfile('nonexistent');
      assert.strictEqual(profile, undefined);
    });

    test('addProfile adds new profile', () => {
      addProfile({ name: 'new', baseUrl: 'http://new.com' });
      
      const profiles = loadProfiles();
      assert.strictEqual(profiles.length, 1);
      assert.strictEqual(profiles[0].name, 'new');
    });

    test('addProfile updates existing profile', () => {
      addProfile({ name: 'test', baseUrl: 'http://old.com' });
      addProfile({ name: 'test', baseUrl: 'http://new.com' });
      
      const profiles = loadProfiles();
      assert.strictEqual(profiles.length, 1);
      assert.strictEqual(profiles[0].baseUrl, 'http://new.com');
    });

    test('removeProfile removes existing profile', () => {
      addProfile({ name: 'test1', baseUrl: 'http://test1.com' });
      addProfile({ name: 'test2', baseUrl: 'http://test2.com' });
      
      const removed = removeProfile('test1');
      
      assert.strictEqual(removed, true);
      const profiles = loadProfiles();
      assert.strictEqual(profiles.length, 1);
      assert.strictEqual(profiles[0].name, 'test2');
    });

    test('removeProfile returns false for non-existent profile', () => {
      const removed = removeProfile('nonexistent');
      assert.strictEqual(removed, false);
    });
  });

  describe('Session State', () => {
    let testDir: string;
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      testDir = join(tmpdir(), `c8ctl-test-${Date.now()}`);
      mkdirSync(testDir, { recursive: true });
      originalEnv = { ...process.env };
      process.env.C8CTL_DATA_DIR = testDir;
    });

    afterEach(() => {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
      process.env = originalEnv;
    });

    test('loadSessionState returns default when no state exists', () => {
      const state = loadSessionState();
      assert.deepStrictEqual(state, { outputMode: 'text' });
    });

    test('saveSessionState and loadSessionState work correctly', () => {
      const state = {
        activeProfile: 'test',
        activeTenant: 'tenant1',
        outputMode: 'json' as const,
      };
      
      saveSessionState(state);
      const loaded = loadSessionState();
      
      assert.deepStrictEqual(loaded, state);
    });

    test('setActiveProfile updates session state', () => {
      setActiveProfile('myprofile');
      const state = loadSessionState();
      assert.strictEqual(state.activeProfile, 'myprofile');
    });

    test('setActiveTenant updates session state', () => {
      setActiveTenant('mytenant');
      const state = loadSessionState();
      assert.strictEqual(state.activeTenant, 'mytenant');
    });

    test('setOutputMode updates session state', () => {
      setOutputMode('json');
      const state = loadSessionState();
      assert.strictEqual(state.outputMode, 'json');
    });
  });

  describe('Configuration Resolution', () => {
    let testDir: string;
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      // Create temporary test directory
      testDir = join(tmpdir(), `c8ctl-test-${Date.now()}`);
      mkdirSync(testDir, { recursive: true });
      
      // Override data directory and clear Camunda env vars
      originalEnv = { ...process.env };
      process.env.C8CTL_DATA_DIR = testDir;
      
      // Clear all Camunda env vars to ensure test isolation
      delete process.env.CAMUNDA_BASE_URL;
      delete process.env.CAMUNDA_CLIENT_ID;
      delete process.env.CAMUNDA_CLIENT_SECRET;
      delete process.env.CAMUNDA_AUDIENCE;
      delete process.env.CAMUNDA_OAUTH_URL;
      delete process.env.CAMUNDA_USERNAME;
      delete process.env.CAMUNDA_PASSWORD;
      delete process.env.CAMUNDA_DEFAULT_TENANT_ID;
    });

    afterEach(() => {
      // Cleanup
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
      process.env = originalEnv;
    });

    test('resolveClusterConfig uses profile flag if provided', () => {
      addProfile({
        name: 'flagprofile',
        baseUrl: 'http://flag.com',
        clientId: 'flag-client',
      });
      
      const config = resolveClusterConfig('flagprofile');
      
      assert.strictEqual(config.baseUrl, 'http://flag.com');
      assert.strictEqual(config.clientId, 'flag-client');
    });

    test('resolveClusterConfig uses session profile if no flag', () => {
      addProfile({
        name: 'sessionprofile',
        baseUrl: 'http://session.com',
      });
      setActiveProfile('sessionprofile');
      
      const config = resolveClusterConfig();
      
      assert.strictEqual(config.baseUrl, 'http://session.com');
    });

    test('resolveClusterConfig uses env vars if no profile', () => {
      process.env.CAMUNDA_BASE_URL = 'http://env.com';
      process.env.CAMUNDA_CLIENT_ID = 'env-client';
      
      const config = resolveClusterConfig();
      
      assert.strictEqual(config.baseUrl, 'http://env.com');
      assert.strictEqual(config.clientId, 'env-client');
    });

    test('resolveClusterConfig falls back to localhost', () => {
      const config = resolveClusterConfig();
      
      assert.strictEqual(config.baseUrl, 'http://localhost:8080/v2');
      assert.strictEqual(config.username, 'demo');
      assert.strictEqual(config.password, 'demo');
    });

    test('resolveTenantId uses session tenant first', () => {
      setActiveTenant('session-tenant');
      
      const tenantId = resolveTenantId();
      assert.strictEqual(tenantId, 'session-tenant');
    });

    test('resolveTenantId uses profile default tenant', () => {
      addProfile({
        name: 'tenant-profile',
        baseUrl: 'http://test.com',
        defaultTenantId: 'profile-tenant',
      });
      setActiveProfile('tenant-profile');
      
      const tenantId = resolveTenantId();
      assert.strictEqual(tenantId, 'profile-tenant');
    });

    test('resolveTenantId uses env var', () => {
      process.env.CAMUNDA_DEFAULT_TENANT_ID = 'env-tenant';
      
      const tenantId = resolveTenantId();
      assert.strictEqual(tenantId, 'env-tenant');
    });

    test('resolveTenantId falls back to <default>', () => {
      const tenantId = resolveTenantId();
      assert.strictEqual(tenantId, '<default>');
    });
  });
});
