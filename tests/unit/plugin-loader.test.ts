/**
 * Unit tests for plugin loader
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { 
  clearLoadedPlugins, 
  getPluginCommandNames,
  getPluginCommandsInfo,
  isPluginCommand,
  _registerPluginForTesting,
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

  test('getPluginCommandsInfo includes examples from plugin metadata', async () => {
    clearLoadedPlugins();
    _registerPluginForTesting(
      'test-plugin',
      { 'test-cmd': async () => {} },
      {
        name: 'test-plugin',
        commands: {
          'test-cmd': {
            description: 'A test command',
            examples: [
              { command: 'c8ctl test-cmd start', description: 'Start something' },
              { command: 'c8ctl test-cmd stop', description: 'Stop something' },
            ],
          },
        },
      },
    );

    const info = getPluginCommandsInfo();
    assert.strictEqual(info.length, 1);
    assert.strictEqual(info[0].commandName, 'test-cmd');
    assert.strictEqual(info[0].description, 'A test command');
    assert.ok(Array.isArray(info[0].examples), 'Should include examples array');
    assert.strictEqual(info[0].examples!.length, 2);
    assert.strictEqual(info[0].examples![0].command, 'c8ctl test-cmd start');
    assert.strictEqual(info[0].examples![1].description, 'Stop something');

    clearLoadedPlugins();
  });

  test('getPluginCommandsInfo returns undefined examples when not set', async () => {
    clearLoadedPlugins();
    _registerPluginForTesting(
      'no-examples-plugin',
      { 'simple-cmd': async () => {} },
      {
        name: 'no-examples-plugin',
        commands: {
          'simple-cmd': { description: 'No examples here' },
        },
      },
    );

    const info = getPluginCommandsInfo();
    assert.strictEqual(info.length, 1);
    assert.strictEqual(info[0].examples, undefined, 'Examples should be undefined when not provided');

    clearLoadedPlugins();
  });
});
