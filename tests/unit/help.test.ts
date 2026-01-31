/**
 * Unit tests for help module
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { getVersion, showVersion, showHelp, showVerbResources } from '../../src/commands/help.ts';

describe('Help Module', () => {
  let consoleLogSpy: any[];
  let originalLog: typeof console.log;

  beforeEach(() => {
    consoleLogSpy = [];
    originalLog = console.log;
    
    console.log = (...args: any[]) => {
      consoleLogSpy.push(args.join(' '));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  test('getVersion returns package version', () => {
    const version = getVersion();
    assert.ok(version);
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  test('showVersion outputs version', () => {
    showVersion();
    
    assert.strictEqual(consoleLogSpy.length, 1);
    assert.ok(consoleLogSpy[0].includes('c8ctl'));
    assert.ok(consoleLogSpy[0].includes('v'));
  });

  test('showHelp outputs full help text', () => {
    showHelp();
    
    const output = consoleLogSpy.join('\n');
    
    // Check for key sections
    assert.ok(output.includes('c8ctl - Camunda 8 CLI'));
    assert.ok(output.includes('Usage:'));
    assert.ok(output.includes('Commands:'));
    assert.ok(output.includes('Flags:'));
    
    // Check for main commands
    assert.ok(output.includes('list'));
    assert.ok(output.includes('get'));
    assert.ok(output.includes('create'));
    assert.ok(output.includes('deploy'));
    assert.ok(output.includes('run'));
    assert.ok(output.includes('load'));
    assert.ok(output.includes('unload'));
    
    // Check for aliases
    assert.ok(output.includes('pi'));
    assert.ok(output.includes('ut'));
    assert.ok(output.includes('inc'));
    assert.ok(output.includes('msg'));
    
    // Check for flags
    assert.ok(output.includes('--profile'));
    assert.ok(output.includes('--version'));
    assert.ok(output.includes('--help'));
  });

  test('showVerbResources shows resources for list', () => {
    showVerbResources('list');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl list'));
    assert.ok(output.includes('process-instances'));
    assert.ok(output.includes('user-tasks'));
    assert.ok(output.includes('incidents'));
    assert.ok(output.includes('jobs'));
    assert.ok(output.includes('profiles'));
    assert.ok(output.includes('plugins'));
  });

  test('showVerbResources shows resources for get', () => {
    showVerbResources('get');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl get'));
    assert.ok(output.includes('process-instance'));
    assert.ok(output.includes('topology'));
  });

  test('showVerbResources shows resources for create', () => {
    showVerbResources('create');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl create'));
    assert.ok(output.includes('process-instance'));
  });

  test('showVerbResources shows resources for complete', () => {
    showVerbResources('complete');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl complete'));
    assert.ok(output.includes('user-task'));
    assert.ok(output.includes('job'));
  });

  test('showVerbResources shows resources for use', () => {
    showVerbResources('use');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl use'));
    assert.ok(output.includes('profile'));
    assert.ok(output.includes('tenant'));
  });

  test('showVerbResources shows resources for output', () => {
    showVerbResources('output');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl output'));
    assert.ok(output.includes('json'));
    assert.ok(output.includes('text'));
  });

  test('showVerbResources handles unknown verb', () => {
    showVerbResources('unknown');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('Unknown command'));
    assert.ok(output.includes('c8ctl help'));
  });

  test('showVerbResources shows resources for load', () => {
    showVerbResources('load');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl load'));
    assert.ok(output.includes('plugin'));
  });

  test('showVerbResources shows resources for unload', () => {
    showVerbResources('unload');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl unload'));
    assert.ok(output.includes('plugin'));
  });

  test('showVerbResources shows resources for completion', () => {
    showVerbResources('completion');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl completion'));
    assert.ok(output.includes('bash'));
    assert.ok(output.includes('zsh'));
    assert.ok(output.includes('fish'));
  });

  test('showHelp includes completion command', () => {
    showHelp();
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('completion'));
    assert.ok(output.includes('bash|zsh|fish'));
  });
});
