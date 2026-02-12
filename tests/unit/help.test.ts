/**
 * Unit tests for help module
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { getVersion, showVersion, showHelp, showVerbResources, showCommandHelp } from '../../src/commands/help.ts';

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
    assert.ok(output.includes('await'));
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
    assert.ok(output.includes('--variables'));
    assert.ok(output.includes('--awaitCompletion'));
    assert.ok(output.includes('--fetchVariables'));
    assert.ok(output.includes('--version'));
    assert.ok(output.includes('--help'));
    
    // Check for case-insensitive search flags
    assert.ok(output.includes('--iname'));
    assert.ok(output.includes('--iid'));
    assert.ok(output.includes('--iassignee'));
    assert.ok(output.includes('--ierrorMessage'));
    assert.ok(output.includes('--itype'));
    assert.ok(output.includes('--ivalue'));
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
    assert.ok(output.includes('incident'));
    assert.ok(output.includes('topology'));
    assert.ok(output.includes('form'));
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

  test('showVerbResources shows resources for await', () => {
    showVerbResources('await');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl await'));
    assert.ok(output.includes('process-instance'));
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

  test('showCommandHelp shows list help with resources and flags', () => {
    showCommandHelp('list');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl list'));
    assert.ok(output.includes('process-instances (pi)'));
    assert.ok(output.includes('--bpmnProcessId'));
    assert.ok(output.includes('--state'));
    assert.ok(output.includes('--assignee'));
    assert.ok(output.includes('user-tasks (ut)'));
    assert.ok(output.includes('incidents (inc)'));
    assert.ok(output.includes('jobs'));
    assert.ok(output.includes('profiles'));
    assert.ok(output.includes('plugins'));
  });

  test('showCommandHelp shows get help with resources and flags', () => {
    showCommandHelp('get');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl get'));
    assert.ok(output.includes('process-instance (pi)'));
    assert.ok(output.includes('--variables'));
    assert.ok(output.includes('process-definition (pd)'));
    assert.ok(output.includes('--xml'));
    assert.ok(output.includes('incident (inc)'));
    assert.ok(output.includes('topology'));
    assert.ok(output.includes('form'));
    assert.ok(output.includes('--userTask'));
    assert.ok(output.includes('--processDefinition'));
  });

  test('showCommandHelp shows create help with resources and flags', () => {
    showCommandHelp('create');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl create'));
    assert.ok(output.includes('process-instance (pi)'));
    assert.ok(output.includes('--bpmnProcessId'));
    assert.ok(output.includes('--version'));
    assert.ok(output.includes('--variables'));
  });

  test('showCommandHelp shows complete help with resources and flags', () => {
    showCommandHelp('complete');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl complete'));
    assert.ok(output.includes('user-task (ut)'));
    assert.ok(output.includes('job'));
    assert.ok(output.includes('--variables'));
  });

  test('showCommandHelp shows search help with resources and flags', () => {
    showCommandHelp('search');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl search'));
    assert.ok(output.includes('process-instances (pi)'));
    assert.ok(output.includes('process-definitions (pd)'));
    assert.ok(output.includes('user-tasks (ut)'));
    assert.ok(output.includes('incidents (inc)'));
    assert.ok(output.includes('jobs'));
    assert.ok(output.includes('variables'));
    assert.ok(output.includes('--bpmnProcessId'));
    assert.ok(output.includes('--iid'));
    assert.ok(output.includes('--iname'));
    assert.ok(output.includes('Wildcard Search'));
    assert.ok(output.includes('Case-Insensitive Search'));
  });

  test('showCommandHelp shows deploy help', () => {
    showCommandHelp('deploy');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl deploy'));
    assert.ok(output.includes('BPMN'));
    assert.ok(output.includes('DMN'));
    assert.ok(output.includes('form'));
    assert.ok(output.includes('Building Blocks'));
  });

  test('showCommandHelp shows run help', () => {
    showCommandHelp('run');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl run'));
    assert.ok(output.includes('Deploy and start'));
    assert.ok(output.includes('--variables'));
  });

  test('showCommandHelp shows watch help', () => {
    showCommandHelp('watch');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl watch'));
    assert.ok(output.includes('Watch files'));
    assert.ok(output.includes('Alias: w'));
    assert.ok(output.includes('--variables'));
  });

  test('showCommandHelp shows cancel help', () => {
    showCommandHelp('cancel');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl cancel'));
    assert.ok(output.includes('process-instance (pi)'));
  });

  test('showCommandHelp shows resolve help', () => {
    showCommandHelp('resolve');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl resolve'));
    assert.ok(output.includes('incident'));
    assert.ok(output.includes('Alias: inc'));
  });

  test('showCommandHelp shows fail help', () => {
    showCommandHelp('fail');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl fail'));
    assert.ok(output.includes('job'));
    assert.ok(output.includes('--retries'));
    assert.ok(output.includes('--errorMessage'));
  });

  test('showCommandHelp shows activate help', () => {
    showCommandHelp('activate');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl activate'));
    assert.ok(output.includes('jobs'));
    assert.ok(output.includes('--maxJobsToActivate'));
    assert.ok(output.includes('--timeout'));
    assert.ok(output.includes('--worker'));
  });

  test('showCommandHelp shows publish help', () => {
    showCommandHelp('publish');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl publish'));
    assert.ok(output.includes('message'));
    assert.ok(output.includes('Alias: msg'));
    assert.ok(output.includes('--correlationKey'));
    assert.ok(output.includes('--timeToLive'));
  });

  test('showCommandHelp shows correlate help', () => {
    showCommandHelp('correlate');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl correlate'));
    assert.ok(output.includes('message'));
    assert.ok(output.includes('--correlationKey'));
  });

  test('showCommandHelp handles watch alias w', () => {
    showCommandHelp('w');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl watch'));
    assert.ok(output.includes('Alias: w'));
  });

  test('showHelp includes all help commands', () => {
    showHelp();
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl help search'));
    assert.ok(output.includes('c8ctl help deploy'));
    assert.ok(output.includes('c8ctl help run'));
    assert.ok(output.includes('c8ctl help watch'));
    assert.ok(output.includes('c8ctl help cancel'));
    assert.ok(output.includes('c8ctl help resolve'));
    assert.ok(output.includes('c8ctl help fail'));
    assert.ok(output.includes('c8ctl help activate'));
    assert.ok(output.includes('c8ctl help publish'));
    assert.ok(output.includes('c8ctl help correlate'));
  });

  test('showVerbResources shows resources for help', () => {
    showVerbResources('help');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl help'));
    assert.ok(output.includes('list'));
    assert.ok(output.includes('get'));
    assert.ok(output.includes('create'));
    assert.ok(output.includes('complete'));
    assert.ok(output.includes('await'));
    assert.ok(output.includes('search'));
    assert.ok(output.includes('deploy'));
    assert.ok(output.includes('run'));
    assert.ok(output.includes('watch'));
    assert.ok(output.includes('cancel'));
    assert.ok(output.includes('resolve'));
    assert.ok(output.includes('fail'));
    assert.ok(output.includes('activate'));
    assert.ok(output.includes('publish'));
    assert.ok(output.includes('correlate'));
  });

  test('showCommandHelp handles unknown command', () => {
    showCommandHelp('unknown');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('No detailed help available'));
    assert.ok(output.includes('unknown'));
  });
});
