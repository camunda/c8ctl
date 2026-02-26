/**
 * Integration tests for plugin lifecycle (load/unload)
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { execSync, execFileSync } from 'node:child_process';
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
      execFileSync('node', ['src/index.ts', 'load', 'plugin', '--from', `file:${testPluginDir}`], {
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

      // Verify plugin list includes version information
      const listOutput = execSync('node src/index.ts list plugins', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        timeout: 5000,
      });
      assert.ok(listOutput.includes('Version'), 'Plugin list should include Version column');
      assert.ok(listOutput.includes(testPluginName), 'Plugin list should include the loaded plugin name');
      assert.ok(listOutput.includes('1.0.0'), 'Plugin list should include the loaded plugin version');
      
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

  test('should expose createClient, resolveTenantId and getLogger on plugin runtime object', async () => {
    const runtimePluginDir = join(process.cwd(), 'test-plugin-runtime-client-temp');
    const runtimePluginName = 'c8ctl-test-plugin-runtime-client';
    const runtimeNodeModulesPath = join(pluginsDir, 'node_modules', runtimePluginName);

    if (existsSync(runtimePluginDir)) {
      rmSync(runtimePluginDir, { recursive: true, force: true });
    }

    try {
      mkdirSync(runtimePluginDir, { recursive: true });

      writeFileSync(
        join(runtimePluginDir, 'package.json'),
        JSON.stringify({
          name: runtimePluginName,
          version: '1.0.0',
          type: 'module',
          description: 'Runtime client exposure test plugin',
          keywords: ['c8ctl', 'plugin'],
        }, null, 2),
      );

      writeFileSync(
        join(runtimePluginDir, 'c8ctl-plugin.js'),
        `export const commands = {
  'runtime-client-check': async () => {
    const hasClient = typeof globalThis.c8ctl?.createClient === 'function';
    const hasTenantResolver = typeof globalThis.c8ctl?.resolveTenantId === 'function';
    const hasLoggerGetter = typeof globalThis.c8ctl?.getLogger === 'function';
    const logger = hasLoggerGetter ? globalThis.c8ctl.getLogger() : null;
    const hasLoggerInfo = typeof logger?.info === 'function';
    const tenantId = hasTenantResolver ? globalThis.c8ctl.resolveTenantId() : '';
    const hasVersion = typeof globalThis.c8ctl?.version === 'string' && globalThis.c8ctl.version.length > 0;
    const hasPlatform = typeof globalThis.c8ctl?.platform === 'string' && globalThis.c8ctl.platform.length > 0;
    const hasOutputMode = typeof globalThis.c8ctl?.outputMode === 'string' && globalThis.c8ctl.outputMode.length > 0;
    console.log(hasClient ? 'RUNTIME_CLIENT_AVAILABLE' : 'RUNTIME_CLIENT_MISSING');
    console.log(hasTenantResolver ? 'RUNTIME_TENANT_RESOLVER_AVAILABLE' : 'RUNTIME_TENANT_RESOLVER_MISSING');
    console.log(hasLoggerGetter ? 'RUNTIME_LOGGER_GETTER_AVAILABLE' : 'RUNTIME_LOGGER_GETTER_MISSING');
    console.log(hasLoggerInfo ? 'RUNTIME_LOGGER_INFO_AVAILABLE' : 'RUNTIME_LOGGER_INFO_MISSING');
    console.log(hasVersion ? 'RUNTIME_VERSION_AVAILABLE' : 'RUNTIME_VERSION_MISSING');
    console.log(hasPlatform ? 'RUNTIME_PLATFORM_AVAILABLE' : 'RUNTIME_PLATFORM_MISSING');
    console.log(hasOutputMode ? 'RUNTIME_OUTPUT_MODE_AVAILABLE' : 'RUNTIME_OUTPUT_MODE_MISSING');
    if (tenantId) {
      console.log('RUNTIME_TENANT_ID_RESOLVED');
    }
  },
};
`,
      );

      execFileSync('node', ['src/index.ts', 'load', 'plugin', '--from', `file:${runtimePluginDir}`], {
        cwd: process.cwd(),
        stdio: 'pipe',
      });

      assert.ok(existsSync(runtimeNodeModulesPath), 'Runtime test plugin should be installed');

      const commandOutput = execSync('node src/index.ts runtime-client-check', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        timeout: 5000,
      });

      assert.ok(
        commandOutput.includes('RUNTIME_CLIENT_AVAILABLE'),
        `Plugin runtime should expose createClient. Output: ${commandOutput}`,
      );
      assert.ok(
        commandOutput.includes('RUNTIME_TENANT_RESOLVER_AVAILABLE'),
        `Plugin runtime should expose resolveTenantId. Output: ${commandOutput}`,
      );
      assert.ok(
        commandOutput.includes('RUNTIME_TENANT_ID_RESOLVED'),
        `Plugin runtime should resolve a tenant id. Output: ${commandOutput}`,
      );
      assert.ok(
        commandOutput.includes('RUNTIME_LOGGER_GETTER_AVAILABLE'),
        `Plugin runtime should expose getLogger. Output: ${commandOutput}`,
      );
      assert.ok(
        commandOutput.includes('RUNTIME_LOGGER_INFO_AVAILABLE'),
        `Plugin runtime logger should provide info(). Output: ${commandOutput}`,
      );
      assert.ok(
        commandOutput.includes('RUNTIME_VERSION_AVAILABLE'),
        `Plugin runtime should preserve version field. Output: ${commandOutput}`,
      );
      assert.ok(
        commandOutput.includes('RUNTIME_PLATFORM_AVAILABLE'),
        `Plugin runtime should preserve platform field. Output: ${commandOutput}`,
      );
      assert.ok(
        commandOutput.includes('RUNTIME_OUTPUT_MODE_AVAILABLE'),
        `Plugin runtime should preserve outputMode field. Output: ${commandOutput}`,
      );
    } finally {
      if (existsSync(runtimePluginDir)) {
        rmSync(runtimePluginDir, { recursive: true, force: true });
      }

      try {
        execSync(`node src/index.ts unload plugin ${runtimePluginName}`, {
          cwd: process.cwd(),
          stdio: 'ignore',
        });
      } catch {
        // Ignore cleanup errors
      }

      if (existsSync(runtimeNodeModulesPath)) {
        rmSync(runtimeNodeModulesPath, { recursive: true, force: true });
      }
    }
  });
  
  test('should complete full plugin lifecycle with init, build, load, execute, and help', async () => {
    const scaffoldPluginName = 'test-scaffold';
    const scaffoldDir = join(process.cwd(), `c8ctl-${scaffoldPluginName}`);
    const fullPluginName = `c8ctl-${scaffoldPluginName}`;
    const scaffoldNodeModulesPath = join(pluginsDir, 'node_modules', fullPluginName);
    
    // Clean up from any previous test run
    if (existsSync(scaffoldDir)) {
      rmSync(scaffoldDir, { recursive: true, force: true });
    }
    
    try {
      // Step 1: Bootstrap a new c8ctl plugin with "c8ctl init plugin"
      const initOutput = execSync(`node src/index.ts init plugin ${scaffoldPluginName}`, {
        cwd: process.cwd(),
        encoding: 'utf-8',
        timeout: 5000
      });
      
      assert.ok(initOutput.includes('Plugin scaffolding created successfully'), 
        'Init command should succeed');
      assert.ok(existsSync(scaffoldDir), 'Plugin directory should be created');
      assert.ok(existsSync(join(scaffoldDir, 'package.json')), 'package.json should exist');
      assert.ok(existsSync(join(scaffoldDir, 'src', 'c8ctl-plugin.ts')), 'Plugin source should exist');
      assert.ok(existsSync(join(scaffoldDir, 'tsconfig.json')), 'tsconfig.json should exist');
      
      // Step 2: Add a minimal implementation to the generated skeleton
      // Modify the hello command to output something we can verify
      const pluginSource = `/**
 * ${fullPluginName} - A c8ctl plugin
 */

// Optional metadata for help text
export const metadata = {
  name: '${fullPluginName}',
  description: 'Test scaffold plugin',
  commands: {
    'scaffold-test': {
      description: 'Test command from scaffolded plugin',
    },
  },
};

// Required commands export
export const commands = {
  'scaffold-test': async (args: string[]) => {
    console.log('SCAFFOLD_TEST_EXECUTED');
    if (args.length > 0) {
      console.log('Args:', args.join(','));
    }
  },
};
`;
      
      writeFileSync(join(scaffoldDir, 'src', 'c8ctl-plugin.ts'), pluginSource);
      
      // Step 3: Build the plugin
      execSync('npm install', {
        cwd: scaffoldDir,
        stdio: 'pipe',
        timeout: 30000
      });
      
      execSync('npm run build', {
        cwd: scaffoldDir,
        stdio: 'pipe',
        timeout: 10000
      });
      
      // Verify the build output exists
      const builtPluginFile = join(scaffoldDir, 'c8ctl-plugin.js');
      assert.ok(existsSync(builtPluginFile), 'Built plugin file should exist');
      
      // Step 4: Load the plugin
      execFileSync('node', ['src/index.ts', 'load', 'plugin', '--from', `file:${scaffoldDir}`], {
        cwd: process.cwd(),
        stdio: 'pipe',
        timeout: 10000
      });
      
      // Verify plugin is installed
      assert.ok(existsSync(scaffoldNodeModulesPath), 
        'Scaffolded plugin should be installed in global directory');
      
      // Step 5: Make sure the plugin works - command executes
      let commandOutput = '';
      try {
        commandOutput = execSync('node src/index.ts scaffold-test arg1 arg2', {
          cwd: process.cwd(),
          encoding: 'utf-8',
          timeout: 5000
        });
      } catch (error: any) {
        commandOutput = error.stdout || '';
      }
      
      assert.ok(commandOutput.includes('SCAFFOLD_TEST_EXECUTED'), 
        `Scaffolded plugin command should execute. Output: ${commandOutput}`);
      assert.ok(commandOutput.includes('Args: arg1,arg2'), 
        'Command should receive arguments');
      
      // Step 6: Make sure the plugin command is available in "c8ctl help"
      const helpOutput = execSync('node src/index.ts help', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        timeout: 5000
      });
      
      assert.ok(helpOutput.includes('Plugin Commands'), 
        'Help should include Plugin Commands section');
      assert.ok(helpOutput.includes('scaffold-test'), 
        'Help should list the scaffold-test command');
      assert.ok(helpOutput.includes('Test command from scaffolded plugin'), 
        'Help should include command description');
      
    } finally {
      // Cleanup
      if (existsSync(scaffoldDir)) {
        rmSync(scaffoldDir, { recursive: true, force: true });
      }
      
      try {
        execSync(`node src/index.ts unload plugin ${fullPluginName}`, {
          cwd: process.cwd(),
          stdio: 'ignore'
        });
      } catch {
        // Ignore cleanup errors
      }
      
      if (existsSync(scaffoldNodeModulesPath)) {
        rmSync(scaffoldNodeModulesPath, { recursive: true, force: true });
      }
    }
  });
  
  test('plugin cannot overwrite built-in commands', async () => {
    const conflictPluginName = 'test-conflict';
    const conflictDir = join(process.cwd(), `c8ctl-${conflictPluginName}`);
    const fullPluginName = `c8ctl-${conflictPluginName}`;
    const conflictNodeModulesPath = join(pluginsDir, 'node_modules', fullPluginName);
    
    // Clean up from any previous test run
    if (existsSync(conflictDir)) {
      rmSync(conflictDir, { recursive: true, force: true });
    }
    
    try {
      // Create a plugin directory manually (not using init to keep it simple)
      mkdirSync(conflictDir, { recursive: true });
      
      // Create package.json
      writeFileSync(
        join(conflictDir, 'package.json'),
        JSON.stringify({
          name: fullPluginName,
          version: '1.0.0',
          type: 'module',
          description: 'Test plugin that tries to overwrite built-in commands',
          keywords: ['c8ctl', 'plugin']
        }, null, 2)
      );
      
      // Create plugin file that tries to overwrite a built-in command (e.g., 'list')
      writeFileSync(
        join(conflictDir, 'c8ctl-plugin.js'),
        `export const metadata = {
  name: '${fullPluginName}',
  description: 'Test conflict plugin',
  commands: {
    'list': {
      description: 'PLUGIN VERSION - This should NOT override the built-in list command',
    },
  },
};

export const commands = {
  'list': async (args) => {
    console.log('PLUGIN_LIST_COMMAND_EXECUTED');
  },
};
`
      );
      
      // Load the plugin
      execFileSync('node', [
        'src/index.ts',
        'load',
        'plugin',
        '--from',
        `file:${conflictDir}`,
      ], {
        cwd: process.cwd(),
        stdio: 'pipe',
        timeout: 10000
      });
      
      // Verify plugin is installed
      assert.ok(existsSync(conflictNodeModulesPath), 
        'Conflict plugin should be installed in global directory');
      
      // Try to execute 'list' command - should execute BUILT-IN, not plugin version
      let listOutput = '';
      try {
        // Execute 'list profiles' which is a valid built-in command
        listOutput = execSync('node src/index.ts list profiles', {
          cwd: process.cwd(),
          encoding: 'utf-8',
          timeout: 5000
        });
      } catch (error: any) {
        listOutput = error.stdout || error.stderr || '';
      }
      
      // Built-in command should execute (showing profiles or "No profiles found")
      // Plugin command should NOT execute (would show 'PLUGIN_LIST_COMMAND_EXECUTED')
      assert.ok(!listOutput.includes('PLUGIN_LIST_COMMAND_EXECUTED'), 
        'Built-in list command should execute, not plugin version');
      
      // Verify that either profiles are listed OR we get the expected built-in response
      const isBuiltInResponse = listOutput.includes('No profiles found') || 
                                 listOutput.includes('Profile') ||
                                 listOutput.includes('profiles');
      assert.ok(isBuiltInResponse, 
        `Built-in list command should work normally. Output: ${listOutput}`);
      
    } finally {
      // Cleanup
      if (existsSync(conflictDir)) {
        rmSync(conflictDir, { recursive: true, force: true });
      }
      
      try {
        execSync(`node src/index.ts unload plugin ${fullPluginName}`, {
          cwd: process.cwd(),
          stdio: 'ignore'
        });
      } catch {
        // Ignore cleanup errors
      }
      
      if (existsSync(conflictNodeModulesPath)) {
        rmSync(conflictNodeModulesPath, { recursive: true, force: true });
      }
    }
  });

  test('downgrade respects file source and fails with actionable hint', async () => {
    const fileSourcePluginName = 'c8ctl-file-source-plugin';
    const fileSourcePluginDir = join(process.cwd(), 'test-file-source-plugin-temp');
    const fileSourceNodeModulesPath = join(pluginsDir, 'node_modules', fileSourcePluginName);

    if (existsSync(fileSourcePluginDir)) {
      rmSync(fileSourcePluginDir, { recursive: true, force: true });
    }

    try {
      mkdirSync(fileSourcePluginDir, { recursive: true });

      writeFileSync(
        join(fileSourcePluginDir, 'package.json'),
        JSON.stringify({
          name: fileSourcePluginName,
          version: '1.0.0',
          type: 'module',
          description: 'Test file-source plugin for downgrade behavior',
          keywords: ['c8ctl', 'plugin']
        }, null, 2)
      );

      writeFileSync(
        join(fileSourcePluginDir, 'c8ctl-plugin.js'),
        `export const commands = {
  'file-source-test': async () => {
    console.log('FILE_SOURCE_TEST');
  }
};
`
      );

      execFileSync('node', ['src/index.ts', 'load', 'plugin', '--from', `file:${fileSourcePluginDir}`], {
        cwd: process.cwd(),
        stdio: 'pipe',
        timeout: 10000,
      });

      assert.ok(existsSync(fileSourceNodeModulesPath), 'File-source plugin should be installed');

      let downgradeFailed = false;
      let downgradeOutput = '';
      try {
        execSync(`node src/index.ts downgrade plugin ${fileSourcePluginName} 0.9.0`, {
          cwd: process.cwd(),
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 5000,
        });
      } catch (error: any) {
        downgradeFailed = true;
        downgradeOutput = `${error.stdout || ''}${error.stderr || ''}`;
      }

      assert.ok(downgradeFailed, 'Downgrade should fail for file-based plugin source');
      assert.ok(downgradeOutput.includes('Cannot downgrade file-based plugin'),
        `Downgrade should explain file-source limitation. Output: ${downgradeOutput}`);
      assert.ok(downgradeOutput.includes('c8ctl load plugin --from <file-url>'),
        `Downgrade should provide actionable hint. Output: ${downgradeOutput}`);

      // Plugin should remain installed because downgrade exits before uninstall
      assert.ok(existsSync(fileSourceNodeModulesPath),
        'File-source plugin should remain installed after failed downgrade');
    } finally {
      if (existsSync(fileSourcePluginDir)) {
        rmSync(fileSourcePluginDir, { recursive: true, force: true });
      }

      try {
        execSync(`node src/index.ts unload plugin ${fileSourcePluginName}`, {
          cwd: process.cwd(),
          stdio: 'ignore',
        });
      } catch {
        // Ignore cleanup errors
      }

      if (existsSync(fileSourceNodeModulesPath)) {
        rmSync(fileSourceNodeModulesPath, { recursive: true, force: true });
      }
    }
  });

  test('upgrade respects file source and fails with actionable hint', async () => {
    const fileSourcePluginName = 'c8ctl-file-source-plugin-upgrade';
    const fileSourcePluginDir = join(process.cwd(), 'test-file-source-plugin-upgrade-temp');
    const fileSourceNodeModulesPath = join(pluginsDir, 'node_modules', fileSourcePluginName);

    if (existsSync(fileSourcePluginDir)) {
      rmSync(fileSourcePluginDir, { recursive: true, force: true });
    }

    try {
      mkdirSync(fileSourcePluginDir, { recursive: true });

      writeFileSync(
        join(fileSourcePluginDir, 'package.json'),
        JSON.stringify({
          name: fileSourcePluginName,
          version: '1.0.0',
          type: 'module',
          description: 'Test file-source plugin for upgrade behavior',
          keywords: ['c8ctl', 'plugin']
        }, null, 2)
      );

      writeFileSync(
        join(fileSourcePluginDir, 'c8ctl-plugin.js'),
        `export const commands = {
  'file-source-upgrade-test': async () => {
    console.log('FILE_SOURCE_UPGRADE_TEST');
  }
};
`
      );

      execFileSync('node', ['src/index.ts', 'load', 'plugin', '--from', `file:${fileSourcePluginDir}`], {
        cwd: process.cwd(),
        stdio: 'pipe',
        timeout: 10000,
      });

      assert.ok(existsSync(fileSourceNodeModulesPath), 'File-source plugin should be installed');

      let upgradeFailed = false;
      let upgradeOutput = '';
      try {
        execSync(`node src/index.ts upgrade plugin ${fileSourcePluginName} 1.1.0`, {
          cwd: process.cwd(),
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 5000,
        });
      } catch (error: any) {
        upgradeFailed = true;
        upgradeOutput = `${error.stdout || ''}${error.stderr || ''}`;
      }

      assert.ok(upgradeFailed, 'Versioned upgrade should fail for file-based plugin source');
      assert.ok(upgradeOutput.includes('Cannot upgrade file-based plugin'),
        `Upgrade should explain file-source limitation. Output: ${upgradeOutput}`);
      assert.ok(upgradeOutput.includes('c8ctl load plugin --from <file-url>'),
        `Upgrade should provide actionable hint. Output: ${upgradeOutput}`);

      // Plugin should remain installed because upgrade exits before uninstall
      assert.ok(existsSync(fileSourceNodeModulesPath),
        'File-source plugin should remain installed after failed versioned upgrade');
    } finally {
      if (existsSync(fileSourcePluginDir)) {
        rmSync(fileSourcePluginDir, { recursive: true, force: true });
      }

      try {
        execSync(`node src/index.ts unload plugin ${fileSourcePluginName}`, {
          cwd: process.cwd(),
          stdio: 'ignore',
        });
      } catch {
        // Ignore cleanup errors
      }

      if (existsSync(fileSourceNodeModulesPath)) {
        rmSync(fileSourceNodeModulesPath, { recursive: true, force: true });
      }
    }
  });
});
