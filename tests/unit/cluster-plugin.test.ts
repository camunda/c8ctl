/**
 * Unit tests for the cluster plugin (default-plugins/cluster)
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const plugin = await import('../../default-plugins/cluster/c8ctl-plugin.js');

// ---------------------------------------------------------------------------
// metadata
// ---------------------------------------------------------------------------

describe('Cluster Plugin – metadata', () => {
  test('has name "cluster"', () => {
    assert.strictEqual(plugin.metadata.name, 'cluster');
  });

  test('has a description', () => {
    assert.ok(
      typeof plugin.metadata.description === 'string' && plugin.metadata.description.length > 0,
      'metadata.description should be a non-empty string',
    );
  });

  test('declares the "cluster" command', () => {
    assert.ok(plugin.metadata.commands['cluster'], 'Should declare a "cluster" command');
  });

  test('cluster command has a description', () => {
    const cmd = plugin.metadata.commands['cluster'];
    assert.ok(
      typeof cmd.description === 'string' && cmd.description.length > 0,
      'cluster command should have a non-empty description',
    );
  });

  test('cluster command provides examples', () => {
    const examples = plugin.metadata.commands['cluster'].examples;
    assert.ok(Array.isArray(examples), 'examples should be an array');
    assert.ok(examples.length >= 2, 'Should have at least two examples');

    for (const ex of examples) {
      assert.ok(typeof ex.command === 'string' && ex.command.length > 0, 'Each example must have a command');
      assert.ok(typeof ex.description === 'string' && ex.description.length > 0, 'Each example must have a description');
    }
  });

  test('examples include start and stop commands', () => {
    const examples = plugin.metadata.commands['cluster'].examples;
    const cmds = examples.map((e: { command: string }) => e.command);
    assert.ok(cmds.some((c: string) => c.includes('start')), 'Should have a start example');
    assert.ok(cmds.some((c: string) => c.includes('stop')), 'Should have a stop example');
  });
});

// ---------------------------------------------------------------------------
// commands export
// ---------------------------------------------------------------------------

describe('Cluster Plugin – commands export', () => {
  test('exports a commands object with a "cluster" key', () => {
    assert.ok(plugin.commands, 'Should export commands');
    assert.ok(typeof plugin.commands['cluster'] === 'function', '"cluster" should be a function');
  });
});

// ---------------------------------------------------------------------------
// cluster command – usage / argument handling
// ---------------------------------------------------------------------------

describe('Cluster Plugin – command usage output', () => {
  let captured: string[];
  let originalLog: typeof console.log;

  beforeEach(() => {
    captured = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  test('prints usage when called with no arguments', async () => {
    await plugin.commands['cluster']([]);

    const output = captured.join('\n');
    assert.ok(output.includes('Usage'), 'Should print usage header');
    assert.ok(output.includes('start'), 'Usage should mention "start"');
    assert.ok(output.includes('stop'), 'Usage should mention "stop"');
  });

  test('prints usage when called with an invalid subcommand', async () => {
    await plugin.commands['cluster'](['invalid']);

    const output = captured.join('\n');
    assert.ok(output.includes('Usage'), 'Should print usage for unrecognised subcommand');
  });

  test('usage mentions version option', async () => {
    await plugin.commands['cluster']([]);

    const output = captured.join('\n');
    assert.ok(output.includes('--c8-version'), 'Should document --c8-version flag');
  });

  test('usage mentions --debug flag', async () => {
    await plugin.commands['cluster']([]);

    const output = captured.join('\n');
    assert.ok(output.includes('--debug'), 'Should document --debug flag');
  });

  test('usage contains examples', async () => {
    await plugin.commands['cluster']([]);

    const output = captured.join('\n');
    assert.ok(output.includes('Examples'), 'Should contain an Examples section');
  });
});

// ---------------------------------------------------------------------------
// cluster command – version validation (invalid versions → process.exit)
// ---------------------------------------------------------------------------

describe('Cluster Plugin – version validation', () => {
  test('rejects version with path traversal (..)', () => {
    assert.throws(
      () => plugin.validateVersionSpec('../etc/passwd'),
      /Invalid version string/,
      'Should throw for path traversal version',
    );
  });

  test('rejects version with shell metacharacters', () => {
    assert.throws(
      () => plugin.validateVersionSpec('8.8; rm -rf /'),
      /Invalid version string/,
      'Should throw for version with spaces/semicolons',
    );
  });

  test('rejects version with slashes', () => {
    assert.throws(
      () => plugin.validateVersionSpec('8.8/evil'),
      /Invalid version string/,
      'Should throw for version containing slashes',
    );
  });

  test('accepts valid semver-like version strings', () => {
    const validVersions = ['8.8', '8.9.0', '8.9.0-alpha5', '8.8.1-rc1', 'latest', 'stable'];

    for (const version of validVersions) {
      assert.doesNotThrow(
        () => plugin.validateVersionSpec(version),
        `Version "${version}" should not trigger a validation error`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// parsePluginArgs
// ---------------------------------------------------------------------------

describe('Cluster Plugin – parsePluginArgs', () => {
  test('returns null subcommand with no args', () => {
    const result = plugin.parsePluginArgs([]);
    assert.strictEqual(result.subcommand, null);
    assert.strictEqual(result.version, null);
    assert.strictEqual(result.debug, false);
  });

  test('parses start subcommand', () => {
    const result = plugin.parsePluginArgs(['start']);
    assert.strictEqual(result.subcommand, 'start');
  });

  test('parses stop subcommand', () => {
    const result = plugin.parsePluginArgs(['stop']);
    assert.strictEqual(result.subcommand, 'stop');
  });

  test('parses positional version after subcommand', () => {
    const result = plugin.parsePluginArgs(['start', '8.8']);
    assert.strictEqual(result.subcommand, 'start');
    assert.strictEqual(result.version, '8.8');
  });

  test('parses --c8-version flag', () => {
    const result = plugin.parsePluginArgs(['start', '--c8-version', '8.8']);
    assert.strictEqual(result.subcommand, 'start');
    assert.strictEqual(result.version, '8.8');
  });

  test('parses --debug flag', () => {
    const result = plugin.parsePluginArgs(['start', '--debug']);
    assert.strictEqual(result.debug, true);
  });

  test('throws when --c8-version has no value (end of args)', () => {
    assert.throws(
      () => plugin.parsePluginArgs(['--c8-version']),
      /Missing value for --c8-version/,
    );
  });

  test('throws when --c8-version is followed by another flag', () => {
    assert.throws(
      () => plugin.parsePluginArgs(['--c8-version', '--debug']),
      /Missing value for --c8-version/,
    );
  });

  test('throws when --c8-version value is another flag after subcommand', () => {
    assert.throws(
      () => plugin.parsePluginArgs(['start', '--c8-version', '--debug']),
      /Missing value for --c8-version/,
    );
  });
});

// ---------------------------------------------------------------------------
// findC8RunBinaryPath / isC8RunInstalled / getC8RunBinaryPath
// ---------------------------------------------------------------------------

describe('Cluster Plugin – findC8RunBinaryPath', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'c8ctl-test-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  test('returns null when install dir does not exist', () => {
    const config = { cacheDir: tempDir, version: '8.8' };
    const result = plugin.findC8RunBinaryPath(config);
    assert.strictEqual(result, null);
  });

  test('returns null when install dir exists but no binary', () => {
    const config = { cacheDir: tempDir, version: '8.8' };
    mkdirSync(join(tempDir, 'c8run-8.8'), { recursive: true });
    const result = plugin.findC8RunBinaryPath(config);
    assert.strictEqual(result, null);
  });

  test('returns path when binary exists in versioned subdir', () => {
    const config = { cacheDir: tempDir, version: '8.8' };
    const binaryDir = join(tempDir, 'c8run-8.8', 'c8run-8.8.1');
    mkdirSync(binaryDir, { recursive: true });
    writeFileSync(join(binaryDir, 'c8run'), '');
    const result = plugin.findC8RunBinaryPath(config);
    assert.ok(result !== null, 'should find binary');
    assert.ok(result!.includes('c8run'), 'path should reference binary name');
  });
});

describe('Cluster Plugin – isC8RunInstalled', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'c8ctl-test-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  test('returns false when not installed', () => {
    const config = { cacheDir: tempDir, version: '8.8' };
    assert.strictEqual(plugin.isC8RunInstalled(config), false);
  });

  test('returns true when binary exists', () => {
    const config = { cacheDir: tempDir, version: '8.8' };
    const binaryDir = join(tempDir, 'c8run-8.8', 'c8run-8.8.1');
    mkdirSync(binaryDir, { recursive: true });
    writeFileSync(join(binaryDir, 'c8run'), '');
    assert.strictEqual(plugin.isC8RunInstalled(config), true);
  });
});

describe('Cluster Plugin – getC8RunBinaryPath', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'c8ctl-test-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  test('throws when binary not found', () => {
    const config = { cacheDir: tempDir, version: '8.8' };
    assert.throws(
      () => plugin.getC8RunBinaryPath(config),
      /c8run 8\.8 binary not found/,
    );
  });

  test('returns path when binary exists', () => {
    const config = { cacheDir: tempDir, version: '8.8' };
    const binaryDir = join(tempDir, 'c8run-8.8', 'c8run-8.8.1');
    mkdirSync(binaryDir, { recursive: true });
    writeFileSync(join(binaryDir, 'c8run'), '');
    const result = plugin.getC8RunBinaryPath(config);
    assert.ok(typeof result === 'string' && result.length > 0, 'should return a non-empty path');
  });
});

// ---------------------------------------------------------------------------
// purgeInstalledVersion
// ---------------------------------------------------------------------------

describe('Cluster Plugin – purgeInstalledVersion', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'c8ctl-test-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  test('removes the install dir when it exists', () => {
    const config = { cacheDir: tempDir, version: '8.8' };
    const installDir = join(tempDir, 'c8run-8.8');
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, 'dummy'), '');

    plugin.purgeInstalledVersion(config);

    assert.strictEqual(existsSync(installDir), false, 'install dir should be removed');
  });

  test('does not throw when install dir does not exist', () => {
    const config = { cacheDir: tempDir, version: '8.8' };
    assert.doesNotThrow(() => plugin.purgeInstalledVersion(config));
  });
});

// ---------------------------------------------------------------------------
// ensureC8RunInstalled
// ---------------------------------------------------------------------------

describe('Cluster Plugin – ensureC8RunInstalled', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'c8ctl-test-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  test('returns without error when binary is already installed', async () => {
    const config = { cacheDir: tempDir, version: '8.8', isAlias: false };
    // Create the binary structure so isC8RunInstalled returns true
    const binaryDir = join(tempDir, 'c8run-8.8', 'c8run-8.8.1');
    mkdirSync(binaryDir, { recursive: true });
    writeFileSync(join(binaryDir, 'c8run'), '');

    // Should return without attempting a download
    await assert.doesNotReject(() => plugin.ensureC8RunInstalled(config));
  });

  test('purges install dir when version is an alias before checking', async () => {
    const config = { cacheDir: tempDir, version: '8.8', isAlias: true };
    // Set up a binary so purge has something to remove
    const installDir = join(tempDir, 'c8run-8.8');
    const binaryDir = join(installDir, 'c8run-8.8.1');
    mkdirSync(binaryDir, { recursive: true });
    writeFileSync(join(binaryDir, 'c8run'), '');

    assert.strictEqual(plugin.isC8RunInstalled(config), true, 'should be installed before test');

    // When isAlias=true, ensureC8RunInstalled calls purgeInstalledVersion then downloads.
    // Downloading in a unit test would make a real HTTP request, so we test the purge
    // side-effect separately using purgeInstalledVersion (the function ensureC8RunInstalled delegates to).
    plugin.purgeInstalledVersion(config);

    assert.strictEqual(existsSync(installDir), false, 'install dir should be purged');
    assert.strictEqual(plugin.isC8RunInstalled(config), false, 'should not be installed after purge');
  });
});
