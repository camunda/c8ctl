/**
 * Watch command - monitor files for changes and auto-deploy
 */

import { watch } from 'node:fs';
import { resolve, extname, basename } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { getLogger } from '../logger.ts';
import { deploy } from './deployments.ts';

const WATCHED_EXTENSIONS = ['.bpmn', '.dmn', '.form'];

/**
 * Watch for file changes and auto-deploy
 */
export async function watchFiles(paths: string[], options: {
  profile?: string;
}): Promise<void> {
  const logger = getLogger();
  
  if (!paths || paths.length === 0) {
    paths = ['.'];
  }

  // Resolve all paths
  const resolvedPaths = paths.map(p => resolve(p));
  
  // Validate paths exist
  for (const path of resolvedPaths) {
    if (!existsSync(path)) {
      logger.error(`Path does not exist: ${path}`);
      process.exit(1);
    }
  }

  logger.info(`👁️  Watching for changes in: ${resolvedPaths.join(', ')}`);
  logger.info(`📋 Monitoring extensions: ${WATCHED_EXTENSIONS.join(', ')}`);
  logger.info('Press Ctrl+C to stop watching\n');

  // Keep track of recently deployed files to avoid duplicate deploys
  const recentlyDeployed = new Map<string, number>();
  const DEPLOY_COOLDOWN = 1000; // 1 second cooldown

  // Watch each path
  for (const path of resolvedPaths) {
    const stats = statSync(path);
    const isDirectory = stats.isDirectory();

    const watcher = watch(path, { recursive: isDirectory }, async (eventType, filename) => {
      if (!filename) return;

      const ext = extname(filename);
      if (!WATCHED_EXTENSIONS.includes(ext)) {
        return;
      }

      const fullPath = isDirectory ? resolve(path, filename) : path;
      
      // Check cooldown to prevent duplicate deploys
      const lastDeploy = recentlyDeployed.get(fullPath);
      const now = Date.now();
      if (lastDeploy && (now - lastDeploy) < DEPLOY_COOLDOWN) {
        return;
      }

      // Check if file still exists (might have been deleted)
      if (!existsSync(fullPath)) {
        logger.info(`⚠️  File deleted, skipping: ${basename(filename)}`);
        return;
      }

      logger.info(`\n🔄 Change detected: ${basename(filename)}`);
      recentlyDeployed.set(fullPath, now);

      try {
        await deploy([fullPath], { profile: options.profile });
      } catch (error) {
        logger.error(`Failed to deploy ${basename(filename)}`, error as Error);
      }
    });

    // Handle watcher errors
    watcher.on('error', (error) => {
      logger.error('Watcher error', error);
    });
  }

  // Keep process alive
  process.on('SIGINT', () => {
    logger.info('\n\n🍹 - bottoms up.');
    process.exit(0);
  });
}
