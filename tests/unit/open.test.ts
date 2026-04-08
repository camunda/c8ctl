/**
 * Unit tests for the open command
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { deriveAppUrl, OPEN_APPS } from '../../src/commands/open.ts';

describe('open command', () => {
  describe('deriveAppUrl', () => {
    test('strips /v2 suffix from self-hosted base URL', () => {
      assert.strictEqual(deriveAppUrl('http://localhost:8080/v2', 'operate'), 'http://localhost:8080/operate');
    });

    test('strips /v2/ (with trailing slash) from base URL', () => {
      assert.strictEqual(deriveAppUrl('http://localhost:8080/v2/', 'operate'), 'http://localhost:8080/operate');
    });

    test('strips /v1 suffix', () => {
      assert.strictEqual(deriveAppUrl('http://localhost:8080/v1', 'tasklist'), 'http://localhost:8080/tasklist');
    });

    test('works without a version path suffix', () => {
      assert.strictEqual(deriveAppUrl('http://localhost:8080', 'modeler'), 'http://localhost:8080/modeler');
    });

    test('works with trailing slash and no version suffix', () => {
      assert.strictEqual(deriveAppUrl('http://localhost:8080/', 'optimize'), 'http://localhost:8080/optimize');
    });

    test('works with https and custom port', () => {
      assert.strictEqual(deriveAppUrl('https://camunda.example.com:443/v2', 'operate'), 'https://camunda.example.com:443/operate');
    });

    test('produces correct URL for each supported app', () => {
      for (const app of OPEN_APPS) {
        const url = deriveAppUrl('http://localhost:8080/v2', app);
        assert.strictEqual(url, `http://localhost:8080/${app}`, `expected correct URL for ${app}`);
      }
    });
  });

  describe('OPEN_APPS', () => {
    test('contains operate', () => {
      assert.ok(OPEN_APPS.includes('operate'));
    });

    test('contains tasklist', () => {
      assert.ok(OPEN_APPS.includes('tasklist'));
    });

    test('contains modeler', () => {
      assert.ok(OPEN_APPS.includes('modeler'));
    });

    test('contains optimize', () => {
      assert.ok(OPEN_APPS.includes('optimize'));
    });
  });
});
