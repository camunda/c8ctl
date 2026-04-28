/**
 * Thin handler wrapper for the `completion` verb.
 *
 * All shell-completion implementation logic (rendering, install,
 * detection, refresh) lives in `src/completion.ts` so it can be unit
 * tested without violating the test→commands import boundary (#291).
 * This file holds only the `defineCommand` wrapper that dispatches the
 * verb at runtime.
 */

import { defineCommand } from "../command-framework.ts";
import { installCompletion, showCompletion } from "../completion.ts";

/**
 * `completion` verb dispatcher.
 *
 * `completion` is modelled in the registry with `requiresResource: false`
 * and enumerated resources `["bash", "zsh", "fish", "install"]`. The
 * registry-driven dispatch in `src/index.ts` routes any completion
 * invocation to `completion:` because `requiresResource` is false. This
 * single handler branches on the incoming resource.
 *
 * Registered against `"install"` (not `""`) so the typed `flags`
 * parameter includes `shell` — the only resource-scoped flag, declared
 * in `resourceFlags.install` per the verb/resource flag-bucket
 * disjointness invariant (#256). The dispatch key is still `completion:`
 * because dispatch is derived from `requiresResource`, not from the
 * registration resource.
 *
 * All validation errors are raised via `throw` so the framework wrapper
 * routes them through `handleCommandError`. The architectural guard in
 * `tests/unit/no-process-exit-in-handlers.test.ts` forbids `process.exit`
 * here.
 */
export const completionCommand = defineCommand(
	"completion",
	"install",
	async (ctx, flags) => {
		const resource = ctx.resource;
		if (resource === "install") {
			const shellFlag = flags.shell;
			installCompletion(typeof shellFlag === "string" ? shellFlag : undefined);
			return undefined;
		}
		// Non-install resource → render the requested shell's completion script.
		// `--shell` is unknown-flag-rejected for non-install resources by
		// `detectUnknownFlags`, so it is never set on this branch.
		showCompletion(resource || undefined);
		return undefined;
	},
);
