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

  beforeEach(async () => {
    testDir = join(tmpdir(), `c8ctl-session-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    originalEnv = { ...process.env };
    process.env.XDG_DATA_HOME = testDir;
    
    // Reset c8ctl runtime state before each test
    const { c8ctl } = await import('../../src/runtime.ts');
    c8ctl.activeProfile = undefined;
    c8ctl.activeTenant = undefined;
    c8ctl.outputMode = 'text';
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    process.env = originalEnv;
  });

  test('use profile sets active profile in c8ctl runtime', async () => {
    const { addProfile, setActiveProfile, loadSessionState } = await import('../../src/config.ts');
    const { c8ctl } = await import('../../src/runtime.ts');
    
    // Add a profile first
    addProfile({
      name: 'test-profile',
      baseUrl: 'http://test.com',
    });

    // Set as active
    setActiveProfile('test-profile');

    // Verify it's set in c8ctl runtime
    assert.strictEqual(c8ctl.activeProfile, 'test-profile');
    
    // Verify loadSessionState returns the same value
    const state = loadSessionState();
    assert.strictEqual(state.activeProfile, 'test-profile');
  });

  test('use tenant sets active tenant in c8ctl runtime', async () => {
    const { setActiveTenant, loadSessionState } = await import('../../src/config.ts');
    const { c8ctl } = await import('../../src/runtime.ts');
    
    setActiveTenant('my-tenant');

    // Verify it's set in c8ctl runtime
    assert.strictEqual(c8ctl.activeTenant, 'my-tenant');
    
    // Verify loadSessionState returns the same value
    const state = loadSessionState();
    assert.strictEqual(state.activeTenant, 'my-tenant');
  });

  test('output mode sets mode in c8ctl runtime', async () => {
    const { setOutputMode, loadSessionState } = await import('../../src/config.ts');
    const { c8ctl } = await import('../../src/runtime.ts');
    
    setOutputMode('json');

    // Verify it's set in c8ctl runtime
    assert.strictEqual(c8ctl.outputMode, 'json');
    
    // Verify loadSessionState returns the same value
    const state = loadSessionState();
    assert.strictEqual(state.outputMode, 'json');
  });

  test('session state is managed in c8ctl runtime object', async () => {
    const { 
      addProfile, 
      setActiveProfile, 
      setActiveTenant, 
      setOutputMode, 
      loadSessionState 
    } = await import('../../src/config.ts');
    const { c8ctl } = await import('../../src/runtime.ts');
    
    // Add profile
    addProfile({
      name: 'prod',
      baseUrl: 'https://prod.example.com',
    });

    // Set session state
    setActiveProfile('prod');
    setActiveTenant('tenant-123');
    setOutputMode('json');

    // Verify all are set in c8ctl runtime
    assert.strictEqual(c8ctl.activeProfile, 'prod');
    assert.strictEqual(c8ctl.activeTenant, 'tenant-123');
    assert.strictEqual(c8ctl.outputMode, 'json');
    
    // Verify loadSessionState returns the same values
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
