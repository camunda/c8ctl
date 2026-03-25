/**
 * Unit tests for the cluster plugin (default-plugins/cluster)
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

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
