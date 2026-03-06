import { test, describe } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'src', 'index.ts');

const DUPLICATE_PROFILE_ERROR = 'Cannot specify the same flag multiple times: --profile';

/** Spawn the CLI with the provided args and return the synchronous result. */
function runCli(args: string[]) {
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf-8',
    cwd: PROJECT_ROOT,
  });
}

/** Representative command invocations that cover each CLI command branch. */
const COMMAND_BRANCH_SAMPLES: string[][] = [
  ['help', 'list'],
  ['completion', 'bash'],
  ['use', 'profile', 'dev'],
  ['output', 'json'],
  ['list', 'profile'],
  ['add', 'profile', 'dev'],
  ['which', 'profile'],
  ['list', 'plugin'],
  ['load', 'plugin', 'example-plugin'],
  ['sync', 'plugin'],
  ['upgrade', 'plugin', 'example-plugin'],
  ['downgrade', 'plugin', 'example-plugin'],
  ['init', 'plugin', 'example-plugin'],
  ['list', 'pi'],
  ['get', 'pi', '123'],
  ['create', 'pi'],
  ['cancel', 'pi', '123'],
  ['await', 'pi'],
  ['list', 'pd'],
  ['get', 'pd', '123'],
  ['list', 'ut'],
  ['complete', 'ut', '123'],
  ['list', 'inc'],
  ['get', 'inc', '123'],
  ['resolve', 'inc', '123'],
  ['list', 'jobs'],
  ['activate', 'jobs'],
  ['complete', 'job', '123'],
  ['fail', 'job', '123'],
  ['publish', 'msg', 'demo'],
  ['correlate', 'msg', 'demo'],
  ['get', 'topology'],
  ['get', 'form', '123'],
  ['deploy', 'tests/fixtures/simple.bpmn'],
  ['run', 'tests/fixtures/simple.bpmn'],
  ['watch', '.'],
  ['mcp-proxy'],
  ['search', 'pi'],
];

describe('CLI mixed-switch validation', () => {
  test('rejects duplicate --profile for all command branches', () => {
    for (const sample of COMMAND_BRANCH_SAMPLES) {
      const result = runCli([...sample, '--profile=a', '--profile=b']);
      assert.strictEqual(result.status, 1, `Expected exit code 1 for: c8 ${sample.join(' ')}`);
      assert.ok(
        result.stderr.includes(DUPLICATE_PROFILE_ERROR),
        `Expected duplicate-profile parse error for: c8 ${sample.join(' ')}\nstderr: ${result.stderr}`,
      );
    }
  });

  test('rejects repeated non-boolean resource flags', () => {
    const result = runCli(['search', 'pi', '--state=ACTIVE', '--state=COMPLETED']);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /Cannot specify the same flag multiple times: --state/);
  });

  test('rejects duplicate string flags for both --flag=value and --flag value syntaxes', () => {
    const withEquals = runCli(['list', 'pi', '--profile=a', '--profile=b']);
    assert.strictEqual(withEquals.status, 1);
    assert.match(withEquals.stderr, /Cannot specify the same flag multiple times: --profile/);

    const withSeparateValue = runCli(['list', 'pi', '--profile', 'a', '--profile', 'b']);
    assert.strictEqual(withSeparateValue.status, 1);
    assert.match(withSeparateValue.stderr, /Cannot specify the same flag multiple times: --profile/);
  });
});
