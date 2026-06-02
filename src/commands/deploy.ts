/**
 * Deploy command handler.
 *
 * Side-effectful: collects files, validates, deploys, and renders its own
 * table output.
 *
 * The body lives directly in the handler (per #288): argument-shape
 * resolution, dry-run preview via the context's `ctx.dryRun()` helper,
 * and the call into the shared `deployResources` helper that watch also
 * uses for change-triggered re-deploys.
 */

import { appendFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import {
	c8ctl,
	createClient,
	DEFAULT_PROFILE,
	getAllProfiles,
	getProfileOrModeler,
	readSkipDeployConfirm,
	saveSkipDeployConfirm,
} from "../core/index.ts";
import { defineCommand, isInteractive, select } from "../framework/index.ts";
import {
	ALL_DEPLOYABLE_EXTENSIONS,
	DEPLOYABLE_EXTENSIONS,
	resolveIgnoreBaseDir,
} from "../utils/index.ts";
import {
	checkServerSupportsExtensions,
	collectResourcesForPaths,
	deployResources,
	logMessage,
	logSkippedExtensions,
} from "./helpers/deploy-helpers.ts";

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

// ── Skipped-files interactive menu ────────────────────────────────

type SkippedFilesAction =
	| "deploy-once"
	| "ignore"
	| "deploy-always"
	| "ignore-always"
	| "instructions";

/**
 * Present an interactive menu when files are skipped during deployment
 * due to extension filtering. Returns file paths to include in the
 * deployment (empty if the user chose to ignore).
 */
async function handleSkippedFiles(
	skippedFiles: string[],
	skippedExtensions: Set<string>,
	basePath: string,
): Promise<string[]> {
	if (skippedFiles.length === 0) return [];

	const exts = [...skippedExtensions].sort().join(", ");
	const fileList = skippedFiles
		.map((f) => relative(basePath, f) || basename(f))
		.sort();

	logMessage(
		`\nFound ${skippedFiles.length} file(s) with extensions not in the allow-list (${exts}):`,
	);
	for (const f of fileList) {
		logMessage(`  • ${f}`);
	}

	const result = await select<SkippedFilesAction>({
		message: "What do you want to do about these files?",
		options: [
			{
				label: "Deploy them",
				description: "include in this deployment only",
				value: "deploy-once",
			},
			{
				label: "Ignore them",
				description: "skip for now",
				value: "ignore",
			},
			{
				label: "Deploy them always",
				description: "remember to deploy these files in .c8ignore",
				value: "deploy-always",
			},
			{
				label: "Ignore them always",
				description: "remember to skip these files in .c8ignore",
				value: "ignore-always",
			},
			{
				label: "Show me how to configure this",
				description: "print instructions and exit",
				value: "instructions",
			},
		],
	});

	if (result.cancelled) {
		return [];
	}

	const action = result.value;

	if (action === "ignore") {
		return [];
	}

	if (action === "deploy-once") {
		return skippedFiles;
	}

	if (action === "deploy-always") {
		const c8ignorePath = join(basePath, ".c8ignore");
		// Prefix with "/" to anchor patterns to the .c8ignore base dir.
		// Without anchoring, a root-level file like "notes.md" would
		// match at any depth (e.g. subdir/notes.md).
		const patterns = skippedFiles.map(
			(f) => `!/${relative(basePath, f).split(sep).join("/")}`,
		);
		const block = `\n# Auto-added by c8ctl — always deploy these files\n${patterns.join("\n")}\n`;

		appendFileSync(c8ignorePath, block);
		logMessage(
			`\nAppended to ${relative(process.cwd(), c8ignorePath) || c8ignorePath}:`,
		);
		for (const p of patterns) {
			logMessage(`  ${p}`);
		}
		logMessage("\nFuture deploys will include these files automatically.\n");
		// Include the skipped files in this deploy as well — the label
		// says "Deploy them always", which implies "starting now".
		return skippedFiles;
	}

	if (action === "ignore-always") {
		const c8ignorePath = join(basePath, ".c8ignore");
		// Filter out the "<no extension>" sentinel — it has no valid glob representation
		const realExtensions = [...skippedExtensions]
			.filter((ext) => ext !== "<no extension>")
			.sort();
		if (realExtensions.length === 0) {
			logMessage(
				"\nAll skipped files have no extension — cannot auto-ignore by extension.",
			);
			logMessage("Add specific file patterns to .c8ignore manually.\n");
			return [];
		}
		const patterns = realExtensions.map((ext) => `*${ext}`);
		const block = `\n# Auto-added by c8ctl — ignore ${realExtensions.join(", ")} files\n${patterns.join("\n")}\n`;

		appendFileSync(c8ignorePath, block);
		logMessage(
			`\nAppended to ${relative(process.cwd(), c8ignorePath) || c8ignorePath}:`,
		);
		for (const p of patterns) {
			logMessage(`  ${p}`);
		}
		logMessage("");
		return [];
	}

	// action === "instructions"
	logMessage(`
Extension filtering controls which files are included when scanning directories.

  Default allow-list: .bpmn, .dmn, .form

  Flags:
    --extensions=<ext>    Add specific extensions (merged with defaults)
                          Example: c8 deploy --extensions=.md,.txt

    --all-extensions      Include all server-supported types
                          (.md, .txt, .xml, .rpa, .json, .config, .yml, .yaml)

    --force               Skip extension filtering entirely

  Persistence:
    .c8ignore             Add *<ext> patterns to exclude files permanently
                          Example: echo "*.md" >> .c8ignore

  Explicit files bypass the allow-list:
    c8 deploy my-file.md  (deploys regardless of extension)
`);
	throw new Error(
		"Exiting. Re-run deploy after configuring extension filtering.",
	);
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
	const extensionList = resolveExtensionList(flags);

	// ── Deploy target confirmation (interactive profile selector) ─────
	let deployProfile = ctx.profile;
	const ALWAYS_ACTIVE = Symbol("alwaysActive");
	if (!ctx.yes && !ctx.profile) {
		const profiles = getAllProfiles();
		if (profiles.length > 1) {
			const { activeProfile } = c8ctl;
			const activeConfig =
				activeProfile != null ? getProfileOrModeler(activeProfile) : undefined;
			const envIsEffectiveTarget =
				!!process.env.CAMUNDA_BASE_URL && activeConfig == null;

			if (!envIsEffectiveTarget) {
				const skipDeployConfirm = readSkipDeployConfirm();
				if (!skipDeployConfirm) {
					const effectiveName =
						activeProfile != null && activeConfig != null
							? activeProfile
							: DEFAULT_PROFILE;
					const defaultIndex = Math.max(
						0,
						profiles.findIndex((p) => p.name === effectiveName),
					);

					const profileOptions: Array<{
						label: string;
						description: string | undefined;
						value: string | symbol;
					}> = profiles.map((p) => ({
						label: p.name,
						description: p.baseUrl,
						value: p.name,
					}));
					profileOptions.push({
						label: `Always use "${effectiveName}" (don't ask again)`,
						description: "Persists to session — reset with: c8 use profile",
						value: ALWAYS_ACTIVE,
					});

					const result = await select({
						message: "Which profile do you want to deploy to?",
						options: profileOptions,
						initialIndex: defaultIndex,
						nonInteractiveHint:
							"Hint: run interactively to choose, or use --profile=<name> to specify.",
					});

					if (result.cancelled) {
						throw new Error("Deploy cancelled.");
					} else if (!result.interactive) {
						throw new Error(
							`Multiple profiles configured but no profile specified.\n` +
								`Use --profile=<name> or --yes to skip the prompt.\n` +
								`Available profiles: ${profiles.map((p) => p.name).join(", ")}`,
						);
					} else if (result.value === ALWAYS_ACTIVE) {
						saveSkipDeployConfirm(true);
						logMessage(
							`Future deploys will use the active profile without prompting. Reset with: c8 use profile <name>`,
						);
					} else if (
						typeof result.value === "string" &&
						result.value !== effectiveName
					) {
						deployProfile = result.value;
					}
				}
			}
		}
	}

	// Dry-run preview. Collect resources first so the preview body
	// reflects what would actually be sent — and so the empty-paths /
	// no-files guards still surface as thrown errors before we emit.
	// Uses `ctx.isDryRun` and `ctx.tenantId` from the framework rather
	// than reaching into the global runtime/config layer.
	//
	// Note: dry-run runs before the server version check, so on clusters
	// <8.10 the preview may include extended-extension resources or
	// deploy-always negation rules that the real deploy path would
	// exclude. This is acceptable — dry-run is a best-effort preview
	// and avoids an unnecessary HTTP call when only previewing.
	if (ctx.isDryRun) {
		const { resources: previewResources, skippedExtensions } =
			collectResourcesForPaths(paths, flags.force, extensionList);

		logSkippedExtensions(skippedExtensions);

		const dr = ctx.dryRun({
			command: "deploy",
			method: "POST",
			endpoint: "/deployments",
			profile: deployProfile,
			body: {
				tenantId: ctx.tenantId,
				resources: previewResources.map((r) => ({ name: r.name })),
			},
		});
		if (dr) return dr;
	}

	// ── Pre-flight version check ──
	// Skip the topology call when --force is set — extension filtering
	// is bypassed entirely, so the result is unused.
	const serverSupportsExtensions = flags.force
		? true
		: await checkServerSupportsExtensions(createClient(deployProfile));

	// ── Collect resources and handle skipped files interactively ──
	// Fall back to the default allow-list on servers that don't support
	// extended extensions (<8.10). Note: explicit file paths bypass
	// extension filtering by design, so this only gates directory scans.
	const userRequestedExtensions =
		!!flags["all-extensions"] || !!flags.extensions;
	const effectiveExtensions = serverSupportsExtensions
		? extensionList
		: DEPLOYABLE_EXTENSIONS;

	if (!serverSupportsExtensions && userRequestedExtensions) {
		logMessage(
			`Warning: server does not support extended extensions (requires 8.10+). ` +
				`Falling back to default extensions (${DEPLOYABLE_EXTENSIONS.join(", ")}). ` +
				`Use --force to deploy all files regardless.`,
		);
	}

	const {
		skippedFiles,
		skippedExtensions,
		effectivePaths: resolvedPaths,
	} = collectResourcesForPaths(
		paths,
		flags.force,
		effectiveExtensions,
		serverSupportsExtensions,
	);

	// Use the effective (possibly PA-expanded) paths for .c8ignore and
	// display-path resolution so patterns align with the scan root.
	const basePath = resolveIgnoreBaseDir(resolvedPaths);

	let extraPaths: string[] = [];
	if (
		skippedFiles.length > 0 &&
		!ctx.yes &&
		serverSupportsExtensions &&
		isInteractive()
	) {
		extraPaths = await handleSkippedFiles(
			skippedFiles,
			skippedExtensions,
			basePath,
		);
	} else if (skippedFiles.length > 0) {
		logSkippedExtensions(skippedExtensions);
	}

	await deployResources([...paths, ...extraPaths], {
		profile: deployProfile,
		force: flags.force,
		extensionList: effectiveExtensions,
		suppressSkippedLog: skippedFiles.length > 0,
		loadDeployAlways: serverSupportsExtensions,
		basePath,
		verbose: ctx.verbose,
	});
	return { kind: "none" };
});
