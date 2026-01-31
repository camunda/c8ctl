/**
 * Integration tests for bash completion
 * Tests that the generated bash completion script works correctly in a real bash shell
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

describe('Bash Completion Integration Tests', () => {
  test('bash completion script is generated without errors', () => {
    const result = spawnSync('node', ['src/index.ts', 'completion', 'bash'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    assert.strictEqual(result.status, 0, 'completion bash command should succeed');
    assert.ok(result.stdout.includes('_c8ctl_completions'), 'Should contain completion function');
    assert.ok(result.stdout.includes('complete -F _c8ctl_completions c8ctl'), 'Should register completion');
  });

  test('bash completion script loads without errors in bash', () => {
    // Generate completion script
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'bash'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const completionScript = completionResult.stdout;

    // Create a test script that sources the completion and verifies it loads
    const testScript = `
set -e
${completionScript}

# Verify function exists
type _c8ctl_completions > /dev/null || exit 1

# Verify completion is registered
complete -p c8ctl | grep -q "_c8ctl_completions" || exit 2

echo "SUCCESS"
`;

    const result = spawnSync('bash', ['--norc', '--noprofile', '-c', testScript], {
      encoding: 'utf-8',
    });

    assert.strictEqual(result.status, 0, 'Bash script should succeed');
    assert.ok(result.stdout.includes('SUCCESS'), 'Completion should load successfully');
  });

  test('bash completion completes verbs starting with "l"', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'bash'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const testScript = `
set -e
${completionResult.stdout}

# Simulate completion for "c8ctl l"
COMP_WORDS=(c8ctl l)
COMP_CWORD=1
_c8ctl_completions

# Check results
echo "\${COMPREPLY[@]}"
`;

    const result = spawnSync('bash', ['--norc', '--noprofile', '-c', testScript], {
      encoding: 'utf-8',
    });

    assert.strictEqual(result.status, 0, 'Completion test should succeed');
    assert.ok(result.stdout.includes('list'), 'Should complete to "list"');
    assert.ok(result.stdout.includes('load'), 'Should complete to "load"');
  });

  test('bash completion completes resources for "list" command', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'bash'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const testScript = `
set -e
${completionResult.stdout}

# Simulate completion for "c8ctl list p"
COMP_WORDS=(c8ctl list p)
COMP_CWORD=2
_c8ctl_completions

# Check results
echo "\${COMPREPLY[@]}"
`;

    const result = spawnSync('bash', ['--norc', '--noprofile', '-c', testScript], {
      encoding: 'utf-8',
    });

    assert.strictEqual(result.status, 0, 'Completion test should succeed');
    assert.ok(result.stdout.includes('process-instances'), 'Should include "process-instances"');
    assert.ok(result.stdout.includes('profiles'), 'Should include "profiles"');
    assert.ok(result.stdout.includes('plugins'), 'Should include "plugins"');
  });

  test('bash completion completes shell types for "completion" command', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'bash'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const testScript = `
set -e
${completionResult.stdout}

# Simulate completion for "c8ctl completion "
COMP_WORDS=(c8ctl completion "")
COMP_CWORD=2
_c8ctl_completions

# Check results
echo "\${COMPREPLY[@]}"
`;

    const result = spawnSync('bash', ['--norc', '--noprofile', '-c', testScript], {
      encoding: 'utf-8',
    });

    assert.strictEqual(result.status, 0, 'Completion test should succeed');
    assert.ok(result.stdout.includes('bash'), 'Should include "bash"');
    assert.ok(result.stdout.includes('zsh'), 'Should include "zsh"');
    assert.ok(result.stdout.includes('fish'), 'Should include "fish"');
  });

  test('bash completion completes resources for "get" command', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'bash'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const testScript = `
set -e
${completionResult.stdout}

# Simulate completion for "c8ctl get "
COMP_WORDS=(c8ctl get "")
COMP_CWORD=2
_c8ctl_completions

# Check results
echo "\${COMPREPLY[@]}"
`;

    const result = spawnSync('bash', ['--norc', '--noprofile', '-c', testScript], {
      encoding: 'utf-8',
    });

    assert.strictEqual(result.status, 0, 'Completion test should succeed');
    assert.ok(result.stdout.includes('process-instance'), 'Should include "process-instance"');
    assert.ok(result.stdout.includes('topology'), 'Should include "topology"');
  });

  test('bash completion handles flags correctly', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'bash'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const testScript = `
set -e
${completionResult.stdout}

# Simulate completion for flags starting with "--"
COMP_WORDS=(c8ctl list process-instances --h)
COMP_CWORD=3
_c8ctl_completions

# Check results
echo "\${COMPREPLY[@]}"
`;

    const result = spawnSync('bash', ['--norc', '--noprofile', '-c', testScript], {
      encoding: 'utf-8',
    });

    assert.strictEqual(result.status, 0, 'Completion test should succeed');
    assert.ok(result.stdout.includes('--help'), 'Should include "--help" flag');
  });

  test('bash completion completes aliases (pi for process-instance)', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'bash'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const testScript = `
set -e
${completionResult.stdout}

# Simulate completion for "c8ctl list pi"
COMP_WORDS=(c8ctl list pi)
COMP_CWORD=2
_c8ctl_completions

# Check that pi is in the completions
echo "\${COMPREPLY[@]}"
`;

    const result = spawnSync('bash', ['--norc', '--noprofile', '-c', testScript], {
      encoding: 'utf-8',
    });

    assert.strictEqual(result.status, 0, 'Completion test should succeed');
    assert.ok(result.stdout.includes('pi'), 'Should include "pi" alias');
  });

  test('bash completion does not use external dependencies', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'bash'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    // Verify the script doesn't rely on _init_completion from bash-completion package
    assert.ok(
      !completionResult.stdout.includes('_init_completion ||'),
      'Should not use _init_completion from bash-completion package'
    );
    
    // Verify it initializes variables manually
    assert.ok(
      completionResult.stdout.includes('cur="${COMP_WORDS[COMP_CWORD]}"'),
      'Should initialize cur variable'
    );
    assert.ok(
      completionResult.stdout.includes('prev="${COMP_WORDS[COMP_CWORD-1]}"'),
      'Should initialize prev variable'
    );
  });
});
