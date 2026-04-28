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
 * All validation errors are raised via `throw` so the framework wrapper
 * routes them through `handleCommandError`. The architectural guard in
 * `tests/unit/no-process-exit-in-handlers.test.ts` forbids `process.exit`
 * here.
 */
export const completionCommand = defineCommand(
	"completion",
	"",
	async (ctx, flags) => {
		const resource = ctx.resource;
		if (resource === "install") {
			const shellFlag = flags.shell;
			installCompletion(typeof shellFlag === "string" ? shellFlag : undefined);
			return undefined;
		}
		// Empty resource → show usage error consistent with prior behaviour.
		showCompletion(resource || undefined);
		return undefined;
	},
);
