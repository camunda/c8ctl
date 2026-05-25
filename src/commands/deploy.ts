/**
 * Deploy command handler.
 *
 * Side-effectful: collects files, validates, deploys, and renders its own
 * table output.
 *
 * The body lives directly in the handler (per #288): argument-shape
 * resolution, dry-run preview via the framework's `dryRun()` helper,
 * and the call into the shared `deployResources` helper that watch also
 * uses for change-triggered re-deploys.
 */

import { defineCommand, dryRun } from "../command-framework.ts";
import {
	collectResourcesForPaths,
	deployResources,
	logSkippedExtensions,
} from "../deploy-helpers.ts";
import {
	ALL_DEPLOYABLE_EXTENSIONS,
	DEPLOYABLE_EXTENSIONS,
} from "../resource-extensions.ts";

// ─── defineCommand ───────────────────────────────────────────────────────────

/**
 * Resolve the effective extension allow-list from the deploy flags.
 *
 * Priority: --force (no filtering) > --all-extensions > --extensions > default
 *
 * When `--extensions` is provided, the custom list is *merged* with the
 * default (.bpmn, .dmn, .form) so users add to the baseline rather than
 * replacing it.
 */
function resolveExtensionList(flags: {
	force?: boolean;
	extensions?: string;
	"all-extensions"?: boolean;
}): readonly string[] {
	// When --force is set the allow-list is irrelevant — downstream code
	// skips filtering entirely. Return the default so callers always get a
	// valid list, but the value is never consulted.
	if (flags.force) return DEPLOYABLE_EXTENSIONS;

	// --all-extensions: use the full server-supported list
	if (flags["all-extensions"]) return ALL_DEPLOYABLE_EXTENSIONS;

	// --extensions: merge custom extensions with the default set
	if (flags.extensions && String(flags.extensions).trim()) {
		const custom = String(flags.extensions)
			.split(",")
			.map((e) => e.trim())
			.filter(Boolean)
			.map((e) => (e.startsWith(".") ? e : `.${e}`));

		const merged = [...new Set([...DEPLOYABLE_EXTENSIONS, ...custom])];
		return merged;
	}

	return DEPLOYABLE_EXTENSIONS;
}

export const deployCommand = defineCommand("deploy", "", async (ctx, flags) => {
	// Argument shape: `c8 deploy [path...]`. With no positional, default
	// to cwd. Pinned by tests/unit/deploy-behaviour.test.ts.
	const paths = ctx.resource
		? [ctx.resource, ...ctx.positionals]
		: ctx.positionals.length > 0
			? ctx.positionals
			: ["."];

	// Resolve the active extension allow-list from flags.
	// Priority: --force (no filtering) > --all-extensions > --extensions > default
	const extensionList = resolveExtensionList(flags);

	// Dry-run preview. Collect resources first so the preview body
	// reflects what would actually be sent — and so the empty-paths /
	// no-files guards still surface as thrown errors before we emit.
	// Uses `ctx.dryRun` and `ctx.tenantId` from the framework rather
	// than reaching into the global runtime/config layer.
	if (ctx.dryRun) {
		const { resources: previewResources, skippedExtensions } =
			collectResourcesForPaths(paths, flags.force, extensionList);

		logSkippedExtensions(skippedExtensions);

		const dr = dryRun({
			command: "deploy",
			method: "POST",
			endpoint: "/deployments",
			profile: ctx.profile,
			body: {
				tenantId: ctx.tenantId,
				resources: previewResources.map((r) => ({ name: r.name })),
			},
		});
		if (dr) return dr;
	}

	// Execute path: only reached when not in dry-run mode (the branch
	// above returns early). `deployResources` runs its own
	// `collectResourcesForPaths` internally and renders the success
	// table. Keeping the helper self-contained avoids threading
	// pre-collected state between the handler and the shared helper
	// used by `watch`.
	await deployResources(paths, {
		profile: ctx.profile,
		force: flags.force,
		extensionList,
	});
	return { kind: "none" };
});
