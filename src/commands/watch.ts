/**
 * Watch command - monitor files for changes and auto-deploy
 */

import { watch } from 'node:fs';
import { resolve, extname, basename } from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { getLogger } from '../logger.ts';
import { deploy } from './deployments.ts';
import { createClient } from '../client.ts';
import { resolveTenantId } from '../config.ts';
import { resolveBpmnFiles } from '../utils/glob-resolver.ts';
import { extractProcessId } from './run.ts';

const WATCHED_EXTENSIONS = ['.bpmn', '.dmn', '.form'];

export interface RunSpec {
  patterns: string[];
  variables?: Record<string, any>;
}

/**
 * Create process instances for specified BPMN files
 */
async function createProcessInstances(runSpecs: RunSpec[], profile?: string): Promise<void> {
  const logger = getLogger();
  const client = createClient(profile);
  const tenantId = resolveTenantId(profile);
  
  for (const spec of runSpecs) {
    // Resolve patterns to actual BPMN files
    const bpmnFiles = resolveBpmnFiles(spec.patterns);
    
    if (bpmnFiles.length === 0) {
      logger.info(`⚠️  No BPMN files found for patterns: ${spec.patterns.join(', ')}`);
      continue;
    }
    
    // Log files if multiple were found
    if (bpmnFiles.length > 1) {
      logger.info(`📋 Found ${bpmnFiles.length} BPMN file(s):`);
      bpmnFiles.forEach(f => logger.info(`   - ${basename(f.path)}`));
    }
    
    // Create process instances for each BPMN file
    for (const bpmnFile of bpmnFiles) {
      try {
        // Read BPMN content to extract process ID
        const content = readFileSync(bpmnFile.path, 'utf-8');
        const processId = extractProcessId(content);
        
        if (!processId) {
          logger.error(`Could not extract process ID from ${basename(bpmnFile.path)}`);
          continue;
        }
        
        // Create process instance request
        const request = {
          processDefinitionId: processId as any,
          tenantId,
          variables: spec.variables,
        };
        
        const result = await client.createProcessInstance(request as any);
        logger.success(
          `Process instance created for ${basename(bpmnFile.path)}`,
          result.processInstanceKey
        );
      } catch (error) {
        logger.error(`Failed to create process instance for ${basename(bpmnFile.path)}`, error as Error);
      }
    }
  }
}

/**
 * Watch for file changes and auto-deploy
 */
export async function watchFiles(paths: string[], options: {
  profile?: string;
  runSpecs?: RunSpec[];
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
  
  if (options.runSpecs && options.runSpecs.length > 0) {
    logger.info(`🚀 Will create process instances after changes detected`);
  }
  
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
        
        // If --run flags are specified, create process instances after deployment
        if (options.runSpecs && options.runSpecs.length > 0) {
          logger.info('🚀 Creating process instances...');
          // Add small delay to ensure deployment is fully processed
          await new Promise(resolve => setTimeout(resolve, 500));
          await createProcessInstances(options.runSpecs, options.profile);
        }
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
