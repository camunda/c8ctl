/**
 * Pure helpers that are the guts of the `process-instance` commands, kept
 * test-visible in the `utils` layer.
 */

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
