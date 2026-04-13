/**
 * Shared test utilities for CLI behavioural (dry-run) tests.
 *
 * Provides a subprocess helper that invokes the CLI with a deterministic
 * environment and a JSON parser for dry-run output.
 */

import { asyncSpawn, type SpawnResult } from './spawn.ts';

const CLI = 'src/index.ts';

/**
 * Invoke the CLI as a subprocess with a test-friendly environment.
 * Sets CAMUNDA_BASE_URL so commands resolve a cluster config without
 * needing a real profile or running cluster.
 */
export async function c8(...args: string[]): Promise<SpawnResult> {
  return asyncSpawn('node', ['--experimental-strip-types', CLI, ...args], {
    env: {
      ...process.env,
      CAMUNDA_BASE_URL: 'http://test-cluster/v2',
      HOME: '/tmp/c8ctl-test-nonexistent-home',
    },
  });
}

/**
 * Parse the JSON dry-run payload from CLI stdout.
 * Throws a descriptive error if stdout is not valid JSON.
 */
export function parseJson(result: SpawnResult): Record<string, unknown> {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Failed to parse JSON from stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}
