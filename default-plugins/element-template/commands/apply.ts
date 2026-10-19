/**
 * `c8ctl element-template apply` — apply an element template to a BPMN
 * element via the prebuilt bpmn-js + bpmn-js-element-templates vendor bundle.
 */

import { createRequire } from "node:module";
import { dirname } from "node:path";
import type {} from "../../../src/core/runtime.ts";
import {
	applySetOverrides,
	atomicOverwriteFile,
	findPropertiesByBindingName,
	installStdoutEpipeHandler,
	parseArgs,
	parseSetArg,
	pinFilePath,
	type Template,
	type TemplateProperty,
	warnUnmetConditions,
} from "../helpers.ts";
import {
	elementExistsInBpmn,
	getExecutionPlatformVersion,
	parseTemplateRef,
	readBpmnInput,
	readTemplateFromPathOrUrl,
	resolveTemplateId,
} from "../template-ref.ts";
import {
	type BpmnElement,
	type ElementTemplatesService,
	resolveVendorBundle,
	type VendorBundle,
} from "../vendor.ts";

if (!globalThis.c8ctl) throw new Error("c8ctl runtime not initialised");
const c8ctl = globalThis.c8ctl;
const require = createRequire(import.meta.url);

/**
 * Force the value of each `--set` into the element.
 *
 * bpmn-js-element-templates' applyTemplate preserves existing input/output/
 * header/property values on a re-apply (and unconditionally on Dropdown
 * properties — see ChangeElementTemplateHandler#shouldKeepValue, ref
 * bpmn-io/bpmn-js-properties-panel#767). For a CLI the user expectation is
 * "--set wins". After the first applyTemplate we write each --set value via
 * the library's own `setPropertyValue`, the same code path the Modeler
 * properties panel uses (FEEL casting included).
 *
 * Properties whose condition isn't met against the pre-apply element state
 * are skipped here and picked up by the second applyTemplate, which
 * re-evaluates conditions against the now-updated element and creates the
 * missing entries using our mutated `prop.value` as the default.
 */
function forceSetValues(
	element: BpmnElement,
	elementTemplates: ElementTemplatesService,
	template: Template,
	setArgs: string[],
): void {
	for (const arg of setArgs) {
		const { bindingTypeFilter, name, value } = parseSetArg(arg);
		const matches = findPropertiesByBindingName(
			template.properties,
			name,
			bindingTypeFilter,
		);
		for (const prop of matches) {
			if (
				prop.binding &&
				elementTemplates.isConditionMet(element, template.properties, prop)
			) {
				elementTemplates.setPropertyValue(element, prop, value);
			}
		}
	}
}

/**
 * Apply an element template to a BPMN element using bpmn-js-headless and
 * bpmn-js-element-templates (same libraries as Web/Desktop Modeler).
 *
 * Loaded from a prebuilt CJS vendor bundle since the upstream libraries
 * use extensionless ESM imports that Node.js can't resolve without a bundler.
 *
 * Pass `setArgs` to honor `--set` overrides on re-apply. The first
 * applyTemplate uses the (already-mutated) template defaults for fresh
 * properties; `forceSetValues` then overrides preserved values; a second
 * applyTemplate picks up dependents whose conditions just became met.
 */
async function applyElementTemplate(
	xml: string,
	template: Template,
	elementId: string,
	setArgs: string[],
): Promise<string> {
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

	await modeler.importXML(xml);

	const elementRegistry = modeler.get("elementRegistry");
	const element = elementRegistry.get(elementId);
	if (!element) {
		throw new Error(`Element "${elementId}" not found in the BPMN diagram`);
	}

	const elementTemplates = modeler.get("elementTemplates");
	elementTemplates.set([template]);
	// `applyTemplate` returns the element to keep working with: it is a new
	// one when the template changes the element's type (e.g. Task →
	// ServiceTask), leaving the original stale.
	let current = elementTemplates.applyTemplate(element, template) ?? element;

	if (setArgs.length > 0) {
		forceSetValues(current, elementTemplates, template, setArgs);
		// Second pass so dependents whose conditions are newly met get
		// created with our mutated defaults.
		current = elementTemplates.applyTemplate(current, template) ?? current;
	}

	const result = await modeler.saveXML({ format: true });
	return result.xml;
}

export async function applySubcommand(args: string[]): Promise<void> {
	const logger = c8ctl.getLogger();
	// applySubcommand writes BPMN XML to stdout in the non-in-place path;
	// install the EPIPE handler before any downstream `head -c N` or
	// `| less` can sever the pipe.
	installStdoutEpipeHandler();
	const parsed = parseArgs(args);

	if (parsed.error) {
		throw new Error(parsed.error);
	}

	const [templateArg, elementId, bpmnFilePath] = parsed.positionals;

	if (parsed.positionals.length > 3) {
		throw new Error(
			`Unexpected argument: ${parsed.positionals[3]}. Usage: c8ctl element-template apply <template> <element-id> [<file.bpmn>]`,
		);
	}

	if (!templateArg) {
		throw new Error(
			"Missing template argument. Usage: c8ctl element-template apply <template> <element-id> [<file.bpmn>]",
		);
	}
	if (!elementId) {
		throw new Error(
			"Missing element-id argument. Usage: c8ctl element-template apply <template> <element-id> [<file.bpmn>]",
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

	const ref = parseTemplateRef(templateArg);
	if (!ref) {
		throw new Error("Missing template argument.");
	}
	let template: Template;
	if (ref.kind === "id") {
		const executionPlatformVersion = await getExecutionPlatformVersion(
			input.xml,
		);
		template = await resolveTemplateId(ref, {
			searchDir: bpmnFilePath ? dirname(input.source) : process.cwd(),
			executionPlatformVersion,
		});
		if (ref.version === undefined && !executionPlatformVersion) {
			logger.warn(
				"BPMN has no modeler:executionPlatformVersion — applying latest version " +
					`(${template.version}) of ${ref.id}.`,
			);
		}
	} else {
		template = await readTemplateFromPathOrUrl(ref.value);
	}

	// Validate --set overrides against the template before dry-run or real apply,
	// so `--dry-run --set notAProperty=x` fails just as the real apply would.
	let setProperties: TemplateProperty[] = [];
	if (parsed.setArgs.length > 0) {
		setProperties = applySetOverrides(template.properties, parsed.setArgs);
	}

	// Dry-run: describe what would happen without mutating anything
	if (c8ctl.dryRun) {
		// Validate the target element exists so dry-run only reports a successful
		// plan when the real apply would also succeed.
		if (!(await elementExistsInBpmn(input.xml, elementId))) {
			throw new Error(`Element "${elementId}" not found in the BPMN diagram`);
		}
		const fallbackId = ref.kind === "id" ? ref.id : ref.value;
		const info = {
			dryRun: true,
			command: "element-template apply",
			template: {
				id: template.id ?? fallbackId,
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
			if (parsed.setArgs.length > 0) {
				logger.output(`  --set:    ${parsed.setArgs.join(", ")}`);
			}
		}
		return;
	}

	let resultXml: string;
	try {
		resultXml = await applyElementTemplate(
			input.xml,
			template,
			elementId,
			parsed.setArgs,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Error applying template: ${message}`);
	}

	if (setProperties.length > 0) {
		warnUnmetConditions(logger, resultXml, setProperties);
	}

	if (writePath) {
		atomicOverwriteFile(writePath, resultXml, input.xml, true);
		logger.info(`Updated ${bpmnFilePath}`);
		return;
	}

	process.stdout.write(resultXml);
}
