/**
 * Logger component for c8ctl CLI
 * Handles output in multiple modes (text, json) based on session state
 */

export type OutputMode = 'text' | 'json';

export class Logger {
  private mode: OutputMode;

  constructor(mode: OutputMode = 'text') {
    this.mode = mode;
  }

  setMode(mode: OutputMode): void {
    this.mode = mode;
  }

  getMode(): OutputMode {
    return this.mode;
  }

  info(message: string): void {
    if (this.mode === 'text') {
      console.log(message);
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
    loggerInstance = new Logger(mode);
  } else if (mode !== undefined) {
    loggerInstance.setMode(mode);
  }
  return loggerInstance;
}
