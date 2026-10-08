/**
 * Shared runner for `element-template update` and `element-template change`:
 * migrate one element to another template version or to another template,
 * carrying its values along with the recipe the target template declares.
 */

import { closeSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve as resolvePath } from "node:path";
import semver from "semver";
import type {} from "../../../src/core/runtime.ts";
import { loadCache, pickVersion, requireCachePresent } from "../cache.ts";
import {
	atomicOverwriteFile,
	installStdoutEpipeHandler,
	type Template,
} from "../helpers.ts";
import {
	type MigrationModeler,
	migrateElement,
	readAppliedTemplate,
} from "../migration/apply.ts";
import {
	parseRecipe,
	type Recipe,
	RecipeError,
	readEmbeddedRecipe,
	validateRecipeOwner,
} from "../migration/recipe.ts";
import { buildReport } from "../migration/report.ts";
import { findSuccessors } from "../migration/steps.ts";
import type { MigrationTemplate } from "../migration/types.ts";
import {
	type RecipeSource,
	renderReportText,
	reportToJson,
	shouldUseColor,
} from "../migration-output.ts";
import {
	getExecutionPlatformVersion,
	parseTemplateRef,
	readBpmnInput,
	readTemplateFromPathOrUrl,
	resolveOotbTemplate,
} from "../template-ref.ts";
import {
	type BpmnElement,
	type ModelerInstance,
	resolveVendorBundle,
	type VendorBundle,
} from "../vendor.ts";

if (!globalThis.c8ctl) throw new Error("c8ctl runtime not initialised");
const c8ctl = globalThis.c8ctl;
const require = createRequire(import.meta.url);

export type MigrateMode = "change" | "update";

export const USAGE: Record<MigrateMode, string> = {
	change:
		"c8ctl element-template change <template> <element-id> [<file.bpmn>] | change --successor <element-id> [<file.bpmn>]",
	update: "c8ctl element-template update <element-id> [<file.bpmn>]",
};

interface MigrateArgs {
	inPlace: boolean;
	allowLossy: boolean;
	successor: boolean;
	recipePath: string | undefined;
	toVersion: number | undefined;
	positionals: string[];
}

function readFlagValue(
	args: string[],
	index: number,
	flag: string,
): { value: string; skip: number } {
	const arg = args[index];
	if (arg.startsWith(`${flag}=`)) {
		return { value: arg.slice(flag.length + 1), skip: 0 };
	}
	const next = args[index + 1];
	if (next === undefined || next.startsWith("-")) {
		throw new Error(`${flag} requires a value`);
	}
	return { value: next, skip: 1 };
}

export function parseMigrateArgs(
	args: string[],
	mode: MigrateMode,
): MigrateArgs {
	const parsed: MigrateArgs = {
		inPlace: false,
		allowLossy: false,
		successor: false,
		recipePath: undefined,
		toVersion: undefined,
		positionals: [],
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") {
			parsed.positionals.push(...args.slice(i + 1));
			break;
		}
		if (arg === "--in-place" || arg === "-i") {
			parsed.inPlace = true;
		} else if (arg === "--allow-lossy") {
			parsed.allowLossy = true;
		} else if (arg === "--successor") {
			if (mode !== "change") {
				throw new Error("--successor is only valid for change");
			}
			parsed.successor = true;
		} else if (arg === "--recipe" || arg.startsWith("--recipe=")) {
			const { value, skip } = readFlagValue(args, i, "--recipe");
			parsed.recipePath = value;
			i += skip;
		} else if (arg === "--to-version" || arg.startsWith("--to-version=")) {
			if (mode !== "update") {
				throw new Error("--to-version is only valid for update");
			}
			const { value, skip } = readFlagValue(args, i, "--to-version");
			if (!/^\d+$/.test(value)) {
				throw new Error(`--to-version must be a whole number, got "${value}"`);
			}
			parsed.toVersion = Number(value);
			if (!Number.isSafeInteger(parsed.toVersion))
				throw new Error("--to-version must be a safe integer");
			i += skip;
		} else if (arg.startsWith("-")) {
			throw new Error(`Unknown flag: ${arg}`);
		} else {
			parsed.positionals.push(arg);
		}
	}
	return parsed;
}

function isMigrationTemplate(
	template: Template,
): template is Template & { id: string } {
	return typeof template.id === "string";
}

/** A template object returned by the modeler service. */
function looksLikeTemplate(value: unknown): value is MigrationTemplate {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"properties" in value &&
		Array.isArray(value.properties)
	);
}

function migrationTemplates(templates: Template[]): MigrationTemplate[] {
	return templates.filter(isMigrationTemplate);
}

function compatibleTemplates(
	templates: Template[],
	engineVersion: string,
): MigrationTemplate[] {
	return migrationTemplates(
		templates.filter(
			(template) =>
				!template.engines?.camunda ||
				semver.satisfies(engineVersion, template.engines.camunda),
		),
	);
}

function loadRecipeFile(path: string): Recipe {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(resolvePath(path), "utf-8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot read recipe ${path}: ${message}`);
	}
	return parseRecipe(raw);
}

function embeddedRecipe(template: MigrationTemplate): Recipe | undefined {
	try {
		return readEmbeddedRecipe(template);
	} catch (error) {
		if (error instanceof RecipeError) {
			throw new Error(
				`Template ${template.id}@${template.version} carries an unusable recipe. ${error.message}`,
			);
		}
		throw error;
	}
}

function createModeler(): ModelerInstance {
	const vendor: VendorBundle = require(resolveVendorBundle());
	return new vendor.Modeler({
		additionalModules: [
			vendor.HeadlessTextRendererModule,
			vendor.CloudElementTemplatesCoreModule,
		],
		moddleExtensions: { zeebe: vendor.ZeebeModdleExtension },
	});
}

function describeTemplates(templates: MigrationTemplate[]): string {
	return templates.map((t) => `${t.name ?? t.id} (${t.id})`).join(", ");
}

async function resolveTarget({
	mode,
	parsed,
	modeler,
	element,
	applied,
	executionPlatformVersion,
}: {
	mode: MigrateMode;
	parsed: MigrateArgs;
	modeler: ModelerInstance;
	element: BpmnElement;
	applied: { id: string; version: number };
	executionPlatformVersion: string | null;
}): Promise<MigrationTemplate> {
	if (mode === "update") {
		requireCachePresent();
		const versions = (loadCache() ?? []).filter((t) => t.id === applied.id);
		if (versions.length === 0) {
			throw new Error(
				`Template '${applied.id}' is not in the local cache. update works for out-of-the-box templates; run 'c8ctl element-template sync' or use 'change' with a template file.`,
			);
		}
		const target = pickVersion(versions, {
			version: parsed.toVersion,
			executionPlatformVersion,
		});
		if (!target || !isMigrationTemplate(target)) {
			throw new Error(
				parsed.toVersion === undefined
					? `No version of '${applied.id}' is compatible with Camunda ${executionPlatformVersion}.`
					: `Template '${applied.id}' has no version ${parsed.toVersion}.`,
			);
		}
		if ((target.version ?? 0) < applied.version) {
			throw new Error(
				`Template '${applied.id}' is already at version ${applied.version}; refusing to move back to ${target.version}.`,
			);
		}
		return target;
	}

	if (parsed.successor) {
		requireCachePresent();
		const cache = compatibleTemplates(
			loadCache() ?? [],
			executionPlatformVersion ?? "",
		);
		const service = modeler.get("elementTemplates");
		service.set(cache);
		const candidates = service.getCompatible(element).filter(looksLikeTemplate);
		const successors = findSuccessors(
			candidates,
			applied.id,
			applied.version,
			cache,
		);
		if (successors.length === 0) {
			throw new Error(
				`No template declares a migration from '${applied.id}'. Pick a target explicitly: ${USAGE.change}`,
			);
		}
		if (successors.length > 1) {
			throw new Error(
				`Several templates declare a migration from '${applied.id}': ${describeTemplates(successors)}. Pick one explicitly: ${USAGE.change}`,
			);
		}
		return successors[0];
	}

	const ref = parseTemplateRef(parsed.positionals[0]);
	if (!ref) {
		throw new Error(`Missing template argument. Usage: ${USAGE.change}`);
	}
	const target =
		ref.kind === "id"
			? await resolveOotbTemplate(ref, { executionPlatformVersion })
			: await readTemplateFromPathOrUrl(ref.value);
	if (!isMigrationTemplate(target)) {
		throw new Error("The target template has no id.");
	}
	return target;
}

async function runMigrateInternal(
	mode: MigrateMode,
	args: string[],
): Promise<void> {
	const logger = c8ctl.getLogger();
	installStdoutEpipeHandler();
	const parsed = parseMigrateArgs(args, mode);

	const positionalCount = mode === "update" || parsed.successor ? 2 : 3;
	if (parsed.positionals.length > positionalCount) {
		throw new Error(
			`Unexpected argument: ${parsed.positionals[positionalCount]}. Usage: ${USAGE[mode]}`,
		);
	}
	const positionals =
		mode === "change" && !parsed.successor
			? parsed.positionals.slice(1)
			: parsed.positionals;
	const [elementId, bpmnFilePath] = positionals;
	if (mode === "change" && !parsed.successor && !parsed.positionals[0]) {
		throw new Error(`Missing template argument. Usage: ${USAGE.change}`);
	}
	if (!elementId) {
		throw new Error(`Missing element-id argument. Usage: ${USAGE[mode]}`);
	}

	const dryRun = c8ctl.dryRun === true;
	if (parsed.inPlace && !bpmnFilePath) {
		throw new Error("--in-place cannot be used with stdin input");
	}
	const writesXmlToStdout = !parsed.inPlace && !dryRun;
	if (c8ctl.outputMode === "json" && writesXmlToStdout) {
		throw new Error(
			"--json needs --in-place or --dry-run, because stdout carries the BPMN otherwise",
		);
	}

	const input = await readBpmnInput(bpmnFilePath);
	if (!input) {
		throw new Error(
			"No BPMN input provided. Pass a file path or pipe BPMN XML via stdin.",
		);
	}
	const executionPlatformVersion = await getExecutionPlatformVersion(input.xml);
	const engineVersion = executionPlatformVersion
		? semver.coerce(executionPlatformVersion)?.version
		: undefined;
	if (!engineVersion) {
		throw new Error(
			"Cannot verify template compatibility: set a valid modeler:executionPlatformVersion on the BPMN document.",
		);
	}

	const modeler = createModeler();
	await modeler.importXML(input.xml);
	const element = modeler.get("elementRegistry").get(elementId);
	if (!element) {
		throw new Error(`Element "${elementId}" not found in the BPMN diagram`);
	}
	const applied = readAppliedTemplate(element.businessObject);
	if (!applied) {
		throw new Error(
			`Element "${elementId}" has no element template applied. Use 'apply' first.`,
		);
	}

	const target = await resolveTarget({
		mode,
		parsed,
		modeler,
		element,
		applied,
		executionPlatformVersion: engineVersion,
	});
	const recipe = parsed.recipePath
		? loadRecipeFile(parsed.recipePath)
		: undefined;
	const targetRecipe = recipe ?? embeddedRecipe(target);
	if (targetRecipe) validateRecipeOwner(targetRecipe, target);
	if (
		"engines" in target &&
		target.engines &&
		typeof target.engines === "object" &&
		"camunda" in target.engines &&
		typeof target.engines.camunda === "string" &&
		!semver.satisfies(engineVersion, target.engines.camunda)
	) {
		throw new Error(
			`Template '${target.id}' is not compatible with Camunda ${engineVersion}.`,
		);
	}

	if (target.id === applied.id && target.version === applied.version) {
		if (c8ctl.outputMode === "json") {
			const report = buildReport({
				fromTemplate: target,
				toTemplate: target,
				before: [],
				after: [],
				facts: {
					moved: [],
					set: [],
					notes: [],
					guardSkipped: [],
					templateSkipped: [],
					noMatch: [],
					feelSkipped: [],
				},
				usedRecipe: false,
				refusal: null,
			});
			logger.json({
				...reportToJson(report, {
					elementId,
					action: mode,
					recipe: "none",
					dryRun,
					file: parsed.inPlace ? bpmnFilePath : undefined,
				}),
				noop: true,
			});
		} else {
			logger.info(
				`${elementId} is already on ${target.name ?? target.id} v${applied.version}; nothing to do.`,
				{ stream: writesXmlToStdout ? "stderr" : "stdout" },
			);
		}
		if (writesXmlToStdout) {
			process.stdout.write(input.xml);
		}
		return;
	}

	const cache = compatibleTemplates(loadCache() ?? [], engineVersion);
	const templates = [
		...cache.filter((t) => t.id === applied.id || t.id === target.id),
		target,
	];
	const fromTemplate = templates.find(
		(t) => t.id === applied.id && t.version === applied.version,
	) ?? { id: applied.id, version: applied.version, properties: [] };

	const recipeSource: RecipeSource = recipe
		? "file"
		: embeddedRecipe(target)
			? "embedded"
			: "none";

	const service = modeler.get("elementTemplates");
	const migrationModeler: MigrationModeler = {
		elementTemplates: service,
		modeling: modeler.get("modeling"),
	};
	let report: ReturnType<typeof migrateElement>["report"];
	try {
		({ report } = migrateElement({
			modeler: migrationModeler,
			element,
			fromTemplate,
			target,
			templates,
			recipe,
		}));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot migrate ${elementId}: ${message}`);
	}
	const { xml } = await modeler.saveXML({ format: true });
	if (recipe && (!report.usedRecipe || report.refusal)) {
		throw new Error(
			`Explicit recipe cannot be used: ${report.refusal ?? "no applicable source entry or reachable source floor"}.`,
		);
	}
	const requiresAuthorization =
		(parsed.inPlace && !report.lossless) || report.refusal !== null;
	if (requiresAuthorization && !parsed.allowLossy && !dryRun) {
		throw new Error(
			"Migration may lose values or discard its recipe; preview with --dry-run and pass --allow-lossy to authorize it.",
		);
	}

	if (!dryRun && parsed.inPlace && bpmnFilePath) {
		if (readFileSync(bpmnFilePath, "utf-8") !== input.xml)
			throw new Error(
				"BPMN changed during migration; refusing to overwrite concurrent edits.",
			);
		atomicOverwriteFile(bpmnFilePath, xml);
	}
	if (c8ctl.outputMode === "json") {
		logger.json({
			...reportToJson(report, {
				elementId,
				action: mode,
				recipe: recipeSource,
				dryRun,
				file: parsed.inPlace ? bpmnFilePath : undefined,
			}),
			requiresAuthorization,
			authorized: parsed.allowLossy,
		});
	} else {
		const stream = writesXmlToStdout ? process.stderr : process.stdout;
		stream.write(
			renderReportText(report, {
				elementId,
				color: shouldUseColor(stream),
				dryRun,
			}),
		);
		if (requiresAuthorization)
			stream.write(
				parsed.allowLossy
					? "Lossy migration authorized with --allow-lossy.\n"
					: "Requires --allow-lossy authorization before writing.\n",
			);
	}

	if (dryRun) {
		return;
	}
	if (parsed.inPlace && bpmnFilePath) {
		if (c8ctl.outputMode !== "json") {
			logger.info(`Updated ${bpmnFilePath}`);
		}
		return;
	}
	process.stdout.write(xml);
}

export async function runMigrate(
	mode: MigrateMode,
	args: string[],
): Promise<void> {
	const parsed = parseMigrateArgs(args, mode);
	const file =
		parsed.positionals[mode === "change" && !parsed.successor ? 2 : 1];
	if (!parsed.inPlace || !file || c8ctl.dryRun)
		return runMigrateInternal(mode, args);
	const lock = `${resolvePath(file)}.migration.lock`;
	let descriptor: number;
	try {
		descriptor = openSync(lock, "wx");
	} catch {
		throw new Error(
			`Cannot acquire migration lock ${lock}. Another writer may be active; remove a stale lock only after checking that no migration is running.`,
		);
	}
	try {
		await runMigrateInternal(mode, args);
	} finally {
		closeSync(descriptor);
		unlinkSync(lock);
	}
}
