/**
 * Unit tests for version checking logic in c8ctl-mcp-chat plugin
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

/**
 * Version check logic extracted from c8ctl-plugin.js
 * This mimics the logic in checkClusterVersion function
 */
function checkVersion(version) {
  const versionParts = version.split('.').map(part => parseInt(part, 10));
  const major = versionParts[0] || 0;
  const minor = versionParts[1] || 0;
  
  // Check if version is 8.9 or later
  if (major < 8 || (major === 8 && minor < 9)) {
    return false; // Version too old
  }
  return true; // Version OK
}

describe('Version Checking', () => {
  test('accepts version 8.9.0', () => {
    assert.strictEqual(checkVersion('8.9.0'), true);
  });

  test('accepts version 8.9', () => {
    assert.strictEqual(checkVersion('8.9'), true);
  });

  test('rejects version 8.8.0', () => {
    assert.strictEqual(checkVersion('8.8.0'), false);
  });

  test('rejects version 8.8', () => {
    assert.strictEqual(checkVersion('8.8'), false);
  });

  test('accepts version 8.10.0 (regression test for parseFloat bug)', () => {
    assert.strictEqual(checkVersion('8.10.0'), true);
  });

  test('accepts version 8.10', () => {
    assert.strictEqual(checkVersion('8.10'), true);
  });

  test('accepts version 8.11.0', () => {
    assert.strictEqual(checkVersion('8.11.0'), true);
  });

  test('accepts version 8.12.0', () => {
    assert.strictEqual(checkVersion('8.12.0'), true);
  });

  test('accepts version 9.0.0', () => {
    assert.strictEqual(checkVersion('9.0.0'), true);
  });

  test('accepts version 10.0.0', () => {
    assert.strictEqual(checkVersion('10.0.0'), true);
  });

  test('rejects version 7.9.0', () => {
    assert.strictEqual(checkVersion('7.9.0'), false);
  });

  test('rejects version 7.20.0', () => {
    assert.strictEqual(checkVersion('7.20.0'), false);
  });

  describe('Edge cases', () => {
    test('handles version with only major number', () => {
      assert.strictEqual(checkVersion('8'), false); // 8.0 < 8.9
      assert.strictEqual(checkVersion('9'), true);  // 9.0 >= 8.9
    });

    test('handles version with patch and beyond', () => {
      assert.strictEqual(checkVersion('8.9.1'), true);
      assert.strictEqual(checkVersion('8.9.0-alpha'), true); // parseInt stops at non-digit
      assert.strictEqual(checkVersion('8.10.5.1'), true);
    });
  });

  describe('Regression test: parseFloat bug', () => {
    test('demonstrates the old parseFloat bug would fail', () => {
      // This test documents why we switched from parseFloat
      // parseFloat("8.10") = 8.1, which is < 8.9 (WRONG!)
      const oldBuggyLogic = (version) => {
        const majorMinor = version.split('.').slice(0, 2).join('.');
        return parseFloat(majorMinor) >= 8.9;
      };

      // These would fail with the old logic:
      assert.strictEqual(oldBuggyLogic('8.10.0'), false, 'Old logic incorrectly rejects 8.10');
      assert.strictEqual(oldBuggyLogic('8.11.0'), false, 'Old logic incorrectly rejects 8.11');
      
      // But work with new logic:
      assert.strictEqual(checkVersion('8.10.0'), true);
      assert.strictEqual(checkVersion('8.11.0'), true);
    });
  });
});
