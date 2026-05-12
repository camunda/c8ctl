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
	parseArgs,
	type Template,
	warnUnmetConditions,
} from "../helpers.ts";
import {
	getExecutionPlatformVersion,
	parseTemplateRef,
	readBpmnInput,
	readTemplateFromPathOrUrl,
	resolveOotbTemplate,
} from "../template-ref.ts";

const c8ctl = globalThis.c8ctl!;
const require = createRequire(import.meta.url);

// Minimal vendor-bundle surface — the bundle is loaded via require() with
// an absolute path, so we type the local destination instead of declaring
// the module name. Everything beyond this surface stays as `unknown` and
// gets narrowed at the use site.
type ElementRegistry = { get(id: string): unknown };
type ElementTemplatesService = {
	set(templates: Template[]): void;
	applyTemplate(element: unknown, template: Template): void;
};
type ModelerInstance = {
	importXML(xml: string): Promise<unknown>;
	get(name: "elementRegistry"): ElementRegistry;
	get(name: "elementTemplates"): ElementTemplatesService;
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
 * Apply an element template to a BPMN element using bpmn-js-headless and
 * bpmn-js-element-templates (same libraries as Web/Desktop Modeler).
 *
 * Loaded from a prebuilt CJS vendor bundle since the upstream libraries
 * use extensionless ESM imports that Node.js can't resolve without a bundler.
 */
async function applyElementTemplate(
	xml: string,
	template: Template,
	elementId: string,
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
		if (!ref.version && !executionPlatformVersion) {
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
		resultXml = await applyElementTemplate(input.xml, template, elementId);
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
