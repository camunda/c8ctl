/**
 * Unit tests for completion module
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { showCompletion } from '../../src/commands/completion.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'src', 'index.ts');

describe('Completion Module', () => {
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
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  test('generates bash completion script', () => {
    showCompletion('bash');
    
    const output = consoleLogSpy.join('\n');
    
    // Check for bash-specific content
    assert.ok(output.includes('# c8ctl bash completion'));
    assert.ok(output.includes('_c8ctl_completions()'));
    assert.ok(output.includes('cur="${COMP_WORDS[COMP_CWORD]}"'), 'Should initialize cur variable');
    assert.ok(output.includes('COMPREPLY=()'), 'Should initialize COMPREPLY');
    assert.ok(output.includes('complete -F _c8ctl_completions c8ctl'));
    assert.ok(output.includes('complete -F _c8ctl_completions c8'));
    
    // Check for verbs
    assert.ok(output.includes('list'));
    assert.ok(output.includes('get'));
    assert.ok(output.includes('create'));
    assert.ok(output.includes('deploy'));
    assert.ok(output.includes('run'));
    assert.ok(output.includes('upgrade'));
    assert.ok(output.includes('downgrade'));
    assert.ok(output.includes('init'));
    
    // Check for resources
    assert.ok(output.includes('process-instance'));
    assert.ok(output.includes('user-task'));
    assert.ok(output.includes('incident'));

    // Check for plugin commands
    assert.ok(output.includes('cluster'), 'Should include cluster verb');
    assert.ok(output.includes('"start stop status list list-remote install delete log logs"'), 'Should include cluster subcommands');

    // Check for open command
    assert.ok(output.includes('open'), 'Should include open verb');
    assert.ok(output.includes('"operate tasklist modeler optimize"'), 'Should include open resources');

    // Check for feedback command
    assert.ok(output.includes('feedback'), 'Should include feedback verb');
  });

  test('generates zsh completion script', () => {
    showCompletion('zsh');
    
    const output = consoleLogSpy.join('\n');
    
    // Check for zsh-specific content
    assert.ok(output.includes('#compdef c8ctl c8'));
    assert.ok(output.includes('_c8ctl()'));
    assert.ok(output.includes('_describe'));
    assert.ok(output.includes('_arguments'));
    
    // Check for verbs with descriptions
    assert.ok(output.includes('list:List resources'));
    assert.ok(output.includes('get:Get resource by key'));
    assert.ok(output.includes('deploy:Deploy BPMN/DMN/forms'));
    assert.ok(output.includes('upgrade:Upgrade a plugin'));
    assert.ok(output.includes('downgrade:Downgrade a plugin'));
    assert.ok(output.includes('init:Create a new plugin from template'));
    
    // Check for flags
    assert.ok(output.includes('--profile[Use specific profile]'));
    assert.ok(output.includes('--help[Show help]'));

    // Check for plugin commands
    assert.ok(output.includes("'cluster:Manage local Camunda 8 cluster'"), 'Should include cluster verb');
    assert.ok(output.includes("'start:Start local Camunda 8 cluster'"), 'Should include cluster start subcommand');
    assert.ok(output.includes("'stop:Stop local Camunda 8 cluster'"), 'Should include cluster stop subcommand');

    // Check for open command
    assert.ok(output.includes("'open:Open Camunda web application in browser'"), 'Should include open verb');
    assert.ok(output.includes("'operate:Open Camunda Operate'"), 'Should include operate resource');
    assert.ok(output.includes("'tasklist:Open Camunda Tasklist'"), 'Should include tasklist resource');
    assert.ok(output.includes("'modeler:Open Camunda Web Modeler'"), 'Should include modeler resource');
    assert.ok(output.includes("'optimize:Open Camunda Optimize'"), 'Should include optimize resource');

    // Check for feedback command
    assert.ok(output.includes("'feedback:Open the feedback page to report issues or request features'"), 'Should include feedback verb');
  });

  test('generates fish completion script', () => {
    showCompletion('fish');
    
    const output = consoleLogSpy.join('\n');
    
    // Check for fish-specific content
    assert.ok(output.includes('# c8ctl fish completion'));
    assert.ok(output.includes('complete -c c8ctl'));
    assert.ok(output.includes('complete -c c8'));
    assert.ok(output.includes('__fish_use_subcommand'));
    assert.ok(output.includes('__fish_seen_subcommand_from'));
    
    // Check for commands
    assert.ok(output.includes("'list' -d 'List resources'"));
    assert.ok(output.includes("'deploy' -d 'Deploy BPMN/DMN/forms'"));
    
    // Check for flags
    assert.ok(output.includes('-s h -l help'));
    assert.ok(output.includes('-l profile'));

    // Check for plugin commands
    assert.ok(output.includes("'cluster' -d 'Manage local Camunda 8 cluster'"), 'Should include cluster verb');
    assert.ok(output.includes("'start' -d 'Start local Camunda 8 cluster'"), 'Should include cluster start subcommand');
    assert.ok(output.includes("'stop' -d 'Stop local Camunda 8 cluster'"), 'Should include cluster stop subcommand');

    // Check for open command
    assert.ok(output.includes("'open' -d 'Open Camunda web application in browser'"), 'Should include open verb');
    assert.ok(output.includes("'operate' -d 'Open Camunda Operate'"), 'Should include operate resource');
    assert.ok(output.includes("'tasklist' -d 'Open Camunda Tasklist'"), 'Should include tasklist resource');

    // Check for feedback command
    assert.ok(output.includes("'feedback' -d 'Open the feedback page to report issues or request features'"), 'Should include feedback verb');
  });

  // Error cases: run the CLI as a subprocess so that process.exit happens
  // in a child process and does not interfere with the test runner.

  test('handles missing shell argument', () => {
    const result = spawnSync('node', [CLI, 'completion'], {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
    });
    assert.strictEqual(result.status, 1, 'Should exit with code 1');
    assert.ok(result.stderr.includes('Shell type required'), `stderr should mention "Shell type required". Got: ${result.stderr}`);
    assert.ok(result.stderr.includes('c8 completion <bash|zsh|fish>'), `stderr should include usage hint. Got: ${result.stderr}`);
  });

  test('handles unknown shell', () => {
    const result = spawnSync('node', [CLI, 'completion', 'powershell'], {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
    });
    assert.strictEqual(result.status, 1, 'Should exit with code 1');
    assert.ok(result.stderr.includes('Unknown shell: powershell'), `stderr should mention "Unknown shell: powershell". Got: ${result.stderr}`);
    // logger.info() in text mode goes to stdout
    assert.ok(result.stdout.includes('Supported shells: bash, zsh, fish'), `stdout should list supported shells. Got: ${result.stdout}`);
  });

  test('handles case-insensitive shell names', () => {
    showCompletion('BASH');
    
    const output = consoleLogSpy.join('\n');
    assert.ok(output.includes('# c8ctl bash completion'));
    
    consoleLogSpy.length = 0;
    showCompletion('Zsh');
    
    const output2 = consoleLogSpy.join('\n');
    assert.ok(output2.includes('#compdef c8ctl c8'));
    
    consoleLogSpy.length = 0;
    showCompletion('FiSh');
    
    const output3 = consoleLogSpy.join('\n');
    assert.ok(output3.includes('# c8ctl fish completion'));
  });
});
