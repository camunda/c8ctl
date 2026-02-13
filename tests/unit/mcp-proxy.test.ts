/**
 * Unit tests for MCP proxy URL normalization
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { normalizeRemoteMcpUrl } from '../../src/commands/mcp-proxy.ts';

describe('normalizeRemoteMcpUrl', () => {
  const mcpServerPath = '/mcp/cluster';

  test('appends mcpServerPath to URL with empty path', () => {
    const result = normalizeRemoteMcpUrl(
      'http://localhost:8080',
      mcpServerPath,
    );
    assert.strictEqual(result, 'http://localhost:8080/mcp/cluster');
  });

  test('appends mcpServerPath to URL with root path', () => {
    const result = normalizeRemoteMcpUrl(
      'http://localhost:8080/',
      mcpServerPath,
    );
    assert.strictEqual(result, 'http://localhost:8080/mcp/cluster');
  });

  test('replaces /v2 with mcpServerPath', () => {
    const result = normalizeRemoteMcpUrl(
      'http://localhost:8080/v2',
      mcpServerPath,
    );
    assert.strictEqual(result, 'http://localhost:8080/mcp/cluster');
  });

  test('keeps URL with existing mcpServerPath', () => {
    const result = normalizeRemoteMcpUrl(
      'http://localhost:8080/mcp/cluster',
      mcpServerPath,
    );
    assert.strictEqual(result, 'http://localhost:8080/mcp/cluster');
  });

  test('preserves custom path', () => {
    const result = normalizeRemoteMcpUrl(
      'http://localhost:8080/custom/path',
      mcpServerPath,
    );
    assert.strictEqual(result, 'http://localhost:8080/custom/path');
  });

  test('handles invalid URLs gracefully', () => {
    const invalidUrl = 'not-a-valid-url';
    const result = normalizeRemoteMcpUrl(invalidUrl, mcpServerPath);
    assert.strictEqual(result, invalidUrl);
  });

  test('preserves protocol, host, and port', () => {
    const result = normalizeRemoteMcpUrl(
      'https://example.com:9443',
      mcpServerPath,
    );
    assert.strictEqual(result, 'https://example.com:9443/mcp/cluster');
  });

  test('handles URLs with query parameters', () => {
    const result = normalizeRemoteMcpUrl(
      'http://localhost:8080/custom?key=value',
      mcpServerPath,
    );
    assert.strictEqual(
      result,
      'http://localhost:8080/custom?key=value',
    );
  });

  test('handles URLs with fragments', () => {
    const result = normalizeRemoteMcpUrl(
      'http://localhost:8080/custom#section',
      mcpServerPath,
    );
    assert.strictEqual(result, 'http://localhost:8080/custom#section');
  });

  test('handles different mcpServerPath values', () => {
    const result = normalizeRemoteMcpUrl(
      'http://localhost:8080',
      '/api/mcp',
    );
    assert.strictEqual(result, 'http://localhost:8080/api/mcp');
  });

  test('replaces /v2 with different mcpServerPath', () => {
    const result = normalizeRemoteMcpUrl(
      'http://localhost:8080/v2',
      '/api/mcp',
    );
    assert.strictEqual(result, 'http://localhost:8080/api/mcp');
  });

  test('handles URL with trailing slash on /v2', () => {
    const result = normalizeRemoteMcpUrl(
      'http://localhost:8080/v2/',
      mcpServerPath,
    );
    assert.strictEqual(result, 'http://localhost:8080/mcp/cluster');
  });
});
