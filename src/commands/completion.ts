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
 * registration resource. The framework uses `ctx.resource` for error
 * messages so failures on non-install branches are not mislabelled
 * "Failed to completion install".
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
		// Note: `flags.shell` may still be populated here because dispatch is
		// `completion:` regardless of resource and the install schema is in
		// effect — `parseArgs` will accept `--shell` and `deserializeFlags`
		// will populate it. `detectUnknownFlags` (src/command-validation.ts)
		// emits a warning that `--shell` is not valid for non-install
		// resources, but the value is not stripped. This branch deliberately
		// ignores `flags.shell`; the warning is the user-facing signal.
		showCompletion(resource || undefined);
		return undefined;
	},
);
