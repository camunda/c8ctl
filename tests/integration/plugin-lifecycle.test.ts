/**
 * Integration tests for plugin lifecycle (load/unload)
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getUserDataDir } from '../../src/config.ts';

describe('Plugin Lifecycle Integration Tests', () => {
  const testPluginDir = join(process.cwd(), 'test-plugin-temp');
  const testPluginName = 'c8ctl-test-plugin';
  const pluginsDir = join(getUserDataDir(), 'plugins');
  const nodeModulesPluginPath = join(pluginsDir, 'node_modules', testPluginName);
  
  // Setup: Clean up any previous test artifacts
  before(() => {
    // Remove temp directory if it exists
    if (existsSync(testPluginDir)) {
      rmSync(testPluginDir, { recursive: true, force: true });
    }
    
    // Unload plugin if it exists from previous run
    try {
      execSync(`node src/index.ts unload plugin ${testPluginName}`, { 
        cwd: process.cwd(),
        stdio: 'ignore' 
      });
    } catch {
      // Ignore if not installed
    }
    
    // Remove from global node_modules if still there
    if (existsSync(nodeModulesPluginPath)) {
      rmSync(nodeModulesPluginPath, { recursive: true, force: true });
    }
  });
  
  // Cleanup: Ensure test artifacts are removed
  after(() => {
    // Remove temp directory
    if (existsSync(testPluginDir)) {
      rmSync(testPluginDir, { recursive: true, force: true });
    }
    
    // Unload plugin
    try {
      execSync(`node src/index.ts unload plugin ${testPluginName}`, { 
        cwd: process.cwd(),
        stdio: 'ignore' 
      });
    } catch {
      // Ignore if already uninstalled
    }
    
    // Remove from global node_modules
    if (existsSync(nodeModulesPluginPath)) {
      rmSync(nodeModulesPluginPath, { recursive: true, force: true });
    }
  });
  
  test('should load plugin and make commands available', async () => {
    // Create test plugin directory
    mkdirSync(testPluginDir, { recursive: true });
    
    // Create package.json
    writeFileSync(
      join(testPluginDir, 'package.json'),
      JSON.stringify({
        name: testPluginName,
        version: '1.0.0',
        type: 'module',
        description: 'Test plugin for c8ctl integration tests',
        keywords: ['c8ctl', 'plugin']
      }, null, 2)
    );
    
    // Create plugin file with a unique test command
    writeFileSync(
      join(testPluginDir, 'c8ctl-plugin.js'),
      `export const commands = {
  'test-command': async (args) => {
    console.log('TEST_COMMAND_EXECUTED');
  }
};
`
    );
    
    try {
      // Load the plugin using c8ctl load command with file: protocol
      execSync(`node src/index.ts load plugin --from file:${testPluginDir}`, { 
        cwd: process.cwd(),
        stdio: 'pipe'
      });
      
      // Verify plugin is installed in global directory
      assert.ok(existsSync(nodeModulesPluginPath), 'Plugin should be installed in global plugins directory');
      
      // Verify plugin file exists
      const installedPluginFile = join(nodeModulesPluginPath, 'c8ctl-plugin.js');
      assert.ok(existsSync(installedPluginFile), `Plugin file should exist at ${installedPluginFile}`);
      
      // Verify plugin command works by running CLI in a new process
      let commandOutput = '';
      let commandStderr = '';
      try {
        commandOutput = execSync('node src/index.ts test-command', {
          cwd: process.cwd(),
          encoding: 'utf-8',
          timeout: 5000
        });
      } catch (error: any) {
        // Command may exit with 0 or throw, check both outputs
        commandOutput = error.stdout || '';
        commandStderr = error.stderr || '';
      }
      
      assert.ok(commandOutput.includes('TEST_COMMAND_EXECUTED'), 
        `Plugin command should execute. Output: ${commandOutput}, Stderr: ${commandStderr}`);
      
      // Unload the plugin using c8ctl unload command
      execSync(`node src/index.ts unload plugin ${testPluginName}`, {
        cwd: process.cwd(),
        stdio: 'pipe'
      });
      
      // Verify plugin is uninstalled from global directory
      assert.ok(!existsSync(nodeModulesPluginPath), 
        'Plugin should be removed from global plugins directory');
      
      // Verify plugin command no longer works
      let shouldFail = false;
      try {
        const failOutput = execSync('node src/index.ts test-command', {
          cwd: process.cwd(),
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 5000
        });
        // If we get here, command didn't fail as expected
        shouldFail = !failOutput.includes('TEST_COMMAND_EXECUTED');
      } catch (error: any) {
        // Expected to fail - check error message
        const errorOutput = error.stderr || error.stdout || error.message;
        shouldFail = errorOutput.includes('Unknown command') || 
                     errorOutput.includes('test-command');
      }
      
      assert.ok(shouldFail, 'Plugin command should not be available after unload');
      
    } finally {
      // Cleanup in finally block to ensure it runs even if test fails
      if (existsSync(testPluginDir)) {
        rmSync(testPluginDir, { recursive: true, force: true });
      }
      
      try {
        execSync(`node src/index.ts unload plugin ${testPluginName}`, { 
          cwd: process.cwd(),
          stdio: 'ignore' 
        });
      } catch {
        // Ignore cleanup errors
      }
      
      if (existsSync(nodeModulesPluginPath)) {
        rmSync(nodeModulesPluginPath, { recursive: true, force: true });
      }
    }
  });
});
