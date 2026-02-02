/**
 * Unit tests for config module
 * Tests the Modeler-compatible Connection format
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { c8ctl } from '../../src/runtime.ts';
import {
  getUserDataDir,
  getModelerDataDir,
  loadConnections,
  saveConnections,
  getConnection,
  saveConnection,
  removeConnection,
  createConnection,
  createDefaultLocalConnection,
  connectionToClusterConfig,
  connectionToProfile,
  getConnectionLabel,
  getAuthTypeLabel,
  getTargetTypeLabel,
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

  describe('Connection Management', () => {
    let testDir: string;
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      // Create temporary test directory for modeler config
      testDir = join(tmpdir(), `c8ctl-modeler-test-${Date.now()}`);
      mkdirSync(testDir, { recursive: true });
      
      // Override modeler data directory for tests
      originalEnv = { ...process.env };
      process.env.C8CTL_MODELER_DIR = testDir;
    });

    afterEach(() => {
      // Cleanup
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
      process.env = originalEnv;
    });

    test('loadConnections returns empty array when no config exists', () => {
      const connections = loadConnections();
      assert.deepStrictEqual(connections, []);
    });

    test('saveConnections and loadConnections work correctly', () => {
      const connections: Connection[] = [
        {
          id: 'conn-1',
          name: 'test',
          targetType: TARGET_TYPES.SELF_HOSTED,
          contactPoint: 'http://localhost:8080/v2',
          authType: AUTH_TYPES.NONE,
        },
        {
          id: 'conn-2',
          name: 'cloud',
          targetType: TARGET_TYPES.CAMUNDA_CLOUD,
          camundaCloudClusterUrl: 'https://abc.bru-2.zeebe.camunda.io',
          camundaCloudClientId: 'client123',
          camundaCloudClientSecret: 'secret123',
        },
      ];
      
      saveConnections(connections);
      const loaded = loadConnections();
      
      assert.strictEqual(loaded.length, 2);
      assert.strictEqual(loaded[0].id, 'conn-1');
      assert.strictEqual(loaded[1].id, 'conn-2');
    });

    test('saveConnections preserves other config settings', () => {
      // Write initial config with other settings
      const configPath = join(testDir, 'config.json');
      writeFileSync(configPath, JSON.stringify({
        'someOtherPlugin.setting': true,
        'anotherSetting': 'value',
      }), 'utf-8');

      const connections: Connection[] = [
        {
          id: 'conn-1',
          name: 'test',
          targetType: TARGET_TYPES.SELF_HOSTED,
          contactPoint: 'http://localhost:8080/v2',
        },
      ];
      
      saveConnections(connections);
      
      // Verify other settings are preserved
      const data = readFileSync(configPath, 'utf-8');
      const config = JSON.parse(data);
      assert.strictEqual(config['someOtherPlugin.setting'], true);
      assert.strictEqual(config['anotherSetting'], 'value');
    });

    test('getConnection returns correct connection by ID', () => {
      const connections: Connection[] = [
        {
          id: 'conn-1',
          name: 'test',
          targetType: TARGET_TYPES.SELF_HOSTED,
          contactPoint: 'http://localhost:8080/v2',
        },
        {
          id: 'conn-2',
          name: 'prod',
          targetType: TARGET_TYPES.SELF_HOSTED,
          contactPoint: 'https://prod.example.com/v2',
        },
      ];
      
      saveConnections(connections);
      const conn = getConnection('conn-2');
      
      assert.ok(conn);
      assert.strictEqual(conn.id, 'conn-2');
      assert.strictEqual(conn.name, 'prod');
    });

    test('getConnection returns correct connection by name', () => {
      const connections: Connection[] = [
        {
          id: 'conn-1',
          name: 'test',
          targetType: TARGET_TYPES.SELF_HOSTED,
          contactPoint: 'http://localhost:8080/v2',
        },
      ];
      
      saveConnections(connections);
      const conn = getConnection('test');
      
      assert.ok(conn);
      assert.strictEqual(conn.id, 'conn-1');
    });

    test('getConnection returns undefined for non-existent connection', () => {
      const conn = getConnection('nonexistent');
      assert.strictEqual(conn, undefined);
    });

    test('saveConnection adds new connection', () => {
      const conn: Connection = {
        id: 'new-conn',
        name: 'new',
        targetType: TARGET_TYPES.SELF_HOSTED,
        contactPoint: 'http://new.com/v2',
      };
      
      saveConnection(conn);
      
      const connections = loadConnections();
      assert.strictEqual(connections.length, 1);
      assert.strictEqual(connections[0].id, 'new-conn');
    });

    test('saveConnection updates existing connection', () => {
      const conn: Connection = {
        id: 'test-conn',
        name: 'test',
        targetType: TARGET_TYPES.SELF_HOSTED,
        contactPoint: 'http://old.com/v2',
      };
      
      saveConnection(conn);
      
      conn.contactPoint = 'http://new.com/v2';
      saveConnection(conn);
      
      const connections = loadConnections();
      assert.strictEqual(connections.length, 1);
      assert.strictEqual(connections[0].contactPoint, 'http://new.com/v2');
    });

    test('removeConnection removes existing connection by ID', () => {
      const connections: Connection[] = [
        { id: 'conn-1', name: 'test1', targetType: TARGET_TYPES.SELF_HOSTED, contactPoint: 'http://test1.com/v2' },
        { id: 'conn-2', name: 'test2', targetType: TARGET_TYPES.SELF_HOSTED, contactPoint: 'http://test2.com/v2' },
      ];
      
      saveConnections(connections);
      const removed = removeConnection('conn-1');
      
      assert.strictEqual(removed, true);
      const remaining = loadConnections();
      assert.strictEqual(remaining.length, 1);
      assert.strictEqual(remaining[0].id, 'conn-2');
    });

    test('removeConnection removes existing connection by name', () => {
      const connections: Connection[] = [
        { id: 'conn-1', name: 'test1', targetType: TARGET_TYPES.SELF_HOSTED, contactPoint: 'http://test1.com/v2' },
        { id: 'conn-2', name: 'test2', targetType: TARGET_TYPES.SELF_HOSTED, contactPoint: 'http://test2.com/v2' },
      ];
      
      saveConnections(connections);
      const removed = removeConnection('test1');
      
      assert.strictEqual(removed, true);
      const remaining = loadConnections();
      assert.strictEqual(remaining.length, 1);
    });

    test('removeConnection returns false for non-existent connection', () => {
      const removed = removeConnection('nonexistent');
      assert.strictEqual(removed, false);
    });

    test('createConnection generates new connection with UUID', () => {
      const conn = createConnection('My Connection');
      
      assert.ok(conn.id);
      assert.ok(conn.id.length > 30); // UUID format
      assert.strictEqual(conn.name, 'My Connection');
      assert.strictEqual(conn.targetType, TARGET_TYPES.SELF_HOSTED);
      assert.strictEqual(conn.contactPoint, 'http://localhost:8080/v2');
    });

    test('createDefaultLocalConnection creates c8run connection', () => {
      const conn = createDefaultLocalConnection();
      
      assert.ok(conn.id);
      assert.strictEqual(conn.name, 'c8run (local)');
      assert.strictEqual(conn.targetType, TARGET_TYPES.SELF_HOSTED);
      assert.strictEqual(conn.contactPoint, 'http://localhost:8080/v2');
      assert.strictEqual(conn.authType, AUTH_TYPES.NONE);
    });
  });

  describe('Connection Conversion', () => {
    test('connectionToClusterConfig converts self-hosted with no auth', () => {
      const conn: Connection = {
        id: 'conn-1',
        name: 'local',
        targetType: TARGET_TYPES.SELF_HOSTED,
        contactPoint: 'http://localhost:8080/v2',
        authType: AUTH_TYPES.NONE,
      };
      
      const config = connectionToClusterConfig(conn);
      
      assert.strictEqual(config.baseUrl, 'http://localhost:8080/v2');
      assert.strictEqual(config.clientId, undefined);
      assert.strictEqual(config.username, undefined);
    });

    test('connectionToClusterConfig converts self-hosted with basic auth', () => {
      const conn: Connection = {
        id: 'conn-1',
        name: 'local',
        targetType: TARGET_TYPES.SELF_HOSTED,
        contactPoint: 'http://localhost:8080/v2',
        authType: AUTH_TYPES.BASIC,
        basicAuthUsername: 'demo',
        basicAuthPassword: 'demo',
      };
      
      const config = connectionToClusterConfig(conn);
      
      assert.strictEqual(config.baseUrl, 'http://localhost:8080/v2');
      assert.strictEqual(config.username, 'demo');
      assert.strictEqual(config.password, 'demo');
    });

    test('connectionToClusterConfig converts self-hosted with OAuth', () => {
      const conn: Connection = {
        id: 'conn-1',
        name: 'sm',
        targetType: TARGET_TYPES.SELF_HOSTED,
        contactPoint: 'https://sm.example.com/v2',
        authType: AUTH_TYPES.OAUTH,
        clientId: 'sm-client',
        clientSecret: 'sm-secret',
        oauthURL: 'https://auth.example.com/token',
        audience: 'sm-audience',
      };
      
      const config = connectionToClusterConfig(conn);
      
      assert.strictEqual(config.baseUrl, 'https://sm.example.com/v2');
      assert.strictEqual(config.clientId, 'sm-client');
      assert.strictEqual(config.clientSecret, 'sm-secret');
      assert.strictEqual(config.oAuthUrl, 'https://auth.example.com/token');
      assert.strictEqual(config.audience, 'sm-audience');
    });

    test('connectionToClusterConfig converts Camunda Cloud connection', () => {
      const conn: Connection = {
        id: 'conn-1',
        name: 'cloud',
        targetType: TARGET_TYPES.CAMUNDA_CLOUD,
        camundaCloudClusterUrl: 'https://abc.bru-2.zeebe.camunda.io',
        camundaCloudClientId: 'cloud-client',
        camundaCloudClientSecret: 'cloud-secret',
      };
      
      const config = connectionToClusterConfig(conn);
      
      // Cloud connections use the cluster URL directly
      assert.strictEqual(config.baseUrl, 'https://abc.bru-2.zeebe.camunda.io');
      assert.strictEqual(config.clientId, 'cloud-client');
      assert.strictEqual(config.clientSecret, 'cloud-secret');
      assert.strictEqual(config.oAuthUrl, 'https://login.cloud.camunda.io/oauth/token');
      // Cloud uses URL as audience
      assert.strictEqual(config.audience, 'https://abc.bru-2.zeebe.camunda.io');
    });

    test('connectionToProfile converts connection to legacy profile format', () => {
      const conn: Connection = {
        id: 'conn-1',
        name: 'test',
        targetType: TARGET_TYPES.SELF_HOSTED,
        contactPoint: 'http://localhost:8080/v2',
        authType: AUTH_TYPES.BASIC,
        basicAuthUsername: 'demo',
        basicAuthPassword: 'demo',
        tenantId: 'test-tenant',
      };
      
      const profile = connectionToProfile(conn);
      
      assert.strictEqual(profile.name, 'test');
      assert.strictEqual(profile.baseUrl, 'http://localhost:8080/v2');
      assert.strictEqual(profile.username, 'demo');
      assert.strictEqual(profile.password, 'demo');
      assert.strictEqual(profile.defaultTenantId, 'test-tenant');
    });
  });

  describe('Connection Labels', () => {
    test('getConnectionLabel returns name if present', () => {
      const conn: Connection = {
        id: 'conn-1',
        name: 'My Connection',
        targetType: TARGET_TYPES.SELF_HOSTED,
      };
      
      assert.strictEqual(getConnectionLabel(conn), 'My Connection');
    });

    test('getConnectionLabel returns id if no name', () => {
      const conn: Connection = {
        id: 'conn-uuid-123',
        targetType: TARGET_TYPES.SELF_HOSTED,
      };
      
      // Without name or URL, returns 'Unnamed connection'
      assert.strictEqual(getConnectionLabel(conn), 'Unnamed connection');
    });

    test('getConnectionLabel returns URL-based label if no name but has URL', () => {
      const conn: Connection = {
        id: 'conn-uuid-123',
        targetType: TARGET_TYPES.SELF_HOSTED,
        contactPoint: 'http://localhost:8080/v2',
      };
      
      assert.strictEqual(getConnectionLabel(conn), 'Unnamed (http://localhost:8080/v2)');
    });

    test('getAuthTypeLabel returns correct labels', () => {
      assert.strictEqual(getAuthTypeLabel({
        id: '1', targetType: TARGET_TYPES.SELF_HOSTED, authType: AUTH_TYPES.NONE
      }), 'None');
      
      assert.strictEqual(getAuthTypeLabel({
        id: '1', targetType: TARGET_TYPES.SELF_HOSTED, authType: AUTH_TYPES.BASIC
      }), 'Basic');
      
      assert.strictEqual(getAuthTypeLabel({
        id: '1', targetType: TARGET_TYPES.SELF_HOSTED, authType: AUTH_TYPES.OAUTH
      }), 'OAuth');
      
      assert.strictEqual(getAuthTypeLabel({
        id: '1', targetType: TARGET_TYPES.CAMUNDA_CLOUD
      }), 'OAuth (Cloud)');
    });

    test('getTargetTypeLabel returns correct labels', () => {
      assert.strictEqual(getTargetTypeLabel({
        id: '1', targetType: TARGET_TYPES.SELF_HOSTED
      }), 'Self-Hosted');
      
      assert.strictEqual(getTargetTypeLabel({
        id: '1', targetType: TARGET_TYPES.CAMUNDA_CLOUD
      }), 'Camunda Cloud');
    });
  });

  describe('Connection Validation', () => {
    test('validateConnection rejects missing id', () => {
      const errors = validateConnection({ targetType: TARGET_TYPES.SELF_HOSTED });
      assert.ok(errors.includes('Connection must have an ID'));
    });

    test('validateConnection rejects missing targetType', () => {
      const errors = validateConnection({ id: '123' });
      assert.ok(errors.includes('Target type is required (camundaCloud or selfHosted)'));
    });

    test('validateConnection validates Camunda Cloud connection', () => {
      const errors = validateConnection({
        id: '123',
        targetType: TARGET_TYPES.CAMUNDA_CLOUD,
      });
      
      assert.ok(errors.includes('Cluster URL is required for Camunda Cloud'));
      assert.ok(errors.includes('Client ID is required for Camunda Cloud'));
      assert.ok(errors.includes('Client Secret is required for Camunda Cloud'));
    });

    test('validateConnection accepts valid Camunda Cloud connection', () => {
      const errors = validateConnection({
        id: '123',
        targetType: TARGET_TYPES.CAMUNDA_CLOUD,
        camundaCloudClusterUrl: 'https://abc.bru-2.zeebe.camunda.io',
        camundaCloudClientId: 'client',
        camundaCloudClientSecret: 'secret',
      });
      
      assert.strictEqual(errors.length, 0);
    });

    test('validateConnection validates self-hosted with basic auth', () => {
      const errors = validateConnection({
        id: '123',
        targetType: TARGET_TYPES.SELF_HOSTED,
        contactPoint: 'http://localhost:8080',
        authType: AUTH_TYPES.BASIC,
      });
      
      assert.ok(errors.includes('Username is required for Basic authentication'));
      assert.ok(errors.includes('Password is required for Basic authentication'));
    });

    test('validateConnection validates self-hosted with OAuth', () => {
      const errors = validateConnection({
        id: '123',
        targetType: TARGET_TYPES.SELF_HOSTED,
        contactPoint: 'http://localhost:8080',
        authType: AUTH_TYPES.OAUTH,
      });
      
      assert.ok(errors.includes('Client ID is required for OAuth authentication'));
      assert.ok(errors.includes('Client Secret is required for OAuth authentication'));
      assert.ok(errors.includes('OAuth URL is required for OAuth authentication'));
      assert.ok(errors.includes('Audience is required for OAuth authentication'));
    });

    test('validateConnection accepts valid self-hosted with no auth', () => {
      const errors = validateConnection({
        id: '123',
        targetType: TARGET_TYPES.SELF_HOSTED,
        contactPoint: 'http://localhost:8080',
        authType: AUTH_TYPES.NONE,
      });
      
      assert.strictEqual(errors.length, 0);
    });

    test('validateConnection rejects invalid URL format', () => {
      const errors = validateConnection({
        id: '123',
        targetType: TARGET_TYPES.SELF_HOSTED,
        contactPoint: 'localhost:8080', // missing http://
      });
      
      assert.ok(errors.includes('Cluster URL must start with http://, https://, grpc://, or grpcs://'));
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
    let modelerDir: string;
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      // Create temporary test directories
      testDir = join(tmpdir(), `c8ctl-test-${Date.now()}`);
      modelerDir = join(tmpdir(), `c8ctl-modeler-test-${Date.now()}`);
      mkdirSync(testDir, { recursive: true });
      mkdirSync(modelerDir, { recursive: true });
      
      // Override data directories
      originalEnv = { ...process.env };
      process.env.C8CTL_DATA_DIR = testDir;
      process.env.C8CTL_MODELER_DIR = modelerDir;
      
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
      if (existsSync(modelerDir)) {
        rmSync(modelerDir, { recursive: true, force: true });
      }
      process.env = originalEnv;
    });

    test('resolveClusterConfig uses connection by name', () => {
      const conn: Connection = {
        id: 'flag-conn',
        name: 'flagprofile',
        targetType: TARGET_TYPES.SELF_HOSTED,
        contactPoint: 'http://flag.com/v2',
        authType: AUTH_TYPES.OAUTH,
        clientId: 'flag-client',
        clientSecret: 'flag-secret',
        oauthURL: 'http://flag.com/oauth',
        audience: 'flag-audience',
      };
      saveConnection(conn);
      
      const config = resolveClusterConfig('flagprofile');
      
      assert.strictEqual(config.baseUrl, 'http://flag.com/v2');
      assert.strictEqual(config.clientId, 'flag-client');
    });

    test('resolveClusterConfig uses session profile if no flag', () => {
      const conn: Connection = {
        id: 'session-conn',
        name: 'sessionprofile',
        targetType: TARGET_TYPES.SELF_HOSTED,
        contactPoint: 'http://session.com/v2',
        authType: AUTH_TYPES.NONE,
      };
      saveConnection(conn);
      setActiveProfile('sessionprofile');
      
      const config = resolveClusterConfig();
      
      assert.strictEqual(config.baseUrl, 'http://session.com/v2');
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

    test('resolveTenantId uses connection tenant', () => {
      const conn: Connection = {
        id: 'tenant-conn',
        name: 'tenant-profile',
        targetType: TARGET_TYPES.SELF_HOSTED,
        contactPoint: 'http://test.com/v2',
        tenantId: 'profile-tenant',
      };
      saveConnection(conn);
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
