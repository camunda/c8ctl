/**
 * Integration tests for fish completion
 * Tests that the generated fish completion script works correctly in a real fish shell
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';

describe('Fish Completion Integration Tests', () => {
  test('fish completion script is generated without errors', () => {
    const result = spawnSync('node', ['src/index.ts', 'completion', 'fish'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    assert.strictEqual(result.status, 0, 'completion fish command should succeed');
    assert.ok(result.stdout.includes('# c8ctl fish completion'), 'Should contain fish completion header');
    assert.ok(result.stdout.includes('complete -c c8ctl'), 'Should contain complete commands for c8ctl');
    assert.ok(result.stdout.includes('complete -c c8'), 'Should contain complete commands for c8');
  });

  test('fish completion script loads without errors in fish', () => {
    // Generate completion script
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'fish'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const completionScript = completionResult.stdout;

    // Create a test script that sources the completion and verifies it loads
    const testScript = `
# Create isolated fish config
export XDG_CONFIG_HOME=$(mktemp -d)
export HOME=$XDG_CONFIG_HOME
trap "rm -rf $XDG_CONFIG_HOME" EXIT

# Create fish config directory
mkdir -p $XDG_CONFIG_HOME/fish/completions

# Write completion script
cat > $XDG_CONFIG_HOME/fish/completions/c8ctl.fish << 'FISHCOMP'
${completionScript}
FISHCOMP

# Test in isolated fish shell
fish --no-config --private -c '
set -x XDG_CONFIG_HOME '"$XDG_CONFIG_HOME"'
source '"$XDG_CONFIG_HOME"'/fish/completions/c8ctl.fish
echo "SUCCESS"
' 2>&1
`;

    const result = spawnSync('sh', ['-c', testScript], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: process.env.PATH },
    });

    assert.strictEqual(result.status, 0, 'Fish script should succeed');
    assert.ok(result.stdout.includes('SUCCESS'), 'Completion should load successfully');
  });

  test('fish completion includes verbs', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'fish'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const script = completionResult.stdout;

    // Check for verb completions
    assert.ok(script.includes("'list'"), 'Should include list verb');
    assert.ok(script.includes("'get'"), 'Should include get verb');
    assert.ok(script.includes("'create'"), 'Should include create verb');
    assert.ok(script.includes("'deploy'"), 'Should include deploy verb');
    assert.ok(script.includes("'run'"), 'Should include run verb');
    assert.ok(script.includes("'watch'"), 'Should include watch verb');
    assert.ok(script.includes("'completion'"), 'Should include completion verb');
  });

  test('fish completion uses __fish_use_subcommand condition', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'fish'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const script = completionResult.stdout;

    // Verify that verbs use __fish_use_subcommand to only show when no command given
    assert.ok(
      script.includes("__fish_use_subcommand' -a 'list'"),
      'Should use __fish_use_subcommand for list'
    );
    assert.ok(
      script.includes("__fish_use_subcommand' -a 'get'"),
      'Should use __fish_use_subcommand for get'
    );
  });

  test('fish completion has resources for "list" command', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'fish'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const script = completionResult.stdout;

    // Check that list command has appropriate resources
    assert.ok(
      script.includes("__fish_seen_subcommand_from list' -a 'process-instances'"),
      'Should include process-instances for list'
    );
    assert.ok(
      script.includes("__fish_seen_subcommand_from list' -a 'user-tasks'"),
      'Should include user-tasks for list'
    );
    assert.ok(
      script.includes("__fish_seen_subcommand_from list' -a 'incidents'"),
      'Should include incidents for list'
    );
    assert.ok(
      script.includes("__fish_seen_subcommand_from list' -a 'profiles'"),
      'Should include profiles for list'
    );
    assert.ok(
      script.includes("__fish_seen_subcommand_from list' -a 'plugins'"),
      'Should include plugins for list'
    );
  });

  test('fish completion has resources for "get" command', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'fish'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const script = completionResult.stdout;

    assert.ok(
      script.includes("__fish_seen_subcommand_from get' -a 'process-instance'"),
      'Should include process-instance for get'
    );
    assert.ok(
      script.includes("__fish_seen_subcommand_from get' -a 'topology'"),
      'Should include topology for get'
    );
  });

  test('fish completion supports shell types for "completion" command', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'fish'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const script = completionResult.stdout;

    assert.ok(
      script.includes("__fish_seen_subcommand_from completion' -a 'bash'"),
      'Should include bash for completion'
    );
    assert.ok(
      script.includes("__fish_seen_subcommand_from completion' -a 'zsh'"),
      'Should include zsh for completion'
    );
    assert.ok(
      script.includes("__fish_seen_subcommand_from completion' -a 'fish'"),
      'Should include fish for completion'
    );
  });

  test('fish completion includes aliases (pi for process-instance)', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'fish'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const script = completionResult.stdout;

    assert.ok(script.includes("'pi'"), 'Should include pi alias');
    assert.ok(script.includes("'ut'"), 'Should include ut alias');
    assert.ok(script.includes("'inc'"), 'Should include inc alias');
    assert.ok(script.includes("'msg'"), 'Should include msg alias');
  });

  test('fish completion includes flags with descriptions', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'fish'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const script = completionResult.stdout;

    // Global flags
    assert.ok(script.includes("-s h -l help -d 'Show help'"), 'Should include -h/--help flag');
    assert.ok(script.includes("-s v -l version -d 'Show version'"), 'Should include -v/--version flag');
    assert.ok(script.includes("-l profile -d 'Use specific profile'"), 'Should include --profile flag');
    assert.ok(script.includes("-l variables -d 'JSON variables'"), 'Should include --variables flag');
    assert.ok(script.includes("-l baseUrl -d 'Cluster base URL'"), 'Should include --baseUrl flag');
  });

  test('fish completion clears existing completions', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'fish'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const script = completionResult.stdout;

    // Verify that script clears existing completions first
    assert.ok(script.includes('complete -c c8ctl -e'), 'Should clear c8ctl completions');
    assert.ok(script.includes('complete -c c8 -e'), 'Should clear c8 completions');
  });

  test('fish completion has flags for both c8ctl and c8 commands', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'fish'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const script = completionResult.stdout;

    // Check that both commands have the same completions
    assert.ok(script.includes('complete -c c8ctl -s h -l help'), 'Should have flags for c8ctl');
    assert.ok(script.includes('complete -c c8 -s h -l help'), 'Should have flags for c8');
  });

  test('fish completion uses -r flag for options requiring arguments', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'fish'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const script = completionResult.stdout;

    // Check that options that require arguments use -r flag
    assert.ok(
      script.includes("-l profile -d 'Use specific profile' -r"),
      'Should use -r for --profile'
    );
    assert.ok(
      script.includes("-l variables -d 'JSON variables' -r"),
      'Should use -r for --variables'
    );
    assert.ok(
      script.includes("-l baseUrl -d 'Cluster base URL' -r"),
      'Should use -r for --baseUrl'
    );
  });

  test('fish completion structure is valid', () => {
    const completionResult = spawnSync('node', ['src/index.ts', 'completion', 'fish'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    const script = completionResult.stdout;

    // Verify key structural elements
    assert.ok(script.startsWith('# c8ctl fish completion'), 'Should start with comment header');
    assert.ok(script.includes('complete -c c8ctl -e'), 'Should clear old completions');
    assert.ok(script.includes('complete -c c8 -e'), 'Should clear old completions for c8');
    
    // Count approximate number of complete statements (should be many)
    const completeCount = (script.match(/complete -c/g) || []).length;
    assert.ok(completeCount > 100, `Should have many complete statements (found ${completeCount})`);
  });
});
