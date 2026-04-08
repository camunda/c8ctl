/**
 * Open command - opens Camunda web applications in a browser
 */

import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { getLogger } from '../logger.ts';
import { resolveClusterConfig } from '../config.ts';

export const OPEN_APPS = ['operate', 'tasklist', 'modeler', 'optimize'] as const;
export type AppName = typeof OPEN_APPS[number];

/**
 * Derive the URL of a Camunda web application from the cluster base URL.
 *
 * For self-hosted clusters the base URL is the REST API endpoint
 * (e.g. `http://localhost:8080/v2`).  The web apps live on the same
 * host/port, one path segment below the root, so we strip the `/v2`
 * (or any `/v<n>`) suffix and append `/<app>`.
 */
export function deriveAppUrl(baseUrl: string, app: AppName): string {
  const base = baseUrl.replace(/\/v\d+\/?$/, '').replace(/\/$/, '');
  return `${base}/${app}`;
}

/**
 * Determine the platform-appropriate command and arguments to open a URL.
 * Exported for testing.
 */
export function getBrowserCommand(url: string): { command: string; args: string[] } {
  const plat = platform();
  if (plat === 'darwin') {
    return { command: 'open', args: [url] };
  }
  if (plat === 'win32') {
    return { command: 'cmd.exe', args: ['/c', 'start', '', url] };
  }
  // Linux / WSL
  return { command: 'xdg-open', args: [url] };
}

/**
 * Open a URL in the default system browser.
 * Works on macOS, Linux, and Windows (WSL).
 */
export function openUrl(url: string): void {
  const { command, args } = getBrowserCommand(url);
  spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
}

/**
 * Open a Camunda web application in the default browser.
 */
export async function openApp(app: string | undefined, options: { profile?: string }): Promise<void> {
  const logger = getLogger();

  if (!app || !(OPEN_APPS as readonly string[]).includes(app)) {
    logger.error(`Application required. Available: ${OPEN_APPS.join(', ')}`);
    logger.info('Usage: c8 open <app> [--profile <name>]');
    process.exit(1);
  }

  const config = resolveClusterConfig(options.profile);
  const url = deriveAppUrl(config.baseUrl, app as AppName);

  logger.info(`Opening ${app} at: ${url}`);
  openUrl(url);
}
