/**
 * Shared bpmn-js vendor-bundle loading + minimal type surface for commands
 * that round-trip BPMN through bpmn-js-headless (`apply`, `edit`).
 */

import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModdleElement } from "./binding.ts";
import type { Template } from "./helpers.ts";

export type { ModdleElement };
export type BpmnElement = { businessObject: ModdleElement };
export type ElementRegistry = { get(id: string): BpmnElement | undefined };
export type ElementTemplatesService = {
	set(templates: Template[]): void;
	applyTemplate(element: BpmnElement, template: Template): void;
};
export type Modeling = {
	updateModdleProperties(
		element: BpmnElement,
		moddleElement: ModdleElement,
		properties: Record<string, unknown>,
	): void;
};
export type ModelerInstance = {
	importXML(xml: string): Promise<unknown>;
	get(name: "elementRegistry"): ElementRegistry;
	get(name: "elementTemplates"): ElementTemplatesService;
	get(name: "modeling"): Modeling;
	get(name: string): unknown;
	saveXML(options: { format?: boolean }): Promise<{ xml: string }>;
};
export type ModelerCtor = new (options: {
	additionalModules: unknown[];
	moddleExtensions: Record<string, unknown>;
}) => ModelerInstance;
export type VendorBundle = {
	Modeler: ModelerCtor;
	CloudElementTemplatesCoreModule: unknown;
	ZeebeModdleExtension: unknown;
	HeadlessTextRendererModule: unknown;
};

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the prebuilt vendor bundle. Plugins live in two places:
 *   - dev:        default-plugins/element-template/{vendor.ts,commands/*.ts}
 *                 vendor: ../../dist/vendor/bpmn-element-templates.cjs
 *   - production: dist/default-plugins/element-template/{vendor.js,commands/*.js}
 *                 vendor: ../../vendor/bpmn-element-templates.cjs
 */
export function resolveVendorBundle(): string {
	const candidates = [
		resolvePath(
			__dirname,
			"..",
			"..",
			"dist",
			"vendor",
			"bpmn-element-templates.cjs",
		),
		resolvePath(__dirname, "..", "..", "vendor", "bpmn-element-templates.cjs"),
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
