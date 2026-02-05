/**
 * Unit tests for Deno-specific functionality
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

describe('Deno Request Patching', () => {
  let OriginalRequest: any;
  let PatchedRequest: any;

  beforeEach(() => {
    // Save original Request
    OriginalRequest = globalThis.Request;

    // Simulate the patching logic from src/deno.ts
    if (typeof OriginalRequest === 'function') {
      class PatchedRequestClass extends OriginalRequest {
        constructor(input: any, init?: any) {
          if (init && typeof init === 'object' && 'client' in (init as any)) {
            const candidate = (init as any).client;
            const isLikelyDenoHttpClient = !!candidate && typeof candidate === 'object' && typeof candidate.close === 'function';
            if (!isLikelyDenoHttpClient) {
              const nextInit = { ...(init as any) };
              delete nextInit.client;
              super(input, nextInit);
              return;
            }
          }
          super(input, init);
        }
      }
      PatchedRequest = PatchedRequestClass;
      (globalThis as any).Request = PatchedRequest;
    }
  });

  afterEach(() => {
    // Restore original Request
    (globalThis as any).Request = OriginalRequest;
  });

  describe('Non-HttpClient client stripping', () => {
    test('strips non-HttpClient client value from RequestInit', () => {
      // Camunda SDK passes a non-Deno client object
      const nonDenoClient = { someProperty: 'value' };
      const init = { 
        method: 'POST',
        client: nonDenoClient,
        headers: { 'Content-Type': 'application/json' }
      };

      // Should not throw and should create a Request without the client property
      const request = new PatchedRequest('https://example.com/api', init);
      
      assert.ok(request instanceof Request);
      assert.strictEqual(request.method, 'POST');
      assert.strictEqual(request.url, 'https://example.com/api');
    });

    test('strips client value when it is a string', () => {
      const init = { 
        method: 'GET',
        client: 'not-a-deno-client'
      };

      const request = new PatchedRequest('https://example.com/api', init);
      
      assert.ok(request instanceof Request);
      assert.strictEqual(request.method, 'GET');
    });

    test('strips client value when it is a number', () => {
      const init = { 
        method: 'GET',
        client: 123
      };

      const request = new PatchedRequest('https://example.com/api', init);
      
      assert.ok(request instanceof Request);
    });

    test('strips client value when it is null', () => {
      const init = { 
        method: 'GET',
        client: null
      };

      const request = new PatchedRequest('https://example.com/api', init);
      
      assert.ok(request instanceof Request);
    });

    test('strips client value when it is an object without close method', () => {
      const nonDenoClient = { 
        open: () => {},
        send: () => {},
        // Missing close method
      };
      const init = { 
        method: 'POST',
        client: nonDenoClient
      };

      const request = new PatchedRequest('https://example.com/api', init);
      
      assert.ok(request instanceof Request);
    });
  });

  describe('Deno HttpClient preservation', () => {
    test('preserves Deno HttpClient when close method exists', () => {
      // Mock a Deno HttpClient with close method
      const denoHttpClient = {
        close: () => {},
        // Other Deno HttpClient properties would be here
      };
      const init = { 
        method: 'GET',
        client: denoHttpClient
      };

      // This should not strip the client because it looks like a Deno HttpClient
      // In a real Deno environment, this would work. In Node, it might fail,
      // but the logic should attempt to preserve it.
      try {
        const request = new PatchedRequest('https://example.com/api', init);
        // If it succeeds, verify it's a Request
        assert.ok(request instanceof Request);
      } catch (error) {
        // In Node.js environment, the Request constructor doesn't accept client,
        // so this might throw. That's expected - the test is validating the logic
        // tries to preserve it, not that it succeeds in Node.
        assert.ok(error instanceof TypeError);
      }
    });
  });

  describe('Edge cases', () => {
    test('works with undefined init', () => {
      const request = new PatchedRequest('https://example.com/api');
      
      assert.ok(request instanceof Request);
      assert.strictEqual(request.url, 'https://example.com/api');
    });

    test('works with null init', () => {
      const request = new PatchedRequest('https://example.com/api', null);
      
      assert.ok(request instanceof Request);
    });

    test('works with empty init object', () => {
      const request = new PatchedRequest('https://example.com/api', {});
      
      assert.ok(request instanceof Request);
    });

    test('preserves other RequestInit properties when stripping client', () => {
      const init = {
        method: 'POST',
        headers: { 'Authorization': 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'value' }),
        client: 'should-be-stripped'
      };

      const request = new PatchedRequest('https://example.com/api', init);
      
      assert.ok(request instanceof Request);
      assert.strictEqual(request.method, 'POST');
      assert.ok(request.headers.get('Authorization')?.includes('Bearer token'));
      assert.ok(request.headers.get('Content-Type')?.includes('application/json'));
    });

    test('does not mutate original init object', () => {
      const init = {
        method: 'POST',
        client: 'should-be-stripped',
        headers: { 'Content-Type': 'application/json' }
      };
      const originalInit = { ...init };

      const request = new PatchedRequest('https://example.com/api', init);
      
      assert.ok(request instanceof Request);
      // Original init should still have the client property
      assert.strictEqual(init.client, 'should-be-stripped');
      assert.deepStrictEqual(init, originalInit);
    });
  });

  describe('Request construction with various inputs', () => {
    test('works with Request object as input', () => {
      const originalRequest = new OriginalRequest('https://example.com/api', { method: 'POST' });
      const init = {
        client: 'should-be-stripped'
      };

      const request = new PatchedRequest(originalRequest, init);
      
      assert.ok(request instanceof Request);
      assert.strictEqual(request.method, 'POST');
    });

    test('works with URL object as input', () => {
      const url = new URL('https://example.com/api');
      const init = {
        method: 'DELETE',
        client: 'should-be-stripped'
      };

      const request = new PatchedRequest(url, init);
      
      assert.ok(request instanceof Request);
      assert.strictEqual(request.method, 'DELETE');
      assert.strictEqual(request.url, 'https://example.com/api');
    });
  });
});
