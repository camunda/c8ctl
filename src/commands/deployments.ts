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
function extractDefinitionId(content: Uint8Array, extension: string): string | null {
  const text = new TextDecoder('utf-8').decode(content);
  
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
  content: Uint8Array;
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
  const resources: ResourceFile[] = [];

  try {
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
        // Normalize bytes type for TS (avoid Uint8Array<ArrayBufferLike> vs BlobPart mismatch)
        const bytes = new Uint8Array(r.content);
        return new File([bytes], r.name, { type: mimeType });
      }),
    });
    
    logger.success('Deployment successful', result.deploymentKey.toString());
    
    // Group resources by their directory (building block or process application)
    type ResourceRow = {File: string, Type: string, ID: string, Version: string | number, Key: string, sortKey: string};
    
    // Normalize all deployed resources into a common structure
    const allResources = [
      ...result.processes.map(proc => ({
        type: 'Process' as const,
        id: proc.processDefinitionId,
        version: proc.processDefinitionVersion,
        key: proc.processDefinitionKey.toString(),
        resource: definitionIdToResource.get(proc.processDefinitionId),
      })),
      ...result.decisions.map(dec => ({
        type: 'Decision' as const,
        id: dec.decisionDefinitionId || '-',
        version: dec.version ?? '-',
        key: dec.decisionDefinitionKey?.toString() || '-',
        resource: definitionIdToResource.get(dec.decisionDefinitionId || ''),
      })),
      ...result.forms.map(form => ({
        type: 'Form' as const,
        id: form.formId || '-',
        version: form.version ?? '-',
        key: form.formKey?.toString() || '-',
        resource: formNameToResource.get(form.formId || ''),
      })),
    ];
    
    const tableData: ResourceRow[] = allResources.map(({type, id, version, key, resource}) => {
      const fileDisplay = resource 
        ? `${resource.isBuildingBlock ? '🧱 ' : ''}${resource.isProcessApplication ? '📦 ' : ''}${resource.relativePath || resource.name}`
        : '-';
      
      // Extract directory path for grouping (e.g., "bla/_bb-building-block" or "pa")
      const sortKey = resource?.relativePath 
        ? resource.relativePath.substring(0, resource.relativePath.lastIndexOf('/') + 1) || resource.relativePath
        : 'zzz'; // Resources without paths go last
      
      return {
        File: fileDisplay,
        Type: type,
        ID: id,
        Version: version,
        Key: key,
        sortKey,
      };
    });
    
    // Sort by directory path (grouping), then by file name
    tableData.sort((a, b) => {
      if (a.sortKey !== b.sortKey) {
        return a.sortKey.localeCompare(b.sortKey);
      }
      return a.File.localeCompare(b.File);
    });
    
    // Remove sortKey before displaying
    const displayData = tableData.map(({File, Type, ID, Version, Key}) => ({File, Type, ID, Version, Key}));
    
    if (displayData.length > 0) {
      logger.table(displayData);
    }
  } catch (error) {
    handleDeploymentError(error, resources, logger);
  }
}

/**
 * Format and display deployment errors with actionable guidance
 */
function handleDeploymentError(error: unknown, resources: ResourceFile[], logger: ReturnType<typeof getLogger>): never {
  const raw = (error && typeof error === 'object') ? (error as Record<string, unknown>) : {};

  // Try to interpret common transport/network issues first for actionable guidance
  const deriveNetworkErrorTitle = (err: unknown): string | undefined => {
    const anyErr = err as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    const code = typeof anyErr?.code === 'string'
      ? anyErr.code
      : (typeof (anyErr?.cause as Record<string, unknown> | undefined)?.code === 'string'
          ? ((anyErr.cause as Record<string, unknown>).code as string)
          : undefined);

    if (!code && typeof anyErr?.name === 'string') {
      // Handle fetch/abort style errors
      if (anyErr.name === 'AbortError') {
        return 'Request to Camunda cluster timed out or was aborted. Please check your network connection and try again.';
      }
    }

    switch (code) {
      case 'ECONNREFUSED':
        return 'Cannot connect to Camunda cluster (connection refused). Verify the endpoint URL and that the cluster is reachable.';
      case 'ENOTFOUND':
        return 'Cannot resolve Camunda cluster host. Check the cluster URL and your DNS/network configuration.';
      case 'EHOSTUNREACH':
        return 'Camunda cluster host is unreachable. Check VPN/proxy settings and your network connectivity.';
      case 'ECONNRESET':
        return 'Connection to Camunda cluster was reset. Retry the operation and check for intermittent network issues.';
      case 'ETIMEDOUT':
        return 'Request to Camunda cluster timed out. Check your network connection and consider retrying.';
      default:
        return undefined;
    }
  };

  // Extract RFC 9457 Problem Detail fields and other useful signals
  const problemTitle = typeof raw.title === 'string' ? (raw.title as string) : undefined;
  const networkTitle = deriveNetworkErrorTitle(error);
  const errorInstanceTitle =
    error instanceof Error && typeof error.message === 'string' && error.message
      ? error.message
      : undefined;
  const messageFieldTitle = typeof raw.message === 'string' ? (raw.message as string) : undefined;
  const title =
    problemTitle ??
    networkTitle ??
    errorInstanceTitle ??
    messageFieldTitle ??
    'Unknown error (unexpected error format; re-run with increased logging or check network configuration).';

  const detail = typeof raw.detail === 'string' ? (raw.detail as string) : undefined;
  const status = typeof raw.status === 'number' ? (raw.status as number) : undefined;

  // Display the main error
  logger.error('Deployment failed', new Error(title));

  // Display the detailed error message if available
  if (detail) {
    console.error('\n' + formatDeploymentErrorDetail(detail));
  }

  // Provide actionable hints based on error type
  console.error('');
  printDeploymentHints(title, detail, status, resources);
  process.exit(1);
}

/**
 * Format the error detail for better readability
 */
function formatDeploymentErrorDetail(detail: string): string {
  // The detail often contains embedded newlines, format them nicely
  const lines = detail.split('\n').map(line => line.trim()).filter(Boolean);
  
  // Find the main message and the file-specific errors
  const result: string[] = [];
  let inFileError = false;
  
  for (const line of lines) {
    if (line.startsWith("'") && (line.includes('.bpmn') || line.includes('.dmn') || line.includes('.form'))) {
      // This is a file-specific error
      inFileError = true;
      result.push(`  📄 ${line}`);
    } else if (line.startsWith('- Element:')) {
      result.push(`     ${line}`);
    } else if (line.startsWith('- ERROR:') || line.startsWith('- WARNING:')) {
      const icon = line.startsWith('- ERROR:') ? '❌' : '⚠️';
      result.push(`     ${icon} ${line.substring(2)}`);
    } else if (inFileError && line.startsWith('-')) {
      result.push(`     ${line}`);
    } else {
      result.push(`  ${line}`);
    }
  }
  
  return result.join('\n');
}

/**
 * Print actionable hints based on the error type
 */
function printDeploymentHints(title: string, detail: string | undefined, status: number | undefined, resources: ResourceFile[]): void {
  const hints: string[] = [];
  
  if (title === 'INVALID_ARGUMENT') {
    if (detail?.includes('Must reference a message')) {
      hints.push('💡 A message start event or intermediate catch event is missing a message reference.');
      hints.push('   Open the BPMN file in Camunda Modeler and configure the message name.');
    }
    if (detail?.includes('duplicate')) {
      hints.push('💡 Resource IDs must be unique within a deployment.');
      hints.push('   Check for duplicate process/decision IDs in your files.');
    }
    if (detail?.includes('parsing') || detail?.includes('syntax')) {
      hints.push('💡 The resource file contains syntax errors.');
      hints.push('   Validate the file in Camunda Modeler or check the XML/JSON structure.');
    }
  } else if (title === 'RESOURCE_EXHAUSTED') {
    hints.push('💡 The server is under heavy load (backpressure).');
    hints.push('   Wait a moment and retry the deployment.');
  } else if (title === 'NOT_FOUND' || status === 404) {
    hints.push('💡 The Camunda server could not be reached or the endpoint was not found.');
    hints.push('   Check your connection settings with: c8 list profiles');
  } else if (title === 'UNAUTHENTICATED' || title === 'PERMISSION_DENIED' || status === 401 || status === 403) {
    hints.push('💡 Authentication or authorization failed.');
    hints.push('   Check your credentials and permissions for the current profile.');
  } else {
    hints.push('💡 Review the error message above for specific issues.');
    hints.push('   You may need to fix the resource files before deploying.');
  }
  
  // Show which files were being deployed
  if (resources.length > 0) {
    hints.push('');
    hints.push(`📁 Resources attempted (${resources.length}):`);
    resources.slice(0, 5).forEach(r => {
      hints.push(`   - ${r.relativePath || r.name}`);
    });
    if (resources.length > 5) {
      hints.push(`   ... and ${resources.length - 5} more`);
    }
  }
  
  hints.forEach(h => console.error(h));
}
