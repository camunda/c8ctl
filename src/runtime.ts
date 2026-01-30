/**
 * c8ctl runtime object with environment information and session state
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OutputMode } from './logger.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface C8ctlEnv {
  version: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  cwd: string;
  rootDir: string;
}

/**
 * Get c8ctl version from package.json
 */
function getVersion(): string {
  try {
    const packageJsonPath = join(__dirname, '..', 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * c8ctl runtime class with session state management
 */
class C8ctl {
  private _activeProfile?: string;
  private _activeTenant?: string;
  private _outputMode: OutputMode = 'text';

  readonly env: C8ctlEnv = {
    version: getVersion(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    rootDir: join(__dirname, '..'),
  };

  get activeProfile(): string | undefined {
    return this._activeProfile;
  }

  set activeProfile(value: string | undefined) {
    this._activeProfile = value;
  }

  get activeTenant(): string | undefined {
    return this._activeTenant;
  }

  set activeTenant(value: string | undefined) {
    this._activeTenant = value;
  }

  get outputMode(): OutputMode {
    return this._outputMode;
  }

  set outputMode(value: OutputMode) {
    this._outputMode = value;
  }
}

/**
 * Global c8ctl runtime instance
 */
export const c8ctl = new C8ctl();
