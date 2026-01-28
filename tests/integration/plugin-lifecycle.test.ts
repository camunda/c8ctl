/**
 * Integration tests for plugin lifecycle (load/unload)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

describe('Plugin Lifecycle Integration Tests', () => {
  const testPluginDir = join(process.cwd(), 'test-plugin-temp');
  const testPluginName = 'c8ctl-test-plugin';
  
  test.skip('should load plugin and make commands available', async () => {
    // Skip by default as this requires npm install
    // Create a test plugin
    if (existsSync(testPluginDir)) {
      rmSync(testPluginDir, { recursive: true, force: true });
    }
    mkdirSync(testPluginDir, { recursive: true });
    
    // Create package.json
    writeFileSync(
      join(testPluginDir, 'package.json'),
      JSON.stringify({
        name: testPluginName,
        version: '1.0.0',
        type: 'module'
      })
    );
    
    // Create plugin file
    writeFileSync(
      join(testPluginDir, 'c8ctl-plugin.js'),
      `
export const commands = {
  'test-command': async (args) => {
    console.log('TEST_COMMAND_EXECUTED');
    return 'success';
  }
};
`
    );
    
    try {
      // Load the plugin
      execSync(`npm install file:${testPluginDir}`, { 
        cwd: process.cwd(),
        stdio: 'inherit' 
      });
      
      // Verify plugin command works
      const output = execSync('node src/index.ts test-command', {
        cwd: process.cwd(),
        encoding: 'utf-8'
      });
      
      assert.ok(output.includes('TEST_COMMAND_EXECUTED'), 'Plugin command should execute');
      
      // Unload the plugin
      execSync(`npm uninstall ${testPluginName}`, {
        cwd: process.cwd(),
        stdio: 'inherit'
      });
      
      // Verify plugin command no longer works
      try {
        execSync('node src/index.ts test-command', {
          cwd: process.cwd(),
          encoding: 'utf-8'
        });
        assert.fail('Plugin command should not be available after unload');
      } catch (error: any) {
        assert.ok(error.message.includes('Unknown command'), 'Should show unknown command error');
      }
    } finally {
      // Cleanup
      if (existsSync(testPluginDir)) {
        rmSync(testPluginDir, { recursive: true, force: true });
      }
      // Make sure plugin is uninstalled
      try {
        execSync(`npm uninstall ${testPluginName}`, { 
          cwd: process.cwd(),
          stdio: 'ignore' 
        });
      } catch {
        // Ignore if already uninstalled
      }
    }
  });
});
