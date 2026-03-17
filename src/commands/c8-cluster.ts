/**
 * c8-cluster command - Manage local Camunda 8 cluster (c8run)
 *
 * Provides an opinionated way to download, start, and stop c8run for local development.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { chmod, readFile } from 'node:fs/promises';
import { homedir, platform as osPlatform, arch as osArch } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getLogger } from '../logger.ts';

const logger = getLogger();

// ============================================================================
// Configuration
// ============================================================================

interface C8RunConfig {
  cacheDir: string;
  version: string;
}

const PID_MARKER_FILE = 'c8run.pid';
const VERSION_MARKER_FILE = 'c8run.version';

/**
 * Get the cache directory for c8run installations
 */
function getCacheDir(): string {
  const envDir = process.env.C8RUN_CACHE_DIR;
  if (envDir) {
    return envDir;
  }

  // Platform-specific cache directories
  const platform = osPlatform();
  const home = homedir();

  switch (platform) {
    case 'darwin':
      return join(home, 'Library', 'Caches', 'c8run');
    case 'win32':
      return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'c8run', 'cache');
    default: // linux and others
      return join(process.env.XDG_CACHE_HOME || join(home, '.cache'), 'c8run');
  }
}

/**
 * Determine platform identifier for c8run downloads
 */
function getPlatformIdentifier(): { platform: string; arch: string; extension: string; executable: string } {
  const platform = osPlatform();
  const arch = osArch();

  // Map Node.js arch to Camunda arch naming
  let camundaArch: string;
  if (arch === 'x64') {
    camundaArch = 'x86_64';
  } else if (arch === 'arm64') {
    camundaArch = 'aarch64';
  } else {
    throw new Error(`Unsupported architecture: ${arch}`);
  }

  if (platform === 'darwin') {
    return {
      platform: 'darwin',
      arch: camundaArch,
      extension: 'zip',
      executable: 'c8run',
    };
  } else if (platform === 'linux') {
    return {
      platform: 'linux',
      arch: camundaArch,
      extension: 'tar.gz',
      executable: 'c8run',
    };
  } else if (platform === 'win32') {
    // Only WSL is supported, not native Windows
    logger.warn('Native Windows is not supported. Please use WSL (Windows Subsystem for Linux).');
    return {
      platform: 'linux',
      arch: camundaArch,
      extension: 'tar.gz',
      executable: 'c8run',
    };
  }

  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

/**
 * Resolve version string to specific version
 */
async function resolveVersion(versionSpec: string): Promise<string> {
  if (versionSpec === 'latest' || versionSpec === 'stable') {
    // For now, hardcode to 8.8 as the latest stable
    // TODO: Fetch from a version manifest or GitHub releases
    return '8.8';
  }

  if (versionSpec === 'alpha' || versionSpec === 'latest-alpha') {
    return '8.9-alpha';
  }

  // Assume it's a specific version like "8.8" or "8.7.1"
  return versionSpec;
}

// ============================================================================
// Download and Installation
// ============================================================================

interface DownloadProgress {
  downloaded: number;
  total: number;
  percentage: number;
}

/**
 * Download c8run binary from Camunda Download Center
 */
async function downloadC8Run(config: C8RunConfig): Promise<string> {
  const version = config.version;
  const platformInfo = getPlatformIdentifier();

  // Construct download URL
  // Format: https://downloads.camunda.cloud/release/camunda/c8run/8.8/camunda8-run-8.8-darwin-aarch64.zip
  const downloadUrl = `https://downloads.camunda.cloud/release/camunda/c8run/${version}/camunda8-run-${version}-${platformInfo.platform}-${platformInfo.arch}.${platformInfo.extension}`;

  logger.info(`Downloading Camunda ${version} for ${platformInfo.platform}...`);
  logger.debug(`URL: ${downloadUrl}`);

  // Create cache directory
  const cacheDir = config.cacheDir;
  mkdirSync(cacheDir, { recursive: true });

  const targetFile = join(cacheDir, `c8run-${version}-${platformInfo.platform}-${platformInfo.arch}.${platformInfo.extension}`);

  // Download with progress
  const response = await fetch(downloadUrl);

  if (!response.ok) {
    throw new Error(
      `Failed to download c8run ${version}: HTTP ${response.status}\n` +
      `URL: ${downloadUrl}\n` +
      `Please check the version exists or try a different version.`
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
          logger.info(`Progress: ${percentage}% (${Math.floor(downloadedSize / 1024 / 1024)} MB / ${Math.floor(totalSize / 1024 / 1024)} MB)`);
          lastReportedPercentage = percentage;
        }
      }
    }
  }

  fileStream.end();

  logger.info(`Downloaded and saved to ${targetFile} (${Math.floor(downloadedSize / 1024 / 1024)} MB)`);

  return targetFile;
}

/**
 * Verify checksum of downloaded file
 */
async function verifyChecksum(filePath: string, expectedChecksum?: string): Promise<boolean> {
  if (!expectedChecksum) {
    logger.warn('No checksum provided for verification. Skipping verification.');
    return true;
  }

  logger.info('Verifying checksum...');

  const fileBuffer = await readFile(filePath);
  const hash = createHash('sha256');
  hash.update(fileBuffer);
  const actualChecksum = hash.digest('hex');

  if (actualChecksum !== expectedChecksum) {
    logger.error(`Checksum mismatch!\nExpected: ${expectedChecksum}\nActual: ${actualChecksum}`);
    return false;
  }

  logger.info('Checksum verified successfully.');
  return true;
}

/**
 * Extract c8run archive
 */
async function extractArchive(archivePath: string, targetDir: string): Promise<void> {
  logger.info(`Extracting to ${targetDir}...`);

  mkdirSync(targetDir, { recursive: true });

  const platform = osPlatform();

  // Determine extraction method based on file extension
  if (archivePath.endsWith('.zip')) {
    // Use unzip for .zip files
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
        reject(new Error(`Failed to run unzip command: ${err.message}. Make sure unzip is installed.`));
      });
    });
  } else if (archivePath.endsWith('.tar.gz')) {
    // Use tar for .tar.gz files
    const tarCommand = platform === 'darwin' || platform === 'linux' ? 'tar' : 'tar'; // WSL has tar

    return new Promise((resolve, reject) => {
      const proc = spawn(tarCommand, ['-xzf', archivePath, '-C', targetDir], {
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

/**
 * Find the actual c8run binary path within the extraction directory.
 * The extraction creates a nested structure like: c8run-8.8/c8run-8.8.16/c8run
 * This function finds the latest version subdirectory.
 */
function findC8RunBinaryPath(config: C8RunConfig): string | null {
  const installDir = join(config.cacheDir, `c8run-${config.version}`);
  const platformInfo = getPlatformIdentifier();

  if (!existsSync(installDir)) {
    return null;
  }

  // Read all entries in the install directory
  const entries = readdirSync(installDir, { withFileTypes: true });

  // Find directories that match c8run-{version} pattern
  const versionDirs = entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith(`c8run-${config.version}`))
    .map(entry => entry.name)
    .sort()
    .reverse(); // Sort descending to get latest version first

  // Try each version directory to find the binary
  for (const versionDir of versionDirs) {
    const binaryPath = join(installDir, versionDir, platformInfo.executable);
    if (existsSync(binaryPath)) {
      return binaryPath;
    }
  }

  // Fallback: check if binary is directly in installDir (old structure)
  const directPath = join(installDir, platformInfo.executable);
  if (existsSync(directPath)) {
    return directPath;
  }

  return null;
}

/**
 * Check if c8run is already installed
 */
function isC8RunInstalled(config: C8RunConfig): boolean {
  const binaryPath = findC8RunBinaryPath(config);
  return binaryPath !== null;
}

/**
 * Get path to c8run binary
 */
function getC8RunBinaryPath(config: C8RunConfig): string {
  const binaryPath = findC8RunBinaryPath(config);
  if (!binaryPath) {
    throw new Error(`c8run ${config.version} binary not found in cache directory`);
  }
  return binaryPath;
}

/**
 * Install c8run if not already installed
 */
async function ensureC8RunInstalled(config: C8RunConfig): Promise<void> {
  if (isC8RunInstalled(config)) {
    logger.info(`c8run ${config.version} is already installed.`);
    return;
  }

  logger.info('No local installation found. Setting up...');

  // Download
  const archivePath = await downloadC8Run(config);

  // Verify (skip for now as we don't have checksums readily available)
  // await verifyChecksum(archivePath);

  // Extract
  const installDir = join(config.cacheDir, `c8run-${config.version}`);
  await extractArchive(archivePath, installDir);

  // Make binary executable
  const binaryPath = getC8RunBinaryPath(config);
  await chmod(binaryPath, 0o755);

  logger.info(`c8run ${config.version} installed successfully.`);
}

// ============================================================================
// Process Management
// ============================================================================

interface C8RunProcess {
  process: ChildProcess;
  pid: number;
}

let runningProcess: C8RunProcess | null = null;

const STARTUP_SUMMARY_MARKER = '- Operate:';

export function extractStartupSummary(rawOutput: string): string | null {
  const startIndex = rawOutput.indexOf(STARTUP_SUMMARY_MARKER);
  if (startIndex === -1) {
    return null;
  }

  return rawOutput.slice(startIndex).trim();
}

/**
 * Wait for c8run to be ready by polling health endpoint
 */
async function waitForClusterReady(maxWaitMs: number = 120000): Promise<boolean> {
  const startTime = Date.now();
  const healthUrl = 'http://localhost:9600/actuator/health';

  logger.info('Waiting for cluster to be ready...');

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        const data: any = await response.json();
        if (data.status === 'UP') {
          logger.info('Cluster is ready!');
          return true;
        }
      }
    } catch (error) {
      // Cluster not ready yet, continue polling
    }

    // Wait 2 seconds before next check
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  logger.warn('Cluster did not become ready within timeout.');
  return false;
}

/**
 * Start c8run process
 */
async function startC8Run(config: C8RunConfig, debug = false): Promise<void> {
  const binaryPath = getC8RunBinaryPath(config);
  let startupOutput = '';

  if (!existsSync(binaryPath)) {
    throw new Error(`c8run binary not found at ${binaryPath}`);
  }

  // Check if already running — c8run start exits immediately after launching Java
  // services so the saved PID is never alive; rely solely on the PID file as a
  // "cluster was started" marker (stop removes it on successful shutdown).
  const pidFile = join(config.cacheDir, PID_MARKER_FILE);
  const versionFile = join(config.cacheDir, VERSION_MARKER_FILE);
  if (existsSync(pidFile)) {
    logger.warn('A c8run cluster appears to be running already.');
    if (existsSync(versionFile)) {
      const runningVersion = readFileSync(versionFile, 'utf-8').trim();
      if (runningVersion) {
        logger.info(`Detected running version marker: ${runningVersion}`);
      }
    }
    logger.info('Use "c8ctl stop c8-cluster" to stop it first.');
    return;
  }

  logger.info('Starting Camunda 8 local cluster...');

  // Capture c8run output so we can print its own startup summary. In debug mode,
  // stream the same raw output through to the terminal.
  const proc = spawn(binaryPath, ['start'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    cwd: dirname(binaryPath), // c8run needs to run from its installation directory
  });

  const handleOutput = (chunk: Buffer | string, stream: NodeJS.WriteStream): void => {
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

  // Save PID for stop command
  writeFileSync(pidFile, proc.pid!.toString());
  writeFileSync(versionFile, config.version);

  proc.unref();

  logger.info(`c8run started with PID: ${proc.pid}`);

  // Wait for cluster to be ready
  const isReady = await waitForClusterReady();

  if (isReady) {
    printSummary(startupOutput);
    if (debug) {
      process.exit(0);
    }
  } else {
    logger.error('Cluster failed to start within timeout. Check logs for details.');
    process.exit(1);
  }
}

/**
 * Stop c8run process
 */
async function stopC8Run(config: C8RunConfig): Promise<void> {
  const pidFile = join(config.cacheDir, PID_MARKER_FILE);
  const versionFile = join(config.cacheDir, VERSION_MARKER_FILE);

  const markerExists = existsSync(pidFile) || existsSync(versionFile);
  const installedVersions = existsSync(config.cacheDir)
    ? readdirSync(config.cacheDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('c8run-'))
      .map((entry) => entry.name.slice('c8run-'.length))
      .sort()
    : [];

  if (!markerExists && installedVersions.length === 0) {
    logger.warn('No running c8run process found (use "start c8-cluster" to start one).');
    return;
  }

  const versionsToTry: string[] = [];

  if (existsSync(versionFile)) {
    const markerVersion = readFileSync(versionFile, 'utf-8').trim();
    if (markerVersion) {
      versionsToTry.push(markerVersion);
    }
  }

  // If we cannot determine the running version from markers (or markers are
  // missing due to an earlier failed stop), try all installed versions.
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
  let lastError: Error | undefined;

  for (const version of versionsToTry) {
    const versionConfig: C8RunConfig = { cacheDir: config.cacheDir, version };
    let binaryPath: string;
    try {
      binaryPath = getC8RunBinaryPath(versionConfig);
    } catch {
      continue;
    }

    attempted += 1;
    logger.debug(`Trying c8run stop with version ${version}...`);

    // c8run start exits after launching Java services, so its PID is no longer
    // alive by the time we call stop. Delegate to "c8run stop" for teardown.
    // We may need to run multiple versions here to recover from missing markers.
    const exitCode = await new Promise<number | null>((resolve, reject) => {
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
    throw new Error('Could not find an installed c8run binary to execute stop.');
  }

  if (!hadSuccessfulStop && lastError) {
    throw lastError;
  }

  logger.info('c8run stopped.');
}

/**
 * Print structured summary with endpoints and credentials
 */
function printSummary(rawOutput: string): void {
  const summary = extractStartupSummary(rawOutput);

  if (summary) {
    console.log(`\n${summary}\n`);
    return;
  }

  const fallbackOutput = rawOutput.trim();
  if (fallbackOutput) {
    console.log(`\n${fallbackOutput}\n`);
    return;
  }

  logger.warn('Cluster started, but no startup summary was captured from c8run output.');
}

// ============================================================================
// Command Handlers
// ============================================================================

export interface C8ClusterOptions {
  version?: string;
  force?: boolean;
  debug?: boolean;
}

/**
 * Start c8-cluster
 */
export async function startCluster(options: C8ClusterOptions = {}): Promise<void> {
  try {
    const versionSpec = options.version || 'stable';
    const version = await resolveVersion(versionSpec);

    const config: C8RunConfig = {
      cacheDir: getCacheDir(),
      version,
    };

    // Ensure c8run is installed
    await ensureC8RunInstalled(config);

    // Start c8run
    await startC8Run(config, options.debug ?? false);

  } catch (error) {
    logger.error(`Failed to start c8-cluster: ${error}`);
    process.exit(1);
  }
}

/**
 * Stop c8-cluster
 */
export async function stopCluster(options: C8ClusterOptions = {}): Promise<void> {
  try {
    const versionSpec = options.version || 'stable';
    const version = await resolveVersion(versionSpec);

    const config: C8RunConfig = {
      cacheDir: getCacheDir(),
      version,
    };

    await stopC8Run(config);

  } catch (error) {
    logger.error(`Failed to stop c8-cluster: ${error}`);
    process.exit(1);
  }
}
