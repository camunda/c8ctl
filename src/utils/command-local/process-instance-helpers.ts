/**
 * Pure helpers that are the guts of the `process-instance` commands, kept
 * test-visible in the `utils` layer.
 */

import type {
	AncestorScopeInstruction,
	ModifyProcessInstanceVariableInstruction,
	ProcessInstanceModificationActivateInstruction,
	ProcessInstanceModificationInstruction,
	ProcessInstanceModificationMoveBatchOperationInstruction,
	ProcessInstanceModificationMoveInstruction,
	ProcessInstanceModificationTerminateInstruction,
	SourceElementInstruction,
} from "@camunda8/orchestration-cluster-api";
import {
	ElementId,
	ElementInstanceKey,
} from "@camunda8/orchestration-cluster-api";
import { isRecord } from "../../core/index.ts";

/**
 * Builds an explicit empty-result message for `c8ctl list process-instance`,
 * naming the filters that were actually applied so the user understands the
 * scope of the query that returned nothing.
 *
 * In particular the default `state = ACTIVE` filter — applied unless `--state`
 * or `--all` is given — is otherwise invisible, so a bare `list pi` that hides
 * completed/terminated instances looks like "no instances at all". Rendering the
 * state as an adjective on the resource noun ("No ACTIVE process instances
 * found") makes the constraint obvious.
 *
 * @param filter The `filter` object sent to `searchProcessInstances` (i.e.
 *   `body.filter`), so the message reflects exactly what was queried.
 */
export function processInstancesEmptyMessage(
	filter: Record<string, unknown>,
): string {
	const state = typeof filter.state === "string" ? filter.state : undefined;
	const noun = `${state ? `${state} ` : ""}process instances`;

	const qualifiers: string[] = [];

	const definitionId = filter.processDefinitionId;
	if (typeof definitionId === "string" && definitionId.length > 0) {
		qualifiers.push(`process "${definitionId}"`);
	}

	const version = filter.processDefinitionVersion;
	if (version !== undefined && version !== null) {
		qualifiers.push(`version ${version}`);
	}

	const tenantId = filter.tenantId;
	if (
		typeof tenantId === "string" &&
		tenantId.length > 0 &&
		tenantId !== "<default>"
	) {
		qualifiers.push(`tenant "${tenantId}"`);
	}

	for (const field of ["startDate", "endDate"] as const) {
		if (filter[field] !== undefined) {
			qualifiers.push(`${field} within the given range`);
		}
	}

	const base = `No ${noun} found`;
	return qualifiers.length > 0 ? `${base} for ${qualifiers.join(", ")}` : base;
}

/**
 * Parses one `--map <sourceElementId>=<targetElementId>` value of
 * `c8ctl migrate process-instance` into a migration mapping instruction.
 *
 * Splits on the first `=` only: BPMN element IDs are XML NCNames and cannot
 * contain `=`, so anything after it belongs to the target ID and a second
 * `=` surfaces as an invalid target rather than being silently dropped.
 * Throws on malformed input so the flag-validation boundary reports
 * `Invalid --map: …` before the command runs.
 */
export function parseMigrationMapping(value: string): {
	sourceElementId: ElementId;
	targetElementId: ElementId;
} {
	const separator = value.indexOf("=");
	const source = separator === -1 ? "" : value.slice(0, separator).trim();
	const target = separator === -1 ? "" : value.slice(separator + 1).trim();
	if (!source || !target || target.includes("=")) {
		throw new Error(
			`expected <sourceElementId>=<targetElementId>, got "${value}" (e.g. --map Task_Review=Task_ReviewV2)`,
		);
	}
	return {
		sourceElementId: ElementId.assumeExists(source),
		targetElementId: ElementId.assumeExists(target),
	};
}

// ─── modify process-instance ─────────────────────────────────────────────────
//
// Shorthand flags name an element either by BPMN element ID or by element
// instance key. Element IDs are XML NCNames, which cannot start with a digit,
// so an all-digit value is always a key and never a valid element ID.

const isElementInstanceKey = (value: string): boolean => /^\d+$/.test(value);

function toElementId(value: string): ElementId {
	const id = value.trim();
	if (!/^\S+$/.test(id) || isElementInstanceKey(id)) {
		throw new Error(`expected an element ID (e.g. Task_A), got "${value}"`);
	}
	return ElementId.assumeExists(id);
}

function toSourceElementInstruction(value: string): SourceElementInstruction {
	return isElementInstanceKey(value)
		? {
				sourceType: "byKey",
				sourceElementInstanceKey: ElementInstanceKey.assumeExists(value),
			}
		: { sourceType: "byId", sourceElementId: toElementId(value) };
}

/** Parses one `--activate <elementId>` value of `c8ctl modify process-instance`. */
export function parseActivateFlag(
	value: string,
): ProcessInstanceModificationActivateInstruction {
	if (isElementInstanceKey(value.trim())) {
		throw new Error(
			`expected an element ID (e.g. Task_A), got the element instance key "${value.trim()}": only elements can be activated`,
		);
	}
	return { elementId: toElementId(value) };
}

/**
 * Parses one `--terminate <elementId|elementInstanceKey>` value. An element
 * ID terminates every active instance of that element; a key terminates
 * exactly that element instance.
 */
export function parseTerminateFlag(
	value: string,
): ProcessInstanceModificationTerminateInstruction {
	const trimmed = value.trim();
	if (isElementInstanceKey(trimmed)) {
		return { elementInstanceKey: ElementInstanceKey.assumeExists(trimmed) };
	}
	try {
		return { elementId: toElementId(trimmed) };
	} catch {
		throw new Error(
			`expected an element ID (e.g. Task_A) or element instance key, got "${value}"`,
		);
	}
}

/**
 * Parses one `--move <source>=<targetElementId>` value, where the source is
 * an element ID or an element instance key. Splits on the first `=` only,
 * for the same reason as {@link parseMigrationMapping}.
 */
export function parseMoveFlag(
	value: string,
): ProcessInstanceModificationMoveInstruction {
	const separator = value.indexOf("=");
	const source = separator === -1 ? "" : value.slice(0, separator).trim();
	const target = separator === -1 ? "" : value.slice(separator + 1).trim();
	if (!source || !target || target.includes("=")) {
		throw new Error(
			`expected <sourceElementId|sourceElementInstanceKey>=<targetElementId>, got "${value}" (e.g. --move Task_Charge=Task_Review)`,
		);
	}
	if (isElementInstanceKey(target)) {
		throw new Error(
			`the move target must be an element ID, not an element instance key, got "${target}"`,
		);
	}
	return {
		sourceElementInstruction: toSourceElementInstruction(source),
		targetElementId: toElementId(target),
	};
}

/**
 * Narrows a parsed `--move` to the batch shape. Batch modification resolves
 * instances by filter, so a source element instance key, which belongs to
 * exactly one instance, has no meaning there.
 */
export function toBatchMoveInstruction(
	move: ProcessInstanceModificationMoveInstruction,
): ProcessInstanceModificationMoveBatchOperationInstruction {
	const source = move.sourceElementInstruction;
	if (source.sourceType !== "byId") {
		throw new Error(
			"batch modification only supports moves by source element ID, not by element instance key",
		);
	}
	return {
		sourceElementId: source.sourceElementId,
		targetElementId: move.targetElementId,
	};
}

/** Parses an `--operationReference` value; the API requires an int64 > 0. */
export function parseOperationReference(value: string): number {
	const parsed = Number(value.trim());
	if (
		!/^\d+$/.test(value.trim()) ||
		!Number.isSafeInteger(parsed) ||
		parsed < 1
	) {
		throw new Error(`must be a positive integer, got "${value}"`);
	}
	return parsed;
}

// ─── `--instructions` JSON validation ───────────────────────────────────────
//
// The JSON is checked field by field, with unknown fields rejected, so a typo
// such as `activateInstruction` fails here with its path instead of being
// dropped and leaving the request without that instruction.

function fieldsOf(
	value: unknown,
	path: string,
	allowed: readonly string[],
): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new Error(`${path ? `${path} ` : ""}must be a JSON object`);
	}
	const unknownField = Object.keys(value).find((k) => !allowed.includes(k));
	if (unknownField !== undefined) {
		throw new Error(
			`${path ? `${path}: ` : ""}unknown field "${unknownField}" (expected one of ${allowed.join(", ")})`,
		);
	}
	return value;
}

function arrayOf<T>(
	value: unknown,
	path: string,
	parseItem: (item: unknown, itemPath: string) => T,
): T[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
	return value.map((item, i) => parseItem(item, `${path}[${i}]`));
}

function elementIdAt(value: unknown, path: string): ElementId {
	if (typeof value !== "string") {
		throw new Error(`${path} must be an element ID string`);
	}
	try {
		return toElementId(value);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${path}: ${message}`);
	}
}

/**
 * Keys are int64 values, which a JSON number cannot hold exactly beyond
 * 2^53. Strings are taken as-is; numbers only within the safe-integer range.
 */
function keyAt(value: unknown, path: string): ElementInstanceKey {
	if (typeof value === "number" && Number.isInteger(value)) {
		if (!Number.isSafeInteger(value)) {
			throw new Error(
				`${path} is too large for a JSON number; pass large keys as strings (e.g. "2251799813685249")`,
			);
		}
		return ElementInstanceKey.assumeExists(String(value));
	}
	if (typeof value === "string" && /^-?\d+$/.test(value)) {
		return ElementInstanceKey.assumeExists(value);
	}
	throw new Error(`${path} must be an integer key`);
}

function variableInstructionAt(
	value: unknown,
	path: string,
): ModifyProcessInstanceVariableInstruction {
	const fields = fieldsOf(value, path, ["variables", "scopeId"]);
	if (!isRecord(fields.variables)) {
		throw new Error(`${path}.variables must be a JSON object`);
	}
	if (fields.scopeId !== undefined && typeof fields.scopeId !== "string") {
		throw new Error(`${path}.scopeId must be a string`);
	}
	return {
		variables: fields.variables,
		...(fields.scopeId !== undefined && { scopeId: fields.scopeId }),
	};
}

function activateInstructionAt(
	value: unknown,
	path: string,
): ProcessInstanceModificationActivateInstruction {
	const fields = fieldsOf(value, path, [
		"elementId",
		"ancestorElementInstanceKey",
		"variableInstructions",
	]);
	const variableInstructions = arrayOf(
		fields.variableInstructions,
		`${path}.variableInstructions`,
		variableInstructionAt,
	);
	return {
		elementId: elementIdAt(fields.elementId, `${path}.elementId`),
		...(fields.ancestorElementInstanceKey !== undefined && {
			ancestorElementInstanceKey: keyAt(
				fields.ancestorElementInstanceKey,
				`${path}.ancestorElementInstanceKey`,
			),
		}),
		...(variableInstructions && { variableInstructions }),
	};
}

function terminateInstructionAt(
	value: unknown,
	path: string,
): ProcessInstanceModificationTerminateInstruction {
	const fields = fieldsOf(value, path, ["elementId", "elementInstanceKey"]);
	const hasId = fields.elementId !== undefined;
	const hasKey = fields.elementInstanceKey !== undefined;
	if (hasId === hasKey) {
		throw new Error(
			`${path}: exactly one of elementId or elementInstanceKey is required`,
		);
	}
	return hasId
		? { elementId: elementIdAt(fields.elementId, `${path}.elementId`) }
		: {
				elementInstanceKey: keyAt(
					fields.elementInstanceKey,
					`${path}.elementInstanceKey`,
				),
			};
}

function sourceElementInstructionAt(
	value: unknown,
	path: string,
): SourceElementInstruction {
	if (!isRecord(value)) throw new Error(`${path} must be a JSON object`);
	if (value.sourceType === "byId") {
		const fields = fieldsOf(value, path, ["sourceType", "sourceElementId"]);
		return {
			sourceType: "byId",
			sourceElementId: elementIdAt(
				fields.sourceElementId,
				`${path}.sourceElementId`,
			),
		};
	}
	if (value.sourceType === "byKey") {
		const fields = fieldsOf(value, path, [
			"sourceType",
			"sourceElementInstanceKey",
		]);
		return {
			sourceType: "byKey",
			sourceElementInstanceKey: keyAt(
				fields.sourceElementInstanceKey,
				`${path}.sourceElementInstanceKey`,
			),
		};
	}
	throw new Error(`${path}.sourceType must be "byId" or "byKey"`);
}

function ancestorScopeInstructionAt(
	value: unknown,
	path: string,
): AncestorScopeInstruction {
	if (!isRecord(value)) throw new Error(`${path} must be a JSON object`);
	const type = value.ancestorScopeType;
	if (type === "direct") {
		const fields = fieldsOf(value, path, [
			"ancestorScopeType",
			"ancestorElementInstanceKey",
		]);
		return {
			ancestorScopeType: "direct",
			ancestorElementInstanceKey: keyAt(
				fields.ancestorElementInstanceKey,
				`${path}.ancestorElementInstanceKey`,
			),
		};
	}
	if (type === "inferred" || type === "sourceParent") {
		fieldsOf(value, path, ["ancestorScopeType"]);
		return { ancestorScopeType: type };
	}
	throw new Error(
		`${path}.ancestorScopeType must be "direct", "inferred" or "sourceParent"`,
	);
}

function moveInstructionAt(
	value: unknown,
	path: string,
): ProcessInstanceModificationMoveInstruction {
	const fields = fieldsOf(value, path, [
		"sourceElementInstruction",
		"targetElementId",
		"ancestorScopeInstruction",
		"variableInstructions",
	]);
	const variableInstructions = arrayOf(
		fields.variableInstructions,
		`${path}.variableInstructions`,
		variableInstructionAt,
	);
	return {
		sourceElementInstruction: sourceElementInstructionAt(
			fields.sourceElementInstruction,
			`${path}.sourceElementInstruction`,
		),
		targetElementId: elementIdAt(
			fields.targetElementId,
			`${path}.targetElementId`,
		),
		...(fields.ancestorScopeInstruction !== undefined && {
			ancestorScopeInstruction: ancestorScopeInstructionAt(
				fields.ancestorScopeInstruction,
				`${path}.ancestorScopeInstruction`,
			),
		}),
		...(variableInstructions && { variableInstructions }),
	};
}

/**
 * Validates the parsed `--instructions` JSON of `c8ctl modify
 * process-instance` against the `ProcessInstanceModificationInstruction`
 * request body and returns it typed. Keys may be given as strings or as
 * safe-integer numbers; they are always sent as strings.
 */
export function parseModificationInstructions(
	value: unknown,
): ProcessInstanceModificationInstruction {
	const fields = fieldsOf(value, "", [
		"activateInstructions",
		"moveInstructions",
		"terminateInstructions",
		"operationReference",
	]);
	const activateInstructions = arrayOf(
		fields.activateInstructions,
		"activateInstructions",
		activateInstructionAt,
	);
	const moveInstructions = arrayOf(
		fields.moveInstructions,
		"moveInstructions",
		moveInstructionAt,
	);
	const terminateInstructions = arrayOf(
		fields.terminateInstructions,
		"terminateInstructions",
		terminateInstructionAt,
	);
	const { operationReference } = fields;
	if (
		operationReference !== undefined &&
		!(
			typeof operationReference === "number" &&
			Number.isSafeInteger(operationReference) &&
			operationReference > 0
		)
	) {
		throw new Error("operationReference must be a positive integer");
	}
	return {
		...(activateInstructions && { activateInstructions }),
		...(moveInstructions && { moveInstructions }),
		...(terminateInstructions && { terminateInstructions }),
		...(operationReference !== undefined && { operationReference }),
	};
}
