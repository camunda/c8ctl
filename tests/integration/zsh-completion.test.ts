/**
 * Integration tests for zsh completion
 * Tests that the generated zsh completion script works correctly in a real zsh shell
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';

// Check if zsh is available
function isZshAvailable(): boolean {
  const result = spawnSync('which', ['zsh'], { encoding: 'utf-8' });
  return result.status === 0;
}

describe('Zsh Completion Integration Tests', () => {
  test('zsh completion script is generated without errors', () => {
    const result = spawnSync('node', ['src/index.ts', 'completion', 'zsh'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    assert.strictEqual(result.status, 0, 'completion zsh command should succeed');
    assert.ok(result.stdout.includes('#compdef c8ctl c8'), 'Should contain compdef directive');
    assert.ok(result.stdout.includes('_c8ctl'), 'Should contain completion function');
  });

  test('zsh completion script loads without errors in zsh', { skip: !isZshAvailable() ? 'zsh not available' : false }, () => {
    // Generate completion script
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'zsh'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const completionScript = completionResult.stdout;

    // Create a test script that sources the completion and verifies it loads
    const testScript = `
# Use zdotdir to isolate zsh environment
export ZDOTDIR=$(mktemp -d)
trap "rm -rf $ZDOTDIR" EXIT

# Create minimal zshrc for autoload and compinit
cat > $ZDOTDIR/.zshrc << 'ZSHRC'
autoload -Uz compinit
compinit -u
ZSHRC

# Load our completion
cat > $ZDOTDIR/_c8ctl << 'COMPLETION'
${completionScript}
COMPLETION

# Add to fpath
export fpath=($ZDOTDIR $fpath)

# Test in isolated zsh
zsh -c '
set -e
source $ZDOTDIR/.zshrc
autoload -Uz _c8ctl
type _c8ctl > /dev/null || exit 1
echo "SUCCESS"
'
`;

    const result = spawnSync('sh', ['-c', testScript], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: process.env.PATH },
    });

    assert.strictEqual(result.status, 0, 'Zsh script should succeed');
    assert.ok(result.stdout.includes('SUCCESS'), 'Completion should load successfully');
  });

  test('zsh completion completes verbs starting with "l"', { skip: !isZshAvailable() ? 'zsh not available' : false }, () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'zsh'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    // For zsh, we can't easily simulate completion outside of interactive mode
    // but we can verify the script structure contains the expected completions
    const script = completionResult.stdout;
    
    // Verify that 'list' and 'load' verbs are defined in the verbs array
    assert.ok(script.includes("'list:List resources'"), 'Should define list verb');
    assert.ok(script.includes("'load:Load a c8ctl plugin'"), 'Should define load verb');
    
    // Verify the script can be loaded without syntax errors
    const testScript = `
export ZDOTDIR=$(mktemp -d)
trap "rm -rf $ZDOTDIR" EXIT

cat > $ZDOTDIR/.zshrc << 'ZSHRC'
autoload -Uz compinit
compinit -u
ZSHRC

cat > $ZDOTDIR/_c8ctl << 'COMPLETION'
${completionResult.stdout}
COMPLETION

export fpath=($ZDOTDIR $fpath)

zsh -c '
setopt NO_GLOBAL_RCS
source $ZDOTDIR/.zshrc
autoload -Uz _c8ctl
compdef _c8ctl c8ctl
echo "SUCCESS"
'
`;

    const result = spawnSync('sh', ['-c', testScript], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: process.env.PATH },
    });

    assert.strictEqual(result.status, 0, 'Completion test should succeed');
    assert.ok(result.stdout.includes('SUCCESS'), 'Completion should load successfully');
  });

  test('zsh completion script structure is valid', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'zsh'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const script = completionResult.stdout;

    // Verify key structural elements
    assert.ok(script.includes('#compdef c8ctl c8'), 'Should have compdef directive');
    assert.ok(script.includes('_c8ctl() {'), 'Should define _c8ctl function');
    assert.ok(script.includes("case $CURRENT in"), 'Should have case statement for position');
    assert.ok(script.includes('_describe'), 'Should use _describe for completions');
    assert.ok(!script.includes('_c8ctl "$@"'), 'Should NOT call _c8ctl at top level (compdef handles registration)');
  });

  test('zsh completion has resources for "list" command', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'zsh'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const script = completionResult.stdout;

    // Check that list command has appropriate resources
    assert.ok(script.includes('process-instances'), 'Should include process-instances');
    assert.ok(script.includes('user-tasks'), 'Should include user-tasks');
    assert.ok(script.includes('incidents'), 'Should include incidents');
    assert.ok(script.includes('profiles'), 'Should include profiles');
    assert.ok(script.includes('plugins'), 'Should include plugins');
  });

  test('zsh completion has resources for "get" command', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'zsh'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const script = completionResult.stdout;

    // Check that get command resources are in the right context
    const getSection = script.match(/get\)[\s\S]*?;;/);
    assert.ok(getSection, 'Should have get command section');
    assert.ok(getSection[0].includes('process-instance'), 'Should include process-instance');
    assert.ok(getSection[0].includes('topology'), 'Should include topology');
  });

  test('zsh completion supports shell types for "completion" command', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'zsh'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const script = completionResult.stdout;

    // Check completion command resources
    const completionSection = script.match(/completion\)[\s\S]*?;;/);
    assert.ok(completionSection, 'Should have completion command section');
    assert.ok(completionSection[0].includes('bash'), 'Should include bash');
    assert.ok(completionSection[0].includes('zsh'), 'Should include zsh');
    assert.ok(completionSection[0].includes('fish'), 'Should include fish');
  });

  test('zsh completion includes aliases (pi for process-instance)', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'zsh'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const script = completionResult.stdout;

    assert.ok(script.includes("'pi:"), 'Should include pi alias');
    assert.ok(script.includes("'ut:"), 'Should include ut alias');
    assert.ok(script.includes("'inc:"), 'Should include inc alias');
    assert.ok(script.includes("'msg:"), 'Should include msg alias');
  });

  test('zsh completion includes flags with descriptions', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'zsh'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const script = completionResult.stdout;

    assert.ok(script.includes('--help[Show help]'), 'Should include --help flag');
    assert.ok(script.includes('--version[Show version]'), 'Should include --version flag');
    assert.ok(script.includes('--profile[Use specific profile]'), 'Should include --profile flag');
    assert.ok(script.includes('--variables[JSON variables]'), 'Should include --variables flag');
  });

  test('zsh completion uses _arguments for flag completion', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'zsh'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const script = completionResult.stdout;

    // Check that _arguments is used for additional positions (flags)
    assert.ok(script.includes('_arguments'), 'Should use _arguments for flag completion');
    assert.ok(script.match(/\*\)[\s\S]*?_arguments/), 'Should use _arguments in default case');
  });
});
