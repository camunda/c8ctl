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
import { chmod, readFile } from 'node:fs/promises';
import { homedir, platform as osPlatform, arch as osArch } from 'node:os';
import { join, dirname } from 'node:path';

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
        { command: 'c8ctl cluster start', description: 'Start a local Camunda 8 cluster (latest stable)' },
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

const PID_MARKER_FILE = 'cluster.pid';
const VERSION_MARKER_FILE = 'cluster.version';

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
    const logger = getLogger();
    logger.warn('Native Windows is not supported. Please use WSL (Windows Subsystem for Linux).');
    return { platform: 'linux', arch: camundaArch, extension: 'tar.gz', executable: 'c8run' };
  }

  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

async function resolveVersion(versionSpec) {
  if (versionSpec === 'latest' || versionSpec === 'stable') {
    return '8.8';
  }
  if (versionSpec === 'alpha' || versionSpec === 'latest-alpha') {
    return '8.9-alpha';
  }
  return versionSpec;
}

// ---------------------------------------------------------------------------
// Download & installation
// ---------------------------------------------------------------------------

async function downloadC8Run(config) {
  const logger = getLogger();
  const version = config.version;
  const platformInfo = getPlatformIdentifier();

  const downloadUrl =
    `https://downloads.camunda.cloud/release/camunda/c8run/${version}/camunda8-run-${version}-${platformInfo.platform}-${platformInfo.arch}.${platformInfo.extension}`;

  logger.info(`Downloading Camunda ${version} for ${platformInfo.platform}...`);

  const cacheDir = config.cacheDir;
  mkdirSync(cacheDir, { recursive: true });

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
  const fileStream = createWriteStream(targetFile);

  let downloadedSize = 0;
  let lastReportedPercentage = 0;

  if (response.body) {
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
  }

  fileStream.end();

  logger.info(
    `Downloaded and saved to ${targetFile} (${Math.floor(downloadedSize / 1024 / 1024)} MB)`,
  );

  return targetFile;
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

function findC8RunBinaryPath(config) {
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

function isC8RunInstalled(config) {
  return findC8RunBinaryPath(config) !== null;
}

function getC8RunBinaryPath(config) {
  const binaryPath = findC8RunBinaryPath(config);
  if (!binaryPath) {
    throw new Error(
      `c8run ${config.version} binary not found in cache directory`,
    );
  }
  return binaryPath;
}

async function ensureC8RunInstalled(config) {
  const logger = getLogger();

  if (isC8RunInstalled(config)) {
    logger.info(`c8run ${config.version} is already installed.`);
    return;
  }

  logger.info('No local installation found. Setting up...');

  const archivePath = await downloadC8Run(config);

  const installDir = join(config.cacheDir, `c8run-${config.version}`);
  await extractArchive(archivePath, installDir);

  const binaryPath = getC8RunBinaryPath(config);
  await chmod(binaryPath, 0o755);

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

async function waitForClusterReady(maxWaitMs = 120000) {
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

  const pidFile = join(config.cacheDir, PID_MARKER_FILE);
  const versionFile = join(config.cacheDir, VERSION_MARKER_FILE);

  if (existsSync(pidFile)) {
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
  await new Promise((resolve) => {
    proc.on('close', resolve);
  });

  writeFileSync(pidFile, proc.pid.toString());
  writeFileSync(versionFile, config.version);

  logger.info('Cluster process launched, waiting for cluster to be ready...');

  const isReady = await waitForClusterReady();

  if (isReady) {
    printSummary(startupOutput, config.version);
    if (debug) {
      process.exit(0);
    }
  } else {
    logger.error(
      'Cluster failed to start within timeout. Check logs for details.',
    );
    process.exit(1);
  }
}

async function stopC8Run(config) {
  const logger = getLogger();
  const pidFile = join(config.cacheDir, PID_MARKER_FILE);
  const versionFile = join(config.cacheDir, VERSION_MARKER_FILE);

  const markerExists = existsSync(pidFile) || existsSync(versionFile);
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

    const exitCode = await new Promise((resolve, reject) => {
      const proc = spawn(binaryPath, ['stop'], {
        stdio: 'inherit',
        cwd: dirname(binaryPath),
      });
      proc.on('exit', resolve);
      proc.on('error', reject);
    }).catch((error) => {
      lastError = error instanceof Error ? error : new Error(String(error));
      return -1;
    });

    if (exitCode === 0 || exitCode === null) {
      hadSuccessfulStop = true;
    } else if (exitCode !== -1) {
      lastError = new Error(`Stop command failed with code ${exitCode}`);
    }
  }

  if (existsSync(pidFile)) {
    rmSync(pidFile);
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

function parsePluginArgs(args) {
  const result = { subcommand: null, version: null, debug: false };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--c8-version' && i + 1 < args.length) {
      result.version = args[i + 1];
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
      console.log('  <version>              Camunda version to use (default: stable / 8.8)');
      console.log('  --c8-version <version> Alternative flag form for version');
      console.log('  --debug                Stream raw c8run output during start');
      console.log('');
      console.log('Examples:');
      console.log('  c8ctl cluster start              # Start latest stable (8.8)');
      console.log('  c8ctl cluster start 8.9.0-alpha5 # Start specific version');
      console.log('  c8ctl cluster stop');
      return;
    }

    const versionSpec = parsed.version || 'stable';
    const version = await resolveVersion(versionSpec);
    const config = { cacheDir: getCacheDir(), version };

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
