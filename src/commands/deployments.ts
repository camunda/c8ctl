/**
 * Deployment commands with building-block folder prioritization
 */

import { getLogger } from '../logger.ts';
import { createClient } from '../client.ts';
import { resolveTenantId } from '../config.ts';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, extname, basename, relative } from 'node:path';

const RESOURCE_EXTENSIONS = ['.bpmn', '.dmn', '.form'];
const PROCESS_APPLICATION_FILE = '.process-application';

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
  isProcessApplication: boolean;
  groupPath?: string; // Path to the root of the group (BB or PA folder)
  relativePath?: string;
}

/**
 * Check if a path is a building block folder (contains _bb- in name)
 */
function isBuildingBlockFolder(path: string): boolean {
  return basename(path).includes('_bb-');
}

/**
 * Check if a directory contains a .process-application file
 */
function hasProcessApplicationFile(dirPath: string): boolean {
  const paFilePath = join(dirPath, PROCESS_APPLICATION_FILE);
  return existsSync(paFilePath);
}

/**
 * Find the root building block or process application folder by traversing up the path
 * Returns the path to the group root, or null if not in a group
 */
function findGroupRoot(filePath: string, basePath: string): { type: 'bb', root: string } | { type: 'pa', root: string } | { type: null, root: null } {
  let currentDir = dirname(filePath);
  
  // Traverse up the directory tree until we reach or go outside basePath
  while (true) {
    // Check if we've gone outside the basePath
    const rel = relative(basePath, currentDir);
    if (rel.startsWith('..') || rel === '') {
      break;
    }
    
    // Check if this directory is a building block
    if (isBuildingBlockFolder(currentDir)) {
      return { type: 'bb', root: currentDir };
    }
    
    // Check if this directory has a .process-application file
    if (hasProcessApplicationFile(currentDir)) {
      return { type: 'pa', root: currentDir };
    }
    
    // Move up one level
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) break; // Reached filesystem root
    currentDir = parentDir;
  }
  
  return { type: null, root: null };
}

/**
 * Recursively collect resource files from a directory
 */
function collectResourceFiles(dirPath: string, collected: ResourceFile[] = [], basePath?: string): ResourceFile[] {
  if (!existsSync(dirPath)) {
    return collected;
  }

  // Set basePath to dirPath on first call
  if (!basePath) {
    basePath = dirPath;
  }

  const stat = statSync(dirPath);
  
  if (stat.isFile()) {
    const ext = extname(dirPath);
    if (RESOURCE_EXTENSIONS.includes(ext)) {
      const groupInfo = findGroupRoot(dirPath, basePath);
      collected.push({
        path: dirPath,
        name: basename(dirPath),
        content: readFileSync(dirPath),
        isBuildingBlock: groupInfo.type === 'bb',
        isProcessApplication: groupInfo.type === 'pa',
        groupPath: groupInfo.root || undefined,
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
        const groupInfo = findGroupRoot(file, basePath);
        collected.push({
          path: file,
          name: basename(file),
          content: readFileSync(file),
          isBuildingBlock: groupInfo.type === 'bb',
          isProcessApplication: groupInfo.type === 'pa',
          groupPath: groupInfo.root || undefined,
        });
      }
    });

    // Process building block folders first (prioritized)
    bbFolders.forEach(bbFolder => {
      collectResourceFiles(bbFolder, collected, basePath);
    });

    // Then process regular folders
    regularFolders.forEach(regularFolder => {
      collectResourceFiles(regularFolder, collected, basePath);
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
    
    // Store the base paths for relative path calculation
    const basePaths = paths.length === 0 ? [process.cwd()] : paths;

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

    // Calculate relative paths for display
    const basePath = basePaths.length === 1 ? basePaths[0] : process.cwd();
    resources.forEach(r => {
      r.relativePath = relative(basePath, r.path) || r.name;
    });

    // Sort: group resources by their group, with building blocks first, then process applications, then standalone
    resources.sort((a, b) => {
      // Building blocks have highest priority
      if (a.isBuildingBlock && !b.isBuildingBlock) return -1;
      if (!a.isBuildingBlock && b.isBuildingBlock) return 1;
      
      // Within building blocks, group by groupPath
      if (a.isBuildingBlock && b.isBuildingBlock) {
        if (a.groupPath && b.groupPath) {
          const groupCompare = a.groupPath.localeCompare(b.groupPath);
          if (groupCompare !== 0) return groupCompare;
        }
        return a.path.localeCompare(b.path);
      }
      
      // Process applications come next
      if (a.isProcessApplication && !b.isProcessApplication) return -1;
      if (!a.isProcessApplication && b.isProcessApplication) return 1;
      
      // Within process applications, group by groupPath
      if (a.isProcessApplication && b.isProcessApplication) {
        if (a.groupPath && b.groupPath) {
          const groupCompare = a.groupPath.localeCompare(b.groupPath);
          if (groupCompare !== 0) return groupCompare;
        }
        return a.path.localeCompare(b.path);
      }
      
      // Finally, standalone resources sorted by path
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

    // Create a mapping from definition ID to resource file for later reference
    const definitionIdToResource = new Map<string, ResourceFile>();
    const formNameToResource = new Map<string, ResourceFile>();
    
    resources.forEach(r => {
      const ext = extname(r.path);
      if (ext === '.bpmn' || ext === '.dmn') {
        const defId = extractDefinitionId(r.content, ext);
        if (defId) {
          definitionIdToResource.set(defId, r);
        }
      } else if (ext === '.form') {
        // Forms are matched by filename (without extension)
        const formId = basename(r.name, '.form');
        formNameToResource.set(formId, r);
      }
    });

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
    
    // Display deployed resources with file information
    const tableData: Array<{File: string, Type: string, ID: string, Version: string | number, Key: string}> = [];
    
    result.processes.forEach(proc => {
      const resource = definitionIdToResource.get(proc.processDefinitionId);
      const fileDisplay = resource 
        ? `${resource.isBuildingBlock ? '🧱 ' : ''}${resource.isProcessApplication ? '📦 ' : ''}${resource.relativePath || resource.name}`
        : '-';
      
      tableData.push({
        File: fileDisplay,
        Type: 'Process',
        ID: proc.processDefinitionId,
        Version: proc.processDefinitionVersion,
        Key: proc.processDefinitionKey.toString(),
      });
    });
    
    result.decisions.forEach(dec => {
      const resource = definitionIdToResource.get(dec.decisionDefinitionId || '');
      const fileDisplay = resource 
        ? `${resource.isBuildingBlock ? '🧱 ' : ''}${resource.isProcessApplication ? '📦 ' : ''}${resource.relativePath || resource.name}`
        : '-';
      
      tableData.push({
        File: fileDisplay,
        Type: 'Decision',
        ID: dec.decisionDefinitionId || '-',
        Version: dec.version ?? '-',
        Key: dec.decisionDefinitionKey?.toString() || '-',
      });
    });
    
    result.forms.forEach(form => {
      const resource = formNameToResource.get(form.formId || '');
      const fileDisplay = resource 
        ? `${resource.isBuildingBlock ? '🧱 ' : ''}${resource.isProcessApplication ? '📦 ' : ''}${resource.relativePath || resource.name}`
        : '-';
      
      tableData.push({
        File: fileDisplay,
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
