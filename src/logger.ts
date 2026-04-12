/**
 * Logger component for c8ctl CLI
 * Handles output in multiple modes (text, json) based on session state
 */

import { c8ctl } from './runtime.ts';

export type OutputMode = 'text' | 'json';

/**
 * Filter a single object to only include the specified fields.
 * Field matching is case-insensitive.
 */
function filterObjectFields(obj: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const lowerFields = fields.map(f => f.toLowerCase());
  return Object.fromEntries(
    Object.entries(obj).filter(([key]) => lowerFields.includes(key.toLowerCase()))
  );
}

/**
 * Apply --fields filtering to arbitrary data.
 * - Array: filter each element's keys
 * - Object: filter object keys
 * - Primitive: return as-is
 */
function filterFields(data: any, fields: string[]): any {
  if (Array.isArray(data)) {
    return data.map(item =>
      item && typeof item === 'object' ? filterObjectFields(item as Record<string, unknown>, fields) : item
    );
  }
  if (data && typeof data === 'object') {
    return filterObjectFields(data as Record<string, unknown>, fields);
  }
  return data;
}

export type LogWriter = {
  log(...data: any[]): void;
  error(...data: any[]): void;
};

/**
 * Detect if an error is a connection/network failure when using the local cluster,
 * and return an actionable hint for the user if so.
 */
function getLocalClusterHint(error?: Error): string | undefined {
  if (!error) return undefined;

  // Only emit the hint when the active profile is 'local' (the default) or not set
  // and no CAMUNDA_* env vars are configured (env vars point elsewhere)
  if (c8ctl.activeProfile !== undefined && c8ctl.activeProfile !== 'local') return undefined;
  if (!c8ctl.activeProfile && process.env.CAMUNDA_BASE_URL) return undefined;

  const isConnectionError = isNetworkError(error);
  if (!isConnectionError) return undefined;

  return 'Hint: Is the local cluster running? Start it with: c8ctl start c8-cluster';
}

/**
 * Return true when the error indicates that a TCP connection could not be established.
 */
function isNetworkError(error: Error): boolean {
  const message = error.message || '';
  // Node.js native fetch surfaces this when the TCP connection is refused
  if (message.toLowerCase().includes('fetch failed')) return true;

  const anyErr = error as unknown as { code?: string; cause?: { code?: string } };
  const code = anyErr.code ?? anyErr.cause?.code;
  if (code) {
    return ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT'].includes(code);
  }
  // Fetch abort (timeout) is also a connectivity issue
  if (error.name === 'AbortError') return true;

  return false;
}

const defaultLogWriter: LogWriter = {
  log(...data: any[]): void {
    console.log(...data); // lgtm[js/clear-text-logging]
  },
  error(...data: any[]): void {
    console.error(...data); // lgtm[js/clear-text-logging]
  },
};

export class Logger {
  private _debugEnabled: boolean = false;
  private _logWriter: LogWriter;

  constructor(logWriter: LogWriter = defaultLogWriter) {
    this._logWriter = logWriter;

    // Enable debug mode if DEBUG or C8CTL_DEBUG env var is set
    this._debugEnabled = process.env.DEBUG === '1' || 
                         process.env.DEBUG === 'true' || 
                         process.env.C8CTL_DEBUG === '1' ||
                         process.env.C8CTL_DEBUG === 'true';
  }

  get mode(): OutputMode {
    // Always get the mode from c8ctl runtime to ensure it reflects current session state
    return c8ctl.outputMode;
  }

  set mode(mode: OutputMode) {
    // Update the c8ctl runtime when mode is set directly on logger
    c8ctl.outputMode = mode;
  }

  get debugEnabled(): boolean {
    return this._debugEnabled;
  }

  set debugEnabled(enabled: boolean) {
    this._debugEnabled = enabled;
  }

  private _writeLog(...data: any[]): void {
    this._logWriter.log(...data);
  }

  private _writeError(...data: any[]): void {
    this._logWriter.error(...data);
  }

  info(message: string): void {
    if (this.mode === 'text') {
      this._writeLog(message);
    } else {
    
      // unix convention suggest: info and warning messages should go to stderr, while only the main output goes to stdout
      this._writeError(JSON.stringify({ status: 'info', message }));
    }
  }

  warn(message: string): void {
    if (this.mode === 'text') {
      this._writeError(`⚠ ${message}`);
    } else {
      this._writeError(JSON.stringify({ status: 'warning', message }));
    }
  }

  debug(message: string, ...args: any[]): void {
    if (this._debugEnabled) {
      if (this.mode === 'text') {
        const timestamp = new Date().toISOString();
        this._writeError(`[DEBUG ${timestamp}] ${message}`, ...args);
      } else {
        this._writeError(JSON.stringify({
          level: 'debug',
          message,
          timestamp: new Date().toISOString(),
          args
        }));
      }
    }
  }

  success(message: string, key?: string | number): void {
    if (this.mode === 'text') {
      if (key !== undefined) {
        this._writeLog(`✓ ${message} [Key: ${key}]`);
      } else {
        this._writeLog(`✓ ${message}`);
      }
    } else {
      if (key !== undefined) {
        this._writeError(JSON.stringify({ status: 'success', message, key }));
      } else {
        this._writeError(JSON.stringify({ status: 'success', message }));
      }
    }
  }

  error(message: string, error?: Error): void {
    if (this.mode === 'text') {
      this._writeError(`✗ ${message}`);
      if (error) {
        const urlInfo = isNetworkError(error) && c8ctl.resolvedBaseUrl
          ? ` (${c8ctl.resolvedBaseUrl})`
          : '';
        this._writeError(`  ${error.message}${urlInfo}`);
      }
      const hint = getLocalClusterHint(error);
      if (hint) {
        this._writeError(`  ${hint}`);
      }
    } else {
      const output: any = { status: 'error', message };
      if (error) {
        output.error = error.message;
        if (isNetworkError(error) && c8ctl.resolvedBaseUrl) {
          output.url = c8ctl.resolvedBaseUrl;
        }
        if (error.stack) {
          output.stack = error.stack;
        }
      }
      const hint = getLocalClusterHint(error);
      if (hint) {
        output.hint = hint;
      }
      this._writeError(JSON.stringify(output));
    }
  }

  table(data: any[]): void {
    const fields = c8ctl.fields;
    // Apply --fields filtering when set (only for object elements)
    const filteredData = fields && fields.length > 0
      ? data.map(obj => (obj && typeof obj === 'object' ? filterObjectFields(obj as Record<string, unknown>, fields) : obj))
      : data;

    if (this.mode === 'text') {
      if (filteredData.length === 0) {
        this._writeLog('No data to display');
        return;
      }
      
      // Get all unique keys from all objects
      const keys = Array.from(new Set(filteredData.flatMap(obj => Object.keys(obj))));
      
      // Calculate column widths
      const widths: Record<string, number> = {};
      keys.forEach(key => {
        widths[key] = Math.max(
          key.length,
          ...filteredData.map(obj => String(obj[key] ?? '').length)
        );
      });

      // Print header
      const header = keys.map(key => key.padEnd(widths[key])).join(' | ');
      this._writeLog(header);
      this._writeLog(keys.map(key => '-'.repeat(widths[key])).join('-+-'));

      // Print rows
      filteredData.forEach(obj => {
        const row = keys.map(key => String(obj[key] ?? '').padEnd(widths[key])).join(' | ');
        this._writeLog(row);
      });
    } else {
      this._writeLog(JSON.stringify(filteredData, null, 2));
    }
  }

  json(data: any): void {
    const fields = c8ctl.fields;
    // Apply --fields filtering when set
    const filteredData = fields && fields.length > 0 ? filterFields(data, fields) : data;

    if (this.mode === 'text') {
      this._writeLog(JSON.stringify(filteredData, null, 2));
    } else {
      this._writeLog(JSON.stringify(filteredData));
    }
  }

  /**
   * Write primary command output to stdout as-is, regardless of output mode.
   * Use this for non-structured content (e.g. XML, plain text). 
   */
  output(content: string): void {
    this._writeLog(content);
  }
}

/**
 * Sort table data by a given column name.
 * If the column doesn't exist, a warning is logged and the original data is returned unchanged.
 */
export type SortOrder = 'asc' | 'desc';

export function sortTableData<T extends Record<string, unknown>>(data: T[], sortBy: string | undefined, logger: Logger, sortOrder: SortOrder = 'asc'): T[] {
  if (!sortBy || data.length === 0) return data;

  // Find actual key using case-insensitive match
  const keys = Object.keys(data[0]);
  const matchedKey = keys.find(k => k.toLowerCase() === sortBy.toLowerCase());

  if (!matchedKey) {
    logger.warn(`Column '${sortBy}' not found in output. Available columns: ${keys.join(', ')}`);
    return data;
  }

  const direction = sortOrder === 'desc' ? -1 : 1;

  return [...data].sort((a, b) => {
    const va = a[matchedKey];
    const vb = b[matchedKey];
    if (va === undefined || va === null) return 1;
    if (vb === undefined || vb === null) return -1;
    const sa = String(va);
    const sb = String(vb);
    // Use numeric comparison when both values are numeric strings
    const na = Number(sa);
    const nb = Number(sb);
    if (!isNaN(na) && !isNaN(nb)) return (na - nb) * direction;
    return (sa < sb ? -1 : sa > sb ? 1 : 0) * direction;
  });
}

// Singleton instance to be used across the CLI
let loggerInstance: Logger | null = null;

export function getLogger(mode?: OutputMode): Logger {
  if (!loggerInstance) {
    loggerInstance = new Logger();
  }
  // Note: mode parameter is deprecated - logger now always reflects c8ctl.outputMode
  // If mode is provided, update c8ctl.outputMode for backwards compatibility
  if (mode !== undefined) {
    c8ctl.outputMode = mode;
  }
  return loggerInstance;
}
