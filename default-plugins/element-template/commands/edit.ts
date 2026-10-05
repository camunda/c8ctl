/**
 * `c8ctl element-template edit` — update property values on a BPMN element
 * that already has an element template applied, without re-running
 * template application.
 *
 * Unlike `apply --set`, `edit` never calls `elementTemplates.applyTemplate`.
 * It only writes into moddle children that already exist, via the same
 * `modeling.updateModdleProperties` command-stack writes `apply` uses.
 * `applyTemplate` is what unconditionally resets Hidden-typed template
 * properties to their template default on every (re-)application — see
 * ChangeElementTemplateHandler#shouldKeepValue and c8ctl#466 — so skipping
 * it means `edit` never clobbers template-owned extension content a user
 * hand-customized beyond the template's own schema (e.g. a manually-added
 * conditional inside a `zeebe:adHoc` `outputElement`).
 *
 * The tradeoff: `edit` can only set bindings whose moddle entry already
 * exists — it can't create one whose gating condition wasn't previously
 * met. Use `apply --set` for that; use `edit` once a template is already
 * applied and you want to change one property without touching anything
 * else the template governs.
 *
 * `edit` still round-trips through bpmn-js's `saveXML`, so it inherits
 * that pipeline's unrelated BPMNDI shape/edge reordering — same as `apply`
 * (see c8ctl#466; considered cosmetic/out of scope, not data loss).
 *
 * The template is identified by the target element's own
 * `zeebe:modelerTemplate`/`zeebe:modelerTemplateVersion` attributes. An
 * explicit `--template <id[@version]|path|url>` wins (and must match that
 * id/version); otherwise it's looked up in `.camunda/element-templates/`
 * next to the BPMN file (or an ancestor directory), then in the OOTB cache.
 */

import { createRequire } from "node:module";
import { dirname } from "node:path";
import type {} from "../../../src/core/runtime.ts";
import { findExtensionContainers, resolveBindingTarget } from "../binding.ts";
import {
	atomicOverwriteFile,
	findPropertiesByBindingName,
	installStdoutEpipeHandler,
	maybePrependFeel,
	parseArgs,
	parseSetArg,
	type Template,
	validateDropdownValue,
} from "../helpers.ts";
import {
	getModdleElement,
	getModdleNumber,
	getModdleString,
} from "../moddle.ts";
import {
	parseTemplateRef,
	readBpmnInput,
	readTemplateFromPathOrUrl,
	resolveTemplateId,
} from "../template-ref.ts";
import {
	type BpmnElement,
	type ModdleElement,
	type ModelerInstance,
	resolveVendorBundle,
	type VendorBundle,
} from "../vendor.ts";

if (!globalThis.c8ctl) throw new Error("c8ctl runtime not initialised");
const c8ctl = globalThis.c8ctl;
const require = createRequire(import.meta.url);

type PlannedWrite = {
	child: ModdleElement;
	property: string;
	value: string;
};

type EditPlan = {
	element: BpmnElement;
	template: Template;
	writes: PlannedWrite[];
};

/**
 * Strip `--template <ref>` / `--template=<ref>` (edit-only, so it isn't part
 * of the `parseArgs` shared with `apply`). Last flag wins; content after
 * `--` is treated as positional.
 */
function extractTemplateFlag(args: string[]): {
	templateArg: string | undefined;
	rest: string[];
} {
	let templateArg: string | undefined;
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") {
			rest.push(...args.slice(i));
			break;
		}
		if (arg === "--template" || arg.startsWith("--template=")) {
			const value =
				arg === "--template" ? args[++i] : arg.slice("--template=".length);
			if (!value) {
				throw new Error(
					"--template requires a value (an OOTB id[@version], a local path, or an https:// URL)",
				);
			}
			templateArg = value;
			continue;
		}
		rest.push(arg);
	}
	return { templateArg, rest };
}

/**
 * Resolve the template recorded on the element. An explicit `--template`
 * wins and must match the recorded id/version — `edit` never switches
 * templates; that's `apply`'s job. Without one, a project-local template
 * is preferred over the OOTB cache.
 */
async function resolveEditTemplate(
	templateArg: string | undefined,
	templateId: string,
	templateVersion: number,
	searchDir: string,
): Promise<Template> {
	if (templateArg) {
		const ref = parseTemplateRef(templateArg);
		const template =
			ref?.kind === "id"
				? await resolveTemplateId(
						{ ...ref, version: ref.version ?? templateVersion },
						{ searchDir },
					)
				: await readTemplateFromPathOrUrl(templateArg);
		if (template.id !== templateId || template.version !== templateVersion) {
			throw new Error(
				`--template ${templateArg} (${template.id ?? "<no id>"} v${template.version ?? "?"}) does not match ` +
					`the template recorded on the element (${templateId} v${templateVersion}). ` +
					"Use 'apply' to switch templates or versions.",
			);
		}
		return template;
	}

	try {
		return await resolveTemplateId(
			{ kind: "id", id: templateId, version: templateVersion },
			{ searchDir },
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`${message}\nFor a custom template, place it under .camunda/element-templates/ next to the ` +
				"BPMN file (or in a parent directory), or pass --template <path|url>.",
		);
	}
}

/**
 * Resolve the target element, its recorded template, and validate every
 * `--set` arg against the element's *already-materialized* moddle tree.
 * Shared by the real run and `--dry-run` so both use identical validation —
 * a dry run that reports success is guaranteed to actually succeed.
 */
async function planEdit(
	modeler: ModelerInstance,
	elementId: string,
	setArgs: string[],
	templateArg: string | undefined,
	searchDir: string,
): Promise<EditPlan> {
	const elementRegistry = modeler.get("elementRegistry");
	const element = elementRegistry.get(elementId);
	if (!element) {
		throw new Error(`Element "${elementId}" not found in the BPMN diagram`);
	}

	const templateId = getModdleString(element.businessObject, "modelerTemplate");
	if (!templateId) {
		throw new Error(
			`Element "${elementId}" has no element template applied (no zeebe:modelerTemplate attribute). ` +
				"Use 'apply' to apply one first.",
		);
	}
	const templateVersion = getModdleNumber(
		element.businessObject,
		"modelerTemplateVersion",
	);
	if (templateVersion === undefined) {
		throw new Error(
			`Element "${elementId}" has zeebe:modelerTemplate="${templateId}" but no recorded ` +
				"zeebe:modelerTemplateVersion. 'edit' requires a pinned version to resolve the exact " +
				"template that was applied — use 'apply' with an explicit template reference instead.",
		);
	}

	const template = await resolveEditTemplate(
		templateArg,
		templateId,
		templateVersion,
		searchDir,
	);

	const extensionElements = getModdleElement(
		element.businessObject,
		"extensionElements",
	);
	const containers = findExtensionContainers(extensionElements);

	// Keyed by (child, property) so conditional duplicate properties (same
	// binding name+type, different `condition`) collapse into one write per
	// pair instead of redundant `updateModdleProperties` calls. Keying via a
	// nested Map also gives "--set wins" last-write semantics — matching
	// `apply`'s behavior — when two distinct --set args resolve to the same
	// target, e.g. `--set method=PUT --set method=DELETE`.
	const writesByChild = new Map<ModdleElement, Map<string, PlannedWrite>>();
	for (const arg of setArgs) {
		const { bindingTypeFilter, name, value } = parseSetArg(arg);
		const matches = findPropertiesByBindingName(
			template.properties,
			name,
			bindingTypeFilter,
		);

		let materialized = false;
		for (const prop of matches) {
			if (!prop.binding) continue;
			const effectiveValue = maybePrependFeel(prop, value);
			if (prop.choices) {
				validateDropdownValue(prop, name, effectiveValue);
			}
			const target = resolveBindingTarget(prop.binding, containers);
			if (target) {
				materialized = true;
				let byProperty = writesByChild.get(target.child);
				if (!byProperty) {
					byProperty = new Map();
					writesByChild.set(target.child, byProperty);
				}
				byProperty.set(target.property, {
					child: target.child,
					property: target.property,
					value: effectiveValue,
				});
			}
		}
		if (!materialized) {
			throw new Error(
				`Property "${name}" has no existing value on this element to edit (its condition may not ` +
					"be met, its binding type isn't supported by 'edit', or the template was never fully " +
					`applied). Use 'apply --set ${name}=...' to materialize it first.`,
			);
		}
	}

	const writes: PlannedWrite[] = [];
	for (const byProperty of writesByChild.values()) {
		writes.push(...byProperty.values());
	}

	return { element, template, writes };
}

export async function editSubcommand(args: string[]): Promise<void> {
	const logger = c8ctl.getLogger();
	// editSubcommand writes BPMN XML to stdout in the non-in-place path;
	// install the EPIPE handler before any downstream `head -c N` or
	// `| less` can sever the pipe.
	installStdoutEpipeHandler();
	const { templateArg, rest } = extractTemplateFlag(args);
	const parsed = parseArgs(rest);

	if (parsed.error) {
		throw new Error(parsed.error);
	}

	const [elementId, bpmnFilePath] = parsed.positionals;

	if (parsed.positionals.length > 2) {
		throw new Error(
			`Unexpected argument: ${parsed.positionals[2]}. Usage: c8ctl element-template edit <element-id> [<file.bpmn>] --set name=value`,
		);
	}
	if (!elementId) {
		throw new Error(
			"Missing element-id argument. Usage: c8ctl element-template edit <element-id> [<file.bpmn>] --set name=value",
		);
	}
	if (parsed.setArgs.length === 0) {
		throw new Error(
			"edit requires at least one --set name=value (nothing to edit). Usage: c8ctl element-template edit <element-id> [<file.bpmn>] --set name=value",
		);
	}

	// Reject incompatible flag combinations before reading stdin —
	// otherwise a piped BPMN stream is consumed (and a long-running
	// producer can hang) just to surface a usage error.
	if (parsed.inPlace && !bpmnFilePath) {
		throw new Error("--in-place cannot be used with stdin input");
	}

	const input = await readBpmnInput(bpmnFilePath);
	if (!input) {
		throw new Error(
			"No BPMN input provided. Pass a file path or pipe BPMN XML via stdin.",
		);
	}

	const vendorPath = resolveVendorBundle();
	const vendor: VendorBundle = require(vendorPath);
	const { Modeler, ZeebeModdleExtension, HeadlessTextRendererModule } = vendor;

	// HeadlessTextRendererModule overrides bpmn-js's default textRenderer,
	// which would otherwise call document.createElementNS during importXML
	// (to measure external label bounds) and throw "document is not defined"
	// in Node. The errors are non-fatal but produce noisy stack traces.
	const modeler = new Modeler({
		additionalModules: [HeadlessTextRendererModule],
		moddleExtensions: { zeebe: ZeebeModdleExtension },
	});

	let plan: EditPlan;
	try {
		await modeler.importXML(input.xml);
		plan = await planEdit(
			modeler,
			elementId,
			parsed.setArgs,
			templateArg,
			bpmnFilePath ? dirname(input.source) : process.cwd(),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Error editing element: ${message}`);
	}

	if (c8ctl.dryRun) {
		const info = {
			dryRun: true,
			command: "element-template edit",
			template: {
				id: plan.template.id,
				name: plan.template.name,
				version: plan.template.version,
			},
			elementId,
			source: input.source,
			inPlace: parsed.inPlace && !!bpmnFilePath,
			setOverrides: parsed.setArgs,
		};
		if (c8ctl.outputMode === "json") {
			logger.json(info);
		} else {
			logger.output("Dry run — no changes applied.");
			logger.output(
				`  Template: ${info.template.name ?? info.template.id}${
					info.template.version != null ? ` v${info.template.version}` : ""
				}`,
			);
			logger.output(`  Element:  ${elementId}`);
			logger.output(`  Source:   ${input.source}`);
			if (info.inPlace) {
				logger.output(`  Mode:     in-place (would overwrite ${bpmnFilePath})`);
			} else {
				logger.output("  Mode:     stdout (would print transformed XML)");
			}
			logger.output(`  --set:    ${parsed.setArgs.join(", ")}`);
		}
		return;
	}

	const modeling = modeler.get("modeling");
	for (const write of plan.writes) {
		modeling.updateModdleProperties(plan.element, write.child, {
			[write.property]: write.value,
		});
	}
	const result = await modeler.saveXML({ format: true });
	const resultXml = result.xml;

	if (parsed.inPlace && bpmnFilePath) {
		atomicOverwriteFile(bpmnFilePath, resultXml);
		logger.info(`Updated ${bpmnFilePath}`);
		return;
	}

	process.stdout.write(resultXml);
}
