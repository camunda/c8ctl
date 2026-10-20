/**
 * Turns a template change into an ordered list of migration steps: the
 * version steps to climb inside the applied template's own lineage, then at
 * most one hop onto a different template.
 *
 * A recipe lives on the template it migrates to. Same-id steps are read
 * from the target (or the newest version of the applied id when hopping),
 * the hop from the target.
 */

import { isDeepStrictEqual } from "node:util";
import { findPropertiesByTarget, splitBindingPrefix } from "./binding.ts";
import { TEMPLATE_REF } from "./plan.ts";
import {
	type Entry,
	type Recipe,
	readEmbeddedRecipe,
	validateRecipeOwner,
} from "./recipe.ts";
import type { MigrationTemplate } from "./types.ts";

export interface Step {
	kind: "version" | "hop";
	templateId: string;
	/** Version the step produces. */
	version: number;
	entries: Entry[];
	/** A version step the plan adds to reach a change floor; the recipe has no entry for it. */
	implicit?: boolean;
}

export interface ResolvedSteps {
	steps: Step[];
	/** Why a declared recipe was not used; callers must authorize carry-over. */
	refusal: string | null;
}

export interface Application {
	step: Step | null;
	template: MigrationTemplate;
}

function versionOf(template: MigrationTemplate): number | undefined {
	return typeof template.version === "number" ? template.version : undefined;
}

/** Explicit definitions replace catalog shadows; all other identities must agree. */
export function resolveCatalog(
	templates: MigrationTemplate[],
	authoritative: MigrationTemplate[] = [],
): MigrationTemplate[] {
	const identity = (template: MigrationTemplate) =>
		JSON.stringify([template.id, versionOf(template) ?? 0]);
	const overrides = new Map(authoritative.map((t) => [identity(t), t]));
	const catalog = new Map<string, MigrationTemplate>();
	const conflicts = new Set<string>();
	for (const candidate of [...authoritative, ...templates]) {
		const key = identity(candidate);
		const template = overrides.get(key) ?? candidate;
		const existing = catalog.get(key);
		if (existing && !isDeepStrictEqual(existing, template)) conflicts.add(key);
		else if (!existing) catalog.set(key, template);
	}
	const conflict = [...conflicts].sort()[0];
	if (conflict) {
		const template = catalog.get(conflict);
		throw new Error(
			`Conflicting definitions for template "${template?.id}" version ${template?.version}; supply one definition per identity.`,
		);
	}
	return [...catalog.values()];
}

export function latestOf(
	templates: MigrationTemplate[],
	id: string,
): MigrationTemplate | undefined {
	let best: MigrationTemplate | undefined;
	for (const t of resolveCatalog(templates)) {
		const v = versionOf(t) ?? 0;
		if (t.id === id && (!best || v > (versionOf(best) ?? 0))) {
			best = t;
		}
	}
	return best;
}

function recipeSourcesFor(recipe: Recipe | undefined, sourceId: string) {
	return (recipe?.sources ?? []).filter((s) => s.sourceTemplateId === sourceId);
}

/** Paths an entry reads from the element, including every guard path. */
function readPaths(entry: Entry): string[] {
	const paths: string[] = [];
	if (entry.kind === "rename") {
		paths.push(entry.from);
	}
	if (entry.kind === "template") {
		paths.push(...[...entry.template.matchAll(TEMPLATE_REF)].map((m) => m[1]));
	}
	for (const guard of entry.when) {
		paths.push(guard.path);
	}
	return paths;
}

/**
 * Every version step must read the applied shape or the preceding selected
 * application, never an unselected catalog version or a removed write. Checks
 * coverage of the recipe, not contiguity of version numbers, since published
 * lineages skip numbers. A hop must read the shape the last step reached.
 * Reads of an unknown applied shape are not checked.
 */
function findCoverageGap(
	steps: { toVersion: number; entries: Entry[] }[],
	appliedId: string,
	appliedVersion: number,
	appliedShapeKnown: boolean,
	templates: MigrationTemplate[],
	hop?: { targetId: string; entries: Entry[] },
): string | null {
	let shape = appliedShapeKnown
		? templates.find(
				(t) => t.id === appliedId && (versionOf(t) ?? 0) === appliedVersion,
			)
		: undefined;
	for (const step of steps) {
		for (const entry of step.entries) {
			for (const path of readPaths(entry)) {
				const { bindingType, key } = splitBindingPrefix(path);
				if (!shape) {
					continue;
				}
				if (
					findPropertiesByTarget(shape.properties, key, bindingType).length ===
					0
				) {
					return `the recipe for ${appliedId} is incomplete: the step at version ${step.toVersion} reads "${path}", which reached version ${shape.version} does not define`;
				}
			}
		}
		shape = templates.find(
			(t) => t.id === appliedId && (versionOf(t) ?? 0) === step.toVersion,
		);
	}
	for (const entry of hop?.entries ?? []) {
		for (const path of readPaths(entry)) {
			const { bindingType, key } = splitBindingPrefix(path);
			if (
				shape &&
				findPropertiesByTarget(shape.properties, key, bindingType).length === 0
			) {
				return `the recipe for ${hop?.targetId} is incomplete: the change from ${appliedId} reads "${path}", which reached version ${shape.version} does not define`;
			}
		}
	}
	return null;
}

/** The recipe source that hops from `sourceId`, at the highest reachable floor. */
function reachableHop(
	recipe: Recipe | undefined,
	sourceId: string,
	drainedVersion: number,
) {
	let best: ReturnType<typeof recipeSourcesFor>[number] | undefined;
	for (const s of recipeSourcesFor(recipe, sourceId)) {
		if (
			s.kind !== "change" ||
			(s.minSourceVersion !== undefined && s.minSourceVersion > drainedVersion)
		) {
			continue;
		}
		if (
			!best ||
			(s.minSourceVersion ?? -1) >
				(best.kind === "change" ? (best.minSourceVersion ?? -1) : -1)
		) {
			best = s;
		}
	}
	return best;
}

/**
 * The floor an implicit step must reach so the best change entry applies:
 * the highest floor at most `newest`. The step lands on the lowest compatible
 * version at or above it. Undefined when no floor needs a bump.
 * Throws when the element is below every floor, all floors are above `newest`
 * and no entry applies without one.
 */
function implicitFloor({
	recipe,
	sourceId,
	reachedVersion,
	newest,
	engineVersion,
}: {
	recipe: Recipe | undefined;
	sourceId: string;
	reachedVersion: number;
	/** Newest compatible source version; undefined when none is compatible. */
	newest: number | undefined;
	engineVersion?: string;
}): number | undefined {
	const changes = recipeSourcesFor(recipe, sourceId).filter(
		(s) => s.kind === "change",
	);
	const floors = changes.flatMap((s) =>
		s.kind === "change" && s.minSourceVersion !== undefined
			? [s.minSourceVersion]
			: [],
	);
	const reachable = floors.filter((f) => newest !== undefined && f <= newest);
	if (reachable.length === 0) {
		const hasFallback = changes.length > floors.length;
		if (
			floors.length > 0 &&
			!hasFallback &&
			reachedVersion < Math.min(...floors)
		) {
			const camunda = engineVersion
				? `Camunda ${engineVersion} (from the BPMN executionPlatformVersion)`
				: "the BPMN Camunda version";
			throw new Error(
				`Template '${sourceId}' v${Math.min(...floors)} or later is required, but ${
					newest === undefined
						? `no version compatible with ${camunda} is available`
						: `the newest version compatible with ${camunda} is v${newest}`
				}.`,
			);
		}
		return undefined;
	}
	const best = Math.max(...reachable);
	return best > reachedVersion ? best : undefined;
}

/**
 * Resolve the steps for moving an element from `appliedId@appliedVersion`
 * to `target`. `recipe` overrides the recipe embedded in the target.
 *
 * A refusal is a message, never a throw. It discards all recipe steps so
 * callers can reject explicit recipes or authorize embedded carry-over.
 */
export function resolveSteps({
	appliedId,
	appliedVersion,
	appliedShapeKnown = true,
	target,
	templates,
	recipe,
	engineVersion,
	isCompatible = () => true,
}: {
	appliedId: string;
	appliedVersion: number;
	/** False when the catalog's applied template is a stand-in without its definition. */
	appliedShapeKnown?: boolean;
	target: MigrationTemplate;
	templates: MigrationTemplate[];
	recipe?: Recipe;
	/** Camunda version of the BPMN, used to explain an unreachable floor. */
	engineVersion?: string;
	/** Whether a template fits the BPMN's Camunda version; the applied one may not. */
	isCompatible?: (template: MigrationTemplate) => boolean;
}): ResolvedSteps {
	templates = resolveCatalog(templates, [target]);
	const sameId = target.id === appliedId;
	const targetVersion = versionOf(target) ?? 0;
	const targetRecipe = recipe ?? readEmbeddedRecipe(target);
	if (targetRecipe) validateRecipeOwner(targetRecipe, target);

	const sourceLatest = latestOf(templates, appliedId);
	const sourceRecipe = sameId
		? targetRecipe
		: sourceLatest
			? readEmbeddedRecipe(sourceLatest)
			: undefined;
	if (!sameId && sourceRecipe && sourceLatest)
		validateRecipeOwner(sourceRecipe, sourceLatest);
	const limit = sameId
		? targetVersion
		: sourceLatest
			? (versionOf(sourceLatest) ?? appliedVersion)
			: appliedVersion;

	const rungs: { toVersion: number; entries: Entry[]; implicit?: boolean }[] =
		recipeSourcesFor(sourceRecipe, appliedId)
			.flatMap((s) =>
				s.kind === "upgrade" &&
				s.toVersion > appliedVersion &&
				s.toVersion <= limit
					? [{ toVersion: s.toVersion, entries: s.entries }]
					: [],
			)
			.sort((a, b) => a.toVersion - b.toVersion);
	for (const rung of rungs) {
		if (!sameId || rung.toVersion !== targetVersion)
			loaded(templates, appliedId, rung.toVersion);
	}

	let reachedVersion = rungs.at(-1)?.toVersion ?? appliedVersion;
	const compatibleVersions = templates
		.filter(
			(t) =>
				t.id === appliedId &&
				isCompatible(t) &&
				// A stand-in for an unavailable applied template has no real definition.
				(appliedShapeKnown || (versionOf(t) ?? 0) !== appliedVersion),
		)
		.map((t) => versionOf(t) ?? 0)
		.sort((a, b) => a - b);
	const floor = sameId
		? undefined
		: implicitFloor({
				recipe: targetRecipe,
				sourceId: appliedId,
				reachedVersion,
				newest: compatibleVersions.at(-1),
				engineVersion,
			});
	if (floor !== undefined) {
		// A floor is a minimum: land on the lowest compatible version at or above it.
		const landing = compatibleVersions.find((v) => v >= floor) ?? floor;
		rungs.push({ toVersion: landing, entries: [], implicit: true });
		reachedVersion = landing;
	}
	const hop = sameId
		? undefined
		: reachableHop(targetRecipe, appliedId, reachedVersion);
	const refusal = findCoverageGap(
		rungs,
		appliedId,
		appliedVersion,
		appliedShapeKnown,
		templates,
		hop && { targetId: target.id, entries: hop.entries },
	);
	if (refusal) {
		return { steps: [], refusal };
	}

	const steps: Step[] = rungs.map((rung) => ({
		kind: "version",
		templateId: appliedId,
		version: rung.toVersion,
		entries: rung.entries,
		...(rung.implicit ? { implicit: true } : {}),
	}));

	if (!sameId) {
		if (hop) {
			steps.push({
				kind: "hop",
				templateId: target.id,
				version: targetVersion,
				entries: hop.entries,
			});
		} else if (targetRecipe) {
			return {
				steps: [],
				refusal: `wrong source ID: the recipe has no change entry for "${appliedId}"`,
			};
		}
	} else if (
		targetRecipe &&
		steps.length === 0 &&
		targetVersion !== appliedVersion
	) {
		return {
			steps: [],
			refusal:
				recipeSourcesFor(targetRecipe, appliedId).length === 0
					? `wrong source ID: the recipe has no upgrade entry for "${appliedId}"`
					: `no applicable upgrade: the recipe has no upgrade above applied version ${appliedVersion} through target version ${targetVersion}`,
		};
	}
	return { steps, refusal: null };
}

/**
 * The newest non-deprecated version of each template among `candidates` whose
 * recipe hops from the applied template. `candidates` should already be
 * filtered for compatibility with the element.
 */
export function findSuccessors(
	candidates: MigrationTemplate[],
	appliedId: string,
	appliedVersion: number,
	templates: MigrationTemplate[],
): MigrationTemplate[] {
	candidates = resolveCatalog(candidates);
	templates = resolveCatalog([...templates, ...candidates]);
	const ids = new Set(candidates.map((c) => c.id));
	const found: MigrationTemplate[] = [];
	for (const id of ids) {
		const latest = latestOf(
			candidates.filter((c) => !c.deprecated),
			id,
		);
		if (latest && latest.id !== appliedId) {
			try {
				const result = resolveSteps({
					appliedId,
					appliedVersion,
					target: latest,
					templates: [...templates, latest],
				});
				if (!result.refusal && result.steps.some((s) => s.kind === "hop"))
					found.push(latest);
			} catch {
				// Discovery excludes candidates whose recipe or required applications are unusable.
			}
		}
	}
	return found;
}

function loaded(
	templates: MigrationTemplate[],
	id: string,
	version: number,
): MigrationTemplate {
	const template = templates.find(
		(t) => t.id === id && (versionOf(t) ?? 0) === version,
	);
	if (!template) {
		throw new Error(`Template "${id}" version ${version} is not available`);
	}
	return template;
}

/**
 * The steps as the templates they apply, in order. A plan that does not end
 * on `target` gets a final, recipe-free application of it, so the change
 * always lands. Throws when a template is not available.
 */
export function resolveApplications(
	templates: MigrationTemplate[],
	steps: Step[],
	target: MigrationTemplate,
): Application[] {
	templates = resolveCatalog(templates, [target]);
	const applications: Application[] = steps.map((step) => ({
		step,
		template: loaded(templates, step.templateId, step.version),
	}));
	const last = applications[applications.length - 1];
	if (
		!last ||
		last.template.id !== target.id ||
		versionOf(last.template) !== versionOf(target)
	) {
		applications.push({ step: null, template: target });
	}
	return applications;
}
