/**
 * Unit tests for help module
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { getVersion, showVersion, showHelp, showVerbResources, showCommandHelp } from '../../src/commands/help.ts';
import { c8ctl } from '../../src/runtime.ts';

describe('Help Module', () => {
  let consoleLogSpy: any[];
  let originalLog: typeof console.log;
  let originalOutputMode: typeof c8ctl.outputMode;

  beforeEach(() => {
    consoleLogSpy = [];
    originalLog = console.log;
    originalOutputMode = c8ctl.outputMode;
    c8ctl.outputMode = 'text';
    
    console.log = (...args: any[]) => {
      consoleLogSpy.push(args.join(' '));
    };
  });

  afterEach(() => {
    console.log = originalLog;
    c8ctl.outputMode = originalOutputMode;
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
    assert.ok(output.includes('--requestTimeout'));
    assert.ok(output.includes('--sortBy'));
    assert.ok(output.includes('--asc'));
    assert.ok(output.includes('--desc'));
    assert.ok(output.includes('--limit'));
    assert.ok(output.includes('--version'));
    assert.ok(output.includes('--help'));
    
    // Check for case-insensitive search flags
    assert.ok(output.includes('--iname'));
    assert.ok(output.includes('--iid'));
    assert.ok(output.includes('--iassignee'));
    assert.ok(output.includes('--ierrorMessage'));
    assert.ok(output.includes('--itype'));
    assert.ok(output.includes('--ivalue'));
    
    // Check for date range filter flags
    assert.ok(output.includes('--between'));
    assert.ok(output.includes('--dateField'));

    // Check for verbose flag
    assert.ok(output.includes('--verbose'));
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

  test('showVerbResources shows resources for upgrade', () => {
    showVerbResources('upgrade');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl upgrade'));
    assert.ok(output.includes('plugin'));
  });

  test('showVerbResources shows resources for downgrade', () => {
    showVerbResources('downgrade');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl downgrade'));
    assert.ok(output.includes('plugin'));
  });

  test('showVerbResources shows resources for init', () => {
    showVerbResources('init');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl init'));
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
    assert.ok(output.includes('--sortBy'));
    assert.ok(output.includes('--asc'));
    assert.ok(output.includes('--desc'));
    assert.ok(output.includes('--limit'));
    assert.ok(output.includes('user-tasks (ut)'));
    assert.ok(output.includes('incidents (inc)'));
    assert.ok(output.includes('jobs'));
    assert.ok(output.includes('profiles'));
    assert.ok(output.includes('plugins'));
    assert.ok(output.includes('⚠'), 'list pi help should mention the incident indicator symbol');
    assert.ok(output.includes('incident'), 'list pi help should explain the indicator is for incidents');
    assert.ok(output.includes('--between'), 'list help should include --between flag');
    assert.ok(output.includes('--dateField'), 'list help should include --dateField flag');
    assert.ok(output.includes('--version'), 'list pi help should include --version flag');
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
    assert.ok(output.includes('--id'));
    assert.ok(output.includes('--iid'));
    assert.ok(output.includes('--iname'));
    assert.ok(output.includes('--sortBy'));
    assert.ok(output.includes('--asc'));
    assert.ok(output.includes('--desc'));
    assert.ok(output.includes('--limit'));
    assert.ok(output.includes('Wildcard Search'));
    assert.ok(output.includes('Case-Insensitive Search'));
    assert.ok(output.includes('Date Range Filter'), 'search help should include date range filter section');
    assert.ok(output.includes('--between'), 'search help should include --between flag');
    assert.ok(output.includes('--dateField'), 'search help should include --dateField flag');
    assert.ok(output.includes('--version'), 'search help should include --version flag for pi and pd');
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
    assert.ok(output.includes('--force'));
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
    assert.ok(output.includes('c8ctl help profiles'));
    assert.ok(output.includes('c8ctl help plugin'));
    assert.ok(output.includes('c8ctl help plugins'));
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
    assert.ok(output.includes('profiles'));
    assert.ok(output.includes('profile'));
    assert.ok(output.includes('plugin'));
    assert.ok(output.includes('plugins'));
  });

  test('showCommandHelp shows profile management help', () => {
    showCommandHelp('profiles');

    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl profiles'));
    assert.ok(output.includes('list profiles'));
    assert.ok(output.includes('add profile <name>'));
    assert.ok(output.includes('remove profile <name>'));
    assert.ok(output.includes('use profile <name>'));
    assert.ok(output.includes('modeler:'));
  });

  test('showCommandHelp shows profile management help for profile alias', () => {
    showCommandHelp('profile');

    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl profiles'));
    assert.ok(output.includes('add profile <name>'));
    assert.ok(output.includes('use profile <name>'));
  });

  test('showCommandHelp shows plugin management help', () => {
    showCommandHelp('plugin');

    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl plugin'));
    assert.ok(output.includes('load plugin <name>'));
    assert.ok(output.includes('load plugin --from <url>'));
    assert.ok(output.includes('list plugins'));
    assert.ok(output.includes('upgrade plugin <name> [version]'));
    assert.ok(output.includes('downgrade plugin <name> <version>'));
  });

  test('showCommandHelp shows plugin help for plugins alias', () => {
    showCommandHelp('plugins');

    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('c8ctl plugin'));
    assert.ok(output.includes('sync plugins'));
    assert.ok(output.includes('init plugin [name]'));
  });

  test('showCommandHelp handles unknown command', () => {
    showCommandHelp('unknown');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('No detailed help available'));
    assert.ok(output.includes('unknown'));
  });

  // ── Agent Flags ──────────────────────────────────────────────────────────

  test('showHelp includes agent flags section', () => {
    showHelp();

    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('Agent Flags'), 'help should include Agent Flags section header');
    assert.ok(output.includes('--fields'), 'help should include --fields flag');
    assert.ok(output.includes('--dry-run'), 'help should include --dry-run flag');
  });

  test('showHelp agent flags section is clearly separated', () => {
    showHelp();

    const output = consoleLogSpy.join('\n');
    // Section header should be visually separated (uses ━ or similar separator)
    assert.ok(output.includes('Agent Flags'), 'should have Agent Flags header');
    // Should appear after standard flags section
    const agentPos = output.indexOf('Agent Flags');
    const flagsPos = output.indexOf('--profile');
    assert.ok(agentPos > flagsPos, 'Agent Flags section should appear after standard flags');
  });

  test('showHelp --fields description explains context window purpose', () => {
    showHelp();

    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('context window') || output.includes('context'), 
      '--fields description should mention context window');
  });

  test('showHelp --dry-run description explains it is for mutating commands', () => {
    showHelp();

    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('mutating'), 
      '--dry-run description should explicitly mention mutating commands');
  });

  // ── JSON Mode Help ────────────────────────────────────────────────────────

  test('showHelp emits JSON structure in JSON mode', () => {
    c8ctl.outputMode = 'json';
    const jsonSpy: string[] = [];
    const originalConsoleLog = console.log;
    console.log = (...args: any[]) => { jsonSpy.push(args.join(' ')); };

    showHelp();

    console.log = originalConsoleLog;
    assert.ok(jsonSpy.length > 0, 'should have output');
    const parsed = JSON.parse(jsonSpy[0]);
    assert.ok(parsed.version, 'JSON help should include version');
    assert.ok(Array.isArray(parsed.commands), 'JSON help should include commands array');
    assert.ok(Array.isArray(parsed.agentFlags), 'JSON help should include agentFlags array');
    assert.ok(Array.isArray(parsed.globalFlags), 'JSON help should include globalFlags array');
    assert.ok(parsed.resourceAliases, 'JSON help should include resourceAliases');
  });

  test('JSON help agentFlags contains --fields and --dry-run', () => {
    c8ctl.outputMode = 'json';
    const jsonSpy: string[] = [];
    const originalConsoleLog = console.log;
    console.log = (...args: any[]) => { jsonSpy.push(args.join(' ')); };

    showHelp();

    console.log = originalConsoleLog;
    const parsed = JSON.parse(jsonSpy[0]);
    const flagNames = parsed.agentFlags.map((f: any) => f.flag);
    assert.ok(flagNames.includes('--fields'), 'agentFlags should include --fields');
    assert.ok(flagNames.includes('--dry-run'), 'agentFlags should include --dry-run');
  });

  test('JSON help commands marks mutating commands', () => {
    c8ctl.outputMode = 'json';
    const jsonSpy: string[] = [];
    const originalConsoleLog = console.log;
    console.log = (...args: any[]) => { jsonSpy.push(args.join(' ')); };

    showHelp();

    console.log = originalConsoleLog;
    const parsed = JSON.parse(jsonSpy[0]);
    const createCmd = parsed.commands.find((c: any) => c.verb === 'create');
    assert.ok(createCmd, 'commands should include create');
    assert.strictEqual(createCmd.mutating, true, 'create should be mutating');
    const listCmd = parsed.commands.find((c: any) => c.verb === 'list');
    assert.ok(listCmd, 'commands should include list');
    assert.strictEqual(listCmd.mutating, false, 'list should not be mutating');
  });

  test('showCommandHelp emits JSON in JSON mode', () => {
    c8ctl.outputMode = 'json';
    const jsonSpy: string[] = [];
    const originalConsoleLog = console.log;
    console.log = (...args: any[]) => { jsonSpy.push(args.join(' ')); };

    showCommandHelp('list');

    console.log = originalConsoleLog;
    assert.ok(jsonSpy.length > 0, 'should have output');
    const parsed = JSON.parse(jsonSpy[0]);
    assert.strictEqual(parsed.command, 'list');
    assert.ok(Array.isArray(parsed.agentFlags), 'should include agentFlags');
  });

});
