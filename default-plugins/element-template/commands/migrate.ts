/**
 * Runner for `element-template update`: migrate every element that uses a
 * template to a newer version of it, or to another template, carrying values
 * along with the recipe the target template declares.
 */

import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	realpathSync,
	unlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import type {} from "../../../src/core/runtime.ts";
import { loadCache } from "../cache.ts";
import {
	atomicOverwriteFile,
	BINDING_TYPE_SHORTHANDS,
	CONCURRENT_EDIT_MESSAGE,
	installStdoutEpipeHandler,
	isRecord,
	type Template,
} from "../helpers.ts";
import {
	type MigrationModeler,
	migrateElement,
	readAppliedTemplate,
	type ValueMap,
} from "../migration/apply.ts";
import {
	type ElementValue,
	enumerateElementValues,
	getExtensionElements,
} from "../migration/element-values.ts";
import { getModdleString } from "../migration/moddle.ts";
import { DestinationError, emptyFacts } from "../migration/plan.ts";
import {
	parseRecipe,
	type Recipe,
	RecipeError,
	readEmbeddedRecipe,
	validateRecipeOwner,
} from "../migration/recipe.ts";
import { buildReport, type MigrationReport } from "../migration/report.ts";
import {
	findSuccessors,
	latestOf,
	resolveCatalog,
} from "../migration/steps.ts";
import type { MigrationTemplate } from "../migration/types.ts";
import {
	type MigrationRedactionContext,
	type RecipeOrigin,
	redactMigrationDiagnostic,
	renderLegend,
	renderReportText,
	reportToJson,
	shouldUseColor,
} from "../migration-output.ts";
import {
	findLocalTemplates,
	getExecutionPlatformVersion,
	isEngineCompatible,
	parseTemplateRef,
	readBpmnInput,
	readTemplateFromPathOrUrl,
	resolveTemplateId,
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

const COMMAND = "element-template update";
const USAGE =
	"c8ctl element-template update <template-id> [<element-id>] [<file.bpmn>] [--to <template>[@<n>]] [--recipe <file>] [--map <from>=<to>]... [--in-place]";

interface MigrateArgs {
	inPlace: boolean;
	allowLossy: boolean;
	to: string | undefined;
	recipePath: string | undefined;
	maps: string[];
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

function parseMigrateArgs(args: string[]): MigrateArgs {
	const parsed: MigrateArgs = {
		inPlace: false,
		allowLossy: false,
		to: undefined,
		recipePath: undefined,
		maps: [],
		positionals: [],
	};
	const valueFlag = (arg: string, flag: string) =>
		arg === flag || arg.startsWith(`${flag}=`);
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
		} else if (valueFlag(arg, "--recipe")) {
			const { value, skip } = readFlagValue(args, i, "--recipe");
			if (value === "") throw new Error("--recipe requires a value");
			parsed.recipePath = value;
			i += skip;
		} else if (valueFlag(arg, "--to")) {
			const { value, skip } = readFlagValue(args, i, "--to");
			if (value === "") throw new Error("--to requires a value");
			parsed.to = value;
			i += skip;
		} else if (valueFlag(arg, "--map")) {
			const { value, skip } = readFlagValue(args, i, "--map");
			parsed.maps.push(value);
			i += skip;
		} else if (arg.startsWith("-")) {
			throw new Error(`Unknown flag: ${arg}`);
		} else {
			parsed.positionals.push(arg);
		}
	}
	return parsed;
}

interface ResolvedMigrateArgs {
	parsed: MigrateArgs;
	templateId: string;
	elementId: string | undefined;
	bpmnFilePath: string | undefined;
}

function resolveMigrateArgs(args: string[]): ResolvedMigrateArgs {
	const parsed = parseMigrateArgs(args);
	const [templateId, ...rest] = parsed.positionals;
	if (!templateId) {
		throw new Error(`Missing template-id argument. Usage: ${USAGE}`);
	}
	if (templateId.toLowerCase().endsWith(".bpmn")) {
		throw new Error(
			`"${templateId}" is a BPMN file; the first argument is the applied template ID. Usage: ${USAGE}`,
		);
	}
	if (templateId.includes("@")) {
		throw new Error(
			`The template selector does not take a version ("${templateId}"). To pick the target version, use --to <template-id>@<n>.`,
		);
	}
	if (rest.length > 2) {
		throw new Error(`Unexpected argument: ${rest[2]}. Usage: ${USAGE}`);
	}
	let elementId: string | undefined;
	let bpmnFilePath: string | undefined;
	if (rest.length === 2) {
		[elementId, bpmnFilePath] = rest;
	} else if (rest.length === 1) {
		if (rest[0].toLowerCase().endsWith(".bpmn") || existsSync(rest[0])) {
			bpmnFilePath = rest[0];
		} else {
			elementId = rest[0];
		}
	}
	return { parsed, templateId, elementId, bpmnFilePath };
}

/** Parse `--map <from>=<to>`; each side may carry a binding-type prefix. */
function parseMapArg(arg: string): ValueMap {
	const eq = arg.indexOf("=");
	if (eq <= 0 || eq === arg.length - 1) {
		throw new Error(
			`Invalid --map format: "${arg}". Expected <from>=<to> (e.g. --map maxTokens=limit)`,
		);
	}
	const side = (text: string) => {
		const colon = text.indexOf(":");
		if (colon === -1) return { key: text, bindingType: null };
		const prefix = text.slice(0, colon);
		const bindingType = BINDING_TYPE_SHORTHANDS[prefix];
		if (!bindingType) {
			const valid = Object.keys(BINDING_TYPE_SHORTHANDS).join(", ");
			throw new Error(
				`Unknown binding type prefix "${prefix}" in --map "${arg}". Valid prefixes: ${valid}`,
			);
		}
		return { key: text.slice(colon + 1), bindingType };
	};
	return { from: side(arg.slice(0, eq)), to: side(arg.slice(eq + 1)) };
}

function isMigrationTemplate(
	template: Template,
): template is Template & { id: string } {
	return typeof template.id === "string";
}

function migrationTemplates(templates: Template[]): MigrationTemplate[] {
	return templates.filter(isMigrationTemplate);
}

function compatibleTemplates(
	templates: Template[],
	engineVersion: string,
): MigrationTemplate[] {
	return migrationTemplates(
		templates.filter((template) => isEngineCompatible(template, engineVersion)),
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
		const recipe = readEmbeddedRecipe(template);
		if (recipe) validateRecipeOwner(recipe, template);
		return recipe;
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

interface TemplatePool {
	/** `findLocalTemplates` for `id`, read once per run. */
	localOf(id: string): Template[];
	/** The cache, read on first use, once per run. */
	cache(): Template[];
	/** Marks `id` as defined outside the cache, by a template file or URL. */
	resolvedWithoutCache(id: string): void;
	/**
	 * The local templates of `ids`, shadowing same id+version cache entries.
	 * The cache takes part once it is loaded, or when an id has no local template.
	 */
	pool(ids: (string | undefined)[]): Template[];
}

/** Local templates (see `resolveTemplateId`) take part in update like cached ones. */
function templatePool(searchDir: string): TemplatePool {
	const local = new Map<string, Template[]>();
	const localOf = (id: string) => {
		const templates = local.get(id) ?? findLocalTemplates(searchDir, id);
		local.set(id, templates);
		return templates;
	};
	const withoutCache = new Set<string>();
	let cached: Template[] | undefined;
	const cache = () => {
		cached ??= loadCache() ?? [];
		return cached;
	};
	const identity = (t: Template) => JSON.stringify([t.id, t.version ?? 0]);
	return {
		localOf,
		cache,
		resolvedWithoutCache: (id) => withoutCache.add(id),
		pool(ids) {
			const known = [...new Set(ids)].filter((id) => id !== undefined);
			const shadowing = known.flatMap(localOf);
			const isLocal = (id: string) =>
				withoutCache.has(id) || localOf(id).length > 0;
			if (cached === undefined && known.every(isLocal)) return shadowing;
			const shadowed = new Set(shadowing.map(identity));
			return [
				...shadowing,
				...cache().filter((t) => !shadowed.has(identity(t))),
			];
		},
	};
}

/**
 * The target template: `--to`, else the latest compatible version of
 * `templateId`. An id resolves like every other subcommand's, local templates
 * first; only the OOTB fallback requires the cache.
 */
async function resolveTarget({
	templateId,
	to,
	executionPlatformVersion,
	templatePool,
}: {
	templateId: string;
	to: string | undefined;
	executionPlatformVersion: string;
	templatePool: TemplatePool;
}): Promise<MigrationTemplate> {
	const arg = to ?? templateId;
	const ref = parseTemplateRef(arg);
	const checkConflicts = (id: string) =>
		resolveCatalog(
			migrationTemplates(templatePool.pool([id]).filter((t) => t.id === id)),
		);
	if (ref?.kind === "id") checkConflicts(ref.id);
	const target =
		ref?.kind === "id"
			? await resolveTemplateId(ref, {
					localTemplates: templatePool.localOf(ref.id),
					executionPlatformVersion,
					requireEngineCompatibility: true,
					loadTemplates: () => {
						const cached = templatePool.cache();
						// The cached versions join the pool, so check it again.
						checkConflicts(ref.id);
						return cached;
					},
				})
			: await readTemplateFromPathOrUrl(arg);
	if (!isMigrationTemplate(target)) {
		throw new Error("The target template has no id.");
	}
	if (ref?.kind !== "id") templatePool.resolvedWithoutCache(target.id);
	return target;
}

interface SelectedElement {
	element: BpmnElement;
	id: string;
	name: string | undefined;
}

const selected = (element: BpmnElement, id: string): SelectedElement => ({
	element,
	id,
	name: getModdleString(element.businessObject, "name") || undefined,
});

/** Elements of the diagram that use `templateId`, once each, in diagram order. */
function selectElements(
	modeler: ModelerInstance,
	templateId: string,
	elementId: string | undefined,
): SelectedElement[] {
	const registry = modeler.get("elementRegistry");
	if (elementId !== undefined) {
		const element = registry.get(elementId);
		if (!element) {
			throw new Error(`Element "${elementId}" not found in the BPMN diagram`);
		}
		const applied = readAppliedTemplate(element.businessObject);
		if (!applied) {
			throw new Error(
				`Element "${elementId}" has no element template applied. Use 'apply' first.`,
			);
		}
		if (applied.id !== templateId) {
			throw new Error(
				`Element "${elementId}" uses template '${applied.id}', not '${templateId}'.`,
			);
		}
		return [selected(element, elementId)];
	}
	const seen = new Set<string>();
	const result: SelectedElement[] = [];
	for (const candidate of registry.getAll()) {
		const id = candidate.businessObject.id;
		if (typeof id !== "string" || seen.has(id)) continue;
		const element = registry.get(id);
		if (
			element &&
			readAppliedTemplate(element.businessObject)?.id === templateId
		) {
			seen.add(id);
			result.push(selected(element, id));
		}
	}
	if (result.length === 0) {
		throw new Error(
			`No element in the BPMN diagram uses template '${templateId}'.`,
		);
	}
	return result;
}

type Outcome = { id: string; name: string | undefined } & (
	| {
			status: "updated";
			report: MigrationReport;
			requiresAuthorization: boolean;
	  }
	| { status: "unchanged"; version: number }
	| {
			status: "skipped";
			from: number;
			to: number;
	  }
	| { status: "failed"; error: string; hint?: string }
);

const CARRY_OVER_HINT =
	"Pass --recipe <file> to migrate with a recipe, or --map <from>=<to> to move the value to another binding.";

interface Deprecation {
	templateId: string;
	successors: string[];
}

/** The deprecation of `templateId` and the templates that declare a migration from it. */
function deprecationOf(
	templateId: string,
	templates: MigrationTemplate[],
	cache: MigrationTemplate[],
): Deprecation | null {
	const latest = templates
		.filter((t) => t.id === templateId)
		.sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
	if (!latest?.deprecated) return null;
	let successors: MigrationTemplate[] = [];
	try {
		successors = findSuccessors(
			cache,
			templateId,
			latest.version ?? 0,
			templates,
		);
	} catch {
		// The hint is informational; a catalog conflict must not fail the run.
	}
	return { templateId, successors: successors.map((t) => t.id) };
}

function describeDropped(report: MigrationReport): string {
	const names = report.dropped.map((d) => d.key);
	const unchecked = report.skipped.unchecked.map((u) => u.key);
	return names.length > 0
		? `${names.length} dropped (${names.join(", ")})`
		: unchecked.length > 0
			? `${unchecked.length} unchecked (${unchecked.join(", ")})`
			: report.refusal
				? `recipe not used: ${report.refusal}`
				: "values not migrated";
}

async function runMigrateInternal(
	{ parsed, templateId, elementId, bpmnFilePath }: ResolvedMigrateArgs,
	redaction: MigrationRedactionContext,
	lockedPath?: string,
): Promise<void> {
	const logger = c8ctl.getLogger();
	installStdoutEpipeHandler();

	const dryRun = c8ctl.dryRun === true;
	const json = c8ctl.outputMode === "json";
	if (parsed.inPlace && !bpmnFilePath) {
		throw new Error("--in-place cannot be used with stdin input");
	}
	const writesXmlToStdout = !parsed.inPlace && !dryRun;
	if (json && writesXmlToStdout) {
		throw new Error(
			"--json needs --in-place or --dry-run, because stdout carries the BPMN otherwise",
		);
	}
	const maps = parsed.maps.map(parseMapArg);

	// Under the lock, every BPMN read and write MUST use the locked real path.
	const bpmnPath = lockedPath ?? bpmnFilePath;
	const input = await readBpmnInput(bpmnPath);
	if (!input) {
		throw new Error(
			"No BPMN input provided. Pass a file path or pipe BPMN XML via stdin.",
		);
	}
	const engineVersion = await getExecutionPlatformVersion(input.xml, {
		requireCamunda: true,
	});
	if (!engineVersion) {
		throw new Error(
			'Cannot verify template compatibility: set modeler:executionPlatform="Camunda Cloud" and a valid modeler:executionPlatformVersion (major.minor or semantic version) on the BPMN document.',
		);
	}

	const modeler = createModeler();
	await modeler.importXML(input.xml);
	const selected = selectElements(modeler, templateId, elementId);
	const valuesOf = (element: BpmnElement): ElementValue[] =>
		enumerateElementValues(getExtensionElements(element.businessObject));
	redaction.values = selected.flatMap(({ element }) => valuesOf(element));

	const pool = templatePool(
		bpmnFilePath ? dirname(resolvePath(bpmnFilePath)) : process.cwd(),
	);
	// An applied version without a local template can only come from the cache.
	const localVersions = pool.localOf(templateId).map((t) => t.version ?? 0);
	if (
		selected.some(
			({ element }) =>
				!localVersions.includes(
					readAppliedTemplate(element.businessObject)?.version ?? 0,
				),
		)
	) {
		pool.cache();
	}
	// Every version of the involved lineages, engine-incompatible ones too:
	// a filtered-out source still marks secrets.
	const lineages = (ids: (string | undefined)[]) =>
		migrationTemplates(pool.pool(ids)).filter((t) => ids.includes(t.id));
	// Register the source first: a rejected `--to` quotes the argument.
	redaction.templates = lineages([templateId]);
	const toRef = parseTemplateRef(parsed.to);
	if (toRef?.kind === "id") {
		redaction.templates = lineages([templateId, toRef.id]);
	}

	const recipe = parsed.recipePath
		? loadRecipeFile(parsed.recipePath)
		: undefined;
	if (
		recipe &&
		!recipe.sources.some((s) => s.sourceTemplateId === templateId)
	) {
		throw new Error(
			`Recipe ${parsed.recipePath} has no source entry for template '${templateId}'.`,
		);
	}

	const target = await resolveTarget({
		templateId,
		to: parsed.to,
		executionPlatformVersion: engineVersion,
		templatePool: pool,
	});
	// Recipe diagnostics can quote values that only the target knows.
	redaction.templates = [...lineages([templateId, target.id]), target];
	const targetRecipe = recipe ?? embeddedRecipe(target);
	// A hop that needs a newer source version than any local one climbs through the cache.
	const floors = (targetRecipe?.sources ?? []).flatMap((s) =>
		s.kind === "change" && s.sourceTemplateId === templateId
			? [s.minSourceVersion ?? 0]
			: [],
	);
	const localLatest = latestOf(
		compatibleTemplates(pool.localOf(templateId), engineVersion),
		templateId,
	);
	let localRecipe: Recipe | undefined;
	try {
		localRecipe = localLatest && readEmbeddedRecipe(localLatest);
	} catch {
		// Step resolution reports an unusable recipe for each element.
	}
	// The source version an element reaches through local upgrade rungs alone.
	const reachedLocally = (appliedVersion: number) =>
		Math.max(
			appliedVersion,
			...(localRecipe?.sources ?? []).flatMap((s) =>
				s.kind === "upgrade" &&
				s.sourceTemplateId === templateId &&
				s.toVersion > appliedVersion &&
				s.toVersion <= (localLatest?.version ?? 0)
					? [s.toVersion]
					: [],
			),
		);
	if (
		floors.length > 0 &&
		selected.some(({ element }) => {
			const reached = reachedLocally(
				readAppliedTemplate(element.businessObject)?.version ?? 0,
			);
			return floors.every((floor) => floor > reached);
		})
	) {
		pool.cache();
	}
	// A recipe step to a version without a local template needs the cache.
	const sourceLatest =
		target.id === templateId
			? undefined
			: latestOf(
					compatibleTemplates(pool.pool([templateId]), engineVersion).filter(
						(t) => t.id === templateId,
					),
					templateId,
				);
	let sourceRecipe: Recipe | undefined;
	try {
		sourceRecipe = sourceLatest && readEmbeddedRecipe(sourceLatest);
	} catch {
		// Step resolution reports an unusable recipe for each element.
	}
	const stepVersions = [targetRecipe, sourceRecipe]
		.flatMap((r) => r?.sources ?? [])
		.flatMap((s) =>
			s.kind === "upgrade" && s.sourceTemplateId === templateId
				? [s.toVersion]
				: [],
		);
	const lowestApplied = Math.min(
		...selected.map(
			({ element }) =>
				readAppliedTemplate(element.businessObject)?.version ?? 0,
		),
	);
	if (
		stepVersions.some(
			(v) =>
				v > lowestApplied &&
				!localVersions.includes(v) &&
				!(target.id === templateId && (target.version ?? 0) === v),
		)
	) {
		pool.cache();
	}
	const cache = compatibleTemplates(
		pool.pool([templateId, target.id]),
		engineVersion,
	);
	const templates = resolveCatalog(
		cache.filter((t) => t.id === templateId || t.id === target.id),
		[target],
	);
	redaction.templates = [...lineages([templateId, target.id]), target];
	if (targetRecipe) validateRecipeOwner(targetRecipe, target);
	// An applied source need not be engine-compatible to describe its values.
	const fromTemplateOf = (applied: { id: string; version: number }) => {
		const isApplied = (t: MigrationTemplate) =>
			t.id === applied.id && (t.version ?? 0) === applied.version;
		const source =
			templates.find(isApplied) ?? lineages([applied.id]).find(isApplied);
		return {
			source,
			fromTemplate: source ?? {
				id: applied.id,
				version: applied.version,
				properties: [],
			},
		};
	};
	// Every element climbs its source lineage's recipe, so a bad one fails the
	// run. The lineage includes the applied source, as in `migrateElement`.
	for (const { element } of selected) {
		const applied = readAppliedTemplate(element.businessObject);
		if (!applied || applied.id === target.id) continue;
		const catalog = resolveCatalog(templates, [
			fromTemplateOf(applied).fromTemplate,
			target,
		]);
		const sourceLatest = latestOf(catalog, applied.id);
		if (sourceLatest) embeddedRecipe(sourceLatest);
	}
	if (!isEngineCompatible(target, engineVersion)) {
		throw new Error(
			`Template '${target.id}' is not compatible with Camunda ${engineVersion}.`,
		);
	}
	const recipeSource: RecipeOrigin = recipe
		? "file"
		: targetRecipe
			? "embedded"
			: "none";
	// Upgrade rungs can use the source lineage's embedded recipe.
	const sourceLineageRecipe = (report: MigrationReport) =>
		recipeSource === "none" && report.usedRecipe;
	const originOf = (report: MigrationReport): RecipeOrigin =>
		sourceLineageRecipe(report) ? "embedded" : recipeSource;
	const ownerOf = (report: MigrationReport) =>
		sourceLineageRecipe(report) ? templateId : target.id;

	const service = modeler.get("elementTemplates");
	const migrationModeler: MigrationModeler = {
		elementTemplates: service,
		modeling: modeler.get("modeling"),
	};

	const outcomes: Outcome[] = [];
	for (const { element, id, name } of selected) {
		const applied = readAppliedTemplate(element.businessObject);
		if (!applied) continue;
		if (target.id === applied.id && (target.version ?? 0) === applied.version) {
			// The unchanged result records it in JSON mode.
			if (maps.length > 0 && !json) {
				process.stderr.write(
					`Warning: ${id} is already on the target template, so --map was not applied.\n`,
				);
			}
			outcomes.push({
				status: "unchanged",
				id,
				name,
				version: applied.version,
			});
			continue;
		}
		if (target.id === applied.id && (target.version ?? 0) < applied.version) {
			outcomes.push({
				status: "skipped",
				id,
				name,
				from: applied.version,
				to: target.version ?? 0,
			});
			continue;
		}
		const { source, fromTemplate } = fromTemplateOf(applied);
		try {
			const result = migrateElement({
				modeler: migrationModeler,
				element,
				fromTemplate,
				sourceKnown: source !== undefined,
				target,
				templates,
				recipe,
				engineVersion,
				isCompatible: (template) => isEngineCompatible(template, engineVersion),
				maps,
			});
			redaction.values = [
				...(redaction.values ?? []),
				...valuesOf(result.element),
			];
			const { report } = result;
			if (recipe && (!report.usedRecipe || report.refusal)) {
				throw new Error(
					`Explicit recipe cannot be used: ${report.refusal ?? "no applicable source entry"}.`,
				);
			}
			outcomes.push({
				status: "updated",
				id,
				name,
				report,
				requiresAuthorization:
					((parsed.inPlace || dryRun) && !report.lossless) ||
					report.refusal !== null,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const carryOver =
				error instanceof DestinationError && error.carryOver && !targetRecipe;
			outcomes.push({
				status: "failed",
				id,
				name,
				error: `Cannot migrate ${id}: ${message}`,
				...(carryOver ? { hint: CARRY_OVER_HINT } : {}),
			});
		}
	}

	const updated = outcomes.filter((o) => o.status === "updated");
	const failed = outcomes.filter((o) => o.status === "failed");
	const blocked = updated.filter(
		(o) => o.requiresAuthorization && !parsed.allowLossy,
	);
	const droppedCount = updated.reduce(
		(sum, o) => sum + o.report.dropped.length,
		0,
	);
	const wouldBlock = blocked.length > 0;

	if (wouldBlock && !dryRun && failed.length === 0) {
		throw new Error(
			`Migration may lose values or discard its recipe; preview with --dry-run and pass --allow-lossy to authorize it. Blocked: ${blocked
				.map((o) => `${o.id} (${describeDropped(o.report)})`)
				.join("; ")}`,
		);
	}

	const canWrite = !dryRun && failed.length === 0 && !wouldBlock;
	const saved =
		canWrite && updated.length > 0
			? await modeler.saveXML({ format: true })
			: undefined;
	if (saved && parsed.inPlace && bpmnPath) {
		if (readFileSync(bpmnPath, "utf-8") !== input.xml)
			throw new Error(CONCURRENT_EDIT_MESSAGE);
		atomicOverwriteFile(bpmnPath, saved.xml, input.xml);
	}

	const summary = {
		updated: updated.length,
		skipped: outcomes.filter((o) => o.status === "skipped").length,
		unchanged: outcomes.filter((o) => o.status === "unchanged").length,
		failed: failed.length,
		dropped: droppedCount,
		blocked: blocked.length,
	};

	const deprecation = deprecationOf(templateId, templates, cache);

	if (json) {
		const file = parsed.inPlace ? bpmnFilePath : undefined;
		const elementName = (o: Outcome) =>
			o.name
				? { elementName: redactMigrationDiagnostic(o.name, redaction) }
				: {};
		const emptyReport = (version: number) =>
			buildReport({
				fromTemplate: { ...target, version },
				toTemplate: target,
				before: [],
				after: [],
				facts: emptyFacts(),
				usedRecipe: false,
				refusal: null,
			});
		logger.json({
			dryRun,
			command: COMMAND,
			results: outcomes.map((o) => {
				switch (o.status) {
					case "updated":
						return {
							status: o.status,
							...reportToJson(o.report, {
								elementId: o.id,
								elementName: o.name,
								recipe: originOf(o.report),
								recipePath: parsed.recipePath,
								recipeOwner: ownerOf(o.report),
								dryRun,
								file,
								redaction,
							}),
							requiresAuthorization: o.requiresAuthorization,
							authorized: parsed.allowLossy,
						};
					case "unchanged":
						return {
							status: o.status,
							...reportToJson(emptyReport(o.version), {
								elementId: o.id,
								elementName: o.name,
								recipe: "none",
								dryRun,
								file,
								redaction,
							}),
							noop: true,
						};
					case "skipped":
						return {
							status: o.status,
							elementId: redactMigrationDiagnostic(o.id, redaction),
							...elementName(o),
							from: { id: templateId, version: o.from },
							to: { id: target.id, version: o.to },
						};
					default:
						return {
							status: o.status,
							elementId: redactMigrationDiagnostic(o.id, redaction),
							...elementName(o),
							error: redactMigrationDiagnostic(o.error, redaction),
							...(o.hint ? { hint: o.hint } : {}),
						};
				}
			}),
			summary,
			deprecation,
		});
	} else {
		const stream = writesXmlToStdout ? process.stderr : process.stdout;
		const color = shouldUseColor(stream);
		const s = {
			red: (text: string) => (color ? `\u001b[31m${text}\u001b[39m` : text),
		};
		const lines: string[] = [];
		const errorLines: string[] = [];
		const columns = stream.isTTY ? stream.columns : undefined;
		for (const o of outcomes) {
			if (o.status === "updated") {
				lines.push(
					renderReportText(o.report, {
						elementId: o.id,
						elementName: o.name,
						color,
						recipe: originOf(o.report),
						recipePath: parsed.recipePath,
						recipeOwner: ownerOf(o.report),
						targetTemplate: target,
						authorization: o.requiresAuthorization
							? parsed.allowLossy
								? "authorized"
								: "required"
							: undefined,
						columns,
						redaction,
					}),
				);
			} else if (o.status === "unchanged") {
				lines.push(
					`${o.id} is already on ${target.name ?? target.id} v${o.version}; nothing to do.\n`,
				);
			} else if (o.status === "skipped") {
				lines.push(`${o.id} is on v${o.from}, newer than v${o.to}; skipped.\n`);
			} else {
				const reason = o.error.replace(`Cannot migrate ${o.id}: `, "");
				errorLines.push(
					`${s.red(`✗ Cannot migrate ${o.name ? `${o.name} (${o.id})` : o.id}: ${reason}`)}\n`,
				);
				if (o.hint) errorLines.push(`${o.hint}\n`);
			}
		}
		const counts = (
			[
				[summary.updated, "updated"],
				[summary.skipped, "skipped"],
				[summary.unchanged, "unchanged"],
				[summary.failed, "failed"],
			] as const
		)
			.filter(([n]) => n > 0)
			.map(([n, label], i) =>
				i === 0
					? `${n} element${n === 1 ? "" : "s"} ${label}`
					: `${n} ${label}`,
			);
		const destination = dryRun
			? "Dry run: nothing was written."
			: failed.length > 0
				? ""
				: saved && parsed.inPlace && bpmnFilePath
					? `Updated ${bpmnFilePath}.`
					: writesXmlToStdout
						? "BPMN written to stdout."
						: "";
		lines.push(
			`${[counts.join(", ") && `${counts.join(", ")}.`, destination]
				.filter(Boolean)
				.join(" ")}\n`,
		);
		if (failed.length > 0) {
			errorLines.push("Nothing was written because an element failed.\n");
		} else if (wouldBlock && dryRun) {
			lines.push(
				"A write would be blocked: pass --allow-lossy to authorize it.\n",
			);
		}
		if (deprecation && (!parsed.to || parsed.to === templateId)) {
			const { successors } = deprecation;
			lines.push(
				`Template '${templateId}' is deprecated.${
					successors.length > 0
						? ` Templates that declare a migration from it: ${successors.join(", ")}. Use --to <template>.`
						: ""
				}\n`,
			);
		}
		lines.push(`${renderLegend(color)}\n`);
		stream.write(redactMigrationDiagnostic(lines.join("\n"), redaction));
		if (errorLines.length > 0) {
			process.stderr.write(
				redactMigrationDiagnostic(errorLines.join("\n"), redaction),
			);
		}
	}

	if (failed.length > 0 || (wouldBlock && dryRun)) {
		process.exitCode = 1;
	}
	if (saved && parsed.inPlace && bpmnFilePath) {
		return;
	}
	if (writesXmlToStdout && failed.length === 0) {
		process.stdout.write(saved ? saved.xml : input.xml);
	}
}

async function runLockedMigrate(
	args: string[],
	redaction: MigrationRedactionContext,
): Promise<void> {
	const resolved = resolveMigrateArgs(args);
	const file = resolved.bpmnFilePath;
	if (!resolved.parsed.inPlace || !file || c8ctl.dryRun)
		return runMigrateInternal(resolved, redaction);
	if (!existsSync(resolvePath(file)))
		throw new Error(`File not found: ${file}`);
	// Links to one file MUST share a lock, so it sits beside the real file.
	const lockedPath = realpathSync(file);
	const lock = `${lockedPath}.migration.lock`;
	let descriptor: number;
	try {
		descriptor = openSync(lock, "wx");
	} catch (error) {
		if (!isRecord(error) || error.code !== "EEXIST") throw error;
		throw new Error(
			`Cannot acquire migration lock ${lock}. Another writer may be active; remove a stale lock only after checking that no migration is running.`,
		);
	}
	let cleanupFailure: { error: unknown } | undefined;
	try {
		await runMigrateInternal(resolved, redaction, lockedPath);
	} finally {
		try {
			try {
				closeSync(descriptor);
			} finally {
				unlinkSync(lock);
			}
		} catch (error) {
			// Cleanup must not replace the diagnostic for a failed migration.
			cleanupFailure = { error };
		}
	}
	if (cleanupFailure) throw cleanupFailure.error;
}

export async function runMigrate(args: string[]): Promise<void> {
	const redaction: MigrationRedactionContext = {};
	try {
		await runLockedMigrate(args, redaction);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(redactMigrationDiagnostic(message, redaction));
	}
}
