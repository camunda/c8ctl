/**
 * Integration tests for global install / symlink invocation
 * Verifies the built binary works when invoked through a symlink,
 * as happens with `npm install -g` or `npm link`.
 *
 * npm creates a symlink from the global bin directory to the package's
 * dist/index.js. Node resolves the symlink, so process.argv[1] is the
 * symlink path while import.meta.url resolves to the real file. The
 * entry guard in index.ts must handle this via realpathSync.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

describe('Global Install (symlink) Integration Tests', () => {
  const projectRoot = resolve(import.meta.dirname, '..', '..');
  const distEntry = join(projectRoot, 'dist', 'index.js');
  let tempBinDir: string;
  let symlinkPath: string;

  beforeEach(() => {
    tempBinDir = join(tmpdir(), `c8ctl-global-test-${Date.now()}`);
    mkdirSync(tempBinDir, { recursive: true });
    symlinkPath = join(tempBinDir, 'c8ctl.js');
  });

  afterEach(() => {
    if (existsSync(tempBinDir)) {
      rmSync(tempBinDir, { recursive: true, force: true });
    }
  });

  test('dist/index.js must exist (run npm run build first)', () => {
    assert.ok(
      existsSync(distEntry),
      `dist/index.js not found at ${distEntry}. Run "npm run build" before running this test.`,
    );
  });

  test('binary works when invoked directly with node', () => {
    const result = spawnSync('node', [distEntry, 'help'], {
      encoding: 'utf-8',
      timeout: 10_000,
    });

    assert.strictEqual(result.status, 0, `Expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('c8ctl'), 'help output should mention c8ctl');
    assert.ok(result.stdout.includes('Usage:'), 'help output should contain Usage');
  });

  test('binary works when node receives a symlink as argv[1] (simulates npm link / npm install -g)', () => {
    symlinkSync(distEntry, symlinkPath);

    // Use `node <symlink>` — this is how npm global installs work:
    // the shebang causes node to be invoked with the symlink path as argv[1]
    const result = spawnSync('node', [symlinkPath, 'help'], {
      encoding: 'utf-8',
      timeout: 10_000,
    });

    assert.strictEqual(result.status, 0, `Expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('c8ctl'), 'help output should mention c8ctl');
    assert.ok(result.stdout.includes('Usage:'), 'help output should contain Usage');
  });

  test('binary shows version when invoked through a symlink', () => {
    symlinkSync(distEntry, symlinkPath);

    const result = spawnSync('node', [symlinkPath, 'help'], {
      encoding: 'utf-8',
      timeout: 10_000,
    });

    assert.strictEqual(result.status, 0, `Expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    // Version line appears in help output header
    assert.match(result.stdout, /v\d+\.\d+\.\d+/, 'output should contain a version string');
  });

  test('binary works through a double symlink (symlink -> symlink -> dist/index.js)', () => {
    // Simulates npm global bin -> node_modules symlink -> project dist
    const intermediateDir = join(tempBinDir, 'node_modules');
    mkdirSync(intermediateDir, { recursive: true });
    const intermediatePath = join(intermediateDir, 'index.js');

    // First symlink: intermediate -> real file
    symlinkSync(distEntry, intermediatePath);
    // Second symlink: bin entry -> intermediate
    symlinkSync(intermediatePath, symlinkPath);

    const result = spawnSync('node', [symlinkPath, 'help'], {
      encoding: 'utf-8',
      timeout: 10_000,
    });

    assert.strictEqual(result.status, 0, `Expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('c8ctl'), 'help output should mention c8ctl');
  });
});
