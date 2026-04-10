/**
 * Unit tests for the open command
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deriveAppUrl, getBrowserCommand, openApp, OPEN_APPS } from '../../src/commands/open.ts';

const CLI_ENTRY = join(process.cwd(), 'src', 'index.ts');

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

  describe('getBrowserCommand', () => {
    const url = 'http://localhost:8080/operate';

    test('returns xdg-open on Linux', () => {
      const { command, args } = getBrowserCommand(url, 'linux');
      assert.strictEqual(command, 'xdg-open');
      assert.deepStrictEqual(args, [url]);
    });

    test('returns open on macOS', () => {
      const { command, args } = getBrowserCommand(url, 'darwin');
      assert.strictEqual(command, 'open');
      assert.deepStrictEqual(args, [url]);
    });

    test('returns cmd.exe on Windows', () => {
      const { command, args } = getBrowserCommand(url, 'win32');
      assert.strictEqual(command, 'cmd.exe');
      assert.deepStrictEqual(args, ['/c', 'start', '', url]);
    });

    test('defaults to xdg-open for unknown platforms', () => {
      const { command, args } = getBrowserCommand(url, 'freebsd' as NodeJS.Platform);
      assert.strictEqual(command, 'xdg-open');
      assert.deepStrictEqual(args, [url]);
    });
  });

  describe('OPEN_APPS', () => {
    test('contains all expected apps', () => {
      assert.deepStrictEqual([...OPEN_APPS], ['operate', 'tasklist', 'modeler', 'optimize']);
    });
  });

  describe('openApp', () => {
    let consoleLogSpy: string[];
    let consoleErrorSpy: string[];
    let originalLog: typeof console.log;
    let originalError: typeof console.error;
    let originalExit: typeof process.exit;
    let exitCode: number | undefined;

    beforeEach(() => {
      consoleLogSpy = [];
      consoleErrorSpy = [];
      originalLog = console.log;
      originalError = console.error;
      originalExit = process.exit;
      exitCode = undefined;

      console.log = (...args: any[]) => { consoleLogSpy.push(args.join(' ')); };
      console.error = (...args: any[]) => { consoleErrorSpy.push(args.join(' ')); };
      (process.exit as any) = (code: number) => {
        exitCode = code;
        throw new Error(`process.exit(${code})`);
      };
    });

    afterEach(() => {
      console.log = originalLog;
      console.error = originalError;
      process.exit = originalExit;
    });

    test('exits with error when app is undefined', async () => {
      try {
        await openApp(undefined, {});
        assert.fail('Should have thrown');
      } catch (e: any) {
        assert.ok(e.message.includes('process.exit(1)'));
        assert.strictEqual(exitCode, 1);
      }
      const errorOutput = consoleErrorSpy.join('\n');
      assert.ok(errorOutput.includes('Application required'));
      assert.ok(errorOutput.includes('operate'));
    });

    test('exits with error for invalid app name', async () => {
      try {
        await openApp('console', {});
        assert.fail('Should have thrown');
      } catch (e: any) {
        assert.ok(e.message.includes('process.exit(1)'));
        assert.strictEqual(exitCode, 1);
      }
      const errorOutput = consoleErrorSpy.join('\n');
      assert.ok(errorOutput.includes('Application required'));
    });

    test('shows usage hint on invalid app', async () => {
      try {
        await openApp('invalid', {});
      } catch { /* expected */ }
      const allOutput = consoleLogSpy.join('\n') + consoleErrorSpy.join('\n');
      assert.ok(allOutput.includes('Usage: c8 open <app>') || allOutput.includes('c8 open <app>'),
        `Expected usage hint, got:\nstdout: ${consoleLogSpy.join('\n')}\nstderr: ${consoleErrorSpy.join('\n')}`);
    });
  });

  describe('CLI integration', () => {
    test('c8 open with no app shows error', () => {
      const result = spawnSync('node', [
        '--experimental-strip-types',
        CLI_ENTRY,
        'open',
      ], {
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env, XDG_DATA_HOME: join(tmpdir(), `c8ctl-open-${Date.now()}`) },
      });

      const output = (result.stdout ?? '') + (result.stderr ?? '');
      assert.ok(output.includes('Application required'), `Expected error message, got: ${output}`);
      assert.notStrictEqual(result.status, 0, 'Should exit with non-zero status');
    });

    test('c8 open with invalid app shows error', () => {
      const result = spawnSync('node', [
        '--experimental-strip-types',
        CLI_ENTRY,
        'open', 'console',
      ], {
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env, XDG_DATA_HOME: join(tmpdir(), `c8ctl-open-${Date.now()}`) },
      });

      const output = (result.stdout ?? '') + (result.stderr ?? '');
      assert.ok(output.includes('Application required'), `Expected error message, got: ${output}`);
      assert.notStrictEqual(result.status, 0);
    });

    for (const app of OPEN_APPS) {
      test(`c8 open ${app} --dry-run prints the derived URL`, () => {
        const result = spawnSync('node', [
          '--experimental-strip-types',
          CLI_ENTRY,
          'open', app, '--dry-run',
        ], {
          encoding: 'utf-8',
          timeout: 5000,
          env: {
            ...process.env,
            XDG_DATA_HOME: join(tmpdir(), `c8ctl-open-${Date.now()}`),
            CAMUNDA_BASE_URL: 'http://test-host:8080/v2',
          },
        });

        const output = (result.stdout ?? '') + (result.stderr ?? '');
        assert.ok(output.includes(`http://test-host:8080/${app}`),
          `Expected derived URL for ${app}, got: ${output}`);
      });
    }
  });
});
