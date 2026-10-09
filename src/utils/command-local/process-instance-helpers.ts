/**
 * Pure helpers that are the guts of the `process-instance` commands, kept
 * test-visible in the `utils` layer.
 */

import { ElementId } from "@camunda8/orchestration-cluster-api";

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
