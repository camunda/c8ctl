/**
 * Unit tests for client module
 * Tests SDK client creation with proper configuration
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { resolveClusterConfig } from '../../src/config.ts';
import { c8ctl } from '../../src/runtime.ts';

describe('Client Module', () => {
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

  test('config resolves CAMUNDA_TOKEN_AUDIENCE from environment', () => {
    // Set up environment variables
    process.env.CAMUNDA_BASE_URL = 'https://test.camunda.io';
    process.env.CAMUNDA_CLIENT_ID = 'test-client-id';
    process.env.CAMUNDA_CLIENT_SECRET = 'test-secret';
    process.env.CAMUNDA_TOKEN_AUDIENCE = 'test-audience';

    const config = resolveClusterConfig();

    // Verify the config has the audience from the environment variable
    assert.strictEqual(config.baseUrl, 'https://test.camunda.io');
    assert.strictEqual(config.clientId, 'test-client-id');
    assert.strictEqual(config.clientSecret, 'test-secret');
    assert.strictEqual(config.audience, 'test-audience', 'audience should come from CAMUNDA_TOKEN_AUDIENCE');
  });

  test('config omits audience when CAMUNDA_TOKEN_AUDIENCE is not set', () => {
    // Set up environment variables without audience
    process.env.CAMUNDA_BASE_URL = 'https://test.camunda.io';
    process.env.CAMUNDA_CLIENT_ID = 'test-client-id';
    process.env.CAMUNDA_CLIENT_SECRET = 'test-secret';
    delete process.env.CAMUNDA_TOKEN_AUDIENCE;

    const config = resolveClusterConfig();

    // Verify the config does not have audience
    assert.strictEqual(config.baseUrl, 'https://test.camunda.io');
    assert.strictEqual(config.clientId, 'test-client-id');
    assert.strictEqual(config.clientSecret, 'test-secret');
    assert.strictEqual(config.audience, undefined, 'audience should be undefined when not set');
  });
});

