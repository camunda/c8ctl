/**
 * Integration tests for session management
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Session Management Integration Tests', () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    testDir = join(tmpdir(), `c8ctl-session-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    originalEnv = { ...process.env };
    process.env.XDG_DATA_HOME = testDir;
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    process.env = originalEnv;
  });

  test('use profile persists active profile', async () => {
    const { addProfile, setActiveProfile, loadSessionState } = await import('../../src/config.ts');
    
    // Add a profile first
    addProfile({
      name: 'test-profile',
      baseUrl: 'http://test.com',
    });

    // Set as active
    setActiveProfile('test-profile');

    // Verify it persisted
    const state = loadSessionState();
    assert.strictEqual(state.activeProfile, 'test-profile');
  });

  test('use tenant persists active tenant', async () => {
    const { setActiveTenant, loadSessionState } = await import('../../src/config.ts');
    
    setActiveTenant('my-tenant');

    const state = loadSessionState();
    assert.strictEqual(state.activeTenant, 'my-tenant');
  });

  test('output mode persists', async () => {
    const { setOutputMode, loadSessionState } = await import('../../src/config.ts');
    
    setOutputMode('json');

    const state = loadSessionState();
    assert.strictEqual(state.outputMode, 'json');
  });

  test('session state persists across multiple operations', async () => {
    const { 
      addProfile, 
      setActiveProfile, 
      setActiveTenant, 
      setOutputMode, 
      loadSessionState 
    } = await import('../../src/config.ts');
    
    // Add profile
    addProfile({
      name: 'prod',
      baseUrl: 'https://prod.example.com',
    });

    // Set session state
    setActiveProfile('prod');
    setActiveTenant('tenant-123');
    setOutputMode('json');

    // Verify all persisted
    const state = loadSessionState();
    assert.strictEqual(state.activeProfile, 'prod');
    assert.strictEqual(state.activeTenant, 'tenant-123');
    assert.strictEqual(state.outputMode, 'json');
  });

  test('session state affects credential resolution', async () => {
    const { 
      addProfile, 
      setActiveProfile, 
      resolveClusterConfig 
    } = await import('../../src/config.ts');
    
    // Add profile with specific config
    addProfile({
      name: 'my-profile',
      baseUrl: 'https://custom.example.com',
      clientId: 'custom-client',
    });

    // Set as active
    setActiveProfile('my-profile');

    // Resolve config (should use session profile)
    const config = resolveClusterConfig();
    assert.strictEqual(config.baseUrl, 'https://custom.example.com');
    assert.strictEqual(config.clientId, 'custom-client');
  });

  test('session state affects tenant resolution', async () => {
    const { 
      setActiveTenant, 
      resolveTenantId 
    } = await import('../../src/config.ts');
    
    // Set active tenant
    setActiveTenant('session-tenant');

    // Resolve tenant (should use session tenant)
    const tenantId = resolveTenantId();
    assert.strictEqual(tenantId, 'session-tenant');
  });
});
