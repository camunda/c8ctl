/**
 * Logger component for c8ctl CLI
 * Handles output in multiple modes (text, json) based on session state
 */

import { c8ctl } from './runtime.ts';

export type OutputMode = 'text' | 'json';

export class Logger {
  private _debugEnabled: boolean = false;

  constructor() {
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

  info(message: string): void {
    if (this.mode === 'text') {
      console.log(message);
    } else {
      console.log(JSON.stringify({ status: 'info', message }));
    }
  }

  debug(message: string, ...args: any[]): void {
    if (this._debugEnabled) {
      if (this.mode === 'text') {
        const timestamp = new Date().toISOString();
        console.error(`[DEBUG ${timestamp}] ${message}`, ...args);
      } else {
        console.error(JSON.stringify({ 
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
        console.log(`✓ ${message} [Key: ${key}]`);
      } else {
        console.log(`✓ ${message}`);
      }
    } else {
      if (key !== undefined) {
        console.log(JSON.stringify({ status: 'success', message, key }));
      } else {
        console.log(JSON.stringify({ status: 'success', message }));
      }
    }
  }

  error(message: string, error?: Error): void {
    if (this.mode === 'text') {
      console.error(`✗ ${message}`);
      if (error) {
        console.error(`  ${error.message}`);
      }
    } else {
      const output: any = { status: 'error', message };
      if (error) {
        output.error = error.message;
        if (error.stack) {
          output.stack = error.stack;
        }
      }
      console.error(JSON.stringify(output));
    }
  }

  table(data: any[]): void {
    if (this.mode === 'text') {
      if (data.length === 0) {
        console.log('No data to display');
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
      console.log(header);
      console.log(keys.map(key => '-'.repeat(widths[key])).join('-+-'));

      // Print rows
      data.forEach(obj => {
        const row = keys.map(key => String(obj[key] ?? '').padEnd(widths[key])).join(' | ');
        console.log(row);
      });
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
  }

  json(data: any): void {
    if (this.mode === 'text') {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(JSON.stringify(data));
    }
  }
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
