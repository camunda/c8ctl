/**
 * Shared test stubs for SDK / internal class types that cannot be satisfied
 * structurally from a test.
 *
 * These helpers centralize the unavoidable `as unknown as T` boundary so that
 * individual tests do not each carry their own `biome-ignore lint/plugin`
 * directives for the `no-unsafe-type-assertion` plugin.
 *
 * Overloads accept a partial shape so tests can supply whatever fields the
 * code under test actually touches; everything else is stubbed to a no-op.
 */

import type { createClient } from "../../src/client.ts";
import type { Logger } from "../../src/logger.ts";

type CamundaClient = ReturnType<typeof createClient>;

/**
 * Build a CamundaClient stub from a partial shape.
 *
 * The cast crosses the test/SDK boundary: CamundaClient is a class with
 * private state that cannot be reproduced structurally.
 */
export function makeMockClient(
	partial: Record<string, unknown> = {},
): CamundaClient {
	// biome-ignore lint/plugin: test-only stub for CamundaClient class; structural satisfaction impractical
	return partial as unknown as CamundaClient;
}

/**
 * Build a Logger stub. Defaults all methods to no-ops; override individual
 * methods by passing them in `partial`.
 */
export function makeMockLogger(partial: Partial<Logger> = {}): Logger {
	const base = {
		info: () => {},
		debug: () => {},
		error: () => {},
		warn: () => {},
		json: () => {},
		table: () => {},
		output: () => {},
		...partial,
	};
	// biome-ignore lint/plugin: test-only stub for Logger class; structural satisfaction impractical
	return base as unknown as Logger;
}

/**
 * Build a NodeJS.ProcessEnv from `process.env` plus overrides, without
 * needing an `as NodeJS.ProcessEnv` cast at call sites.
 */
export function makeTestEnv(
	overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
	return { ...process.env, ...overrides };
}

/**
 * Replace `process.exit` with a throwing stub and return a restore function.
 * The returned stub always throws `new Error("exit")` so callers can assert
 * on it via `await ....catch(() => {})` or `assert.throws`. The optional
 * `onExit` callback runs before the throw and receives the exit code; if it
 * throws, its error propagates instead of the default `Error("exit")`.
 *
 * Centralizes the unavoidable cast: the replacement function always throws,
 * so its return type is `never`, but TypeScript cannot widen
 * `(code?: number | string | null) => never` from a plain `() => never`
 * without help.
 */
export function mockProcessExit(
	onExit?: (code?: number | string | null) => void,
): () => void {
	const original = process.exit;
	const stub = ((code?: number | string | null): never => {
		onExit?.(code);
		throw new Error("exit");
	}) satisfies (code?: number | string | null) => never;
	// biome-ignore lint/plugin: test-only override of process.exit global; signature matches via satisfies
	process.exit = stub as typeof process.exit;
	return () => {
		process.exit = original;
	};
}
