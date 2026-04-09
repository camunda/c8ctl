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

  test('examples include start, stop, status, list, logs, list-remote, install, and delete commands', () => {
    const examples = plugin.metadata.commands['cluster'].examples;
    const cmds = examples.map((e: { command: string }) => e.command);
    assert.ok(cmds.some((c: string) => c.includes('start')), 'Should have a start example');
    assert.ok(cmds.some((c: string) => c.includes('stop')), 'Should have a stop example');
    assert.ok(cmds.some((c: string) => c.includes('status')), 'Should have a status example');
    assert.ok(cmds.some((c: string) => c.includes(' list') && !c.includes('list-remote')), 'Should have a list example');
    assert.ok(cmds.some((c: string) => c.includes('logs')), 'Should have a logs example');
    assert.ok(cmds.some((c: string) => c.includes('list-remote')), 'Should have a list-remote example');
    assert.ok(cmds.some((c: string) => c.includes('install')), 'Should have an install example');
    assert.ok(cmds.some((c: string) => c.includes('delete')), 'Should have a delete example');
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

  test('usage lists version aliases', async () => {
    await plugin.commands['cluster']([]);

    const output = captured.join('\n');
    assert.ok(output.includes('Version aliases'), 'Should contain a Version aliases section');
    assert.ok(/^\s+alpha\s+→/m.test(output), 'Should list the alpha alias with arrow separator');
    assert.ok(/^\s+stable\s+→/m.test(output), 'Should list the stable alias with arrow separator');
  });

  test('usage indicates aliases are dynamically resolved', async () => {
    await plugin.commands['cluster']([]);

    const output = captured.join('\n');
    assert.ok(output.includes('dynamically resolved'), 'Should indicate dynamic resolution');
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

  test('also removes the stored ETag file when it exists', () => {
    const config = { cacheDir: tempDir, version: '8.8' };
    plugin.storeETag(config, '"abc123"');
    const etagFile = join(tempDir, 'c8run-8.8.etag');
    assert.ok(existsSync(etagFile), 'ETag file should exist before purge');

    plugin.purgeInstalledVersion(config);

    assert.strictEqual(existsSync(etagFile), false, 'ETag file should be removed by purge');
  });

  test('accepts a custom reason for the log message', () => {
    const config = { cacheDir: tempDir, version: '8.8' };
    const installDir = join(tempDir, 'c8run-8.8');
    mkdirSync(installDir, { recursive: true });

    // Should not throw when called with reason
    assert.doesNotThrow(() => plugin.purgeInstalledVersion(config, { reason: 'as requested' }));
    assert.strictEqual(existsSync(installDir), false, 'install dir should be removed');
  });
});

// ---------------------------------------------------------------------------
// readStoredETag / storeETag
// ---------------------------------------------------------------------------

describe('Cluster Plugin – readStoredETag / storeETag', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'c8ctl-test-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  test('readStoredETag returns null when no ETag file exists', () => {
    const config = { cacheDir: tempDir, version: '8.8' };
    assert.strictEqual(plugin.readStoredETag(config), null);
  });

  test('storeETag writes and readStoredETag reads back the value', () => {
    const config = { cacheDir: tempDir, version: '8.8' };
    plugin.storeETag(config, '"etag-value-123"');
    assert.strictEqual(plugin.readStoredETag(config), '"etag-value-123"');
  });

  test('storeETag creates the cache dir if it does not exist', () => {
    const nestedDir = join(tempDir, 'nested', 'cache');
    const config = { cacheDir: nestedDir, version: '8.8' };
    assert.doesNotThrow(() => plugin.storeETag(config, '"etag"'));
    assert.ok(existsSync(nestedDir), 'cache dir should be created');
  });

  test('readStoredETag returns null for empty file', () => {
    const config = { cacheDir: tempDir, version: '8.8' };
    writeFileSync(join(tempDir, 'c8run-8.8.etag'), '');
    assert.strictEqual(plugin.readStoredETag(config), null);
  });
});

// ---------------------------------------------------------------------------
// hasNewerVersionAvailable
// ---------------------------------------------------------------------------

describe('Cluster Plugin – hasNewerVersionAvailable', () => {
  let tempDir: string;
  let originalFetch: typeof globalThis.fetch;

  // Minimal stub type matching only what the plugin uses
  type FetchStub = (url: string, init?: RequestInit) => Promise<{ ok: boolean; headers: { get: (h: string) => string | null } }>;

  function stubFetch(impl: FetchStub) {
    // We must replace globalThis.fetch which is typed as readonly in strict TS;
    // Object.defineProperty allows the replacement without an unsafe cast.
    Object.defineProperty(globalThis, 'fetch', { value: impl, writable: true, configurable: true });
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'c8ctl-test-'));
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    Object.defineProperty(globalThis, 'fetch', { value: originalFetch, writable: true, configurable: true });
  });

  test('returns false and records ETag when no ETag is stored (upgrade scenario)', async () => {
    const config = { cacheDir: tempDir, version: '8.8' };
    assert.strictEqual(plugin.readStoredETag(config), null, 'no ETag stored initially');

    stubFetch(async () => ({
      ok: true,
      headers: { get: (h: string) => h === 'etag' ? '"etag-initial"' : null },
    }));

    const result = await plugin.hasNewerVersionAvailable(config);
    assert.strictEqual(result, false, 'should not trigger re-download on first check');
    assert.strictEqual(plugin.readStoredETag(config), '"etag-initial"', 'should record the remote ETag for future checks');
  });

  test('returns false when stored ETag matches remote ETag', async () => {
    const config = { cacheDir: tempDir, version: '8.8' };
    plugin.storeETag(config, '"etag-abc"');

    stubFetch(async () => ({
      ok: true,
      headers: { get: (h: string) => h === 'etag' ? '"etag-abc"' : null },
    }));

    const result = await plugin.hasNewerVersionAvailable(config);
    assert.strictEqual(result, false, 'same ETag means no new version');
  });

  test('returns true when stored ETag differs from remote ETag', async () => {
    const config = { cacheDir: tempDir, version: '8.8' };
    plugin.storeETag(config, '"etag-old"');

    stubFetch(async () => ({
      ok: true,
      headers: { get: (h: string) => h === 'etag' ? '"etag-new"' : null },
    }));

    const result = await plugin.hasNewerVersionAvailable(config);
    assert.strictEqual(result, true, 'different ETag means new version available');
  });

  test('returns false when network request fails', async () => {
    const config = { cacheDir: tempDir, version: '8.8' };
    plugin.storeETag(config, '"etag-abc"');

    stubFetch(async () => { throw new Error('Network error'); });

    const result = await plugin.hasNewerVersionAvailable(config);
    assert.strictEqual(result, false, 'network failure should not force a re-download');
  });

  test('returns false when server responds with non-OK status', async () => {
    const config = { cacheDir: tempDir, version: '8.8' };
    plugin.storeETag(config, '"etag-abc"');

    stubFetch(async () => ({ ok: false, headers: { get: () => null } }));

    const result = await plugin.hasNewerVersionAvailable(config);
    assert.strictEqual(result, false, 'server error should not force a re-download');
  });

  test('returns false when server provides no ETag or Last-Modified', async () => {
    const config = { cacheDir: tempDir, version: '8.8' };
    plugin.storeETag(config, '"etag-abc"');

    stubFetch(async () => ({
      ok: true,
      headers: { get: () => null },
    }));

    const result = await plugin.hasNewerVersionAvailable(config);
    assert.strictEqual(result, false, 'no version signal from server should not force re-download');
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

  test('returns without error when exact version is already installed', async () => {
    const config = { cacheDir: tempDir, version: '8.8.1', isRolling: false, checkForUpdates: false };
    const binaryDir = join(tempDir, 'c8run-8.8.1', 'c8run-8.8.1');
    mkdirSync(binaryDir, { recursive: true });
    writeFileSync(join(binaryDir, 'c8run'), '');

    await assert.doesNotReject(() => plugin.ensureC8RunInstalled(config));
  });

  test('does not purge exact version when already installed (never re-download)', async () => {
    const config = { cacheDir: tempDir, version: '8.8.1', isRolling: false, checkForUpdates: false };
    const installDir = join(tempDir, 'c8run-8.8.1');
    const binaryDir = join(installDir, 'c8run-8.8.1');
    mkdirSync(binaryDir, { recursive: true });
    writeFileSync(join(binaryDir, 'c8run'), '');

    await assert.doesNotReject(() => plugin.ensureC8RunInstalled(config));

    assert.strictEqual(existsSync(installDir), true, 'exact version install dir should NOT be purged');
  });

  test('does not purge alias install when remote ETag matches stored ETag', async () => {
    const config = { cacheDir: tempDir, version: '8.8', isRolling: true, checkForUpdates: true };
    const installDir = join(tempDir, 'c8run-8.8');
    const binaryDir = join(installDir, 'c8run-8.8.1');
    mkdirSync(binaryDir, { recursive: true });
    writeFileSync(join(binaryDir, 'c8run'), '');
    plugin.storeETag(config, '"etag-current"');

    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'fetch', {
      value: async () => ({
        ok: true,
        headers: { get: (h: string) => h === 'etag' ? '"etag-current"' : null },
      }),
      writable: true,
      configurable: true,
    });

    try {
      await assert.doesNotReject(() => plugin.ensureC8RunInstalled(config));
      assert.strictEqual(existsSync(installDir), true, 'install dir should NOT be purged when ETag matches');
    } finally {
      Object.defineProperty(globalThis, 'fetch', { value: originalFetch, writable: true, configurable: true });
    }
  });

  test('purgeInstalledVersion removes install dir and ETag file', async () => {
    const config = { cacheDir: tempDir, version: '8.8', isRolling: true, checkForUpdates: true };
    const installDir = join(tempDir, 'c8run-8.8');
    const binaryDir = join(installDir, 'c8run-8.8.1');
    mkdirSync(binaryDir, { recursive: true });
    writeFileSync(join(binaryDir, 'c8run'), '');
    plugin.storeETag(config, '"etag-old"');

    assert.strictEqual(plugin.isC8RunInstalled(config), true, 'should be installed before test');

    plugin.purgeInstalledVersion(config);

    assert.strictEqual(existsSync(installDir), false, 'install dir should be removed');
    assert.strictEqual(plugin.readStoredETag(config), null, 'ETag file should be removed');
    assert.strictEqual(plugin.isC8RunInstalled(config), false, 'should not be installed after purge');
  });
});

// ---------------------------------------------------------------------------
// parseVersionsFromHtml – dynamic version discovery
// ---------------------------------------------------------------------------

describe('Cluster Plugin – parseVersionsFromHtml', () => {
  test('extracts stable and alpha from a realistic listing', () => {
    // Real-world pattern: 8.8 went GA (but still has old alpha dirs), 8.9 is current alpha
    // Stable = highest minor below the highest alpha train (8.9 has alphas → stable is 8.8)
    const html = `
      <a href="8.6/">8.6</a>
      <a href="8.6.11/">8.6.11</a>
      <a href="8.7/">8.7</a>
      <a href="8.7.0-alpha5/">8.7.0-alpha5</a>
      <a href="8.8.0-alpha2/">8.8.0-alpha2</a>
      <a href="8.8.0-alpha3/">8.8.0-alpha3</a>
      <a href="8.8/">8.8</a>
      <a href="8.8.1/">8.8.1</a>
      <a href="8.9.0-alpha1/">8.9.0-alpha1</a>
      <a href="8.9.0-alpha5/">8.9.0-alpha5</a>
      <a href="8.9/">8.9</a>
    `;
    const result = plugin.parseVersionsFromHtml(html);
    assert.ok(result, 'should return a result');
    assert.strictEqual(result.stable, '8.8', 'stable should be highest minor below the alpha train');
    assert.strictEqual(result.alpha, '8.9', 'alpha should be highest minor overall');
  });

  test('when no alphas exist, stable and alpha are the same', () => {
    const html = `
      <a href="8.6/">8.6</a>
      <a href="8.7/">8.7</a>
      <a href="8.8/">8.8</a>
    `;
    const result = plugin.parseVersionsFromHtml(html);
    assert.ok(result, 'should return a result');
    assert.strictEqual(result.stable, '8.8');
    assert.strictEqual(result.alpha, '8.8');
  });

  test('handles future major versions correctly', () => {
    const html = `
      <a href="8.8/">8.8</a>
      <a href="8.9/">8.9</a>
      <a href="9.0.0-alpha1/">9.0.0-alpha1</a>
      <a href="9.0/">9.0</a>
    `;
    const result = plugin.parseVersionsFromHtml(html);
    assert.ok(result, 'should return a result');
    assert.strictEqual(result.stable, '8.9', 'stable is highest without alpha dirs');
    assert.strictEqual(result.alpha, '9.0', 'alpha is highest overall');
  });

  test('returns null for empty or no-match HTML', () => {
    assert.strictEqual(plugin.parseVersionsFromHtml(''), null);
    assert.strictEqual(plugin.parseVersionsFromHtml('<html>no versions</html>'), null);
  });

  test('deduplicates minor versions', () => {
    const html = `
      <a href="8.8/">8.8</a>
      <a href="8.8/">8.8</a>
      <a href="8.9.0-alpha1/">8.9.0-alpha1</a>
      <a href="8.9.0-alpha2/">8.9.0-alpha2</a>
      <a href="8.9/">8.9</a>
    `;
    const result = plugin.parseVersionsFromHtml(html);
    assert.ok(result);
    assert.strictEqual(result.stable, '8.8');
    assert.strictEqual(result.alpha, '8.9');
  });
});

// ---------------------------------------------------------------------------
// clusterStatus
// ---------------------------------------------------------------------------

describe('Cluster Plugin – clusterStatus', () => {
  let tempDir: string;
  let captured: string[];
  let originalLog: typeof console.log;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'c8ctl-test-'));
    captured = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    };
    originalFetch = globalThis.fetch;
    // Default stub: health endpoint not reachable
    Object.defineProperty(globalThis, 'fetch', {
      value: async () => { throw new Error('Connection refused'); },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    console.log = originalLog;
    Object.defineProperty(globalThis, 'fetch', { value: originalFetch, writable: true, configurable: true });
  });

  test('reports stopped when no marker file and health unreachable', async () => {
    await plugin.clusterStatus(tempDir);
    const output = captured.join('\n');
    assert.ok(output.includes('stopped'), 'Should report stopped status');
  });

  test('includes start hint when stopped', async () => {
    await plugin.clusterStatus(tempDir);
    const output = captured.join('\n');
    assert.ok(output.includes('c8ctl cluster start'), 'Should hint at start command');
  });

  test('reports running when health endpoint is UP', async () => {
    Object.defineProperty(globalThis, 'fetch', {
      value: async () => ({ ok: true, json: async () => ({ status: 'UP' }) }),
      writable: true,
      configurable: true,
    });

    await plugin.clusterStatus(tempDir);
    const output = captured.join('\n');
    assert.ok(output.includes('running'), 'Should report running status');
  });

  test('includes connection URLs when cluster is running', async () => {
    Object.defineProperty(globalThis, 'fetch', {
      value: async () => ({ ok: true, json: async () => ({ status: 'UP' }) }),
      writable: true,
      configurable: true,
    });

    await plugin.clusterStatus(tempDir);
    const output = captured.join('\n');
    assert.ok(output.includes('Operate'), 'Should list Operate URL');
    assert.ok(output.includes('Tasklist'), 'Should list Tasklist URL');
    assert.ok(output.includes('Zeebe'), 'Should list Zeebe endpoints');
    assert.ok(output.includes('demo / demo'), 'Should mention default credentials');
  });

  test('reports version from marker file when available', async () => {
    // Write marker files
    writeFileSync(join(tempDir, 'cluster.active'), 'running');
    writeFileSync(join(tempDir, 'cluster.version'), '8.9.0-alpha5');

    Object.defineProperty(globalThis, 'fetch', {
      value: async () => ({ ok: true, json: async () => ({ status: 'UP' }) }),
      writable: true,
      configurable: true,
    });

    await plugin.clusterStatus(tempDir);
    const output = captured.join('\n');
    assert.ok(output.includes('8.9.0-alpha5'), 'Should display the running version');
  });

  test('reports "starting or unresponsive" when marker exists but health unreachable', async () => {
    writeFileSync(join(tempDir, 'cluster.active'), 'running');

    await plugin.clusterStatus(tempDir);
    const output = captured.join('\n');
    assert.ok(output.includes('starting or unresponsive'), 'Should report starting/unresponsive status');
  });
});

// ---------------------------------------------------------------------------
// listInstalledVersions
// ---------------------------------------------------------------------------

describe('Cluster Plugin – listInstalledVersions', () => {
  let tempDir: string;
  let captured: string[];
  let originalLog: typeof console.log;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'c8ctl-test-'));
    captured = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    console.log = originalLog;
  });

  test('reports no versions when cache dir is empty', async () => {
    await plugin.listInstalledVersions(tempDir);
    const output = captured.join('\n');
    assert.ok(output.includes('No versions installed'), 'Should report no versions');
  });

  test('reports no versions when cache dir does not exist', async () => {
    await plugin.listInstalledVersions(join(tempDir, 'nonexistent'));
    const output = captured.join('\n');
    assert.ok(output.includes('No versions installed'), 'Should report no versions for missing dir');
  });

  test('lists installed version directories', async () => {
    mkdirSync(join(tempDir, 'c8run-8.8'), { recursive: true });
    mkdirSync(join(tempDir, 'c8run-8.9'), { recursive: true });

    await plugin.listInstalledVersions(tempDir);
    const output = captured.join('\n');
    assert.ok(output.includes('8.8'), 'Should list installed version 8.8');
    assert.ok(output.includes('8.9'), 'Should list installed version 8.9');
  });

  test('sorts versions numerically (8.9 before 8.10)', async () => {
    mkdirSync(join(tempDir, 'c8run-8.10'), { recursive: true });
    mkdirSync(join(tempDir, 'c8run-8.9'), { recursive: true });
    mkdirSync(join(tempDir, 'c8run-8.6'), { recursive: true });

    await plugin.listInstalledVersions(tempDir);
    const output = captured.join('\n');
    const idx6 = output.indexOf('8.6');
    const idx9 = output.indexOf('8.9');
    const idx10 = output.indexOf('8.10');
    assert.ok(idx6 < idx9, '8.6 should appear before 8.9');
    assert.ok(idx9 < idx10, '8.9 should appear before 8.10');
  });

  test('always shows version aliases section', async () => {
    await plugin.listInstalledVersions(tempDir);
    const output = captured.join('\n');
    assert.ok(output.includes('Version aliases'), 'Should show version aliases section');
    assert.ok(/alpha\s+→/.test(output), 'Should show alpha alias');
    assert.ok(/stable\s+→/.test(output), 'Should show stable alias');
  });
});

// ---------------------------------------------------------------------------
// cluster command – status and list subcommands via commands export
// ---------------------------------------------------------------------------

describe('Cluster Plugin – status and list subcommands', () => {
  let captured: string[];
  let originalLog: typeof console.log;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    captured = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    };
    originalFetch = globalThis.fetch;
    // Default: health not reachable
    Object.defineProperty(globalThis, 'fetch', {
      value: async () => { throw new Error('Connection refused'); },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    console.log = originalLog;
    Object.defineProperty(globalThis, 'fetch', { value: originalFetch, writable: true, configurable: true });
  });

  test('status subcommand does not print usage', async () => {
    await plugin.commands['cluster'](['status']);
    const output = captured.join('\n');
    assert.ok(!output.includes('Usage:'), 'status subcommand should not print usage');
  });

  test('list subcommand does not print usage', async () => {
    await plugin.commands['cluster'](['list']);
    const output = captured.join('\n');
    assert.ok(!output.includes('Usage:'), 'list subcommand should not print usage');
  });

  test('usage mentions status subcommand', async () => {
    await plugin.commands['cluster']([]);
    const output = captured.join('\n');
    assert.ok(output.includes('status'), 'Usage should mention "status" subcommand');
  });

  test('usage mentions list subcommand', async () => {
    await plugin.commands['cluster']([]);
    const output = captured.join('\n');
    assert.ok(output.includes('list'), 'Usage should mention "list" subcommand');
  });

  test('usage mentions logs subcommand', async () => {
    await plugin.commands['cluster']([]);
    const output = captured.join('\n');
    assert.ok(output.includes('logs'), 'Usage should mention "logs" subcommand');
  });

  test('usage mentions list-remote subcommand', async () => {
    await plugin.commands['cluster']([]);
    const output = captured.join('\n');
    assert.ok(output.includes('list-remote'), 'Usage should mention "list-remote" subcommand');
  });

  test('usage mentions install subcommand', async () => {
    await plugin.commands['cluster']([]);
    const output = captured.join('\n');
    assert.ok(output.includes('install'), 'Usage should mention "install" subcommand');
  });

  test('usage mentions delete subcommand', async () => {
    await plugin.commands['cluster']([]);
    const output = captured.join('\n');
    assert.ok(output.includes('delete'), 'Usage should mention "delete" subcommand');
  });

  test('usage shows stable as default alias', async () => {
    await plugin.commands['cluster']([]);
    const output = captured.join('\n');
    assert.ok(output.includes('default: stable'), 'Usage should show stable as the default');
  });

  test('stop usage does not show a [<version>] argument', async () => {
    await plugin.commands['cluster']([]);
    const output = captured.join('\n');
    // The stop line should just be 'c8ctl cluster stop' with no version arg
    const stopLine = output.split('\n').find((l) => l.includes('cluster stop'));
    assert.ok(stopLine, 'Should have a stop usage line');
    assert.ok(!stopLine!.includes('[<version>]'), 'stop usage should not show [<version>]');
  });
});

// ---------------------------------------------------------------------------
// deleteVersion
// ---------------------------------------------------------------------------

describe('Cluster Plugin – deleteVersion', () => {
  let tempDir: string;
  let captured: string[];
  let originalLog: typeof console.log;
  let originalWarn: typeof console.warn;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'c8ctl-test-'));
    captured = [];
    originalLog = console.log;
    originalWarn = console.warn;
    originalExit = process.exit;
    console.log = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
    console.warn = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
  });

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    console.log = originalLog;
    console.warn = originalWarn;
    process.exit = originalExit;
  });

  test('removes an installed version', async () => {
    const installDir = join(tempDir, 'c8run-8.8');
    const binaryDir = join(installDir, 'c8run-8.8.1');
    mkdirSync(binaryDir, { recursive: true });
    writeFileSync(join(binaryDir, 'c8run'), '');

    await plugin.deleteVersion(tempDir, '8.8');
    assert.strictEqual(existsSync(installDir), false, 'install dir should be removed');
  });

  test('warns when version is not installed', async () => {
    await plugin.deleteVersion(tempDir, '9.9');
    const output = captured.join('\n');
    assert.ok(output.includes('not installed'), 'Should warn that version is not installed');
  });

  test('prevents deleting a currently running version', async () => {
    const installDir = join(tempDir, 'c8run-8.8');
    const binaryDir = join(installDir, 'c8run-8.8.1');
    mkdirSync(binaryDir, { recursive: true });
    writeFileSync(join(binaryDir, 'c8run'), '');
    writeFileSync(join(tempDir, 'cluster.active'), 'running');
    writeFileSync(join(tempDir, 'cluster.version'), '8.8');

    let exitCalled = false;
    process.exit = (() => { exitCalled = true; throw new Error('exit'); }) as never;

    await assert.rejects(
      () => plugin.deleteVersion(tempDir, '8.8'),
      /exit/,
    );
    assert.ok(exitCalled, 'Should call process.exit when trying to delete running version');
  });
});

// ---------------------------------------------------------------------------
// listRemoteVersions
// ---------------------------------------------------------------------------

describe('Cluster Plugin – listRemoteVersions', () => {
  let captured: string[];
  let originalLog: typeof console.log;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    captured = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    console.log = originalLog;
    Object.defineProperty(globalThis, 'fetch', { value: originalFetch, writable: true, configurable: true });
  });

  test('lists versions from remote HTML listing', async () => {
    Object.defineProperty(globalThis, 'fetch', {
      value: async () => ({
        ok: true,
        text: async () => `
          <a href="8.6/">8.6</a>
          <a href="8.7/">8.7</a>
          <a href="8.8/">8.8</a>
          <a href="8.9.0-alpha1/">8.9.0-alpha1</a>
          <a href="8.9/">8.9</a>
        `,
      }),
      writable: true,
      configurable: true,
    });

    await plugin.listRemoteVersions();
    const output = captured.join('\n');
    assert.ok(output.includes('8.6'), 'Should list version 8.6');
    assert.ok(output.includes('8.8'), 'Should list version 8.8');
    assert.ok(output.includes('8.9.0-alpha1'), 'Should list alpha version');
    assert.ok(output.includes('Available versions'), 'Should have a header');
  });

  test('sorts versions numerically (8.9 before 8.10, alpha2 before alpha10)', async () => {
    Object.defineProperty(globalThis, 'fetch', {
      value: async () => ({
        ok: true,
        text: async () => `
          <a href="8.10/">8.10</a>
          <a href="8.9/">8.9</a>
          <a href="8.9.0-alpha10/">8.9.0-alpha10</a>
          <a href="8.9.0-alpha2/">8.9.0-alpha2</a>
        `,
      }),
      writable: true,
      configurable: true,
    });

    await plugin.listRemoteVersions();
    const output = captured.join('\n');
    const alpha2Idx = output.indexOf('8.9.0-alpha2');
    const alpha10Idx = output.indexOf('8.9.0-alpha10');
    const v9Idx = output.indexOf('8.9\n') >= 0 ? output.indexOf('8.9\n') : output.indexOf('  8.9');
    const v10Idx = output.indexOf('8.10');
    assert.ok(alpha2Idx < alpha10Idx, 'alpha2 should appear before alpha10');
    assert.ok(v9Idx < v10Idx, '8.9 should appear before 8.10');
  });

  test('exits with error when network fails', async () => {
    Object.defineProperty(globalThis, 'fetch', {
      value: async () => { throw new Error('Network error'); },
      writable: true,
      configurable: true,
    });

    const originalExit = process.exit;
    let exitCalled = false;
    process.exit = (() => { exitCalled = true; throw new Error('exit'); }) as never;

    try {
      await assert.rejects(() => plugin.listRemoteVersions(), /exit/);
      assert.ok(exitCalled, 'Should exit on network error');
    } finally {
      process.exit = originalExit;
    }
  });
});

// ---------------------------------------------------------------------------
// streamLogs
// ---------------------------------------------------------------------------

describe('Cluster Plugin – streamLogs', () => {
  let tempDir: string;
  let captured: string[];
  let originalLog: typeof console.log;
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'c8ctl-test-'));
    captured = [];
    originalLog = console.log;
    originalWarn = console.warn;
    console.log = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
    console.warn = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
  });

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    console.log = originalLog;
    console.warn = originalWarn;
  });

  test('warns when no cluster is running', async () => {
    await plugin.streamLogs(tempDir);
    const output = captured.join('\n');
    assert.ok(output.includes('No cluster is currently running'), 'Should warn no cluster running');
  });

  test('warns when no log files found', async () => {
    writeFileSync(join(tempDir, 'cluster.active'), 'running');
    writeFileSync(join(tempDir, 'cluster.version'), '8.8');

    // Create an install dir with a binary but no log dir
    const binaryDir = join(tempDir, 'c8run-8.8', 'c8run-8.8.1');
    mkdirSync(binaryDir, { recursive: true });
    writeFileSync(join(binaryDir, 'c8run'), '');

    await plugin.streamLogs(tempDir);
    const output = captured.join('\n');
    assert.ok(output.includes('No log files found'), 'Should warn about missing log files');
  });
});

// ---------------------------------------------------------------------------
// new subcommands via commands export
// ---------------------------------------------------------------------------

describe('Cluster Plugin – logs, list-remote, install, delete subcommands', () => {
  let captured: string[];
  let originalLog: typeof console.log;
  let originalWarn: typeof console.warn;
  let originalError: typeof console.error;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    captured = [];
    originalLog = console.log;
    originalWarn = console.warn;
    originalError = console.error;
    console.log = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
    console.warn = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
    console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
    originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'fetch', {
      value: async () => { throw new Error('Connection refused'); },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    Object.defineProperty(globalThis, 'fetch', { value: originalFetch, writable: true, configurable: true });
  });

  test('log subcommand does not print usage', async () => {
    await plugin.commands['cluster'](['log']);
    const output = captured.join('\n');
    assert.ok(!output.includes('Usage:'), 'log subcommand should not print usage');
  });

  test('logs subcommand does not print usage', async () => {
    await plugin.commands['cluster'](['logs']);
    const output = captured.join('\n');
    assert.ok(!output.includes('Usage:'), 'logs subcommand should not print usage');
  });

  test('list-remote subcommand does not print usage', async () => {
    const originalExit = process.exit;
    process.exit = (() => { throw new Error('exit'); }) as never;

    try {
      await plugin.commands['cluster'](['list-remote']).catch(() => {});
    } finally {
      process.exit = originalExit;
    }
    // If we got here without "Usage:" in output, the subcommand was recognized
    const output = captured.join('\n');
    assert.ok(!output.includes('Usage:'), 'list-remote subcommand should not print usage');
  });

  test('delete subcommand does not print usage', async () => {
    const originalExit = process.exit;
    process.exit = (() => { throw new Error('exit'); }) as never;

    try {
      await plugin.commands['cluster'](['delete', '8.8']).catch(() => {});
    } finally {
      process.exit = originalExit;
    }
    const output = captured.join('\n');
    assert.ok(!output.includes('Usage:'), 'delete subcommand should not print usage');
  });

  test('install subcommand does not print usage', async () => {
    const originalExit = process.exit;
    process.exit = (() => { throw new Error('exit'); }) as never;

    try {
      await plugin.commands['cluster'](['install', '8.8']).catch(() => {});
    } finally {
      process.exit = originalExit;
    }
    const output = captured.join('\n');
    assert.ok(!output.includes('Usage:'), 'install subcommand should not print usage');
  });

  test('install without version exits with error', async () => {
    const originalExit = process.exit;
    process.exit = (() => { throw new Error('exit'); }) as never;

    try {
      await plugin.commands['cluster'](['install']).catch(() => {});
    } finally {
      process.exit = originalExit;
    }
    const output = captured.join('\n');
    assert.ok(output.includes('specify a version'), 'install without version should prompt for one');
  });

  test('delete without version exits with error', async () => {
    const originalExit = process.exit;
    process.exit = (() => { throw new Error('exit'); }) as never;

    try {
      await plugin.commands['cluster'](['delete']).catch(() => {});
    } finally {
      process.exit = originalExit;
    }
    const output = captured.join('\n');
    assert.ok(output.includes('specify a version'), 'delete without version should prompt for one');
  });
});

// ---------------------------------------------------------------------------
// isMinorVersionPattern / isRollingVersion
// ---------------------------------------------------------------------------

describe('Cluster Plugin – isMinorVersionPattern', () => {
  test('recognizes major.minor patterns', () => {
    assert.strictEqual(plugin.isMinorVersionPattern('8.8'), true);
    assert.strictEqual(plugin.isMinorVersionPattern('8.9'), true);
    assert.strictEqual(plugin.isMinorVersionPattern('9.0'), true);
    assert.strictEqual(plugin.isMinorVersionPattern('10.1'), true);
  });

  test('rejects non major.minor patterns', () => {
    assert.strictEqual(plugin.isMinorVersionPattern('stable'), false);
    assert.strictEqual(plugin.isMinorVersionPattern('alpha'), false);
    assert.strictEqual(plugin.isMinorVersionPattern('8.9.0-alpha5'), false);
    assert.strictEqual(plugin.isMinorVersionPattern('8.8.1'), false);
    assert.strictEqual(plugin.isMinorVersionPattern('8'), false);
    assert.strictEqual(plugin.isMinorVersionPattern('latest'), false);
  });
});

describe('Cluster Plugin – isRollingVersion', () => {
  test('returns true for named aliases', () => {
    assert.strictEqual(plugin.isRollingVersion('stable'), true);
    assert.strictEqual(plugin.isRollingVersion('alpha'), true);
  });

  test('returns true for major.minor patterns', () => {
    assert.strictEqual(plugin.isRollingVersion('8.8'), true);
    assert.strictEqual(plugin.isRollingVersion('8.9'), true);
  });

  test('returns false for pinned versions', () => {
    assert.strictEqual(plugin.isRollingVersion('8.9.0-alpha5'), false);
    assert.strictEqual(plugin.isRollingVersion('8.8.1'), false);
    assert.strictEqual(plugin.isRollingVersion('latest'), false);
  });
});

// ---------------------------------------------------------------------------
// ensureC8RunInstalled – start vs install update behavior
// ---------------------------------------------------------------------------

describe('Cluster Plugin – ensureC8RunInstalled start vs install behavior', () => {
  let tempDir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'c8ctl-test-'));
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    Object.defineProperty(globalThis, 'fetch', { value: originalFetch, writable: true, configurable: true });
  });

  test('start (checkForUpdateHint=true) does not block or re-download, but checks remote for hint', async () => {
    // Simulate: 8.8 is installed locally with an old ETag, remote has a new ETag
    const config: any = { cacheDir: tempDir, version: '8.8', isRolling: true, checkForUpdates: false, checkForUpdateHint: true };
    const binaryDir = join(tempDir, 'c8run-8.8', 'c8run-8.8.1');
    mkdirSync(binaryDir, { recursive: true });
    writeFileSync(join(binaryDir, 'c8run'), '');
    plugin.storeETag(config, '"etag-old"');

    let fetchCalled = false;
    Object.defineProperty(globalThis, 'fetch', {
      value: async () => { fetchCalled = true; return { ok: true, headers: { get: () => '"etag-new"' } }; },
      writable: true,
      configurable: true,
    });

    await plugin.ensureC8RunInstalled(config);

    // Await the hint promise (stored on config by ensureC8RunInstalled)
    await config._hintPromise;

    // start DOES fire a remote check for the hint
    assert.strictEqual(fetchCalled, true, 'start should check remote for update hint');
    // But it should NOT purge or re-download — install dir stays
    assert.ok(existsSync(join(tempDir, 'c8run-8.8')), 'should not purge the install');
  });

  test('install (checkForUpdates=true) checks remote ETag for rolling versions', async () => {
    // Simulate: 8.8 is installed locally, remote ETag matches
    const config = { cacheDir: tempDir, version: '8.8', isRolling: true, checkForUpdates: true };
    const binaryDir = join(tempDir, 'c8run-8.8', 'c8run-8.8.1');
    mkdirSync(binaryDir, { recursive: true });
    writeFileSync(join(binaryDir, 'c8run'), '');
    plugin.storeETag(config, '"etag-current"');

    Object.defineProperty(globalThis, 'fetch', {
      value: async () => ({
        ok: true,
        headers: { get: (h: string) => h === 'etag' ? '"etag-current"' : null },
      }),
      writable: true,
      configurable: true,
    });

    await plugin.ensureC8RunInstalled(config);

    // Should still be installed (ETag matches, no update needed)
    assert.ok(existsSync(join(tempDir, 'c8run-8.8')), 'should keep install when ETag matches');
  });

  test('start with minor version succeeds offline (hint check swallows error)', async () => {
    const config: any = { cacheDir: tempDir, version: '8.8', isRolling: true, checkForUpdates: false, checkForUpdateHint: true };
    const binaryDir = join(tempDir, 'c8run-8.8', 'c8run-8.8.1');
    mkdirSync(binaryDir, { recursive: true });
    writeFileSync(join(binaryDir, 'c8run'), '');

    Object.defineProperty(globalThis, 'fetch', {
      value: async () => { throw new Error('Network unreachable'); },
      writable: true,
      configurable: true,
    });

    await assert.doesNotReject(
      () => plugin.ensureC8RunInstalled(config),
      'start with local minor version should succeed even when network fails',
    );

    // Await the hint promise — it should resolve (swallowing the error) without throwing
    await assert.doesNotReject(
      () => config._hintPromise,
      'hint check should swallow network errors',
    );

    // Install should still be there
    assert.ok(existsSync(join(tempDir, 'c8run-8.8')), 'should not purge the install');
  });
});
