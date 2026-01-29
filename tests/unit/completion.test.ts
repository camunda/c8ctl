/**
 * Unit tests for completion module
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { showCompletion } from '../../src/commands/completion.ts';

describe('Completion Module', () => {
  let consoleLogSpy: any[];
  let consoleErrorSpy: any[];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let processExitStub: ((code: number) => never) | undefined;
  let exitCode: number | undefined;

  beforeEach(() => {
    consoleLogSpy = [];
    consoleErrorSpy = [];
    originalLog = console.log;
    originalError = console.error;
    exitCode = undefined;
    
    console.log = (...args: any[]) => {
      consoleLogSpy.push(args.join(' '));
    };
    
    console.error = (...args: any[]) => {
      consoleErrorSpy.push(args.join(' '));
    };

    // Stub process.exit to capture exit codes
    processExitStub = process.exit;
    (process.exit as any) = (code: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    };
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    if (processExitStub) {
      process.exit = processExitStub;
    }
  });

  test('generates bash completion script', () => {
    showCompletion('bash');
    
    const output = consoleLogSpy.join('\n');
    
    // Check for bash-specific content
    assert.ok(output.includes('# c8ctl bash completion'));
    assert.ok(output.includes('_c8ctl_completions()'));
    assert.ok(output.includes('_init_completion'));
    assert.ok(output.includes('complete -F _c8ctl_completions c8ctl'));
    assert.ok(output.includes('complete -F _c8ctl_completions c8'));
    
    // Check for verbs
    assert.ok(output.includes('list'));
    assert.ok(output.includes('get'));
    assert.ok(output.includes('create'));
    assert.ok(output.includes('deploy'));
    assert.ok(output.includes('run'));
    
    // Check for resources
    assert.ok(output.includes('process-instance'));
    assert.ok(output.includes('user-task'));
    assert.ok(output.includes('incident'));
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
    
    // Check for flags
    assert.ok(output.includes('--profile[Use specific profile]'));
    assert.ok(output.includes('--help[Show help]'));
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
  });

  test('handles missing shell argument', () => {
    try {
      showCompletion(undefined);
      assert.fail('Should have thrown an error');
    } catch (error: any) {
      assert.ok(error.message.includes('process.exit(1)'));
      assert.strictEqual(exitCode, 1);
    }
    
    const errorOutput = consoleErrorSpy.join('\n');
    assert.ok(errorOutput.includes('Shell type required'));
    assert.ok(errorOutput.includes('c8 completion <bash|zsh|fish>'));
  });

  test('handles unknown shell', () => {
    try {
      showCompletion('powershell');
      assert.fail('Should have thrown an error');
    } catch (error: any) {
      assert.ok(error.message.includes('process.exit(1)'));
      assert.strictEqual(exitCode, 1);
    }
    
    const errorOutput = consoleErrorSpy.join('\n');
    assert.ok(errorOutput.includes('Unknown shell: powershell'));
    assert.ok(errorOutput.includes('Supported shells: bash, zsh, fish'));
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
