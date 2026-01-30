/**
 * Deployment commands with building-block folder prioritization
 */

import { getLogger } from '../logger.ts';
import { createClient } from '../client.ts';
import { resolveTenantId } from '../config.ts';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, extname, basename } from 'node:path';

const RESOURCE_EXTENSIONS = ['.bpmn', '.dmn', '.form'];

/**
 * Extract process/decision IDs from BPMN/DMN files to detect duplicates
 */
function extractDefinitionId(content: Buffer, extension: string): string | null {
  const text = content.toString('utf-8');
  
  if (extension === '.bpmn') {
    // Extract bpmn:process id attribute
    const match = text.match(/<bpmn\d?:process[^>]+id="([^"]+)"/);
    return match ? match[1] : null;
  } else if (extension === '.dmn') {
    // Extract decision id attribute
    const match = text.match(/<decision[^>]+id="([^"]+)"/);
    return match ? match[1] : null;
  } else if (extension === '.form') {
    // Forms are identified by filename, not internal ID
    return null;
  }
  
  return null;
}

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
 * Find duplicate process/decision IDs across resources
 */
function findDuplicateDefinitionIds(resources: ResourceFile[]): Map<string, string[]> {
  const idMap = resources.reduce((map, r) => {
    const ext = extname(r.path);
    if (ext === '.bpmn' || ext === '.dmn') {
      const defId = extractDefinitionId(r.content, ext);
      if (defId) map.set(defId, [...(map.get(defId) ?? []), r.path]);
    }
    return map;
  }, new Map<string, string[]>());

  return new Map([...idMap].filter(([, paths]) => paths.length > 1));
}

/**
 * Deploy resources
 */
export async function deploy(paths: string[], options: {
  profile?: string;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const tenantId = resolveTenantId(options.profile);

  try {
    const resources: ResourceFile[] = [];

    if (paths.length === 0) {
      logger.error('No paths provided. Use: c8 deploy <path> or c8 deploy (for current directory)');
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

    // Validate for duplicate process/decision IDs
    const duplicates = findDuplicateDefinitionIds(resources);
    if (duplicates.size > 0) {
      logger.error('Cannot deploy: Multiple files with the same process/decision ID in one deployment');
      duplicates.forEach((paths, id) => console.error(`  Process/Decision ID "${id}" found in: ${paths.join(', ')}`));
      console.error('\nCamunda does not allow deploying multiple resources with the same definition ID in a single deployment.');
      console.error('Please deploy these files separately or ensure each process/decision has a unique ID.');
      process.exit(1);
    }

    logger.info(`Deploying ${resources.length} resource(s)...`);

    // Create deployment request - convert buffers to File objects with proper MIME types
    const result = await client.createDeployment({
      tenantId,
      resources: resources.map(r => {
        // Determine MIME type based on extension
        const ext = r.name.split('.').pop()?.toLowerCase();
        const mimeType = ext === 'bpmn' ? 'application/xml' :
                        ext === 'dmn' ? 'application/xml' :
                        ext === 'form' ? 'application/json' :
                        'application/octet-stream';
        // Convert Buffer to Uint8Array for File constructor
        return new File([new Uint8Array(r.content)], r.name, { type: mimeType });
      }),
    });
    
    logger.success('Deployment successful', result.deploymentKey.toString());
    
    // Display deployed resources
    const tableData: Array<{Type: string, ID: string, Version: string | number, Key: string}> = [];
    
    result.processes.forEach(proc => {
      tableData.push({
        Type: 'Process',
        ID: proc.processDefinitionId,
        Version: proc.processDefinitionVersion,
        Key: proc.processDefinitionKey.toString(),
      });
    });
    
    result.decisions.forEach(dec => {
      tableData.push({
        Type: 'Decision',
        ID: dec.decisionDefinitionId || '-',
        Version: dec.version ?? '-',
        Key: dec.decisionDefinitionKey?.toString() || '-',
      });
    });
    
    result.forms.forEach(form => {
      tableData.push({
        Type: 'Form',
        ID: form.formId || '-',
        Version: form.version ?? '-',
        Key: form.formKey?.toString() || '-',
      });
    });
    
    if (tableData.length > 0) {
      logger.table(tableData);
    }
  } catch (error) {
    // Log detailed error information
    if (error && typeof error === 'object') {
      const err = error as any;
      logger.error('Failed to deploy resources', error as Error);
      if (err.response) {
        console.error('API Response:', err.response);
      }
      if (err.message) {
        console.error('Error message:', err.message);
      }
      if (err.cause) {
        console.error('Error cause:', err.cause);
      }
    } else {
      logger.error('Failed to deploy resources', error as Error);
    }
    process.exit(1);
  }
}
