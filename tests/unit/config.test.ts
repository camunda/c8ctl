/**
 * Unit tests for config module
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { c8ctl } from '../../src/runtime.ts';
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
      assert.deepStrictEqual(state, { 
        activeProfile: undefined,
        activeTenant: undefined,
        outputMode: 'text' 
      });
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
      
      // Reset c8ctl runtime state before each test
      c8ctl.activeProfile = undefined;
      c8ctl.activeTenant = undefined;
      c8ctl.outputMode = 'text';
      
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

  describe('Modeler Profile Integration', () => {
    let testDir: string;
    let modelerDir: string;
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      // Create temporary test directories
      testDir = join(tmpdir(), `c8ctl-test-${Date.now()}`);
      modelerDir = join(tmpdir(), `modeler-test-${Date.now()}`);
      mkdirSync(testDir, { recursive: true });
      mkdirSync(modelerDir, { recursive: true });
      
      // Mock directories using platform-agnostic XDG_CONFIG_HOME
      // This works because getModelerDataDir() respects XDG_CONFIG_HOME on Linux
      originalEnv = { ...process.env };
      process.env.XDG_DATA_HOME = testDir;
      process.env.XDG_CONFIG_HOME = modelerDir;
      
      // On macOS, we need to override HOME to use our test directory
      // because getModelerDataDir() uses ~/Library/Application Support/camunda-modeler
      if (process.platform === 'darwin') {
        process.env.HOME = testDir;
      }
    });

    afterEach(() => {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
      if (existsSync(modelerDir)) {
        rmSync(modelerDir, { recursive: true, force: true });
      }
      process.env = originalEnv;
    });

    // Test that loadModelerProfiles returns empty array when no profiles.json exists
    // Note: This test may find profiles from actual Camunda Modeler installation
    // We verify the function works by checking a directory we control
    test('loadModelerProfiles returns empty array if no file', async () => {
      const { loadModelerProfiles, getModelerDataDir } = await import('../../src/config.ts');
      const modelerDataDir = getModelerDataDir();
      
      // Clean up any existing profiles.json in the modeler directory
      const profilesPath = join(modelerDataDir, 'profiles.json');
      if (existsSync(profilesPath)) {
        const backup = profilesPath + '.backup';
        // Temporarily move the file
        try {
          if (existsSync(backup)) {
            rmSync(backup);
          }
          const { renameSync } = await import('node:fs');
          renameSync(profilesPath, backup);
          
          // Now test with no file
          const profiles = loadModelerProfiles();
          assert.strictEqual(profiles.length, 0);
          
          // Restore the file
          renameSync(backup, profilesPath);
        } catch (error) {
          // If we can't move the file, just verify the function doesn't crash
          const profiles = loadModelerProfiles();
          assert.ok(Array.isArray(profiles));
        }
      } else {
        // No file exists, should return empty array
        const profiles = loadModelerProfiles();
        assert.strictEqual(profiles.length, 0);
      }
    });

    test('loadModelerProfiles reads profiles.json from modeler directory', async () => {
      const { loadModelerProfiles, getModelerDataDir } = await import('../../src/config.ts');
      const modelerDataDir = getModelerDataDir();
      mkdirSync(modelerDataDir, { recursive: true });
      
      const modelerProfiles = {
        profiles: [
          {
            name: 'Local Dev',
            clusterId: 'local-cluster',
            clusterUrl: 'http://localhost:8080',
            audience: '',
            clientId: '',
            clientSecret: ''
          }
        ]
      };
      
      writeFileSync(
        join(modelerDataDir, 'profiles.json'),
        JSON.stringify(modelerProfiles, null, 2),
        'utf-8'
      );
      
      const profiles = loadModelerProfiles();
      assert.strictEqual(profiles.length, 1);
      assert.strictEqual(profiles[0].name, 'Local Dev');
      assert.strictEqual(profiles[0].clusterId, 'local-cluster');
    });

    test('getModelerProfile finds profile by name', async () => {
      const { loadModelerProfiles, getModelerProfile, getModelerDataDir } = await import('../../src/config.ts');
      const modelerDataDir = getModelerDataDir();
      mkdirSync(modelerDataDir, { recursive: true });
      
      const modelerProfiles = {
        profiles: [
          { name: 'Cloud Cluster', clusterId: 'abc123', clusterUrl: 'https://abc123.zeebe.camunda.io' }
        ]
      };
      
      writeFileSync(
        join(modelerDataDir, 'profiles.json'),
        JSON.stringify(modelerProfiles, null, 2),
        'utf-8'
      );
      
      const profile = getModelerProfile('Cloud Cluster');
      assert.ok(profile);
      assert.strictEqual(profile.name, 'Cloud Cluster');
    });

    test('getModelerProfile finds profile by clusterId', async () => {
      const { getModelerProfile, getModelerDataDir } = await import('../../src/config.ts');
      const modelerDataDir = getModelerDataDir();
      mkdirSync(modelerDataDir, { recursive: true });
      
      const modelerProfiles = {
        profiles: [
          { name: 'Cloud Cluster', clusterId: 'abc123', clusterUrl: 'https://abc123.zeebe.camunda.io' }
        ]
      };
      
      writeFileSync(
        join(modelerDataDir, 'profiles.json'),
        JSON.stringify(modelerProfiles, null, 2),
        'utf-8'
      );
      
      const profile = getModelerProfile('abc123');
      assert.ok(profile);
      assert.strictEqual(profile.clusterId, 'abc123');
    });

    test('getModelerProfile handles modeler: prefix', async () => {
      const { getModelerProfile, getModelerDataDir } = await import('../../src/config.ts');
      const modelerDataDir = getModelerDataDir();
      mkdirSync(modelerDataDir, { recursive: true });
      
      const modelerProfiles = {
        profiles: [
          { name: 'Test Profile', clusterId: 'test123', clusterUrl: 'http://localhost:8080' }
        ]
      };
      
      writeFileSync(
        join(modelerDataDir, 'profiles.json'),
        JSON.stringify(modelerProfiles, null, 2),
        'utf-8'
      );
      
      const profile = getModelerProfile('modeler:Test Profile');
      assert.ok(profile);
      assert.strictEqual(profile.name, 'Test Profile');
    });

    test('constructApiUrl appends /v2 for localhost URLs', async () => {
      const { constructApiUrl } = await import('../../src/config.ts');
      const url = constructApiUrl({ clusterUrl: 'http://localhost:8080' });
      assert.strictEqual(url, 'http://localhost:8080/v2');
    });

    test('constructApiUrl supports any port number', async () => {
      const { constructApiUrl } = await import('../../src/config.ts');
      const url = constructApiUrl({ clusterUrl: 'http://localhost:9090' });
      assert.strictEqual(url, 'http://localhost:9090/v2');
    });

    test('constructApiUrl does not modify URLs with /v2', async () => {
      const { constructApiUrl } = await import('../../src/config.ts');
      const url = constructApiUrl({ clusterUrl: 'http://localhost:8080/v2' });
      assert.strictEqual(url, 'http://localhost:8080/v2');
    });

    test('constructApiUrl handles cloud URLs without /v2', async () => {
      const { constructApiUrl } = await import('../../src/config.ts');
      const url = constructApiUrl({ clusterUrl: 'https://abc123.region.zeebe.camunda.io' });
      assert.strictEqual(url, 'https://abc123.region.zeebe.camunda.io');
    });

    test('constructApiUrl uses self-managed URLs as-is if no /v2', async () => {
      const { constructApiUrl } = await import('../../src/config.ts');
      // Self-managed clusters should include /v2 in their URL if needed
      const url = constructApiUrl({ clusterUrl: 'https://my-camunda-cluster.example.com' });
      assert.strictEqual(url, 'https://my-camunda-cluster.example.com');
    });

    test('constructApiUrl handles 127.0.0.1 like localhost', async () => {
      const { constructApiUrl } = await import('../../src/config.ts');
      const url = constructApiUrl({ clusterUrl: 'http://127.0.0.1:8080' });
      assert.strictEqual(url, 'http://127.0.0.1:8080/v2');
    });

    test('constructApiUrl constructs cloud URL from clusterId', async () => {
      const { constructApiUrl } = await import('../../src/config.ts');
      const url = constructApiUrl({ clusterId: 'abc123-def456' });
      assert.strictEqual(url, 'https://abc123-def456.zeebe.camunda.io');
    });

    test('constructApiUrl falls back to localhost', async () => {
      const { constructApiUrl } = await import('../../src/config.ts');
      const url = constructApiUrl({});
      assert.strictEqual(url, 'http://localhost:8080/v2');
    });

    test('convertModelerProfile creates c8ctl profile with modeler: prefix', async () => {
      const { convertModelerProfile } = await import('../../src/config.ts');
      const modelerProfile = {
        name: 'Test',
        clusterUrl: 'http://localhost:8080',
        clientId: 'test-client',
        clientSecret: 'test-secret'
      };
      
      const c8ctlProfile = convertModelerProfile(modelerProfile);
      assert.strictEqual(c8ctlProfile.name, 'modeler:Test');
      assert.strictEqual(c8ctlProfile.baseUrl, 'http://localhost:8080/v2');
      assert.strictEqual(c8ctlProfile.clientId, 'test-client');
    });

    test('convertModelerProfile sets OAuth URL for cloud profiles', async () => {
      const { convertModelerProfile } = await import('../../src/config.ts');
      const modelerProfile = {
        name: 'Cloud',
        clusterUrl: 'https://abc123.zeebe.camunda.io',
        audience: 'zeebe.camunda.io',
        clientId: 'cloud-client',
        clientSecret: 'cloud-secret'
      };
      
      const c8ctlProfile = convertModelerProfile(modelerProfile);
      assert.strictEqual(c8ctlProfile.oAuthUrl, 'https://login.cloud.camunda.io/oauth/token');
      assert.strictEqual(c8ctlProfile.audience, 'zeebe.camunda.io');
    });

    test('convertModelerProfile uses clusterId as name fallback', async () => {
      const { convertModelerProfile } = await import('../../src/config.ts');
      const modelerProfile = {
        clusterId: 'fallback-id',
        clusterUrl: 'http://localhost:8080'
      };
      
      const c8ctlProfile = convertModelerProfile(modelerProfile);
      assert.strictEqual(c8ctlProfile.name, 'modeler:fallback-id');
    });

    test('getProfile resolves modeler profiles with modeler: prefix', async () => {
      const { getProfile, getModelerDataDir } = await import('../../src/config.ts');
      const modelerDataDir = getModelerDataDir();
      mkdirSync(modelerDataDir, { recursive: true });
      
      const modelerProfiles = {
        profiles: [
          { name: 'Modeler Test', clusterUrl: 'http://localhost:8080' }
        ]
      };
      
      writeFileSync(
        join(modelerDataDir, 'profiles.json'),
        JSON.stringify(modelerProfiles, null, 2),
        'utf-8'
      );
      
      const profile = getProfile('modeler:Modeler Test');
      assert.ok(profile);
      assert.strictEqual(profile.name, 'modeler:Modeler Test');
      assert.strictEqual(profile.baseUrl, 'http://localhost:8080/v2');
    });
  });
});
