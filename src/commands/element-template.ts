/**
 * Element template commands — apply templates and inspect properties.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { CommandResult } from "../command-framework.ts";
import { defineCommand } from "../command-framework.ts";
import { readBpmnInput } from "./bpmn.ts";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface TemplateProperty {
	id?: string;
	label?: string;
	type?: string;
	value?: unknown;
	group?: string;
	binding?: {
		type?: string;
		name?: string;
		key?: string;
		property?: string;
		source?: string;
	};
	choices?: Array<{ name: string; value: string }>;
	condition?: unknown;
}

interface ElementTemplate {
	name?: string;
	id?: string;
	properties: TemplateProperty[];
	groups?: Array<{ id: string; label: string }>;
}

// ---------------------------------------------------------------------------
// --set flag: template property mutation
// ---------------------------------------------------------------------------

/** Binding type shorthand prefixes for disambiguation. */
const BINDING_TYPE_SHORTHANDS: Record<string, string> = {
	input: "zeebe:input",
	output: "zeebe:output",
	header: "zeebe:taskHeader",
	property: "zeebe:property",
	taskDefinition: "zeebe:taskDefinition",
};

/**
 * Get the user-facing binding name for a template property.
 * Returns the name/key/property field depending on binding type.
 */
function getBindingName(prop: TemplateProperty): string | null {
	const b = prop.binding;
	if (!b) return null;
	if (b.name !== undefined) return b.name;
	if (b.key !== undefined) return b.key;
	if (b.property !== undefined) return b.property;
	return null;
}

/** Get the shorthand label for a binding type (e.g. "zeebe:taskHeader" → "header"). */
function getBindingTypeShorthand(bindingType: string): string {
	const entry = Object.entries(BINDING_TYPE_SHORTHANDS).find(
		([, v]) => v === bindingType,
	);
	return entry ? entry[0] : bindingType;
}

/** Return only the properties that can be targeted by --set. */
function getSettableProperties(
	properties: TemplateProperty[],
): TemplateProperty[] {
	return properties.filter(
		(p) => p.type !== "Hidden" && getBindingName(p) !== null,
	);
}

/**
 * Parse a --set key=value string. If key contains a `:` prefix,
 * resolve the binding type shorthand.
 */
function parseSetArg(arg: string): {
	bindingTypeFilter: string | null;
	name: string;
	value: string;
} {
	const eqIndex = arg.indexOf("=");
	if (eqIndex === -1) {
		throw new Error(
			`Invalid --set format: "${arg}". Expected key=value (e.g. --set method=POST)`,
		);
	}

	const key = arg.slice(0, eqIndex);
	const value = arg.slice(eqIndex + 1);

	// Check for binding type prefix (e.g. "input:url")
	const colonIndex = key.indexOf(":");
	if (colonIndex !== -1) {
		const prefix = key.slice(0, colonIndex);
		const name = key.slice(colonIndex + 1);
		const bindingType = BINDING_TYPE_SHORTHANDS[prefix];
		if (!bindingType) {
			const valid = Object.keys(BINDING_TYPE_SHORTHANDS).join(", ");
			throw new Error(
				`Unknown binding type prefix "${prefix}". Valid prefixes: ${valid}`,
			);
		}
		return { bindingTypeFilter: bindingType, name, value };
	}

	return { bindingTypeFilter: null, name: key, value };
}

/**
 * Find a template property by binding name, optionally filtered by binding type.
 * Throws on ambiguity or unknown names.
 */
function findPropertyByBindingName(
	properties: TemplateProperty[],
	name: string,
	bindingTypeFilter: string | null,
): TemplateProperty {
	const settable = getSettableProperties(properties);

	const matches = settable.filter((p) => {
		if (getBindingName(p) !== name) return false;
		if (bindingTypeFilter && p.binding?.type !== bindingTypeFilter)
			return false;
		return true;
	});

	if (matches.length === 1) return matches[0];

	if (matches.length > 1) {
		const qualified = matches.map((p) => {
			const prefix = getBindingTypeShorthand(p.binding?.type ?? "");
			return `${prefix}:${name}`;
		});
		throw new Error(
			`Ambiguous property "${name}" matches ${matches.length} bindings. Use a qualified name: ${qualified.join(", ")}`,
		);
	}

	// No match — list available names
	const available = [...new Set(settable.map(getBindingName).filter(Boolean))];
	throw new Error(
		`Unknown property "${name}". Available properties for --set:\n  ${available.join(", ")}`,
	);
}

/**
 * Validate a dropdown value against the declared choices.
 */
function validateDropdownValue(
	prop: TemplateProperty,
	name: string,
	value: string,
): void {
	if (!prop.choices) return;
	const validValues = prop.choices.map((c) => c.value);
	if (!validValues.includes(value)) {
		throw new Error(
			`Invalid value "${value}" for "${name}". Valid choices: ${validValues.join(", ")}`,
		);
	}
}

/**
 * Apply --set overrides to template properties. Mutates the template in place.
 * Returns the list of binding names that were set (for post-apply warning).
 */
function applySetOverrides(
	properties: TemplateProperty[],
	setArgs: string[],
): string[] {
	const setBindingNames: string[] = [];

	for (const arg of setArgs) {
		const { bindingTypeFilter, name, value } = parseSetArg(arg);
		const prop = findPropertyByBindingName(properties, name, bindingTypeFilter);

		if (prop.choices) {
			validateDropdownValue(prop, name, value);
		}

		prop.value = value;
		const bindingName = getBindingName(prop);
		if (bindingName) setBindingNames.push(bindingName);
	}

	return setBindingNames;
}

/**
 * Check which --set bindings actually made it into the output XML.
 * Warn for any that were dropped (unmet condition).
 */
function warnUnmetConditions(
	logger: { warn: (msg: string) => void },
	resultXml: string,
	setBindingNames: string[],
	properties: TemplateProperty[],
): void {
	for (const name of setBindingNames) {
		const prop = properties.find((p) => getBindingName(p) === name);
		if (!prop?.binding) continue;

		const bt = prop.binding.type;
		let present = false;
		if (bt === "zeebe:input") present = resultXml.includes(`target="${name}"`);
		else if (bt === "zeebe:taskHeader")
			present = resultXml.includes(`key="${name}"`);
		else if (bt === "zeebe:taskDefinition")
			present = true; // always present
		else present = resultXml.includes(name);

		if (!present) {
			logger.warn(
				`Property "${name}" was set but not applied (unmet condition). Check that controlling properties are also set.`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readTemplate(templatePath: string): ElementTemplate {
	const resolved = resolvePath(templatePath);
	if (!existsSync(resolved)) {
		throw new Error(`Template file not found: ${templatePath}`);
	}
	return JSON.parse(readFileSync(resolved, "utf-8"));
}

// ---------------------------------------------------------------------------
// Apply command
// ---------------------------------------------------------------------------

export const applyElementTemplateCommand = defineCommand(
	"element-template",
	"apply",
	async (ctx, flags, args): Promise<CommandResult> => {
		const { logger } = ctx;
		const inPlace = flags["in-place"];
		const setArgs = flags.set ?? [];
		const templatePath = args.template;
		const elementId = args.elementId;
		const bpmnFilePath: string | undefined = args.file;

		const input = readBpmnInput(bpmnFilePath);
		if (!input) {
			throw new Error(
				"No BPMN input provided. Pass a file path or pipe BPMN XML via stdin.",
			);
		}

		if (inPlace && !bpmnFilePath) {
			throw new Error("--in-place cannot be used with stdin input");
		}

		const template = readTemplate(templatePath);

		// Apply --set overrides to template properties before calling applyTemplate
		let setBindingNames: string[] = [];
		if (setArgs.length > 0) {
			setBindingNames = applySetOverrides(template.properties, setArgs);
		}

		const templateJson = JSON.stringify(template);

		// Apply template
		// @ts-expect-error — element-templates-cli has no type declarations
		const { applyTemplate } = await import("element-templates-cli");

		// Suppress noisy internal "unhandled error in event listener" warnings
		const originalConsoleError = console.error;
		console.error = (...errorArgs: unknown[]) => {
			if (
				typeof errorArgs[0] === "string" &&
				errorArgs[0].includes("unhandled error in event listener")
			)
				return;
			originalConsoleError(...errorArgs);
		};

		let resultXml: string;
		try {
			resultXml = await applyTemplate(input.xml, templateJson, elementId);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			const hint = message.includes("Cannot read properties of undefined")
				? `Element '${elementId}' not found in the BPMN diagram`
				: message;
			throw new Error(`Error applying template: ${hint}`);
		} finally {
			console.error = originalConsoleError;
		}

		// Warn about --set values that were dropped due to unmet conditions
		if (setBindingNames.length > 0) {
			warnUnmetConditions(
				logger,
				resultXml,
				setBindingNames,
				template.properties,
			);
		}

		if (inPlace && bpmnFilePath) {
			writeFileSync(resolvePath(bpmnFilePath), resultXml, "utf-8");
			return {
				kind: "success",
				message: `Updated ${bpmnFilePath}`,
			};
		}

		return { kind: "raw", content: resultXml };
	},
);

// ---------------------------------------------------------------------------
// List Properties command
// ---------------------------------------------------------------------------

export const listPropertiesCommand = defineCommand(
	"element-template",
	"list-properties",
	async (ctx, _flags, args): Promise<CommandResult> => {
		const { logger } = ctx;
		const templatePath = args.template;
		const template = readTemplate(templatePath);

		const settable = getSettableProperties(template.properties);
		const groupLabelMap = new Map(
			(template.groups ?? []).map((g) => [g.id, g.label]),
		);

		// JSON mode
		if (ctx.dryRun === undefined && logger.mode === "json") {
			const properties = settable.map((p) => {
				const bindingName = getBindingName(p);
				const bindingType = p.binding?.type;
				return {
					name: bindingName,
					group: p.group ? (groupLabelMap.get(p.group) ?? p.group) : undefined,
					type: p.type,
					bindingType: bindingType
						? getBindingTypeShorthand(bindingType)
						: undefined,
					...(p.value !== undefined && { default: p.value }),
					...(p.choices && {
						choices: p.choices.map((c) => c.value),
					}),
					...(p.condition ? { conditional: true } : {}),
				};
			});
			logger.json({
				name: template.name,
				id: template.id,
				properties,
			});
			return { kind: "none" };
		}

		// Text mode — group by template group
		const grouped = new Map<string, TemplateProperty[]>();
		const ungrouped: TemplateProperty[] = [];

		for (const prop of settable) {
			if (prop.group) {
				const list = grouped.get(prop.group) ?? [];
				list.push(prop);
				grouped.set(prop.group, list);
			} else {
				ungrouped.push(prop);
			}
		}

		const templateLabel = template.name
			? `${template.name}${template.id ? ` (${template.id})` : ""}`
			: templatePath;
		logger.output(templateLabel);
		logger.output("");

		const formatProp = (prop: TemplateProperty): string => {
			const bindingName = getBindingName(prop) ?? "?";
			const parts: string[] = [];

			// Type info
			if (prop.type === "Dropdown" && prop.choices) {
				parts.push(`Dropdown [${prop.choices.map((c) => c.value).join(", ")}]`);
			} else if (prop.type) {
				parts.push(prop.type);
			}

			// Binding type shorthand (skip for zeebe:input — it's the default)
			const bt = prop.binding?.type;
			if (bt && bt !== "zeebe:input") {
				parts.push(`[${getBindingTypeShorthand(bt)}]`);
			}

			// Default value
			if (prop.value !== undefined && prop.value !== "") {
				parts.push(`(default: ${String(prop.value)})`);
			}

			// Condition marker
			if (prop.condition) {
				parts.push("(conditional)");
			}

			const nameCol = bindingName.padEnd(36);
			return `    ${nameCol} ${parts.join("  ")}`;
		};

		const printGroup = (label: string, props: TemplateProperty[]): void => {
			logger.output(`  ${label}:`);
			for (const prop of props) {
				logger.output(formatProp(prop));
			}
			logger.output("");
		};

		for (const [groupId, props] of grouped) {
			const label = groupLabelMap.get(groupId) ?? groupId;
			printGroup(label, props);
		}

		if (ungrouped.length > 0) {
			printGroup("Other", ungrouped);
		}

		return { kind: "none" };
	},
);
