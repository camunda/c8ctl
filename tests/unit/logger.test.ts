/**
 * Unit tests for logger module
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { Logger, getLogger } from '../../src/logger.ts';
import { c8ctl } from '../../src/runtime.ts';

describe('Logger Module', () => {
  let consoleLogSpy: any[];
  let consoleErrorSpy: any[];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(() => {
    consoleLogSpy = [];
    consoleErrorSpy = [];
    originalLog = console.log;
    originalError = console.error;
    
    console.log = (...args: any[]) => {
      consoleLogSpy.push(args.join(' '));
    };
    
    console.error = (...args: any[]) => {
      consoleErrorSpy.push(args.join(' '));
    };
    
    // Reset c8ctl runtime state
    c8ctl.outputMode = 'text';
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  describe('Text Mode', () => {
    test('info outputs message in text mode', () => {
      c8ctl.outputMode = 'text';
      const logger = new Logger();
      logger.info('Test message');
      
      assert.strictEqual(consoleLogSpy.length, 1);
      assert.strictEqual(consoleLogSpy[0], 'Test message');
    });

    test('success outputs with checkmark in text mode', () => {
      c8ctl.outputMode = 'text';
      const logger = new Logger();
      logger.success('Operation successful');
      
      assert.strictEqual(consoleLogSpy.length, 1);
      assert.ok(consoleLogSpy[0].includes('✓'));
      assert.ok(consoleLogSpy[0].includes('Operation successful'));
    });

    test('success outputs with key in text mode', () => {
      c8ctl.outputMode = 'text';
      const logger = new Logger();
      logger.success('Process created', '123456');
      
      assert.strictEqual(consoleLogSpy.length, 1);
      assert.ok(consoleLogSpy[0].includes('✓'));
      assert.ok(consoleLogSpy[0].includes('Process created'));
      assert.ok(consoleLogSpy[0].includes('[Key: 123456]'));
    });

    test('error outputs with X mark in text mode', () => {
      c8ctl.outputMode = 'text';
      const logger = new Logger();
      logger.error('Operation failed');
      
      assert.strictEqual(consoleErrorSpy.length, 1);
      assert.ok(consoleErrorSpy[0].includes('✗'));
      assert.ok(consoleErrorSpy[0].includes('Operation failed'));
    });

    test('error outputs with error object in text mode', () => {
      c8ctl.outputMode = 'text';
      const logger = new Logger();
      const error = new Error('Something went wrong');
      logger.error('Operation failed', error);
      
      assert.strictEqual(consoleErrorSpy.length, 2);
      assert.ok(consoleErrorSpy[0].includes('✗'));
      assert.ok(consoleErrorSpy[0].includes('Operation failed'));
      assert.ok(consoleErrorSpy[1].includes('Something went wrong'));
    });

    test('table formats data as table in text mode', () => {
      c8ctl.outputMode = 'text';
      const logger = new Logger();
      const data = [
        { Name: 'John', Age: 30, City: 'NYC' },
        { Name: 'Jane', Age: 25, City: 'LA' },
      ];
      
      logger.table(data);
      
      assert.ok(consoleLogSpy.length > 0);
      const output = consoleLogSpy.join('\n');
      assert.ok(output.includes('Name'));
      assert.ok(output.includes('Age'));
      assert.ok(output.includes('City'));
      assert.ok(output.includes('John'));
      assert.ok(output.includes('Jane'));
    });

    test('table handles empty data in text mode', () => {
      c8ctl.outputMode = 'text';
      const logger = new Logger();
      logger.table([]);
      
      assert.strictEqual(consoleLogSpy.length, 1);
      assert.ok(consoleLogSpy[0].includes('No data to display'));
    });

    test('json outputs formatted JSON in text mode', () => {
      c8ctl.outputMode = 'text';
      const logger = new Logger();
      const data = { key: 'value', nested: { data: 123 } };
      
      logger.json(data);
      
      assert.strictEqual(consoleLogSpy.length, 1);
      const output = JSON.parse(consoleLogSpy[0]);
      assert.deepStrictEqual(output, data);
    });
  });

  describe('JSON Mode', () => {
    test('info outputs JSON in JSON mode', () => {
      c8ctl.outputMode = 'json';
      const logger = new Logger();
      logger.info('Test message');
      
      assert.strictEqual(consoleLogSpy.length, 1);
      const output = JSON.parse(consoleLogSpy[0]);
      assert.strictEqual(output.status, 'info');
      assert.strictEqual(output.message, 'Test message');
    });

    test('success outputs JSON in JSON mode', () => {
      c8ctl.outputMode = 'json';
      const logger = new Logger();
      logger.success('Operation successful');
      
      assert.strictEqual(consoleLogSpy.length, 1);
      const output = JSON.parse(consoleLogSpy[0]);
      assert.strictEqual(output.status, 'success');
      assert.strictEqual(output.message, 'Operation successful');
    });

    test('success outputs JSON with key in JSON mode', () => {
      c8ctl.outputMode = 'json';
      const logger = new Logger();
      logger.success('Process created', 123456);
      
      assert.strictEqual(consoleLogSpy.length, 1);
      const output = JSON.parse(consoleLogSpy[0]);
      assert.strictEqual(output.status, 'success');
      assert.strictEqual(output.message, 'Process created');
      assert.strictEqual(output.key, 123456);
    });

    test('error outputs JSON in JSON mode', () => {
      c8ctl.outputMode = 'json';
      const logger = new Logger();
      logger.error('Operation failed');
      
      assert.strictEqual(consoleErrorSpy.length, 1);
      const output = JSON.parse(consoleErrorSpy[0]);
      assert.strictEqual(output.status, 'error');
      assert.strictEqual(output.message, 'Operation failed');
    });

    test('error outputs JSON with error details in JSON mode', () => {
      c8ctl.outputMode = 'json';
      const logger = new Logger();
      const error = new Error('Something went wrong');
      logger.error('Operation failed', error);
      
      assert.strictEqual(consoleErrorSpy.length, 1);
      const output = JSON.parse(consoleErrorSpy[0]);
      assert.strictEqual(output.status, 'error');
      assert.strictEqual(output.message, 'Operation failed');
      assert.strictEqual(output.error, 'Something went wrong');
      assert.ok(output.stack);
    });

    test('table outputs JSON array in JSON mode', () => {
      c8ctl.outputMode = 'json';
      const logger = new Logger();
      const data = [
        { Name: 'John', Age: 30 },
        { Name: 'Jane', Age: 25 },
      ];
      
      logger.table(data);
      
      assert.strictEqual(consoleLogSpy.length, 1);
      const output = JSON.parse(consoleLogSpy[0]);
      assert.deepStrictEqual(output, data);
    });

    test('json outputs compact JSON in JSON mode', () => {
      c8ctl.outputMode = 'json';
      const logger = new Logger();
      const data = { key: 'value', nested: { data: 123 } };
      
      logger.json(data);
      
      assert.strictEqual(consoleLogSpy.length, 1);
      const output = JSON.parse(consoleLogSpy[0]);
      assert.deepStrictEqual(output, data);
    });
  });

  describe('Mode Switching', () => {
    test('mode property switches output mode', () => {
      c8ctl.outputMode = 'text';
      const logger = new Logger();
      logger.success('Test');
      
      assert.strictEqual(consoleLogSpy.length, 1);
      assert.ok(consoleLogSpy[0].includes('✓'));
      
      consoleLogSpy = [];
      logger.mode = 'json';
      // Setting logger.mode should update c8ctl.outputMode
      assert.strictEqual(c8ctl.outputMode, 'json');
      logger.success('Test 2');
      
      assert.strictEqual(consoleLogSpy.length, 1);
      const output = JSON.parse(consoleLogSpy[0]);
      assert.strictEqual(output.status, 'success');
    });

    test('mode property returns current mode', () => {
      c8ctl.outputMode = 'text';
      const logger = new Logger();
      assert.strictEqual(logger.mode, 'text');
      
      c8ctl.outputMode = 'json';
      assert.strictEqual(logger.mode, 'json');
    });
  });

  describe('Debug Mode', () => {
    test('debug outputs when debug is enabled', () => {
      c8ctl.outputMode = 'text';
      const logger = new Logger();
      logger.debugEnabled = true;
      logger.debug('Debug message', { key: 'value' });
      
      assert.strictEqual(consoleErrorSpy.length, 1);
      assert.ok(consoleErrorSpy[0].includes('DEBUG'));
      assert.ok(consoleErrorSpy[0].includes('Debug message'));
    });

    test('debug does not output when debug is disabled', () => {
      c8ctl.outputMode = 'text';
      const logger = new Logger();
      logger.debugEnabled = false;
      logger.debug('Debug message');
      
      assert.strictEqual(consoleErrorSpy.length, 0);
    });

    test('debug outputs JSON in JSON mode', () => {
      c8ctl.outputMode = 'json';
      const logger = new Logger();
      logger.debugEnabled = true;
      logger.debug('Debug message', { key: 'value' });
      
      assert.strictEqual(consoleErrorSpy.length, 1);
      const output = JSON.parse(consoleErrorSpy[0]);
      assert.strictEqual(output.level, 'debug');
      assert.strictEqual(output.message, 'Debug message');
      assert.ok(output.timestamp);
    });

    test('debugEnabled property can be set', () => {
      c8ctl.outputMode = 'text';
      const logger = new Logger();
      assert.strictEqual(logger.debugEnabled, false);
      
      logger.debugEnabled = true;
      assert.strictEqual(logger.debugEnabled, true);
    });
  });

  describe('Singleton Logger', () => {
    test('getLogger returns singleton instance', () => {
      c8ctl.outputMode = 'text';
      const logger1 = getLogger();
      const logger2 = getLogger();
      
      assert.strictEqual(logger1, logger2);
    });

    test('getLogger updates mode if provided', () => {
      c8ctl.outputMode = 'text';
      const logger = getLogger();
      assert.strictEqual(logger.mode, 'text');
      
      // getLogger with mode parameter should update c8ctl.outputMode
      getLogger('json');
      assert.strictEqual(c8ctl.outputMode, 'json');
      assert.strictEqual(logger.mode, 'json');
    });
  });
});
