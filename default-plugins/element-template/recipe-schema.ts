const PROVISIONAL_RECIPE_SCHEMA_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateRecipeSchemaVersion(
	raw: unknown,
	source: string,
): void {
	if (!isRecord(raw) || !Object.hasOwn(raw, "schemaVersion")) return;
	if (raw.schemaVersion === PROVISIONAL_RECIPE_SCHEMA_VERSION) return;
	throw new Error(
		`${source} uses unsupported recipe schemaVersion ${String(raw.schemaVersion)}. c8ctl currently accepts the provisional schemaVersion ${PROVISIONAL_RECIPE_SCHEMA_VERSION} format only.`,
	);
}
