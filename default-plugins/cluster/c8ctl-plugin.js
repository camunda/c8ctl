/**
 * c8ctl-plugin-cluster
 *
 * Download, start, and stop a local Camunda 8 cluster via c8run.
 *
 * Usage:
 *   c8ctl cluster start [<version>] [--debug]
 *   c8ctl cluster stop  [<version>]
 */

import { spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { chmod } from 'node:fs/promises';
import { homedir, platform as osPlatform, arch as osArch } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Version aliases – dynamic discovery with package.json fallback
// ---------------------------------------------------------------------------

const DOWNLOAD_BASE_URL = 'https://downloads.camunda.cloud/release/camunda/c8run/';

const _pluginPackageJson = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf-8'),
);
const _fallbackAliases = _pluginPackageJson.c8ctl.versionAliases;
const KNOWN_ALIAS_NAMES = new Set(['stable', 'alpha']);

function isVersionAlias(versionSpec) {
  return KNOWN_ALIAS_NAMES.has(versionSpec);
}

/**
 * Fetch the c8run download directory listing and discover the latest
 * stable and alpha minor versions.
 *
 * Returns { stable: "X.Y", alpha: "X.Y" } or null on failure.
 */
export async function discoverLatestVersions() {
  try {
    const response = await fetch(DOWNLOAD_BASE_URL);
    if (!response.ok) return null;
    const html = await response.text();
    return parseVersionsFromHtml(html);
  } catch {
    return null;
  }
}

/**
 * Parse the HTML directory listing from the download server to extract
 * the latest stable and alpha minor versions.
 *
 * - Minor version directories (e.g. "8.8/", "8.9/") are rolling releases
 *   updated in-place.
 * - An alpha train exists when there are "X.Y.0-alphaN/" directories
 *   for a given minor. The highest minor with alphas is the alpha alias.
 * - The highest minor without alphas is the stable alias.
 */
export function parseVersionsFromHtml(html) {
  // Match minor-version directories like "8.8/", "8.9/"
  const minorMatches = [...html.matchAll(/href="(\d+\.\d+)\/"/g)].map(m => m[1]);
  // Match alpha directories like "8.9.0-alpha5/"
  const alphaMatches = [...html.matchAll(/href="(\d+\.\d+)\.0-alpha\d+\/"/g)].map(m => m[1]);

  if (minorMatches.length === 0) return null;

  const compareSemver = (a, b) => {
    const [aMaj, aMin] = a.split('.').map(Number);
    const [bMaj, bMin] = b.split('.').map(Number);
    return aMaj - bMaj || aMin - bMin;
  };

  const sortedMinors = [...new Set(minorMatches)].sort(compareSemver);
  const alphaSet = new Set(alphaMatches);

  const highestMinor = sortedMinors[sortedMinors.length - 1];

  // The alpha train is the highest minor that has alpha directories.
  // The stable release is the minor just below the alpha train,
  // or the highest minor if no alpha train exists.
  const highestAlphaMinor = [...alphaSet].sort(compareSemver).pop();

  let stable;
  if (highestAlphaMinor) {
    // Stable = the highest minor that is lower than the alpha train
    stable = sortedMinors.filter(v => compareSemver(v, highestAlphaMinor) < 0).pop() || highestMinor;
  } else {
    stable = highestMinor;
  }

  return {
    stable,
    alpha: highestMinor,
  };
}

// Cache the discovery result for the process lifetime
let _dynamicAliases = undefined;

async function getDynamicAliases() {
  if (_dynamicAliases === undefined) {
    _dynamicAliases = await discoverLatestVersions();
  }
  return _dynamicAliases;
}

async function resolveVersion(versionSpec) {
  if (!isVersionAlias(versionSpec)) return versionSpec;
  const dynamic = await getDynamicAliases();
  if (dynamic?.[versionSpec]) return dynamic[versionSpec];
  return _fallbackAliases[versionSpec] ?? versionSpec;
}

async function getVersionAliasEntries() {
  const dynamic = await getDynamicAliases();
  const aliases = dynamic || _fallbackAliases;
  return Object.entries(aliases);
}

/** Reset the cached dynamic aliases (for testing). */
export function _resetDynamicAliasCache() {
  _dynamicAliases = undefined;
}

// ---------------------------------------------------------------------------
// Plugin metadata
// ---------------------------------------------------------------------------

export const metadata = {
  name: 'cluster',
  description: 'Download, start, and stop a local Camunda 8 cluster',
  commands: {
    'cluster': {
      description:
        'Manage local Camunda 8 cluster — use "c8ctl cluster start [version]" or "c8ctl cluster stop"',
      examples: [
        { command: 'c8ctl cluster start', description: 'Start a local Camunda 8 cluster (latest alpha)' },
        { command: 'c8ctl cluster start 8.9.0-alpha5', description: 'Start a specific version' },
        { command: 'c8ctl cluster stop', description: 'Stop the running cluster' },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers – logger wrapper
// ---------------------------------------------------------------------------

function getLogger() {
  if (globalThis.c8ctl) {
    return globalThis.c8ctl.getLogger();
  }
  // Fallback when running outside c8ctl (shouldn't happen for a plugin)
  return {
    info: console.log,
    warn: console.warn,
    error: console.error,
    debug: () => {},
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ACTIVE_MARKER_FILE = 'cluster.active';
const VERSION_MARKER_FILE = 'cluster.version';
const CLUSTER_STARTUP_TIMEOUT_MS = 120000;

function getCacheDir() {
  const envDir = process.env.C8RUN_CACHE_DIR;
  if (envDir) {
    return envDir;
  }

  const platform = osPlatform();
  const home = homedir();

  switch (platform) {
    case 'darwin':
      return join(home, 'Library', 'Caches', 'c8run');
    case 'win32':
      return join(
        process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'),
        'c8run',
        'cache',
      );
    default:
      return join(
        process.env.XDG_CACHE_HOME || join(home, '.cache'),
        'c8run',
      );
  }
}

function getPlatformIdentifier() {
  const platform = osPlatform();
  const arch = osArch();

  let camundaArch;
  if (arch === 'x64') {
    camundaArch = 'x86_64';
  } else if (arch === 'arm64') {
    camundaArch = 'aarch64';
  } else {
    throw new Error(`Unsupported architecture: ${arch}`);
  }

  if (platform === 'darwin') {
    return { platform: 'darwin', arch: camundaArch, extension: 'zip', executable: 'c8run' };
  } else if (platform === 'linux') {
    return { platform: 'linux', arch: camundaArch, extension: 'tar.gz', executable: 'c8run' };
  } else if (platform === 'win32') {
    return { platform: 'windows', arch: camundaArch, extension: 'zip', executable: 'c8run.exe' };
  }

  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

/**
 * Validate a version spec string to prevent path traversal attacks.
 * Allows only alphanumeric characters, dots, hyphens, and underscores,
 * and explicitly rejects double-dot sequences.
 */
export function validateVersionSpec(versionSpec) {
  if (!/^(?!.*\.\.)([0-9A-Za-z._-]+)$/.test(versionSpec)) {
    throw new Error(
      `Invalid version string: "${versionSpec}". ` +
        'Version must contain only alphanumeric characters, dots, hyphens, and underscores.',
    );
  }
}

// ---------------------------------------------------------------------------
// Download & installation
// ---------------------------------------------------------------------------

function getDownloadUrl(version) {
  const platformInfo = getPlatformIdentifier();
  return `https://downloads.camunda.cloud/release/camunda/c8run/${version}/camunda8-run-${version}-${platformInfo.platform}-${platformInfo.arch}.${platformInfo.extension}`;
}

async function downloadC8Run(config) {
  const logger = getLogger();
  const version = config.version;

  const downloadUrl = getDownloadUrl(version);

  logger.info(`Downloading Camunda ${version} for ${getPlatformIdentifier().platform}...`);

  const cacheDir = config.cacheDir;
  mkdirSync(cacheDir, { recursive: true });

  const platformInfo = getPlatformIdentifier();
  const targetFile = join(
    cacheDir,
    `c8run-${version}-${platformInfo.platform}-${platformInfo.arch}.${platformInfo.extension}`,
  );

  const response = await fetch(downloadUrl);

  if (!response.ok) {
    throw new Error(
      `Failed to download c8run ${version}: HTTP ${response.status}\n` +
        `URL: ${downloadUrl}\n` +
        `Please check the version exists or try a different version.`,
    );
  }

  const totalSize = parseInt(response.headers.get('content-length') || '0');

  if (!response.body) {
    throw new Error(
      `Failed to download c8run ${version}: empty response body\n` +
        `URL: ${downloadUrl}\n` +
        `Please try again or use a different version.`,
    );
  }

  const etag = response.headers.get('etag') || response.headers.get('last-modified') || null;
  // Note: 'etag' values are quoted strings (e.g. '"abc123"') while 'last-modified'
  // values are date strings. Both are used as opaque version tokens for equality
  // comparison — the format difference does not affect correctness.

  const fileStream = createWriteStream(targetFile);

  let downloadedSize = 0;
  let lastReportedPercentage = 0;

  const reader = response.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    fileStream.write(value);
    downloadedSize += value.length;

    if (totalSize > 0) {
      const percentage = Math.floor((downloadedSize / totalSize) * 100);
      if (percentage >= lastReportedPercentage + 10) {
        logger.info(
          `Progress: ${percentage}% (${Math.floor(downloadedSize / 1024 / 1024)} MB / ${Math.floor(totalSize / 1024 / 1024)} MB)`,
        );
        lastReportedPercentage = percentage;
      }
    }
  }

  await new Promise((resolve, reject) => {
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
    fileStream.end();
  });

  logger.info(
    `Downloaded and saved to ${targetFile} (${Math.floor(downloadedSize / 1024 / 1024)} MB)`,
  );

  return { archivePath: targetFile, etag };
}

async function extractArchive(archivePath, targetDir) {
  const logger = getLogger();
  logger.info(`Extracting to ${targetDir}...`);

  mkdirSync(targetDir, { recursive: true });

  if (archivePath.endsWith('.zip')) {
    return new Promise((resolve, reject) => {
      const proc = spawn('unzip', ['-q', archivePath, '-d', targetDir], {
        stdio: 'inherit',
      });
      proc.on('exit', (code) => {
        if (code === 0) {
          logger.info('Extraction complete.');
          resolve();
        } else {
          reject(new Error(`Extraction failed with code ${code}`));
        }
      });
      proc.on('error', (err) => {
        reject(
          new Error(
            `Failed to run unzip command: ${err.message}. Make sure unzip is installed.`,
          ),
        );
      });
    });
  } else if (archivePath.endsWith('.tar.gz')) {
    return new Promise((resolve, reject) => {
      const proc = spawn('tar', ['-xzf', archivePath, '-C', targetDir], {
        stdio: 'inherit',
      });
      proc.on('exit', (code) => {
        if (code === 0) {
          logger.info('Extraction complete.');
          resolve();
        } else {
          reject(new Error(`Extraction failed with code ${code}`));
        }
      });
      proc.on('error', reject);
    });
  } else {
    throw new Error(`Unsupported archive format: ${archivePath}`);
  }
}

export function findC8RunBinaryPath(config) {
  const installDir = join(config.cacheDir, `c8run-${config.version}`);
  const platformInfo = getPlatformIdentifier();

  if (!existsSync(installDir)) {
    return null;
  }

  const entries = readdirSync(installDir, { withFileTypes: true });

  const versionDirs = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith(`c8run-${config.version}`),
    )
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const versionDir of versionDirs) {
    const binaryPath = join(installDir, versionDir, platformInfo.executable);
    if (existsSync(binaryPath)) {
      return binaryPath;
    }
  }

  const directPath = join(installDir, platformInfo.executable);
  if (existsSync(directPath)) {
    return directPath;
  }

  return null;
}

export function isC8RunInstalled(config) {
  return findC8RunBinaryPath(config) !== null;
}

export function getC8RunBinaryPath(config) {
  const binaryPath = findC8RunBinaryPath(config);
  if (!binaryPath) {
    throw new Error(
      `c8run ${config.version} binary not found in cache directory`,
    );
  }
  return binaryPath;
}

export function purgeInstalledVersion(config) {
  const logger = getLogger();
  const installDir = join(config.cacheDir, `c8run-${config.version}`);
  const platformInfo = getPlatformIdentifier();
  const archiveFile = join(
    config.cacheDir,
    `c8run-${config.version}-${platformInfo.platform}-${platformInfo.arch}.${platformInfo.extension}`,
  );

  if (existsSync(installDir)) {
    logger.info(`Removing cached installation for ${config.version} since a newer version is available...`);
    rmSync(installDir, { recursive: true });
  }
  if (existsSync(archiveFile)) {
    rmSync(archiveFile);
  }

  // Remove stored ETag so the next install records a fresh one
  const etagFile = getETagFilePath(config);
  if (existsSync(etagFile)) {
    rmSync(etagFile);
  }
}

function getETagFilePath(config) {
  return join(config.cacheDir, `c8run-${config.version}.etag`);
}

export function readStoredETag(config) {
  const etagFile = getETagFilePath(config);
  if (!existsSync(etagFile)) return null;
  try {
    return readFileSync(etagFile, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

export function storeETag(config, etag) {
  mkdirSync(config.cacheDir, { recursive: true });
  writeFileSync(getETagFilePath(config), etag);
}

export async function hasNewerVersionAvailable(config) {
  const storedETag = readStoredETag(config);

  const downloadUrl = getDownloadUrl(config.version);
  let remoteETag;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const response = await fetch(downloadUrl, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      // Can't determine — keep the current installation
      return false;
    }
    remoteETag = response.headers.get('etag') || response.headers.get('last-modified');
    if (!remoteETag) {
      // Server provides no version signal — keep the current installation
      return false;
    }
  } catch {
    // Network error — keep the current installation (allows offline use)
    return false;
  }

  if (!storedETag) {
    // No ETag stored yet (e.g. first run after upgrade to this version).
    // Record the current remote ETag so future checks can compare, but
    // do NOT treat this as "update available" — the existing install is fine.
    storeETag(config, remoteETag);
    return false;
  }

  return remoteETag !== storedETag;
}

export async function ensureC8RunInstalled(config) {
  const logger = getLogger();

  if (isC8RunInstalled(config)) {
    if (config.isAlias) {
      // No explicit version on command line — check if a newer release is available
      const hasUpdate = await hasNewerVersionAvailable(config);
      if (!hasUpdate) {
        logger.info(`c8run ${config.version} is already installed and up to date.`);
        return;
      }
      purgeInstalledVersion(config);
    } else {
      // Exact version pinned by the user — never re-download
      logger.info(`c8run ${config.version} is already installed.`);
      return;
    }
  }

  logger.info('No local installation found. Setting up...');

  const { archivePath, etag } = await downloadC8Run(config);

  const installDir = join(config.cacheDir, `c8run-${config.version}`);
  await extractArchive(archivePath, installDir);

  // Clean up the downloaded archive to save disk space
  if (existsSync(archivePath)) {
    rmSync(archivePath);
  }

  const binaryPath = getC8RunBinaryPath(config);
  await chmod(binaryPath, 0o755);

  // Store the ETag so future alias-based starts can detect new releases
  if (config.isAlias && etag) {
    storeETag(config, etag);
  }

  logger.info(`c8run ${config.version} installed successfully.`);
}

// ---------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------

const STARTUP_SUMMARY_MARKER = '- Operate:';

function extractStartupSummary(rawOutput) {
  const startIndex = rawOutput.indexOf(STARTUP_SUMMARY_MARKER);
  if (startIndex === -1) {
    return null;
  }
  return rawOutput.slice(startIndex).trim();
}

async function waitForClusterReady(maxWaitMs = CLUSTER_STARTUP_TIMEOUT_MS) {
  const logger = getLogger();
  const startTime = Date.now();
  const healthUrl = 'http://localhost:9600/actuator/health';

  logger.info('Waiting for cluster to be ready...');

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        const data = await response.json();
        if (data.status === 'UP') {
          logger.info('Cluster is ready!');
          return true;
        }
      }
    } catch {
      // Cluster not ready yet, continue polling
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  logger.warn('Cluster did not become ready within timeout.');
  return false;
}

function printSummary(rawOutput, version) {
  const summary = extractStartupSummary(rawOutput);

  if (summary) {
    console.log(`\n${summary}\n`);
    return;
  }

  // c8run daemonizes so captured output is often empty — print known defaults
  console.log('');
  console.log(`Camunda 8 (${version}) is running:`);
  console.log('');
  console.log('  - Operate:    http://localhost:8080/operate');
  console.log('  - Tasklist:   http://localhost:8080/tasklist');
  console.log('  - Zeebe GRPC: localhost:26500');
  console.log('  - Zeebe REST: http://localhost:8080/v2/');
  console.log('  - Health:     http://localhost:9600/actuator/health');
  console.log('');
  console.log('  Default credentials: demo / demo');
  console.log('');
}

async function startC8Run(config, debug = false) {
  const logger = getLogger();
  const binaryPath = getC8RunBinaryPath(config);

  if (!existsSync(binaryPath)) {
    throw new Error(`c8run binary not found at ${binaryPath}`);
  }

  const markerFile = join(config.cacheDir, ACTIVE_MARKER_FILE);
  const versionFile = join(config.cacheDir, VERSION_MARKER_FILE);

  if (existsSync(markerFile)) {
    logger.warn('A cluster appears to be running already.');
    if (existsSync(versionFile)) {
      const runningVersion = readFileSync(versionFile, 'utf-8').trim();
      if (runningVersion) {
        logger.info(`Detected running version marker: ${runningVersion}`);
      }
    }
    logger.info('Use "c8ctl cluster stop" to stop it first.');
    return;
  }

  logger.info('Starting Camunda 8 local cluster...');

  const proc = spawn(binaryPath, ['start'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: dirname(binaryPath),
  });

  if (typeof proc.pid !== 'number') {
    logger.error('Failed to start cluster process: no PID received from c8run. Check logs for details.');
    process.exit(1);
  }

  let startupOutput = '';

  const handleOutput = (chunk, stream) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    startupOutput += text;
    if (debug) {
      stream.write(text);
    }
  };

  proc.stdout?.on('data', (chunk) => {
    handleOutput(chunk, process.stdout);
  });

  proc.stderr?.on('data', (chunk) => {
    handleOutput(chunk, process.stderr);
  });

  // Wait for the c8run Go binary to exit — it spawns Java services then exits
  let exitCode = null;
  let exitSignal = null;

  await new Promise((resolve, reject) => {
    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn c8run: ${err.message}`));
    });
    proc.on('close', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      resolve();
    });
  });

  if (exitCode !== 0) {
    if (startupOutput.trim()) {
      logger.error(`c8run output:\n${startupOutput.trim()}`);
    }
    logger.error(
      `c8run start exited with code ${exitCode ?? 'unknown'}${exitSignal ? ` (signal: ${exitSignal})` : ''}. Cluster will not be marked as running.`,
    );
    process.exit(typeof exitCode === 'number' && exitCode > 0 ? exitCode : 1);
  }

  logger.info('Cluster process launched, waiting for cluster to be ready...');

  const isReady = await waitForClusterReady();

  if (isReady) {
    writeFileSync(markerFile, 'running');
    writeFileSync(versionFile, config.version);
    printSummary(startupOutput, config.version);
  } else {
    logger.error(
      'Cluster failed to start within timeout. Check logs for details.',
    );
    process.exit(1);
  }
}

async function stopC8Run(config) {
  const logger = getLogger();
  const markerFile = join(config.cacheDir, ACTIVE_MARKER_FILE);
  const versionFile = join(config.cacheDir, VERSION_MARKER_FILE);

  const markerExists = existsSync(markerFile);
  const installedVersions = existsSync(config.cacheDir)
    ? readdirSync(config.cacheDir, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() && entry.name.startsWith('c8run-'),
        )
        .map((entry) => entry.name.slice('c8run-'.length))
        .sort()
    : [];

  if (!markerExists && installedVersions.length === 0) {
    logger.warn(
      'No running cluster found (use "c8ctl cluster start" to start one).',
    );
    return;
  }

  const versionsToTry = [];

  if (existsSync(versionFile)) {
    const markerVersion = readFileSync(versionFile, 'utf-8').trim();
    if (markerVersion) {
      versionsToTry.push(markerVersion);
    }
  }

  if (versionsToTry.length === 0) {
    if (installedVersions.length === 0) {
      versionsToTry.push(config.version);
    } else {
      versionsToTry.push(...installedVersions);
    }
  }

  logger.info('Stopping Camunda 8 local cluster...');

  let attempted = 0;
  let hadSuccessfulStop = false;
  let lastError;

  for (const version of versionsToTry) {
    const versionConfig = { cacheDir: config.cacheDir, version };
    let binaryPath;
    try {
      binaryPath = getC8RunBinaryPath(versionConfig);
    } catch {
      continue;
    }

    attempted += 1;

    const { code: exitCode, signal: exitSignal } = await new Promise(
      (resolve, reject) => {
        const proc = spawn(binaryPath, ['stop'], {
          stdio: 'inherit',
          cwd: dirname(binaryPath),
        });
        proc.on('exit', (code, signal) => resolve({ code, signal }));
        proc.on('error', reject);
      },
    ).catch((error) => {
      lastError = error instanceof Error ? error : new Error(String(error));
      return { code: -1, signal: null };
    });

    if (exitCode === 0 || (exitCode === null && !exitSignal)) {
      hadSuccessfulStop = true;
      break;
    } else if (exitCode === null && exitSignal) {
      lastError = new Error(
        `Stop command terminated by signal ${exitSignal}`,
      );
    } else if (exitCode !== -1) {
      lastError = new Error(`Stop command failed with code ${exitCode}`);
    }
  }

  // Always clean up markers, even if stop failed — a stale marker
  // would permanently block future starts.
  if (existsSync(markerFile)) {
    rmSync(markerFile);
  }
  if (existsSync(versionFile)) {
    rmSync(versionFile);
  }

  if (attempted === 0) {
    throw new Error(
      'Could not find an installed c8run binary to execute stop.',
    );
  }

  if (!hadSuccessfulStop && lastError) {
    throw lastError;
  }

  logger.info('Cluster stopped.');
}

// ---------------------------------------------------------------------------
// Argument parsing helper
// ---------------------------------------------------------------------------

export function parsePluginArgs(args) {
  const result = { subcommand: null, version: null, debug: false };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--c8-version') {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error(
          'Missing value for --c8-version. Please provide a version, for example: c8ctl cluster start --c8-version 8.6.0'
        );
      }
      result.version = next;
      i += 2;
      continue;
    }

    if (arg === '--debug') {
      result.debug = true;
      i += 1;
      continue;
    }

    if (!arg.startsWith('-') && result.subcommand === null) {
      result.subcommand = arg;
      i += 1;
      continue;
    }

    // Positional after subcommand → treat as version
    if (!arg.startsWith('-') && result.subcommand !== null && result.version === null) {
      result.version = arg;
      i += 1;
      continue;
    }

    i += 1;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Plugin commands export
// ---------------------------------------------------------------------------

export const commands = {
  'cluster': async (args) => {
    const logger = getLogger();
    const parsed = parsePluginArgs(args);

    if (!parsed.subcommand || !['start', 'stop'].includes(parsed.subcommand)) {
      console.log('Usage:');
      console.log('  c8ctl cluster start [<version>] [--debug]');
      console.log('  c8ctl cluster stop  [<version>]');
      console.log('');
      console.log('Subcommands:');
      console.log('  start   Download (if needed) and start a local Camunda 8 cluster');
      console.log('  stop    Stop the running local Camunda 8 cluster');
      console.log('');
      console.log('Options:');
      console.log('  <version>              Camunda version or alias (default: alpha)');
      console.log('  --c8-version <version> Alternative flag form for version');
      console.log('  --debug                Stream raw c8run output during start');
      console.log('');
      console.log('Version aliases (dynamically resolved):');
      for (const [alias, resolved] of await getVersionAliasEntries()) {
        console.log(`  ${alias.padEnd(22)} → ${resolved}`);
      }
      console.log('');
      console.log('Examples:');
      console.log('  c8ctl cluster start              # Start using default alias (alpha)');
      console.log('  c8ctl cluster start stable       # Start latest stable release');
      console.log('  c8ctl cluster start 8.9.0-alpha5 # Start specific version');
      console.log('  c8ctl cluster stop');
      return;
    }

    const versionSpec = parsed.version || 'alpha';
    if (!parsed.version && parsed.subcommand === 'start') {
      logger.info(`No version specified, using default: "${versionSpec}"`);
    }
    try {
      validateVersionSpec(versionSpec);
    } catch (error) {
      logger.error(error.message);
      process.exit(1);
    }
    const version = await resolveVersion(versionSpec);
    if (isVersionAlias(versionSpec)) {
      logger.info(`Resolved alias "${versionSpec}" → ${version}`);
    }
    const config = { cacheDir: getCacheDir(), version, isAlias: isVersionAlias(versionSpec) };

    if (parsed.subcommand === 'start') {
      try {
        await ensureC8RunInstalled(config);
        await startC8Run(config, parsed.debug);
      } catch (error) {
        logger.error(`Failed to start cluster: ${error}`);
        process.exit(1);
      }
    } else if (parsed.subcommand === 'stop') {
      try {
        await stopC8Run(config);
      } catch (error) {
        logger.error(`Failed to stop cluster: ${error}`);
        process.exit(1);
      }
    }
  },
};
