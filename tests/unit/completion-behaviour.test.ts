/**
 * CLI behavioural tests for shell completion commands.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess. They verify that completion scripts are emitted
 * for each supported shell and that invalid inputs are rejected.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { c8 } from '../utils/cli.ts';

// ─── bash completion ─────────────────────────────────────────────────────────

describe('CLI behavioural: completion bash', () => {

  test('exits 0 and emits a bash completion script', async () => {
    const result = await c8('completion', 'bash');
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('_c8ctl_completions'), 'Expected bash completion function');
    assert.ok(result.stdout.includes('complete -F'), 'Expected complete -F registration');
  });

  test('script registers both c8ctl and c8 aliases', async () => {
    const result = await c8('completion', 'bash');
    assert.ok(result.stdout.includes('c8ctl'), 'Expected c8ctl alias');
    assert.ok(result.stdout.includes(' c8'), 'Expected c8 alias');
  });
});

// ─── zsh completion ──────────────────────────────────────────────────────────

describe('CLI behavioural: completion zsh', () => {

  test('exits 0 and emits a zsh completion script', async () => {
    const result = await c8('completion', 'zsh');
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('#compdef'), 'Expected zsh #compdef directive');
    assert.ok(result.stdout.includes('_c8ctl'), 'Expected zsh completion function');
  });
});

// ─── fish completion ─────────────────────────────────────────────────────────

describe('CLI behavioural: completion fish', () => {

  test('exits 0 and emits a fish completion script', async () => {
    const result = await c8('completion', 'fish');
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('complete -c c8ctl'), 'Expected fish complete command');
  });
});

// ─── error cases ─────────────────────────────────────────────────────────────

describe('CLI behavioural: completion errors', () => {

  test('exits 1 when no shell type is provided', async () => {
    const result = await c8('completion');
    assert.strictEqual(result.status, 1);
  });

  test('exits 1 for unknown shell type', async () => {
    const result = await c8('completion', 'powershell');
    assert.strictEqual(result.status, 1);
  });
});
