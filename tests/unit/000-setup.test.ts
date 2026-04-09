/**
 * Test setup and teardown for all unit tests
 * Runs before and after the entire test suite to prevent scope pollution
 */

import { before, after } from 'node:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getUserDataDir } from '../../src/config.ts';
import { clearLoadedPlugins } from '../../src/plugin-loader.ts';

// Store original environment
const originalEnv = { ...process.env };

/**
 * Clean up user data directory test artifacts
 */
function cleanUserDataDir() {
  const userDataDir = getUserDataDir();
  const profilesPath = join(userDataDir, 'profiles.json');
  const sessionPath = join(userDataDir, 'session.json');
  
  // Only remove test artifacts, not the entire directory
  if (existsSync(profilesPath)) {
    try {
      rmSync(profilesPath, { force: true });
    } catch (error) {
      // Ignore errors - file might be locked or already removed
    }
  }
  
  if (existsSync(sessionPath)) {
    try {
      rmSync(sessionPath, { force: true });
    } catch (error) {
      // Ignore errors - file might be locked or already removed
    }
  }
}

/**
 * Setup: Clean environment before all tests
 */
before(() => {
  // Clear any loaded plugins
  clearLoadedPlugins();
  
  // Clean up any leftover test data from previous runs
  cleanUserDataDir();
  
  const userDataDir = getUserDataDir();
  console.log(`Test suite starting - User data dir: ${userDataDir}`);
  console.log('Environment cleaned and ready for tests');
});

/**
 * Teardown: Clean environment after all tests
 */
after(() => {
  // Clear any loaded plugins
  clearLoadedPlugins();
  
  // Clean up test artifacts
  cleanUserDataDir();
  
  // Restore original environment
  process.env = originalEnv;
  
  console.log('Test suite completed - Environment cleaned');
});
