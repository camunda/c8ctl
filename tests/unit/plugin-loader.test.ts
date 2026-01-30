/**
 * Unit tests for plugin loader
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { 
  clearLoadedPlugins, 
  getPluginCommandNames,
  getPluginCommandsInfo,
  isPluginCommand
} from '../../src/plugin-loader.ts';

describe('Plugin Loader', () => {
  test('clearLoadedPlugins removes all loaded plugins', async () => {
    // Clear any existing plugins
    clearLoadedPlugins();
    
    // Verify no plugins are loaded
    const commandNames = getPluginCommandNames();
    assert.strictEqual(commandNames.length, 0, 'Should have no plugin commands after clear');
  });
  
  test('isPluginCommand returns false for unknown commands', async () => {
    clearLoadedPlugins();
    
    const result = isPluginCommand('nonexistent-command');
    assert.strictEqual(result, false, 'Should return false for unknown command');
  });
  
  test('getPluginCommandNames returns empty array when no plugins loaded', async () => {
    clearLoadedPlugins();
    
    const names = getPluginCommandNames();
    assert.ok(Array.isArray(names), 'Should return an array');
    assert.strictEqual(names.length, 0, 'Should be empty when no plugins loaded');
  });

  test('getPluginCommandsInfo returns empty array when no plugins loaded', async () => {
    clearLoadedPlugins();
    
    const info = getPluginCommandsInfo();
    assert.ok(Array.isArray(info), 'Should return an array');
    assert.strictEqual(info.length, 0, 'Should be empty when no plugins loaded');
  });
});
