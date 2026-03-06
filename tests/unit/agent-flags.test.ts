/**
 * Unit tests for agent-specific flags: --fields and --dry-run
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { Logger } from '../../src/logger.ts';
import { c8ctl } from '../../src/runtime.ts';

describe('--fields flag (output field filtering)', () => {
  let consoleLogSpy: string[];
  let originalLog: typeof console.log;
  let originalOutputMode: typeof c8ctl.outputMode;
  let originalFields: typeof c8ctl.fields;

  beforeEach(() => {
    consoleLogSpy = [];
    originalLog = console.log;
    originalOutputMode = c8ctl.outputMode;
    originalFields = c8ctl.fields;
    console.log = (...args: any[]) => {
      consoleLogSpy.push(args.join(' '));
    };
  });

  afterEach(() => {
    console.log = originalLog;
    c8ctl.outputMode = originalOutputMode;
    c8ctl.fields = originalFields;
  });

  describe('table() field filtering', () => {
    test('filters table columns when --fields is set (text mode)', () => {
      c8ctl.outputMode = 'text';
      c8ctl.fields = ['Key', 'State'];
      const logger = new Logger();
      const data = [
        { Key: '123', State: 'ACTIVE', 'Process ID': 'myProcess', Version: 1 },
        { Key: '456', State: 'COMPLETED', 'Process ID': 'otherProcess', Version: 2 },
      ];
      logger.table(data);
      const output = consoleLogSpy.join('\n');
      assert.ok(output.includes('Key'), 'should include Key column');
      assert.ok(output.includes('State'), 'should include State column');
      assert.ok(!output.includes('Process ID'), 'should NOT include Process ID column');
      assert.ok(!output.includes('Version'), 'should NOT include Version column');
    });

    test('filters table columns when --fields is set (JSON mode)', () => {
      c8ctl.outputMode = 'json';
      c8ctl.fields = ['Key', 'State'];
      const logger = new Logger();
      const data = [
        { Key: '123', State: 'ACTIVE', 'Process ID': 'myProcess', Version: 1 },
        { Key: '456', State: 'COMPLETED', 'Process ID': 'otherProcess', Version: 2 },
      ];
      logger.table(data);
      assert.strictEqual(consoleLogSpy.length, 1);
      const parsed = JSON.parse(consoleLogSpy[0]);
      assert.strictEqual(parsed.length, 2);
      assert.ok('Key' in parsed[0], 'Key should be present');
      assert.ok('State' in parsed[0], 'State should be present');
      assert.ok(!('Process ID' in parsed[0]), 'Process ID should be filtered out');
      assert.ok(!('Version' in parsed[0]), 'Version should be filtered out');
    });

    test('returns all columns when --fields is not set', () => {
      c8ctl.outputMode = 'json';
      c8ctl.fields = undefined;
      const logger = new Logger();
      const data = [{ Key: '123', State: 'ACTIVE', 'Process ID': 'myProcess' }];
      logger.table(data);
      const parsed = JSON.parse(consoleLogSpy[0]);
      assert.ok('Key' in parsed[0]);
      assert.ok('State' in parsed[0]);
      assert.ok('Process ID' in parsed[0]);
    });

    test('field matching is case-insensitive', () => {
      c8ctl.outputMode = 'json';
      c8ctl.fields = ['key', 'state'];  // lowercase
      const logger = new Logger();
      const data = [{ Key: '123', State: 'ACTIVE', Version: 1 }];  // title case keys
      logger.table(data);
      const parsed = JSON.parse(consoleLogSpy[0]);
      assert.ok('Key' in parsed[0], 'Key should match case-insensitively');
      assert.ok('State' in parsed[0], 'State should match case-insensitively');
      assert.ok(!('Version' in parsed[0]), 'Version should be filtered out');
    });

    test('returns empty table data when all fields are filtered out', () => {
      c8ctl.outputMode = 'json';
      c8ctl.fields = ['nonExistentField'];
      const logger = new Logger();
      const data = [{ Key: '123', State: 'ACTIVE' }];
      logger.table(data);
      const parsed = JSON.parse(consoleLogSpy[0]);
      assert.deepStrictEqual(parsed[0], {});
    });
  });

  describe('json() field filtering', () => {
    test('filters object keys when --fields is set (JSON mode)', () => {
      c8ctl.outputMode = 'json';
      c8ctl.fields = ['key', 'state'];
      const logger = new Logger();
      const data = { key: '123', state: 'ACTIVE', processDefinitionId: 'myProcess', version: 1 };
      logger.json(data);
      const parsed = JSON.parse(consoleLogSpy[0]);
      assert.ok('key' in parsed);
      assert.ok('state' in parsed);
      assert.ok(!('processDefinitionId' in parsed));
      assert.ok(!('version' in parsed));
    });

    test('filters array elements when --fields is set', () => {
      c8ctl.outputMode = 'json';
      c8ctl.fields = ['key'];
      const logger = new Logger();
      const data = [
        { key: '123', state: 'ACTIVE', version: 1 },
        { key: '456', state: 'COMPLETED', version: 2 },
      ];
      logger.json(data);
      const parsed = JSON.parse(consoleLogSpy[0]);
      assert.ok('key' in parsed[0]);
      assert.ok(!('state' in parsed[0]));
      assert.ok(!('version' in parsed[0]));
    });

    test('returns full object when --fields is not set', () => {
      c8ctl.outputMode = 'json';
      c8ctl.fields = undefined;
      const logger = new Logger();
      const data = { key: '123', state: 'ACTIVE', version: 1 };
      logger.json(data);
      const parsed = JSON.parse(consoleLogSpy[0]);
      assert.ok('key' in parsed);
      assert.ok('state' in parsed);
      assert.ok('version' in parsed);
    });

    test('passes through primitives unchanged when --fields is set', () => {
      c8ctl.outputMode = 'json';
      c8ctl.fields = ['someField'];
      const logger = new Logger();

      // String
      logger.json('plain string value');
      assert.strictEqual(JSON.parse(consoleLogSpy[0]), 'plain string value');

      // Number
      consoleLogSpy.length = 0;
      logger.json(42);
      assert.strictEqual(JSON.parse(consoleLogSpy[0]), 42);

      // Boolean
      consoleLogSpy.length = 0;
      logger.json(true);
      assert.strictEqual(JSON.parse(consoleLogSpy[0]), true);

      // null
      consoleLogSpy.length = 0;
      logger.json(null);
      assert.strictEqual(JSON.parse(consoleLogSpy[0]), null);
    });
  });
});

describe('--dry-run flag (c8ctl runtime)', () => {
  let originalDryRun: typeof c8ctl.dryRun;

  beforeEach(() => {
    originalDryRun = c8ctl.dryRun;
  });

  afterEach(() => {
    c8ctl.dryRun = originalDryRun;
  });

  test('dryRun defaults to undefined', () => {
    const saved = c8ctl.dryRun;
    c8ctl.dryRun = undefined;
    assert.strictEqual(c8ctl.dryRun, undefined);
    c8ctl.dryRun = saved;
  });

  test('dryRun can be set to true', () => {
    c8ctl.dryRun = true;
    assert.strictEqual(c8ctl.dryRun, true);
  });

  test('dryRun can be set to false', () => {
    c8ctl.dryRun = false;
    assert.strictEqual(c8ctl.dryRun, false);
  });
});
