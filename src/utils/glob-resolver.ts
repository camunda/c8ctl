/**
 * Glob resolver utility for BPMN files
 * Supports wildcards: * (current folder only) and ** (recursive)
 */

import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, basename, extname, dirname } from 'node:path';

export interface ResolvedFile {
  path: string;
  processId?: string;
}

/**
 * Check if a path pattern contains wildcards
 */
function hasWildcard(pattern: string): boolean {
  return pattern.includes('*');
}

/**
 * Resolve a single BPMN file path (no wildcards)
 */
function resolveSingleFile(path: string): ResolvedFile | null {
  const resolvedPath = resolve(path);
  
  if (!existsSync(resolvedPath)) {
    return null;
  }
  
  const stats = statSync(resolvedPath);
  if (!stats.isFile()) {
    return null;
  }
  
  const ext = extname(resolvedPath);
  if (ext !== '.bpmn') {
    return null;
  }
  
  return { path: resolvedPath };
}

/**
 * Recursively find BPMN files in a directory
 */
function findBpmnFilesRecursive(dirPath: string, recursive: boolean = false): ResolvedFile[] {
  const results: ResolvedFile[] = [];
  
  if (!existsSync(dirPath)) {
    return results;
  }
  
  const stats = statSync(dirPath);
  if (!stats.isDirectory()) {
    return results;
  }
  
  const entries = readdirSync(dirPath);
  
  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    const entryStat = statSync(fullPath);
    
    if (entryStat.isFile() && extname(entry) === '.bpmn') {
      results.push({ path: fullPath });
    } else if (entryStat.isDirectory() && recursive) {
      results.push(...findBpmnFilesRecursive(fullPath, true));
    }
  }
  
  return results;
}

/**
 * Resolve a glob pattern to BPMN files
 * Supports: *, **, or plain paths
 */
function resolveGlobPattern(pattern: string): ResolvedFile[] {
  const resolvedPattern = resolve(pattern);
  
  // Check for ** (recursive wildcard)
  if (pattern.includes('**')) {
    const basePath = resolvedPattern.replace(/\/?\*\*.*$/, '');
    return findBpmnFilesRecursive(basePath, true);
  }
  
  // Check for * (single-level wildcard)
  if (pattern.includes('*')) {
    const basePath = dirname(resolvedPattern);
    const filePattern = basename(resolvedPattern);
    
    if (!existsSync(basePath)) {
      return [];
    }
    
    const stats = statSync(basePath);
    if (!stats.isDirectory()) {
      return [];
    }
    
    // If pattern is just *, find all .bpmn files in directory (non-recursive)
    if (filePattern === '*' || filePattern === '*.bpmn') {
      return findBpmnFilesRecursive(basePath, false);
    }
    
    // Otherwise, match against the pattern
    const results: ResolvedFile[] = [];
    const entries = readdirSync(basePath);
    
    for (const entry of entries) {
      const fullPath = join(basePath, entry);
      const entryStat = statSync(fullPath);
      
      if (entryStat.isFile() && extname(entry) === '.bpmn') {
        // Simple wildcard matching
        const regex = new RegExp('^' + filePattern.replace(/\*/g, '.*') + '$');
        if (regex.test(entry)) {
          results.push({ path: fullPath });
        }
      }
    }
    
    return results;
  }
  
  // No wildcard - try as single file or directory
  const singleFile = resolveSingleFile(pattern);
  if (singleFile) {
    return [singleFile];
  }
  
  // Try as directory (non-recursive)
  return findBpmnFilesRecursive(resolvedPattern, false);
}

/**
 * Resolve one or more patterns to unique BPMN files
 * Deduplicates results by file path
 */
export function resolveBpmnFiles(patterns: string[]): ResolvedFile[] {
  const fileMap = new Map<string, ResolvedFile>();
  
  for (const pattern of patterns) {
    const resolved = resolveGlobPattern(pattern);
    for (const file of resolved) {
      fileMap.set(file.path, file);
    }
  }
  
  return Array.from(fileMap.values());
}

/**
 * Extract process ID from BPMN content
 */
export function extractProcessIdFromContent(content: string): string | null {
  const match = content.match(/process[^>]+id="([^"]+)"/);
  return match ? match[1] : null;
}
