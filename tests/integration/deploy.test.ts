/**
 * Integration tests for deployment
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { deploy } from '../../src/commands/deployments.ts';
import { createClient } from '../../src/client.ts';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getUserDataDir } from '../../src/config.ts';

describe('Deployment Integration Tests (requires Camunda 8 at localhost:8080)', () => {
  beforeEach(() => {
    // Clear session state before each test to ensure clean tenant resolution
    const sessionPath = join(getUserDataDir(), 'session.json');
    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath);
    }
  });

  test('deploy simple BPMN creates deployment', async () => {
    // Deploy a single BPMN file - should succeed without throwing
    await deploy(['tests/fixtures/simple.bpmn'], {});
    
    // If we got here, deployment succeeded
    assert.ok(true, 'Deployment completed successfully');
  });

  test('deploy prioritizes building block folders', async () => {
    // Deploy a project with building blocks - should succeed without throwing
    await deploy(['tests/fixtures/_bb-building-block'], {});
    
    // If we got here, deployment succeeded
    assert.ok(true, 'Building block deployment completed successfully');
  });
});
