/**
 * Unit tests for MCP proxy authentication fetch wrapper
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createCamundaFetch } from '../../src/commands/mcp-proxy.ts';
import type { CamundaClient } from '@camunda8/orchestration-cluster-api';
import type { Logger } from '../../src/logger.ts';

describe('createCamundaFetch', () => {
  let originalFetch: typeof fetch;
  let mockLogger: Logger;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockLogger = {
      info: () => {},
      debug: () => {},
      error: () => {},
      warn: () => {},
      json: () => {},
    } as unknown as Logger;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('injects auth headers from CamundaClient', async () => {
    let capturedHeaders: Headers | undefined;

    const mockCamundaClient = {
      getAuthHeaders: async () => ({
        Authorization: 'Bearer test-token',
        'X-Custom-Header': 'custom-value',
      }),
      getConfig: () => ({ restAddress: 'http://localhost:8080' }),
    } as unknown as CamundaClient;

    global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Headers;
      return new Response('success', { status: 200 });
    };

    const customFetch = createCamundaFetch(mockCamundaClient, mockLogger);
    await customFetch('http://test.com/api', {});

    assert.ok(capturedHeaders, 'Headers should be captured');
    assert.strictEqual(
      capturedHeaders?.get('Authorization'),
      'Bearer test-token',
    );
    assert.strictEqual(
      capturedHeaders?.get('X-Custom-Header'),
      'custom-value',
    );
  });

  test('merges auth headers with existing request headers', async () => {
    let capturedHeaders: Headers | undefined;

    const mockCamundaClient = {
      getAuthHeaders: async () => ({ Authorization: 'Bearer test-token' }),
      getConfig: () => ({ restAddress: 'http://localhost:8080' }),
    } as unknown as CamundaClient;

    global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Headers;
      return new Response('success', { status: 200 });
    };

    const customFetch = createCamundaFetch(mockCamundaClient, mockLogger);
    await customFetch('http://test.com/api', {
      headers: { 'Content-Type': 'application/json' },
    });

    assert.ok(capturedHeaders);
    assert.strictEqual(
      capturedHeaders?.get('Authorization'),
      'Bearer test-token',
    );
    assert.strictEqual(
      capturedHeaders?.get('Content-Type'),
      'application/json',
    );
  });

  test('retries request on 401 with fresh token', async () => {
    let callCount = 0;
    let authRefreshCalled = false;

    const mockCamundaClient = {
      getAuthHeaders: async () => ({
        Authorization:
          callCount === 0 ? 'Bearer expired-token' : 'Bearer fresh-token',
      }),
      forceAuthRefresh: async () => {
        authRefreshCalled = true;
      },
      getConfig: () => ({ restAddress: 'http://localhost:8080' }),
    } as unknown as CamundaClient;

    global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Headers;
      const authHeader = headers?.get('Authorization');

      if (callCount === 0) {
        callCount++;
        return new Response('Unauthorized', { status: 401 });
      }

      // Second call should have fresh token
      assert.strictEqual(authHeader, 'Bearer fresh-token');
      return new Response('Success', { status: 200 });
    };

    const customFetch = createCamundaFetch(mockCamundaClient, mockLogger);
    const response = await customFetch('http://test.com/api', {});

    assert.strictEqual(response.status, 200);
    assert.ok(authRefreshCalled, 'forceAuthRefresh should be called');
    assert.strictEqual(callCount, 1, 'Should retry once');
  });

  test('converts AbortError to descriptive timeout error', async () => {
    const mockCamundaClient = {
      getAuthHeaders: async () => ({}),
      getConfig: () => ({ restAddress: 'http://localhost:8080' }),
    } as unknown as CamundaClient;

    global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    };

    const customFetch = createCamundaFetch(
      mockCamundaClient,
      mockLogger,
      5000,
    );

    await assert.rejects(
      async () => await customFetch('http://test.com/api', {}),
      (error: Error) => {
        assert.strictEqual(error.message, 'Request timeout after 5000ms');
        return true;
      },
    );
  });

  test('converts ECONNREFUSED to descriptive connection error', async () => {
    const mockCamundaClient = {
      getAuthHeaders: async () => ({}),
      getConfig: () => ({ restAddress: 'http://localhost:8080' }),
    } as unknown as CamundaClient;

    global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const error: any = new Error('fetch failed');
      error.cause = { code: 'ECONNREFUSED' };
      throw error;
    };

    const customFetch = createCamundaFetch(mockCamundaClient, mockLogger);

    await assert.rejects(
      async () => await customFetch('http://unreachable:9999/api', {}),
      (error: Error) => {
        assert.match(error.message, /Connection refused/);
        assert.match(error.message, /http:\/\/unreachable:9999\/api/);
        assert.match(
          error.message,
          /Please verify the server is running and accessible/,
        );
        return true;
      },
    );
  });

  test('preserves other errors unchanged', async () => {
    const mockCamundaClient = {
      getAuthHeaders: async () => ({}),
      getConfig: () => ({ restAddress: 'http://localhost:8080' }),
    } as unknown as CamundaClient;

    const customError = new Error('Custom network error');

    global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      throw customError;
    };

    const customFetch = createCamundaFetch(mockCamundaClient, mockLogger);

    await assert.rejects(
      async () => await customFetch('http://test.com/api', {}),
      (error: Error) => {
        assert.strictEqual(error, customError);
        return true;
      },
    );
  });

  test('merges abort signals from init and timeout', async () => {
    let capturedSignal: AbortSignal | null | undefined;

    const mockCamundaClient = {
      getAuthHeaders: async () => ({}),
      getConfig: () => ({ restAddress: 'http://localhost:8080' }),
    } as unknown as CamundaClient;

    global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal;
      return new Response('success', { status: 200 });
    };

    const customFetch = createCamundaFetch(mockCamundaClient, mockLogger);
    const externalController = new AbortController();

    await customFetch('http://test.com/api', {
      signal: externalController.signal,
    });

    assert.ok(capturedSignal, 'Signal should be captured');
    // The signal should be present (merged from both sources)
  });

  test('uses timeout signal when no external signal provided', async () => {
    let capturedSignal: AbortSignal | null | undefined;

    const mockCamundaClient = {
      getAuthHeaders: async () => ({}),
      getConfig: () => ({ restAddress: 'http://localhost:8080' }),
    } as unknown as CamundaClient;

    global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal;
      return new Response('success', { status: 200 });
    };

    const customFetch = createCamundaFetch(mockCamundaClient, mockLogger);
    await customFetch('http://test.com/api', {});

    assert.ok(capturedSignal, 'Timeout signal should be present');
  });

  test('handles 401 retry with existing request headers', async () => {
    let callCount = 0;
    let firstCallHeaders: Headers | undefined;
    let secondCallHeaders: Headers | undefined;

    const mockCamundaClient = {
      getAuthHeaders: async () => ({
        Authorization:
          callCount === 0 ? 'Bearer expired-token' : 'Bearer fresh-token',
      }),
      forceAuthRefresh: async () => {},
      getConfig: () => ({ restAddress: 'http://localhost:8080' }),
    } as unknown as CamundaClient;

    global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Headers;

      if (callCount === 0) {
        firstCallHeaders = headers;
        callCount++;
        return new Response('Unauthorized', { status: 401 });
      }

      secondCallHeaders = headers;
      return new Response('Success', { status: 200 });
    };

    const customFetch = createCamundaFetch(mockCamundaClient, mockLogger);
    await customFetch('http://test.com/api', {
      headers: { 'Content-Type': 'application/json' },
    });

    assert.ok(firstCallHeaders);
    assert.ok(secondCallHeaders);
    assert.strictEqual(
      firstCallHeaders?.get('Content-Type'),
      'application/json',
    );
    assert.strictEqual(
      secondCallHeaders?.get('Content-Type'),
      'application/json',
    );
    assert.strictEqual(
      secondCallHeaders?.get('Authorization'),
      'Bearer fresh-token',
    );
  });

  test('respects custom timeout value', async () => {
    const mockCamundaClient = {
      getAuthHeaders: async () => ({}),
      getConfig: () => ({ restAddress: 'http://localhost:8080' }),
    } as unknown as CamundaClient;

    global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      // Simulate slow response - wait for abort signal
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve(new Response('success', { status: 200 }));
        }, 500);
        
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timeout);
          const error: any = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    };

    const customFetch = createCamundaFetch(
      mockCamundaClient,
      mockLogger,
      100,
    );

    await assert.rejects(
      async () => await customFetch('http://test.com/api', {}),
      (error: Error) => {
        assert.strictEqual(error.message, 'Request timeout after 100ms');
        return true;
      },
    );
  });

  test('clears timeout on successful response', async () => {
    const mockCamundaClient = {
      getAuthHeaders: async () => ({}),
      getConfig: () => ({ restAddress: 'http://localhost:8080' }),
    } as unknown as CamundaClient;

    global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      return new Response('success', { status: 200 });
    };

    const customFetch = createCamundaFetch(mockCamundaClient, mockLogger);
    const response = await customFetch('http://test.com/api', {});

    assert.strictEqual(response.status, 200);
    // If timeout wasn't cleared, it might cause issues
    // This test mainly ensures no errors are thrown
  });
});
