/**
 * Unit tests for the --verbose flag and centralized error handling
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { Logger } from '../../src/logger.ts';
import { c8ctl } from '../../src/runtime.ts';
import { handleCommandError } from '../../src/errors.ts';

describe('handleCommandError', () => {
  let errorSpy: string[];
  let infoSpy: string[];
  let originalErr: typeof console.error;
  let originalLog: typeof console.log;
  let originalExit: typeof process.exit;
  let originalVerbose: typeof c8ctl.verbose;
  let originalOutputMode: typeof c8ctl.outputMode;
  let logger: Logger;

  beforeEach(() => {
    errorSpy = [];
    infoSpy = [];
    originalErr = console.error;
    originalLog = console.log;
    originalExit = process.exit;
    originalVerbose = c8ctl.verbose;
    originalOutputMode = c8ctl.outputMode;

    console.error = (...args: any[]) => {
      errorSpy.push(args.join(' '));
    };
    console.log = (...args: any[]) => {
      infoSpy.push(args.join(' '));
    };
    (process.exit as any) = (code: number) => {
      throw new Error(`process.exit(${code})`);
    };

    c8ctl.verbose = false;
    c8ctl.outputMode = 'text';
    logger = new Logger();
  });

  afterEach(() => {
    console.error = originalErr;
    console.log = originalLog;
    process.exit = originalExit;
    c8ctl.verbose = originalVerbose;
    c8ctl.outputMode = originalOutputMode;
  });

  describe('non-verbose mode (default)', () => {
    test('logs user-friendly error message', () => {
      assert.throws(() => {
        handleCommandError(logger, 'Failed to get topology', new Error('fetch failed'));
      });
      assert.ok(errorSpy.some(line => line.includes('Failed to get topology')));
    });

    test('emits verbose hint message', () => {
      assert.throws(() => {
        handleCommandError(logger, 'Failed to get topology', new Error('fetch failed'));
      });
      const allOutput = [...errorSpy, ...infoSpy].join('\n');
      assert.ok(
        allOutput.includes('--verbose'),
        'Should include --verbose hint',
      );
    });

    test('emits additional hints when provided', () => {
      assert.throws(() => {
        handleCommandError(logger, 'Failed to load plugin', new Error('network error'), [
          'Check your network connection',
        ]);
      });
      const allOutput = [...errorSpy, ...infoSpy].join('\n');
      assert.ok(allOutput.includes('Check your network connection'));
    });

    test('emits --verbose hint even with additional hints', () => {
      assert.throws(() => {
        handleCommandError(logger, 'Failed to load plugin', new Error('network error'), [
          'Check your network connection',
        ]);
      });
      const allOutput = [...errorSpy, ...infoSpy].join('\n');
      assert.ok(allOutput.includes('--verbose'));
    });

    test('exits with code 1', () => {
      assert.throws(
        () => handleCommandError(logger, 'Failed to get topology', new Error('fetch failed')),
        (err: Error) => err.message === 'process.exit(1)',
      );
    });
  });

  describe('verbose mode (--verbose flag set)', () => {
    test('re-throws the original error instead of logging', () => {
      c8ctl.verbose = true;
      const originalError = new Error('fetch failed');

      assert.throws(
        () => handleCommandError(logger, 'Failed to get topology', originalError),
        (thrown) => thrown === originalError,
      );
    });

    test('does not emit the verbose hint when re-throwing', () => {
      c8ctl.verbose = true;
      try {
        handleCommandError(logger, 'Failed to get topology', new Error('fetch failed'));
      } catch {
        // expected
      }
      const allOutput = [...errorSpy, ...infoSpy].join('\n');
      assert.ok(!allOutput.includes('--verbose'), 'Should not print --verbose hint in verbose mode');
    });

    test('re-throws non-Error objects as-is', () => {
      c8ctl.verbose = true;
      const originalError = { code: 'ECONNREFUSED', message: 'connection refused' };

      assert.throws(
        () => handleCommandError(logger, 'Failed to connect', originalError),
        (thrown) => thrown === originalError,
      );
    });
  });
});

describe('c8ctl.verbose runtime property', () => {
  let originalVerbose: typeof c8ctl.verbose;

  beforeEach(() => {
    originalVerbose = c8ctl.verbose;
  });

  afterEach(() => {
    c8ctl.verbose = originalVerbose;
  });

  test('defaults to undefined', () => {
    c8ctl.verbose = undefined;
    assert.strictEqual(c8ctl.verbose, undefined);
  });

  test('can be set to true', () => {
    c8ctl.verbose = true;
    assert.strictEqual(c8ctl.verbose, true);
  });

  test('can be set to false', () => {
    c8ctl.verbose = false;
    assert.strictEqual(c8ctl.verbose, false);
  });
});
