/**
 * `c8ctl element-template edit` — update property values on a BPMN element
 * that already has an element template applied, without re-running
 * template application.
 *
 * Unlike `apply --set`, `edit` never calls `elementTemplates.applyTemplate`.
 * It writes only the `--set` properties through the library's own
 * `elementTemplates.setPropertyValue` (the Modeler properties-panel code
 * path, FEEL casting included), gated by `isConditionMet` and checked with
 * `validateProperty`. `applyTemplate` is what unconditionally resets
 * Hidden-typed template properties to their template default on every
 * (re-)application — see ChangeElementTemplateHandler#shouldKeepValue — so
 * skipping it means `edit` never clobbers template-owned extension content a
 * user hand-customized beyond the template's own schema (e.g. a
 * manually-added conditional inside a `zeebe:adHoc` `outputElement`).
 *
 * A property whose condition is not met is an error; `--set` args are
 * applied in order, so `--set method=POST --set body=...` materializes
 * `body` in a single edit.
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
import { parseArgs as parseArgv } from "node:util";
import type {} from "../../../src/core/runtime.ts";
import {
	atomicOverwriteFile,
	findPropertiesByBindingName,
	installStdoutEpipeHandler,
	parseArgs,
	parseSetArg,
	pinFilePath,
	type Template,
	validateDropdownValue,
} from "../helpers.ts";
import {
	getModdleElement,
	getModdleList,
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
	type Modeling,
	resolveVendorBundle,
	type VendorBundle,
} from "../vendor.ts";

if (!globalThis.c8ctl) throw new Error("c8ctl runtime not initialised");
const c8ctl = globalThis.c8ctl;
const require = createRequire(import.meta.url);

/** Ordered collections under `extensionElements` whose entry order we preserve. */
const ORDERED_LISTS = [
	["zeebe:IoMapping", "inputParameters"],
	["zeebe:IoMapping", "outputParameters"],
	["zeebe:TaskHeaders", "values"],
	["zeebe:Properties", "properties"],
] as const;

function entryIdentity(entry: ModdleElement): string {
	const id =
		getModdleString(entry, "target") ??
		getModdleString(entry, "source") ??
		getModdleString(entry, "key") ??
		getModdleString(entry, "name");
	return `${entry.$type}:${id}`;
}

function findContainer(
	element: BpmnElement,
	type: string,
): ModdleElement | undefined {
	return getModdleList(
		getModdleElement(element.businessObject, "extensionElements"),
		"values",
	).find((v) => v.$type === type);
}

/** Snapshot the current entry order of every ordered list on `element`. */
function snapshotOrder(element: BpmnElement): Map<string, string[]> {
	const order = new Map<string, string[]>();
	for (const [type, prop] of ORDERED_LISTS) {
		order.set(
			`${type}/${prop}`,
			getModdleList(findContainer(element, type), prop).map(entryIdentity),
		);
	}
	return order;
}

/**
 * `setPropertyValue` replaces an entry (remove + append), which would move
 * every edited entry to the end of its list and churn the diff. Put the
 * surviving entries back in their original order; newly created ones stay
 * at the end.
 */
function restoreOrder({
	element,
	order,
	modeling,
}: {
	element: BpmnElement;
	order: Map<string, string[]>;
	modeling: Modeling;
}): void {
	for (const [type, prop] of ORDERED_LISTS) {
		const container = findContainer(element, type);
		const before = order.get(`${type}/${prop}`) ?? [];
		const current = getModdleList(container, prop);
		const rank = (e: ModdleElement) => {
			const i = before.indexOf(entryIdentity(e));
			return i === -1 ? before.length : i;
		};
		const sorted = [...current].sort((a, b) => rank(a) - rank(b));
		if (container && sorted.some((e, i) => e !== current[i])) {
			modeling.updateModdleProperties(element, container, { [prop]: sorted });
		}
	}
}

/**
 * Strip `--template <ref>` / `--template=<ref>` (edit-only, so it isn't part
 * of the `parseArgs` shared with `apply`). Tokenised by `node:util`
 * `parseArgs` in non-strict mode so every other flag passes through to the
 * shared parser untouched. Last flag wins; content after `--` is positional.
 */
function extractTemplateFlag(args: string[]): {
	templateArg: string | undefined;
	rest: string[];
} {
	const { tokens } = parseArgv({
		args,
		options: { template: { type: "string" } },
		strict: false,
		allowPositionals: true,
		tokens: true,
	});
	let templateArg: string | undefined;
	const consumed = new Set<number>();
	for (const token of tokens) {
		if (token.kind !== "option" || token.name !== "template") continue;
		if (!token.value) {
			throw new Error(
				"--template requires a value (an OOTB id[@version], a local path, or an https:// URL)",
			);
		}
		templateArg = token.value;
		consumed.add(token.index);
		if (!token.inlineValue) consumed.add(token.index + 1);
	}
	return { templateArg, rest: args.filter((_, i) => !consumed.has(i)) };
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

	// Pin the file before the read, so a retargeted link cannot redirect the write.
	// Unlike migrate, which reads through the pinned path, the read here follows
	// the link. A retarget between pin and read fails the content check and
	// never writes the wrong file.
	const writePath =
		parsed.inPlace && bpmnFilePath ? pinFilePath(bpmnFilePath) : undefined;
	const input = await readBpmnInput(bpmnFilePath);
	if (!input) {
		throw new Error(
			"No BPMN input provided. Pass a file path or pipe BPMN XML via stdin.",
		);
	}

	const vendorPath = resolveVendorBundle();
	const vendor: VendorBundle = require(vendorPath);
	const {
		Modeler,
		CloudElementTemplatesCoreModule,
		ZeebeModdleExtension,
		HeadlessTextRendererModule,
	} = vendor;

	// HeadlessTextRendererModule overrides bpmn-js's default textRenderer,
	// which would otherwise call document.createElementNS during importXML
	// (to measure external label bounds) and throw "document is not defined"
	// in Node. The errors are non-fatal but produce noisy stack traces.
	const modeler = new Modeler({
		additionalModules: [
			HeadlessTextRendererModule,
			CloudElementTemplatesCoreModule,
		],
		moddleExtensions: { zeebe: ZeebeModdleExtension },
	});

	// Resolve the target element and its recorded template, then validate and
	// write every `--set` arg into the in-memory modeler. Nothing is persisted
	// until `saveXML`, so `--dry-run` runs this identical path and returns
	// before the write.
	const searchDir = bpmnFilePath ? dirname(input.source) : process.cwd();
	let template: Template;
	try {
		await modeler.importXML(input.xml);
		const elementRegistry = modeler.get("elementRegistry");
		const element = elementRegistry.get(elementId);
		if (!element) {
			throw new Error(`Element "${elementId}" not found in the BPMN diagram`);
		}

		const templateId = getModdleString(
			element.businessObject,
			"modelerTemplate",
		);
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

		template = await resolveEditTemplate(
			templateArg,
			templateId,
			templateVersion,
			searchDir,
		);

		// Writes go through the library's `setPropertyValue` — the same code path
		// as the Modeler properties panel — against the in-memory modeler. Nothing
		// is persisted until `saveXML`, so a dry run executes the identical
		// validation + writes and simply discards the result. Properties are
		// written in `--set` order, so later args win and see the effects of
		// earlier ones on conditions (e.g. `--set method=POST --set body=...`).
		//
		// The template is deliberately never registered via `elementTemplates.set`:
		// the library's behaviors (ConditionalBehavior et al.) look the element's
		// template up there, and once found, a write that changes which properties
		// are active re-runs template application — resetting Hidden properties,
		// exactly what `edit` exists to avoid.
		const elementTemplates = modeler.get("elementTemplates");
		const order = snapshotOrder(element);
		for (const arg of parsed.setArgs) {
			const { bindingTypeFilter, name, value } = parseSetArg(arg);
			const matches = findPropertiesByBindingName(
				template.properties,
				name,
				bindingTypeFilter,
			);

			// Conditional duplicates share a binding; only the active ones apply.
			const active = matches.filter(
				(prop) =>
					prop.binding &&
					elementTemplates.isConditionMet(element, template.properties, prop),
			);
			if (active.length === 0) {
				throw new Error(
					`Property "${name}" cannot be edited on this element: its condition is not met ` +
						"or it has no binding. Set the property its condition depends on first " +
						"(in the same edit, earlier in the --set order).",
				);
			}
			for (const prop of active) {
				if (prop.choices) {
					validateDropdownValue(prop, name, value);
				}
				const invalid = elementTemplates.validateProperty(value, prop);
				if (invalid) {
					throw new Error(`Invalid value for "${name}": ${invalid}`);
				}
				elementTemplates.setPropertyValue(element, prop, value);
			}
		}
		restoreOrder({ element, order, modeling: modeler.get("modeling") });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Error editing element: ${message}`);
	}

	if (c8ctl.dryRun) {
		const info = {
			dryRun: true,
			command: "element-template edit",
			template: {
				id: template.id,
				name: template.name,
				version: template.version,
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

	const result = await modeler.saveXML({ format: true });
	const resultXml = result.xml;

	if (writePath) {
		atomicOverwriteFile(writePath, resultXml, input.xml, true);
		logger.info(`Updated ${bpmnFilePath}`);
		return;
	}

	process.stdout.write(resultXml);
}
