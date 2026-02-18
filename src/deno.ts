/**
 * c8ctl - Camunda 8 CLI
 * Deno entrypoint used for `deno compile`.
 *
 * Notes:
 * - The codebase is primarily Node-oriented (node:* modules, process.env, etc.).
 * - For Deno, we polyfill the minimal Node globals we rely on.
 * - Plugins are optional but require `npm` and `--allow-run`.
 */

import process from 'node:process';
import { Buffer } from 'node:buffer';
import { runCli } from './cli.ts';

// Ensure Node globals exist for code paths that assume them.
// Deno provides node compatibility modules, but globals are not guaranteed.
(globalThis as any).process ??= process;
(globalThis as any).Buffer ??= Buffer;

// Deno-specific interop fix:
// The Camunda SDK passes an internal option named `client` into RequestInit.
// In Deno, `RequestInit.client` is a special field (must be a Deno.HttpClient),
// and passing a non-Deno client causes Request construction to throw.
// We strip non-HttpClient `client` values to keep the SDK compatible.
const OriginalRequest = (globalThis as any).Request as any;
if (typeof OriginalRequest === 'function') {
    class PatchedRequest extends OriginalRequest {
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

    (globalThis as any).Request = PatchedRequest;
}

const deno = (globalThis as any).Deno as { args?: string[] } | undefined;
await runCli(deno?.args ?? []);
