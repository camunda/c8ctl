/**
 * c8-cluster command - Manage local Camunda 8 cluster (c8run)
 *
 * Provides an opinionated way to download, start, and stop c8run for local development.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { chmod, readFile } from 'node:fs/promises';
import { homedir, platform as osPlatform, arch as osArch } from 'node:os';
import { join, basename } from 'node:path';
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
function getPlatformIdentifier(): { platform: string; extension: string; executable: string } {
  const platform = osPlatform();
  const arch = osArch();

  if (platform === 'darwin') {
    return {
      platform: 'macos',
      extension: 'tar.gz',
      executable: 'c8run',
    };
  } else if (platform === 'linux') {
    return {
      platform: 'linux',
      extension: 'tar.gz',
      executable: 'c8run',
    };
  } else if (platform === 'win32') {
    // Only WSL is supported, not native Windows
    logger.warn('Native Windows is not supported. Please use WSL (Windows Subsystem for Linux).');
    return {
      platform: 'linux',
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
  // Format: https://downloads.camunda.cloud/release/camunda/c8run/8.8/camunda-c8run-8.8.0-macos.tar.gz
  const downloadUrl = `https://downloads.camunda.cloud/release/camunda/c8run/${version}/camunda-c8run-${version}.0-${platformInfo.platform}.${platformInfo.extension}`;

  logger.info(`Downloading Camunda ${version} for ${platformInfo.platform}...`);
  logger.debug(`URL: ${downloadUrl}`);

  // Create cache directory
  const cacheDir = config.cacheDir;
  mkdirSync(cacheDir, { recursive: true });

  const targetFile = join(cacheDir, `c8run-${version}-${platformInfo.platform}.${platformInfo.extension}`);

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

  // Use tar to extract
  const platform = osPlatform();
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
}

/**
 * Check if c8run is already installed
 */
function isC8RunInstalled(config: C8RunConfig): boolean {
  const installDir = join(config.cacheDir, `c8run-${config.version}`);
  const platformInfo = getPlatformIdentifier();
  const binaryPath = join(installDir, platformInfo.executable);
  return existsSync(binaryPath);
}

/**
 * Get path to c8run binary
 */
function getC8RunBinaryPath(config: C8RunConfig): string {
  const installDir = join(config.cacheDir, `c8run-${config.version}`);
  const platformInfo = getPlatformIdentifier();
  return join(installDir, platformInfo.executable);
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

/**
 * Start c8run process
 */
async function startC8Run(config: C8RunConfig): Promise<void> {
  const binaryPath = getC8RunBinaryPath(config);

  if (!existsSync(binaryPath)) {
    throw new Error(`c8run binary not found at ${binaryPath}`);
  }

  logger.info('Starting Camunda 8 local cluster...');

  // Start the process
  const proc = spawn(binaryPath, ['start'], {
    stdio: 'inherit',
    detached: false,
  });

  runningProcess = {
    process: proc,
    pid: proc.pid!,
  };

  // Save PID for stop command
  const pidFile = join(config.cacheDir, 'c8run.pid');
  writeFileSync(pidFile, proc.pid!.toString());

  // Wait for startup (simplified - in reality we'd check health endpoints)
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Print summary
  printSummary();

  // Handle process exit
  proc.on('exit', (code, signal) => {
    logger.info(`c8run process exited with code ${code}, signal ${signal}`);
    runningProcess = null;

    // Clean up PID file
    if (existsSync(pidFile)) {
      rmSync(pidFile);
    }
  });

  // Handle signals for graceful shutdown
  process.on('SIGINT', () => stopC8Run(config));
  process.on('SIGTERM', () => stopC8Run(config));

  // Keep process running
  await new Promise(() => {}); // Never resolves, keeps process alive
}

/**
 * Stop c8run process
 */
async function stopC8Run(config: C8RunConfig): Promise<void> {
  const pidFile = join(config.cacheDir, 'c8run.pid');

  if (runningProcess) {
    logger.info('Stopping c8run process...');
    runningProcess.process.kill('SIGTERM');
    runningProcess = null;

    // Clean up PID file
    if (existsSync(pidFile)) {
      rmSync(pidFile);
    }

    logger.info('c8run stopped.');
    process.exit(0);
  } else if (existsSync(pidFile)) {
    // Process was started in a different session
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim());
    logger.info(`Stopping c8run process (PID: ${pid})...`);

    try {
      process.kill(pid, 'SIGTERM');
      rmSync(pidFile);
      logger.info('c8run stopped.');
    } catch (error) {
      logger.error(`Failed to stop process: ${error}`);
      process.exit(1);
    }
  } else {
    logger.warn('No running c8run process found.');
  }
}

/**
 * Print structured summary with endpoints and credentials
 */
function printSummary(): void {
  const lines = [
    '+---------------------------------------------------------------+',
    '| Camunda 8 is running locally                                  |',
    '|                                                               |',
    '| Operate   -> http://localhost:8080                            |',
    '| Tasklist  -> http://localhost:8080                            |',
    '| Zeebe gRPC-> localhost:26500                                  |',
    '| REST API  -> http://localhost:8080                            |',
    '| Login     -> demo / demo                                      |',
    '+---------------------------------------------------------------+',
  ];

  console.log('\n' + lines.join('\n') + '\n');

  // Suggest next steps
  logger.info('Next steps:');
  logger.info('  • Deploy a process: c8 deploy <file.bpmn>');
  logger.info('  • List processes: c8 list pd');
  logger.info('  • Start an instance: c8 create pi --bpmnProcessId <processId>');
}

// ============================================================================
// Command Handlers
// ============================================================================

export interface C8ClusterOptions {
  version?: string;
  force?: boolean;
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
    await startC8Run(config);

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
