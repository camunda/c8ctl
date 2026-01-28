/**
 * Deployment commands with building-block folder prioritization
 */

import { getLogger } from '../logger.ts';
import { createClient } from '../client.ts';
import { resolveTenantId } from '../config.ts';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, extname, basename } from 'node:path';

const RESOURCE_EXTENSIONS = ['.bpmn', '.dmn', '.form'];

interface ResourceFile {
  path: string;
  name: string;
  content: Buffer;
  isBuildingBlock: boolean;
}

/**
 * Check if a path is a building block folder (contains _bb- in name)
 */
function isBuildingBlockFolder(path: string): boolean {
  return basename(path).includes('_bb-');
}

/**
 * Recursively collect resource files from a directory
 */
function collectResourceFiles(dirPath: string, collected: ResourceFile[] = []): ResourceFile[] {
  if (!existsSync(dirPath)) {
    return collected;
  }

  const stat = statSync(dirPath);
  
  if (stat.isFile()) {
    const ext = extname(dirPath);
    if (RESOURCE_EXTENSIONS.includes(ext)) {
      const parentDir = dirname(dirPath);
      collected.push({
        path: dirPath,
        name: basename(dirPath),
        content: readFileSync(dirPath),
        isBuildingBlock: isBuildingBlockFolder(parentDir),
      });
    }
    return collected;
  }

  if (stat.isDirectory()) {
    const entries = readdirSync(dirPath);
    
    // Separate building block folders from regular ones
    const bbFolders: string[] = [];
    const regularFolders: string[] = [];
    const files: string[] = [];

    entries.forEach(entry => {
      const fullPath = join(dirPath, entry);
      const entryStat = statSync(fullPath);
      
      if (entryStat.isDirectory()) {
        if (isBuildingBlockFolder(entry)) {
          bbFolders.push(fullPath);
        } else {
          regularFolders.push(fullPath);
        }
      } else if (entryStat.isFile()) {
        files.push(fullPath);
      }
    });

    // Process files in current directory first
    files.forEach(file => {
      const ext = extname(file);
      if (RESOURCE_EXTENSIONS.includes(ext)) {
        collected.push({
          path: file,
          name: basename(file),
          content: readFileSync(file),
          isBuildingBlock: isBuildingBlockFolder(dirPath),
        });
      }
    });

    // Process building block folders first (prioritized)
    bbFolders.forEach(bbFolder => {
      collectResourceFiles(bbFolder, collected);
    });

    // Then process regular folders
    regularFolders.forEach(regularFolder => {
      collectResourceFiles(regularFolder, collected);
    });
  }

  return collected;
}

/**
 * Deploy resources
 */
export async function deploy(paths: string[], options: {
  profile?: string;
  all?: boolean;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const tenantId = resolveTenantId(options.profile);

  try {
    const resources: ResourceFile[] = [];

    if (paths.length === 0) {
      logger.error('No paths provided. Use: c8 deploy <path> or c8 deploy --all');
      process.exit(1);
    }

    // Collect all resource files
    paths.forEach(path => {
      collectResourceFiles(path, resources);
    });

    if (resources.length === 0) {
      logger.error('No BPMN/DMN/Form files found in the specified paths');
      process.exit(1);
    }

    // Sort: building blocks first, then by path
    resources.sort((a, b) => {
      if (a.isBuildingBlock && !b.isBuildingBlock) return -1;
      if (!a.isBuildingBlock && b.isBuildingBlock) return 1;
      return a.path.localeCompare(b.path);
    });

    logger.info(`Deploying ${resources.length} resource(s)...`);

    // Create deployment request
    const deploymentRequest: any = {
      tenantId,
      resources: resources.map(r => ({
        name: r.name,
        content: r.content,
      })),
    };

    const result = await client.deployResources(deploymentRequest);
    
    logger.success('Deployment successful', result.key);
    
    if (result.deployments && result.deployments.length > 0) {
      const tableData = result.deployments.map((dep: any) => ({
        Type: dep.resourceType || dep.type,
        'Process ID': dep.bpmnProcessId || dep.processDefinition?.bpmnProcessId || dep.resourceName,
        Version: dep.version || dep.processDefinition?.version || '-',
        Key: dep.key || dep.processDefinition?.processDefinitionKey || '-',
      }));
      logger.table(tableData);
    }
  } catch (error) {
    logger.error('Failed to deploy resources', error as Error);
    process.exit(1);
  }
}
