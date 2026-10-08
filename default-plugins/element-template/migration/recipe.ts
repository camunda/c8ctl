/**
 * Migration recipe parser.
 *
 * Validates a `migratesFrom` recipe (see `migrates-from.schema.json`) and
 * flattens it into a list of entries per source template. Nested `rules`
 * groups are flattened: each leaf entry carries the AND of all enclosing
 * guards.
 *
 * Self-contained on purpose: nothing in `migration/` imports from c8ctl.
 */

export const SUPPORTED_SCHEMA_VERSION = 1;

export type NoteLevel = "info" | "warning";

export interface Note {
	level: NoteLevel;
	message: string;
}

export type Guard =
	| { kind: "equals"; path: string; value: string; not: boolean }
	| { kind: "matches"; path: string; pattern: string; not: boolean }
	| { kind: "in"; path: string; values: string[]; not: boolean }
	| { kind: "exists"; path: string; exists: boolean };

export interface ValueMap {
	rules: { match: string; value: string }[];
	default?: string;
}

interface EntryBase {
	/** Guards that must all hold for the entry to apply. */
	when: Guard[];
	note?: Note;
	/** Position in the recipe, for error messages. */
	label: string;
}

export interface RenameEntry extends EntryBase {
	kind: "rename";
	from: string;
	to: string;
	valueMap?: ValueMap;
}

export interface SetEntry extends EntryBase {
	kind: "set";
	to: string;
	value: string;
}

export interface TemplateEntry extends EntryBase {
	kind: "template";
	to: string;
	template: string;
}

export type Entry = RenameEntry | SetEntry | TemplateEntry;

interface SourceBase {
	sourceTemplateId: string;
	entries: Entry[];
}

export type RecipeSource = SourceBase &
	(
		| { kind: "upgrade"; toVersion: number }
		| { kind: "change"; minSourceVersion?: number }
	);

export interface Recipe {
	schemaVersion: number;
	sources: RecipeSource[];
}

export class RecipeError extends Error {
	constructor(message: string) {
		super(`Invalid migration recipe: ${message}`);
		this.name = "RecipeError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean {
	return (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	);
}

function requireRecord(value: unknown, at: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new RecipeError(`${at} must be an object`);
	}
	return value;
}

function rejectUnknownKeys(
	raw: Record<string, unknown>,
	allowed: readonly string[],
	at: string,
): void {
	for (const key of Object.keys(raw)) {
		if (!allowed.includes(key)) {
			throw new RecipeError(`${at} has unknown property \`${key}\``);
		}
	}
}

function requireString(value: unknown, at: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new RecipeError(`${at} must be a non-empty string`);
	}
	return value;
}

function requireScalar(value: unknown, at: string): string {
	if (!isScalar(value)) {
		throw new RecipeError(`${at} must be a string, number or boolean`);
	}
	return String(value);
}

function parseNote(raw: unknown, at: string): Note {
	if (typeof raw === "string") {
		return { level: "info", message: requireString(raw, at) };
	}
	const obj = requireRecord(raw, at);
	rejectUnknownKeys(obj, ["level", "message"], at);
	const level = obj.level ?? "info";
	if (level !== "info" && level !== "warning") {
		throw new RecipeError(`${at}.level must be "info" or "warning"`);
	}
	return { level, message: requireString(obj.message, `${at}.message`) };
}

function parseValueMap(raw: unknown, at: string): ValueMap {
	const obj = requireRecord(raw, at);
	rejectUnknownKeys(obj, ["rules", "default"], at);
	if (!Array.isArray(obj.rules) || obj.rules.length === 0) {
		throw new RecipeError(`${at}.rules must be a non-empty list`);
	}
	const rules = obj.rules.map((item: unknown, i) => {
		const rule = requireRecord(item, `${at}.rules[${i}]`);
		rejectUnknownKeys(rule, ["match", "value"], `${at}.rules[${i}]`);
		return {
			match: requireString(rule.match, `${at}.rules[${i}].match`),
			value: requireScalar(rule.value, `${at}.rules[${i}].value`),
		};
	});
	if (obj.default === undefined) {
		return { rules };
	}
	return { rules, default: requireScalar(obj.default, `${at}.default`) };
}

const GUARD_OPERATORS: readonly string[] = [
	"equals",
	"matches",
	"in",
	"exists",
];

function parseGuard(raw: unknown, at: string): Guard {
	const obj = requireRecord(raw, at);
	rejectUnknownKeys(obj, ["path", ...GUARD_OPERATORS, "not"], at);
	const path = requireString(obj.path, `${at}.path`);
	const present = GUARD_OPERATORS.filter((op) => obj[op] !== undefined);
	if (present.length !== 1) {
		throw new RecipeError(
			`${at} must have exactly one of ${GUARD_OPERATORS.join(", ")}`,
		);
	}
	const operator = present[0];

	if (operator === "exists") {
		if (obj.not !== undefined) {
			throw new RecipeError(
				`${at}.not is not allowed with \`exists\`; use \`exists: false\``,
			);
		}
		if (typeof obj.exists !== "boolean") {
			throw new RecipeError(`${at}.exists must be a boolean`);
		}
		return { kind: "exists", path, exists: obj.exists };
	}

	if (obj.not !== undefined && typeof obj.not !== "boolean") {
		throw new RecipeError(`${at}.not must be a boolean`);
	}
	const not = obj.not === true;

	if (operator === "equals") {
		return {
			kind: "equals",
			path,
			value: requireScalar(obj.equals, `${at}.equals`),
			not,
		};
	}
	if (operator === "matches") {
		return {
			kind: "matches",
			path,
			pattern: requireString(obj.matches, `${at}.matches`),
			not,
		};
	}
	if (!Array.isArray(obj.in)) {
		throw new RecipeError(`${at}.in must be a list`);
	}
	return {
		kind: "in",
		path,
		values: obj.in.map((v: unknown, i) => requireScalar(v, `${at}.in[${i}]`)),
		not,
	};
}

function parseWhen(raw: unknown, at: string): Guard[] {
	if (Array.isArray(raw)) {
		if (raw.length === 0) {
			throw new RecipeError(`${at}.when must not be an empty list`);
		}
		return raw.map((g: unknown, i) => parseGuard(g, `${at}.when[${i}]`));
	}
	return [parseGuard(raw, `${at}.when`)];
}

function parseLeaf(
	obj: Record<string, unknown>,
	at: string,
	inherited: Guard[],
): Entry {
	const hasFrom = obj.from !== undefined;
	const hasSet = obj.set !== undefined;
	const hasTemplate = obj.template !== undefined;
	if (Number(hasFrom) + Number(hasSet) + Number(hasTemplate) !== 1) {
		throw new RecipeError(
			`${at} must have exactly one of \`from\`, \`set\`, \`template\` (or \`rules\` for a group)`,
		);
	}

	const base = {
		when: [
			...inherited,
			...(obj.when === undefined ? [] : parseWhen(obj.when, at)),
		],
		label: at,
		...(obj.note === undefined
			? {}
			: { note: parseNote(obj.note, `${at}.note`) }),
	};
	const to = requireString(obj.to, `${at}.to`);

	if (hasFrom) {
		rejectUnknownKeys(obj, ["from", "to", "valueMap", "when", "note"], at);
		const entry: RenameEntry = {
			...base,
			kind: "rename",
			from: requireString(obj.from, `${at}.from`),
			to,
		};
		if (obj.valueMap !== undefined) {
			entry.valueMap = parseValueMap(obj.valueMap, `${at}.valueMap`);
		}
		return entry;
	}
	if (hasSet) {
		rejectUnknownKeys(obj, ["set", "to", "when", "note"], at);
		return { ...base, kind: "set", to, value: requireScalar(obj.set, at) };
	}
	rejectUnknownKeys(obj, ["template", "to", "when", "note"], at);
	return {
		...base,
		kind: "template",
		to,
		template: requireString(obj.template, `${at}.template`),
	};
}

function flattenNode(raw: unknown, at: string, inherited: Guard[]): Entry[] {
	const obj = requireRecord(raw, at);
	if (obj.rules === undefined) {
		return [parseLeaf(obj, at, inherited)];
	}
	rejectUnknownKeys(obj, ["when", "rules"], at);
	if (obj.when === undefined) {
		throw new RecipeError(`${at} has \`rules\` but no \`when\``);
	}
	if (!Array.isArray(obj.rules) || obj.rules.length === 0) {
		throw new RecipeError(`${at}.rules must be a non-empty list`);
	}
	const guards = [...inherited, ...parseWhen(obj.when, at)];
	return obj.rules.flatMap((child: unknown, i) =>
		flattenNode(child, `${at}.rules[${i}]`, guards),
	);
}

function parseSource(raw: unknown, at: string): RecipeSource {
	const obj = requireRecord(raw, at);
	if (obj.kind !== "upgrade" && obj.kind !== "change") {
		throw new RecipeError(`${at}.kind must be "upgrade" or "change"`);
	}
	rejectUnknownKeys(
		obj,
		[
			"kind",
			"sourceTemplateId",
			obj.kind === "upgrade" ? "toVersion" : "minSourceVersion",
			"paths",
		],
		at,
	);
	const base: SourceBase = {
		sourceTemplateId: requireString(
			obj.sourceTemplateId,
			`${at}.sourceTemplateId`,
		),
		entries: [],
	};
	const field = obj.kind === "upgrade" ? "toVersion" : "minSourceVersion";
	const version = obj[field];
	if (
		(obj.kind === "upgrade" || version !== undefined) &&
		(typeof version !== "number" ||
			!Number.isSafeInteger(version) ||
			version < 0)
	) {
		throw new RecipeError(`${at}.${field} must be a non-negative safe integer`);
	}
	if (obj.paths !== undefined) {
		if (!Array.isArray(obj.paths)) {
			throw new RecipeError(`${at}.paths must be a list`);
		}
		base.entries = obj.paths.flatMap((node: unknown, i) =>
			flattenNode(node, `${at}.paths[${i}]`, []),
		);
	}
	if (obj.kind === "upgrade" && typeof version === "number") {
		return { ...base, kind: "upgrade", toVersion: version };
	}
	return {
		...base,
		kind: "change",
		...(typeof version === "number" ? { minSourceVersion: version } : {}),
	};
}

/**
 * Parse and validate a recipe. Throws `RecipeError` on the first problem;
 * a recipe is never partially accepted.
 */
export function parseRecipe(raw: unknown): Recipe {
	const obj = requireRecord(raw, "recipe");
	rejectUnknownKeys(obj, ["$schema", "schemaVersion", "sources"], "recipe");
	if (obj.$schema !== undefined && typeof obj.$schema !== "string") {
		throw new RecipeError("recipe.$schema must be a string");
	}

	if (obj.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
		if (typeof obj.schemaVersion === "number" && obj.schemaVersion > 1) {
			throw new RecipeError(
				`schemaVersion ${obj.schemaVersion} is newer than this c8ctl supports (${SUPPORTED_SCHEMA_VERSION}). Update c8ctl to use this recipe`,
			);
		}
		throw new RecipeError(`schemaVersion must be ${SUPPORTED_SCHEMA_VERSION}`);
	}
	if (!Array.isArray(obj.sources) || obj.sources.length === 0) {
		throw new RecipeError("sources must be a non-empty list");
	}

	const sources = obj.sources.map((item: unknown, i) =>
		parseSource(item, `sources[${i}]`),
	);

	const seen = new Set<string>();
	for (const source of sources) {
		const version =
			source.kind === "upgrade" ? source.toVersion : source.minSourceVersion;
		const key = JSON.stringify([
			source.kind,
			source.sourceTemplateId,
			version ?? null,
		]);
		if (seen.has(key)) {
			throw new RecipeError(
				`source "${source.sourceTemplateId}" is declared twice for ${source.kind} at version ${version ?? "(unset)"}`,
			);
		}
		seen.add(key);
	}

	return { schemaVersion: SUPPORTED_SCHEMA_VERSION, sources };
}

/** Owner-relative rules cannot be expressed by the standalone JSON schema. */
export function validateRecipeOwner(
	recipe: Recipe,
	owner: { id: string; version?: number },
): void {
	for (const source of recipe.sources) {
		if (source.kind === "upgrade") {
			if (source.sourceTemplateId !== owner.id) {
				throw new RecipeError(
					`upgrade source must equal recipe owner "${owner.id}"`,
				);
			}
			if (owner.version === undefined || source.toVersion > owner.version) {
				throw new RecipeError(
					`upgrade version ${source.toVersion} exceeds owner version ${owner.version ?? "(unset)"}`,
				);
			}
		} else if (source.sourceTemplateId === owner.id) {
			throw new RecipeError(
				`change source must differ from recipe owner "${owner.id}"`,
			);
		}
	}
}

/**
 * The recipe a template carries in `metadata.migratesFrom`, or `undefined`
 * when it has none. Throws `RecipeError` when the embedded recipe is invalid.
 */
export function readEmbeddedRecipe(template: {
	metadata?: unknown;
}): Recipe | undefined {
	if (!isRecord(template.metadata)) {
		return undefined;
	}
	const raw = template.metadata.migratesFrom;
	return raw === undefined ? undefined : parseRecipe(raw);
}
