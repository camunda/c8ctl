/**
 * Logger component for c8ctl CLI
 * Handles output in multiple modes (text, json) based on session state
 */

import { c8ctl } from './runtime.ts';

export type OutputMode = 'text' | 'json';

export type LogWriter = {
  log(...data: any[]): void;
  error(...data: any[]): void;
};

const defaultLogWriter: LogWriter = {
  log(...data: any[]): void {
    console.log(...data);
  },
  error(...data: any[]): void {
    console.error(...data);
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
      this._writeLog(JSON.stringify({ status: 'info', message }));
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
        this._writeLog(JSON.stringify({ status: 'success', message, key }));
      } else {
        this._writeLog(JSON.stringify({ status: 'success', message }));
      }
    }
  }

  error(message: string, error?: Error): void {
    if (this.mode === 'text') {
      this._writeError(`✗ ${message}`);
      if (error) {
        this._writeError(`  ${error.message}`);
      }
    } else {
      const output: any = { status: 'error', message };
      if (error) {
        output.error = error.message;
        if (error.stack) {
          output.stack = error.stack;
        }
      }
      this._writeError(JSON.stringify(output));
    }
  }

  table(data: any[]): void {
    if (this.mode === 'text') {
      if (data.length === 0) {
        this._writeLog('No data to display');
        return;
      }
      
      // Get all unique keys from all objects
      const keys = Array.from(new Set(data.flatMap(obj => Object.keys(obj))));
      
      // Calculate column widths
      const widths: Record<string, number> = {};
      keys.forEach(key => {
        widths[key] = Math.max(
          key.length,
          ...data.map(obj => String(obj[key] ?? '').length)
        );
      });

      // Print header
      const header = keys.map(key => key.padEnd(widths[key])).join(' | ');
      this._writeLog(header);
      this._writeLog(keys.map(key => '-'.repeat(widths[key])).join('-+-'));

      // Print rows
      data.forEach(obj => {
        const row = keys.map(key => String(obj[key] ?? '').padEnd(widths[key])).join(' | ');
        this._writeLog(row);
      });
    } else {
      this._writeLog(JSON.stringify(data, null, 2));
    }
  }

  json(data: any): void {
    if (this.mode === 'text') {
      this._writeLog(JSON.stringify(data, null, 2));
    } else {
      this._writeLog(JSON.stringify(data));
    }
  }
}

/**
 * Sort table data by a given column name.
 * If the column doesn't exist, a warning is logged and the original data is returned unchanged.
 */
export function sortTableData(data: Array<Record<string, unknown>>, sortBy: string | undefined, logger: Logger): Array<Record<string, unknown>> {
  if (!sortBy || data.length === 0) return data;

  // Find actual key using case-insensitive match
  const keys = Object.keys(data[0]);
  const matchedKey = keys.find(k => k.toLowerCase() === sortBy.toLowerCase());

  if (!matchedKey) {
    logger.warn(`Column '${sortBy}' not found in output. Available columns: ${keys.join(', ')}`);
    return data;
  }

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
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
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
