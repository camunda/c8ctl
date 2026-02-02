/**
 * Integration tests for profile/connection management
 * Tests the Connection-based API for managing Modeler-compatible connections
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Profile Management Integration Tests', () => {
  let testDir: string;
  let modelerDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    testDir = join(tmpdir(), `c8ctl-profile-test-${Date.now()}`);
    modelerDir = join(tmpdir(), `c8ctl-modeler-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    mkdirSync(modelerDir, { recursive: true });
    originalEnv = { ...process.env };
    process.env.C8CTL_DATA_DIR = testDir;
    process.env.C8CTL_MODELER_DIR = modelerDir;
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

  test('add profile', async () => {
    const { addProfile, loadProfiles } = await import('../../src/config.ts');
    
    addProfile({
      name: 'test-profile',
      baseUrl: 'http://test.com',
      clientId: 'test-client',
      clientSecret: 'test-secret',  // Need both clientId and clientSecret for OAuth
      defaultTenantId: 'test-tenant',
    });

    const profiles = loadProfiles();
    assert.strictEqual(profiles.length, 1);
    assert.strictEqual(profiles[0].name, 'test-profile');
    assert.strictEqual(profiles[0].baseUrl, 'http://test.com');
    assert.strictEqual(profiles[0].clientId, 'test-client');
    assert.strictEqual(profiles[0].defaultTenantId, 'test-tenant');
  });

  test('remove profile', async () => {
    const { addProfile, removeProfile, loadProfiles } = await import('../../src/config.ts');
    
    addProfile({
      name: 'test-profile',
      baseUrl: 'http://test.com',
    });

    let profiles = loadProfiles();
    assert.strictEqual(profiles.length, 1);

    const removed = removeProfile('test-profile');
    assert.strictEqual(removed, true);

    profiles = loadProfiles();
    assert.strictEqual(profiles.length, 0);
  });

  test('list profiles shows all profiles', async () => {
    const { addProfile } = await import('../../src/config.ts');
    
    addProfile({ name: 'profile1', baseUrl: 'http://test1.com' });
    addProfile({ name: 'profile2', baseUrl: 'http://test2.com' });
    addProfile({ name: 'profile3', baseUrl: 'http://test3.com' });

    const { loadProfiles } = await import('../../src/config.ts');
    const profiles = loadProfiles();
    
    assert.strictEqual(profiles.length, 3);
    assert.ok(profiles.find(p => p.name === 'profile1'));
    assert.ok(profiles.find(p => p.name === 'profile2'));
    assert.ok(profiles.find(p => p.name === 'profile3'));
  });
});
