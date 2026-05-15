/**
 * `c8ctl element-template apply` — apply an element template to a BPMN
 * element via the prebuilt bpmn-js + bpmn-js-element-templates vendor bundle.
 */

import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type {} from "../../../src/runtime.ts";
import {
	applySetOverrides,
	findPropertiesByBindingName,
	parseArgs,
	parseSetArg,
	type Template,
	type TemplateProperty,
	warnUnmetConditions,
} from "../helpers.ts";
import {
	getExecutionPlatformVersion,
	parseTemplateRef,
	readBpmnInput,
	readTemplateFromPathOrUrl,
	resolveOotbTemplate,
} from "../template-ref.ts";

if (!globalThis.c8ctl) throw new Error("c8ctl runtime not initialised");
const c8ctl = globalThis.c8ctl;
const require = createRequire(import.meta.url);

// Minimal vendor-bundle surface — the bundle is loaded via require() with
// an absolute path, so we type the local destination instead of declaring
// the module name. Everything beyond this surface stays as `unknown` and
// gets narrowed at the use site.
type ModdleElement = {
	$type: string;
	get(name: string): unknown;
	[key: string]: unknown;
};
type BpmnElement = { businessObject: ModdleElement };
type ElementRegistry = { get(id: string): BpmnElement | undefined };
type ElementTemplatesService = {
	set(templates: Template[]): void;
	applyTemplate(element: BpmnElement, template: Template): void;
};
type Modeling = {
	updateModdleProperties(
		element: BpmnElement,
		moddleElement: ModdleElement,
		properties: Record<string, unknown>,
	): void;
};
type ModelerInstance = {
	importXML(xml: string): Promise<unknown>;
	get(name: "elementRegistry"): ElementRegistry;
	get(name: "elementTemplates"): ElementTemplatesService;
	get(name: "modeling"): Modeling;
	get(name: string): unknown;
	saveXML(options: { format?: boolean }): Promise<{ xml: string }>;
};
type ModelerCtor = new (options: {
	additionalModules: unknown[];
	moddleExtensions: Record<string, unknown>;
}) => ModelerInstance;
type VendorBundle = {
	Modeler: ModelerCtor;
	CloudElementTemplatesCoreModule: unknown;
	ZeebeModdleExtension: unknown;
	HeadlessTextRendererModule: unknown;
};

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the prebuilt vendor bundle. Plugins live in two places:
 *   - dev:        default-plugins/element-template/commands/apply.ts
 *                 vendor: ../../../dist/vendor/bpmn-element-templates.cjs
 *   - production: dist/default-plugins/element-template/commands/apply.js
 *                 vendor: ../../../vendor/bpmn-element-templates.cjs
 */
function resolveVendorBundle(): string {
	const candidates = [
		resolvePath(
			__dirname,
			"..",
			"..",
			"..",
			"dist",
			"vendor",
			"bpmn-element-templates.cjs",
		),
		resolvePath(
			__dirname,
			"..",
			"..",
			"..",
			"vendor",
			"bpmn-element-templates.cjs",
		),
	];
	for (const path of candidates) {
		if (existsSync(path)) {
			return path;
		}
	}
	throw new Error(
		"Vendor bundle not found. Run `npm run build:vendor` to build it.\n" +
			`Searched: ${candidates.join(", ")}`,
	);
}

/**
 * Find the first child of `extensionElements` whose moddle `$type` matches.
 * Avoids importing bpmn-js's `is()` helper just for one shape check.
 */
function findExtensionByType(
	extensionElements: ModdleElement | undefined,
	type: string,
): ModdleElement | undefined {
	if (!extensionElements) {
		return undefined;
	}
	// biome-ignore lint/plugin: moddle API contract boundary — get() returns untyped collections
	const values = extensionElements.get("values") as ModdleElement[] | undefined;
	return values?.find((v) => v.$type === type);
}

/**
 * Force the source/value of each `--set` into the corresponding moddle child.
 *
 * bpmn-js-element-templates' applyTemplate preserves existing input/output/
 * header/property values on a re-apply (and unconditionally on Dropdown
 * properties — see ChangeElementTemplateHandler#shouldKeepValue, ref
 * bpmn-io/bpmn-js-properties-panel#767). For a CLI the user expectation is
 * "--set wins". After the first applyTemplate we walk the --set args, locate
 * the moddle entry that backs each binding, and update its value via
 * `modeling.updateModdleProperties` so the change goes through the same
 * command stack the library uses internally.
 *
 * Bindings whose moddle entry doesn't exist yet (because their condition was
 * not met against the pre-apply element state) are skipped here and picked
 * up by the second applyTemplate, which re-evaluates conditions against the
 * now-updated element and creates the missing entries using our mutated
 * `prop.value` as the default.
 */
function forceSetValues(
	modeler: ModelerInstance,
	element: BpmnElement,
	template: Template,
	setArgs: string[],
): void {
	const modeling = modeler.get("modeling");
	// biome-ignore lint/plugin: moddle API contract boundary — get() returns untyped ModdleElement
	const extensionElements = element.businessObject.get("extensionElements") as
		| ModdleElement
		| undefined;
	if (!extensionElements) {
		return;
	}

	const ioMapping = findExtensionByType(extensionElements, "zeebe:IoMapping");
	const taskHeaders = findExtensionByType(
		extensionElements,
		"zeebe:TaskHeaders",
	);
	const taskDefinition = findExtensionByType(
		extensionElements,
		"zeebe:TaskDefinition",
	);
	const zeebeProperties = findExtensionByType(
		extensionElements,
		"zeebe:Properties",
	);

	for (const arg of setArgs) {
		const { bindingTypeFilter, name, value } = parseSetArg(arg);
		const matches = findPropertiesByBindingName(
			template.properties,
			name,
			bindingTypeFilter,
		);
		for (const prop of matches) {
			updateModdleForProperty(modeling, element, prop, value, {
				ioMapping,
				taskHeaders,
				taskDefinition,
				zeebeProperties,
			});
		}
	}
}

function updateModdleForProperty(
	modeling: Modeling,
	element: BpmnElement,
	prop: TemplateProperty,
	value: string,
	containers: {
		ioMapping: ModdleElement | undefined;
		taskHeaders: ModdleElement | undefined;
		taskDefinition: ModdleElement | undefined;
		zeebeProperties: ModdleElement | undefined;
	},
): void {
	const binding = prop.binding;
	if (!binding) {
		return;
	}

	switch (binding.type) {
		case "zeebe:input": {
			// biome-ignore lint/plugin: moddle API contract boundary — get() returns untyped collections
			const inputs = (containers.ioMapping?.get("inputParameters") ??
				[]) as ModdleElement[];
			const child = inputs.find((p) => p.target === binding.name);
			if (child) {
				modeling.updateModdleProperties(element, child, { source: value });
			}
			return;
		}
		case "zeebe:output": {
			// biome-ignore lint/plugin: moddle API contract boundary — get() returns untyped collections
			const outputs = (containers.ioMapping?.get("outputParameters") ??
				[]) as ModdleElement[];
			const child = outputs.find((p) => p.source === binding.source);
			if (child) {
				modeling.updateModdleProperties(element, child, { target: value });
			}
			return;
		}
		case "zeebe:taskHeader": {
			// biome-ignore lint/plugin: moddle API contract boundary — get() returns untyped collections
			const headers = (containers.taskHeaders?.get("values") ??
				[]) as ModdleElement[];
			const child = headers.find((h) => h.key === binding.key);
			if (child) {
				modeling.updateModdleProperties(element, child, { value });
			}
			return;
		}
		case "zeebe:property": {
			// biome-ignore lint/plugin: moddle API contract boundary — get() returns untyped collections
			const props = (containers.zeebeProperties?.get("properties") ??
				[]) as ModdleElement[];
			const child = props.find((p) => p.name === binding.name);
			if (child) {
				modeling.updateModdleProperties(element, child, { value });
			}
			return;
		}
		case "zeebe:taskDefinition": {
			if (containers.taskDefinition && binding.property) {
				modeling.updateModdleProperties(element, containers.taskDefinition, {
					[binding.property]: value,
				});
			}
			return;
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
	elementTemplates.applyTemplate(element, template);

	if (setArgs.length > 0) {
		forceSetValues(modeler, element, template, setArgs);
		// Second pass so dependents whose conditions are newly met get
		// created with our mutated defaults.
		elementTemplates.applyTemplate(element, template);
	}

	const result = await modeler.saveXML({ format: true });
	return result.xml;
}

export async function applySubcommand(args: string[]): Promise<void> {
	const logger = c8ctl.getLogger();
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

	const input = await readBpmnInput(bpmnFilePath);
	if (!input) {
		throw new Error(
			"No BPMN input provided. Pass a file path or pipe BPMN XML via stdin.",
		);
	}

	if (parsed.inPlace && !bpmnFilePath) {
		throw new Error("--in-place cannot be used with stdin input");
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
		template = await resolveOotbTemplate(ref, { executionPlatformVersion });
		if (ref.version === undefined && !executionPlatformVersion) {
			logger.warn(
				"BPMN has no modeler:executionPlatformVersion — applying latest version " +
					`(${template.version}) of ${ref.id}.`,
			);
		}
	} else {
		template = await readTemplateFromPathOrUrl(ref.value);
	}

	// Dry-run: describe what would happen without mutating anything
	if (c8ctl.dryRun) {
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

	let setBindingNames: string[] = [];
	if (parsed.setArgs.length > 0) {
		setBindingNames = applySetOverrides(template.properties, parsed.setArgs);
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

	if (setBindingNames.length > 0) {
		warnUnmetConditions(
			logger,
			resultXml,
			setBindingNames,
			template.properties,
		);
	}

	if (parsed.inPlace && bpmnFilePath) {
		writeFileSync(resolvePath(bpmnFilePath), resultXml, "utf-8");
		logger.info(`Updated ${bpmnFilePath}`);
		return;
	}

	process.stdout.write(resultXml);
}
