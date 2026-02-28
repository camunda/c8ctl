/**
 * Unit tests for logger module
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { Logger, getLogger, sortTableData, type SortOrder } from '../../src/logger.ts';
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

    test('warn outputs with warning symbol in text mode', () => {
      c8ctl.outputMode = 'text';
      const logger = new Logger();
      logger.warn('Something might be wrong');
      
      assert.strictEqual(consoleErrorSpy.length, 1);
      assert.ok(consoleErrorSpy[0].includes('⚠'));
      assert.ok(consoleErrorSpy[0].includes('Something might be wrong'));
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
    test('info outputs JSON to stderr in JSON mode', () => {
      c8ctl.outputMode = 'json';
      const logger = new Logger();
      logger.info('Test message');
      
      assert.strictEqual(consoleErrorSpy.length, 1);
      const output = JSON.parse(consoleErrorSpy[0]);
      assert.strictEqual(output.status, 'info');
      assert.strictEqual(output.message, 'Test message');
    });

    test('success outputs JSON to stderr in JSON mode', () => {
      c8ctl.outputMode = 'json';
      const logger = new Logger();
      logger.success('Operation successful');
      
      assert.strictEqual(consoleErrorSpy.length, 1);
      const output = JSON.parse(consoleErrorSpy[0]);
      assert.strictEqual(output.status, 'success');
      assert.strictEqual(output.message, 'Operation successful');
    });

    test('success outputs JSON with key to stderr in JSON mode', () => {
      c8ctl.outputMode = 'json';
      const logger = new Logger();
      logger.success('Process created', 123456);
      
      assert.strictEqual(consoleErrorSpy.length, 1);
      const output = JSON.parse(consoleErrorSpy[0]);
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

    test('warn outputs JSON in JSON mode', () => {
      c8ctl.outputMode = 'json';
      const logger = new Logger();
      logger.warn('Something might be wrong');
      
      assert.strictEqual(consoleErrorSpy.length, 1);
      const output = JSON.parse(consoleErrorSpy[0]);
      assert.strictEqual(output.status, 'warning');
      assert.strictEqual(output.message, 'Something might be wrong');
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
      
      assert.strictEqual(consoleErrorSpy.length, 1);
      const output = JSON.parse(consoleErrorSpy[0]);
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

  describe('Custom LogWriter', () => {
    test('Logger uses defaultWriter by default', () => {
      c8ctl.outputMode = 'text';
      const logger = new Logger();

      // defaultWriter should route log to console.log
      logger.info('Test message');
      assert.strictEqual(consoleLogSpy.length, 1);
      assert.strictEqual(consoleLogSpy[0], 'Test message');

      // defaultWriter should route error to console.error
      logger.error('Error message');
      assert.strictEqual(consoleErrorSpy.length, 1);
      assert.ok(consoleErrorSpy[0].includes('Error message'));
    });

    test('Logger accepts custom writer', () => {
      c8ctl.outputMode = 'text';
      const customLogOutput: any[] = [];
      const customErrorOutput: any[] = [];

      const customWriter = {
        log(...data: any[]): void {
          customLogOutput.push(data.join(' '));
        },
        error(...data: any[]): void {
          customErrorOutput.push(data.join(' '));
        },
      };

      const logger = new Logger(customWriter);

      logger.info('Custom info');
      logger.success('Custom success');
      logger.error('Custom error');

      // Verify custom writer was used instead of console
      assert.strictEqual(consoleLogSpy.length, 0);
      assert.strictEqual(consoleErrorSpy.length, 0);

      // Verify custom writer captured output
      assert.strictEqual(customLogOutput.length, 2);
      assert.ok(customLogOutput[0].includes('Custom info'));
      assert.ok(customLogOutput[1].includes('Custom success'));

      assert.strictEqual(customErrorOutput.length, 1);
      assert.ok(customErrorOutput[0].includes('Custom error'));
    });

    test('Custom writer receives all method calls', () => {
      c8ctl.outputMode = 'text';
      const logCalls: any[][] = [];
      const errorCalls: any[][] = [];

      const trackingWriter = {
        log(...data: any[]): void {
          logCalls.push(data);
        },
        error(...data: any[]): void {
          errorCalls.push(data);
        },
      };

      const logger = new Logger(trackingWriter);

      logger.info('Info message');
      logger.success('Success message', 123);
      logger.table([{ id: 1, name: 'Test' }]);
      logger.json({ key: 'value' });
      logger.error('Error message', new Error('Failed'));
      logger.debugEnabled = true;
      logger.debug('Debug message', 'arg1', 'arg2');

      // Verify log calls: info(1) + success(1) + table(3: header, separator, row) + json(1) = 6
      assert.strictEqual(logCalls.length, 6, 'Should have 6 log calls');

      // Verify error calls: error with Error object(2) + debug(1) = 3
      assert.strictEqual(errorCalls.length, 3, 'Should have 3 error calls');
    });

    test('Custom writer can route everything to stderr', () => {
      c8ctl.outputMode = 'text';

      // Simulate stderrWriter behavior
      const stderrWriter = {
        log(...data: any[]): void {
          console.error(...data);
        },
        error(...data: any[]): void {
          console.error(...data);
        },
      };

      const logger = new Logger(stderrWriter);

      logger.info('Info to stderr');
      logger.success('Success to stderr');
      logger.error('Error to stderr');

      // All output should go to console.error
      assert.strictEqual(consoleLogSpy.length, 0, 'Nothing should go to stdout');
      assert.ok(consoleErrorSpy.length > 0, 'Everything should go to stderr');

      const allErrors = consoleErrorSpy.join('\n');
      assert.ok(allErrors.includes('Info to stderr'));
      assert.ok(allErrors.includes('Success to stderr'));
      assert.ok(allErrors.includes('Error to stderr'));
    });

    test('Custom writer works with JSON mode', () => {
      c8ctl.outputMode = 'json';
      const logOutput: any[] = [];
      const errorOutput: any[] = [];

      const customWriter = {
        log(...data: any[]): void {
          logOutput.push(data[0]);
        },
        error(...data: any[]): void {
          errorOutput.push(data[0]);
        },
      };

      const logger = new Logger(customWriter);

      logger.info('JSON info');
      logger.success('JSON success', 456);
      logger.error('JSON error');

      // info and success go to stderr in JSON mode (alongside error)
      assert.strictEqual(logOutput.length, 0);
      assert.strictEqual(errorOutput.length, 3);
      const infoObj = JSON.parse(errorOutput[0]);
      assert.strictEqual(infoObj.status, 'info');
      assert.strictEqual(infoObj.message, 'JSON info');

      const successObj = JSON.parse(errorOutput[1]);
      assert.strictEqual(successObj.status, 'success');
      assert.strictEqual(successObj.key, 456);

      const errorObj = JSON.parse(errorOutput[2]);
      assert.strictEqual(errorObj.status, 'error');
      assert.strictEqual(errorObj.message, 'JSON error');
    });

    test('Custom writer handles debug with multiple arguments', () => {
      c8ctl.outputMode = 'text';
      const errorCalls: any[][] = [];

      const trackingWriter = {
        log(...data: any[]): void {},
        error(...data: any[]): void {
          errorCalls.push(data);
        },
      };

      const logger = new Logger(trackingWriter);
      logger.debugEnabled = true;

      logger.debug('Debug with args', { obj: 'value' }, [1, 2, 3], 'string');

      assert.strictEqual(errorCalls.length, 1);
      assert.ok(errorCalls[0].length > 1, 'Should have multiple arguments');
      assert.ok(errorCalls[0][0].includes('Debug with args'));
    });
  });
});

describe('sortTableData', () => {
  let warnMessages: string[];
  let logger: Logger;

  beforeEach(() => {
    warnMessages = [];
    const trackingWriter = {
      log(...data: any[]): void {},
      error(...data: any[]): void {
        warnMessages.push(data.join(' '));
      },
    };
    logger = new Logger(trackingWriter);
    c8ctl.outputMode = 'text';
  });

  test('returns original data when sortBy is undefined', () => {
    const data = [{ Name: 'b' }, { Name: 'a' }];
    const result = sortTableData(data, undefined, logger);
    assert.deepStrictEqual(result, data);
  });

  test('returns original data when data is empty', () => {
    const result = sortTableData([], 'Name', logger);
    assert.deepStrictEqual(result, []);
  });

  test('sorts data by column (ascending)', () => {
    const data = [{ Name: 'banana' }, { Name: 'apple' }, { Name: 'cherry' }];
    const result = sortTableData(data, 'Name', logger);
    assert.deepStrictEqual(result.map(r => r.Name), ['apple', 'banana', 'cherry']);
  });

  test('sorts data by column case-insensitively', () => {
    const data = [{ Name: 'banana' }, { Name: 'apple' }];
    const result = sortTableData(data, 'name', logger);
    assert.deepStrictEqual(result.map(r => r.Name), ['apple', 'banana']);
  });

  test('does not mutate original array', () => {
    const data = [{ Name: 'b' }, { Name: 'a' }];
    const original = [...data];
    sortTableData(data, 'Name', logger);
    assert.deepStrictEqual(data, original);
  });

  test('warns and returns original data when column not found', () => {
    const data = [{ Name: 'b' }, { Name: 'a' }];
    const result = sortTableData(data, 'NonExistent', logger);
    assert.deepStrictEqual(result, data);
    assert.strictEqual(warnMessages.length, 1);
    assert.ok(warnMessages[0].includes('NonExistent'));
    assert.ok(warnMessages[0].includes('Name'));
    assert.ok(!warnMessages[0].includes('Warning: Warning:'), 'Should not double-prefix warning');
  });

  test('sorts numeric-looking strings numerically', () => {
    const data = [{ Version: '10' }, { Version: '2' }, { Version: '1' }];
    const result = sortTableData(data, 'Version', logger);
    assert.deepStrictEqual(result.map(r => r.Version), ['1', '2', '10']);
  });

  test('places null/undefined values last', () => {
    const data = [{ State: null }, { State: 'ACTIVE' }, { State: undefined }];
    const result = sortTableData(data as any, 'State', logger);
    assert.strictEqual(result[0].State, 'ACTIVE');
  });

  test('sorts data descending when sortOrder is desc', () => {
    const data = [{ Name: 'apple' }, { Name: 'cherry' }, { Name: 'banana' }];
    const result = sortTableData(data, 'Name', logger, 'desc');
    assert.deepStrictEqual(result.map(r => r.Name), ['cherry', 'banana', 'apple']);
  });

  test('sorts numeric data descending when sortOrder is desc', () => {
    const data = [{ Version: '1' }, { Version: '10' }, { Version: '2' }];
    const result = sortTableData(data, 'Version', logger, 'desc');
    assert.deepStrictEqual(result.map(r => r.Version), ['10', '2', '1']);
  });

  test('sorts ascending by default (explicit asc)', () => {
    const data = [{ Name: 'banana' }, { Name: 'apple' }, { Name: 'cherry' }];
    const result = sortTableData(data, 'Name', logger, 'asc');
    assert.deepStrictEqual(result.map(r => r.Name), ['apple', 'banana', 'cherry']);
  });

  test('places null/undefined last even in descending order', () => {
    const data = [{ State: null }, { State: 'COMPLETED' }, { State: 'ACTIVE' }, { State: undefined }];
    const result = sortTableData(data as any, 'State', logger, 'desc');
    assert.strictEqual(result[0].State, 'COMPLETED');
    assert.strictEqual(result[1].State, 'ACTIVE');
  });

  test('sorted output is serialized in order when table() is called in json mode', () => {
    const logMessages: string[] = [];
    const trackingWriter = {
      log(...data: any[]): void { logMessages.push(data.join(' ')); },
      error(...data: any[]): void {},
    };
    const jsonLogger = new Logger(trackingWriter);
    c8ctl.outputMode = 'json';

    const data = [{ State: 'COMPLETED' }, { State: 'ACTIVE' }, { State: 'CANCELED' }];
    const sorted = sortTableData(data, 'State', jsonLogger);
    jsonLogger.table(sorted);

    assert.strictEqual(logMessages.length, 1);
    const parsed = JSON.parse(logMessages[0]);
    assert.deepStrictEqual(parsed.map((r: any) => r.State), ['ACTIVE', 'CANCELED', 'COMPLETED']);
  });

  test('warns with JSON-formatted message in json mode when column not found', () => {
    const warnJson: string[] = [];
    const trackingWriter = {
      log(...data: any[]): void {},
      error(...data: any[]): void { warnJson.push(data.join(' ')); },
    };
    const jsonLogger = new Logger(trackingWriter);
    c8ctl.outputMode = 'json';

    const data = [{ Name: 'b' }, { Name: 'a' }];
    sortTableData(data, 'Unknown', jsonLogger);

    assert.strictEqual(warnJson.length, 1);
    const parsed = JSON.parse(warnJson[0]);
    assert.strictEqual(parsed.status, 'warning');
    assert.ok(parsed.message.includes('Unknown'));
  });
});
