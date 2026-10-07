/**
 * Turns a template change into an ordered list of migration steps: the
 * version steps to climb inside the applied template's own lineage, then at
 * most one hop onto a different template.
 *
 * A recipe lives on the template it migrates to. Same-id steps are read
 * from the target (or the newest version of the applied id when hopping),
 * the hop from the target.
 */

import { findPropertiesByTarget, splitBindingPrefix } from "./binding.ts";
import { type Entry, type Recipe, readEmbeddedRecipe } from "./recipe.ts";
import type { MigrationTemplate } from "./types.ts";

export interface Step {
	kind: "version" | "hop";
	templateId: string;
	/** Version the step produces. */
	version: number;
	entries: Entry[];
}

export interface ResolvedSteps {
	steps: Step[];
	/** Why a declared recipe was not used; the change falls back to carry-over. */
	refusal: string | null;
}

export interface Application {
	step: Step | null;
	template: MigrationTemplate;
}

const TEMPLATE_REF = /\$\{([^}]+)\}/g;

function versionOf(template: MigrationTemplate): number | undefined {
	return typeof template.version === "number" ? template.version : undefined;
}

export function latestOf(
	templates: MigrationTemplate[],
	id: string,
): MigrationTemplate | undefined {
	let best: MigrationTemplate | undefined;
	for (const t of templates) {
		const v = versionOf(t);
		if (
			t.id === id &&
			v !== undefined &&
			(!best || v > (versionOf(best) ?? -1))
		) {
			best = t;
		}
	}
	return best;
}

function recipeSourcesFor(recipe: Recipe | undefined, sourceId: string) {
	return (recipe?.sources ?? []).filter((s) => s.sourceTemplateId === sourceId);
}

/** Paths an entry reads from the element, excluding guards that may be absent. */
function readPaths(entry: Entry): string[] {
	const paths: string[] = [];
	if (entry.kind === "rename") {
		paths.push(entry.from);
	}
	if (entry.kind === "template") {
		paths.push(...[...entry.template.matchAll(TEMPLATE_REF)].map((m) => m[1]));
	}
	for (const guard of entry.when) {
		if (guard.kind !== "exists" && !guard.not) {
			paths.push(guard.path);
		}
	}
	return paths;
}

/** Newest loaded version of `id` in `[appliedVersion, before)`. */
function shapeBefore(
	templates: MigrationTemplate[],
	id: string,
	appliedVersion: number,
	before: number,
): MigrationTemplate | undefined {
	let best: MigrationTemplate | undefined;
	for (const t of templates) {
		const v = versionOf(t);
		if (
			t.id === id &&
			v !== undefined &&
			v >= appliedVersion &&
			v < before &&
			(!best || v > (versionOf(best) ?? -1))
		) {
			best = t;
		}
	}
	return best;
}

/**
 * Every version step must read a shape something produces: an earlier step
 * of the same recipe, or the loaded template it runs against. Checks
 * coverage of the recipe, not contiguity of version numbers, since published
 * lineages skip numbers.
 */
function findCoverageGap(
	steps: { minVersion: number; entries: Entry[] }[],
	appliedId: string,
	appliedVersion: number,
	templates: MigrationTemplate[],
): string | null {
	const produced = new Set<string>();
	for (const step of steps) {
		const shape = shapeBefore(
			templates,
			appliedId,
			appliedVersion,
			step.minVersion,
		);
		for (const entry of step.entries) {
			for (const path of readPaths(entry)) {
				const { bindingType, key } = splitBindingPrefix(path);
				if (produced.has(key) || !shape) {
					continue;
				}
				if (
					findPropertiesByTarget(shape.properties, key, bindingType).length ===
					0
				) {
					return `the recipe for ${appliedId} is incomplete: the step at version ${step.minVersion} reads "${path}", which version ${shape.version} does not define and no earlier step writes`;
				}
			}
		}
		for (const entry of step.entries) {
			produced.add(splitBindingPrefix(entry.to).key);
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
		if (s.minVersion !== undefined && s.minVersion > drainedVersion) {
			continue;
		}
		if (!best || (s.minVersion ?? -1) > (best.minVersion ?? -1)) {
			best = s;
		}
	}
	return best;
}

/**
 * Resolve the steps for moving an element from `appliedId@appliedVersion`
 * to `target`. `recipe` overrides the recipe embedded in the target.
 *
 * A refusal is a message, never a throw: the change still lands through the
 * library's carry-over.
 */
export function resolveSteps({
	appliedId,
	appliedVersion,
	target,
	templates,
	recipe,
}: {
	appliedId: string;
	appliedVersion: number;
	target: MigrationTemplate;
	templates: MigrationTemplate[];
	recipe?: Recipe;
}): ResolvedSteps {
	const sameId = target.id === appliedId;
	const targetVersion = versionOf(target) ?? 0;
	const targetRecipe = recipe ?? readEmbeddedRecipe(target);

	const sourceLatest = latestOf(templates, appliedId);
	const sourceRecipe = sameId ? targetRecipe : safeRecipe(sourceLatest);
	const drainedVersion = sameId
		? targetVersion
		: Math.max(
				appliedVersion,
				versionOf(sourceLatest ?? target) ?? appliedVersion,
			);

	const rungs = recipeSourcesFor(sourceRecipe, appliedId)
		.filter(
			(s) =>
				s.minVersion !== undefined &&
				s.minVersion > appliedVersion &&
				s.minVersion <= drainedVersion,
		)
		.map((s) => ({ minVersion: s.minVersion ?? 0, entries: s.entries }))
		.sort((a, b) => a.minVersion - b.minVersion);

	const refusal = findCoverageGap(rungs, appliedId, appliedVersion, templates);
	if (refusal) {
		return { steps: [], refusal };
	}

	const steps: Step[] = rungs.map((rung) => ({
		kind: "version",
		templateId: appliedId,
		version: rung.minVersion,
		entries: rung.entries,
	}));

	if (!sameId) {
		const hop = reachableHop(targetRecipe, appliedId, drainedVersion);
		if (hop) {
			steps.push({
				kind: "hop",
				templateId: target.id,
				version: targetVersion,
				entries: hop.entries,
			});
		}
	}
	return { steps, refusal: null };
}

/** An unusable recipe on a template other than the target is ignored. */
function safeRecipe(
	template: MigrationTemplate | undefined,
): Recipe | undefined {
	if (!template) {
		return undefined;
	}
	try {
		return readEmbeddedRecipe(template);
	} catch {
		return undefined;
	}
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
	const sourceLatest = latestOf(templates, appliedId);
	const drained = Math.max(
		appliedVersion,
		sourceLatest ? (versionOf(sourceLatest) ?? 0) : 0,
	);
	const ids = new Set(candidates.map((c) => c.id));
	const found: MigrationTemplate[] = [];
	for (const id of ids) {
		const latest = latestOf(
			candidates.filter((c) => !c.deprecated),
			id,
		);
		if (latest && latest.id !== appliedId) {
			if (reachableHop(safeRecipe(latest), appliedId, drained)) {
				found.push(latest);
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
		(t) => t.id === id && versionOf(t) === version,
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
