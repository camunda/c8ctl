/**
 * Class-of-defect regression guard for `c8 mcp-proxy` error paths.
 *
 * Status of `mcp-proxy` for issue #288:
 *
 *   `src/commands/mcp-proxy.ts` is **already #288-compliant at the
 *   file level**: the handler body lives directly inside
 *   `defineCommand("mcp-proxy", "", ...)`, uses `ctx.profile` and
 *   `ctx.resource`/`ctx.positionals` from the framework context,
 *   returns `{ kind: "never" }` for the long-running case, and does
 *   not call `process.exit(...)`.
 *
 *   The migration that #288 prescribes for `mcp-proxy` is therefore
 *   the no-op shape it already has. This file pins that shape so it
 *   cannot drift back.
 *
 * Intentional protocol-driven deviation from the standard #288 shape:
 *
 *   The `mcp-proxy` handler catches its own startup/shutdown errors
 *   and sets `process.exitCode = 1` rather than `throw`-ing into the
 *   framework's `handleCommandError` wrapper. This is REQUIRED by the
 *   MCP STDIO protocol contract:
 *
 *     - MCP clients read framed JSON-RPC messages from the proxy's
 *       stdout. Any non-protocol bytes on stdout corrupt the stream
 *       and break the client.
 *     - The framework's default error handler renders user-facing
 *       hints to stdout via the active logger. For `mcp-proxy` that
 *       would write into the protocol channel.
 *     - The handler installs a stderr-only `Logger`, surfaces the
 *       failure on stderr, and signals failure via `process.exitCode`
 *       so the event loop drains naturally without re-entering the
 *       framework's stdout-emitting error path.
 *
 *   The structural guard below uses the AST-based scanner that
 *   intentionally does NOT flag `process.exitCode = N`
 *   (see `tests/utils/no-process-exit.ts`'s file docstring), so this
 *   protocol-driven idiom is permitted while still rejecting any
 *   future regression that adds a real `process.exit(...)` call.
 *
 * Existing behavioural coverage on main (don't duplicate here):
 *
 *   - `tests/integration/mcp-proxy-mock.test.ts` covers the
 *     `createCamundaFetch` request path against a mock server: auth
 *     headers, 404 / 500 / connection-refused / timeout / slow-server
 *     handling, the 401 + token-refresh retry, custom request
 *     headers, and POST-with-body.
 *   - `tests/unit/mcp-proxy.test.ts` covers `normalizeRemoteMcpUrl`.
 *   - `tests/unit/mcp-proxy-auth.test.ts` covers the auth-header
 *     attachment behaviour of `createCamundaFetch`.
 *
 * Guard in this file:
 *
 *   STRUCTURAL — AST scan over `src/commands/mcp-proxy.ts` for zero
 *   `process.exit(...)` call expressions. Mirrors the structural part
 *   of `tests/unit/deploy-error-paths.test.ts`,
 *   `tests/unit/run-error-paths.test.ts`, and
 *   `tests/unit/open-error-paths.test.ts`. AST-based (not regex) so
 *   string literals containing `process.exit(` and stripped-comment
 *   edge cases cannot produce false positives or false negatives.
 *   `process.exitCode = N` is correctly distinguished and permitted.
 */

import assert from "node:assert";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { findProcessExitCalls } from "../utils/no-process-exit.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const MCP_PROXY_TS = join(PROJECT_ROOT, "src", "commands", "mcp-proxy.ts");

describe("mcp-proxy: structural guard — no process.exit in mcp-proxy.ts", () => {
	test("src/commands/mcp-proxy.ts contains no `process.exit(...)` calls", () => {
		const calls = findProcessExitCalls(MCP_PROXY_TS);
		assert.strictEqual(
			calls.length,
			0,
			`Expected zero \`process.exit(...)\` calls in mcp-proxy.ts, found ${calls.length}:\n` +
				calls
					.map((c) => `  - line ${c.line}:${c.column} — ${c.text}`)
					.join("\n") +
				`\n\nThe MCP STDIO protocol forbids non-protocol bytes on stdout. Use\n` +
				`\`process.exitCode = 1\` + a stderr log line so the event loop drains\n` +
				`naturally, instead of re-entering the framework's stdout-emitting\n` +
				`error path. \`process.exitCode = N\` is permitted by this guard.`,
		);
	});
});
