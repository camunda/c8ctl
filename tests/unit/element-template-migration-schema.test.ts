/**
 * The migration recipe JSON schema and the parser must accept and reject the
 * same JSON structures. Keyed uniqueness and owner-relative constraints require
 * semantic validation beyond Draft07 (default-plugins/element-template/migration/).
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import { Ajv } from "ajv";
import {
	parseRecipe,
	RecipeError,
	validateRecipeOwner,
} from "../../default-plugins/element-template/migration/recipe.ts";

const schema: object = JSON.parse(
	readFileSync(
		resolve(
			import.meta.dirname,
			"..",
			"..",
			"default-plugins",
			"element-template",
			"migration",
			"migrates-from.schema.json",
		),
		"utf-8",
	),
);
const validate = new Ajv({ strict: true }).compile(schema);

function recipe(...paths: unknown[]) {
	return {
		schemaVersion: 1,
		sources: [
			{ kind: "change", sourceTemplateId: "old", minSourceVersion: 3, paths },
		],
	};
}

const rename = { from: "a", to: "b" };

const VALID: Record<string, unknown> = {
	"upgrade at zero": {
		schemaVersion: 1,
		sources: [{ kind: "upgrade", sourceTemplateId: "old", toVersion: 0 }],
	},
	"empty schema reference": { $schema: "", ...recipe(rename) },
	"rename, set and template": recipe(
		rename,
		{ to: "kind", set: "x" },
		{ to: "url", template: `\${host}/\${path}` },
	),
	"scalar set values": recipe({ to: "n", set: 5 }, { to: "f", set: false }),
	"nested groups": recipe({
		when: { path: "type", equals: "a" },
		rules: [
			rename,
			{ when: { path: "mode", exists: true }, rules: [{ from: "p", to: "q" }] },
		],
	}),
	"string and object notes": recipe(
		{ ...rename, note: "moved" },
		{ ...rename, note: { level: "warning", message: "lossy" } },
		{ ...rename, note: { message: "plain" } },
	),
	"value map with default": recipe({
		...rename,
		valueMap: { rules: [{ match: "t*", value: "X" }], default: "Y" },
	}),
	"every guard operator": recipe({
		...rename,
		when: [
			{ path: "p", equals: "x" },
			{ path: "p", matches: "pre*", not: true },
			{ path: "p", in: ["u", 1, true] },
			{ path: "p", exists: false },
		],
	}),
	"change without paths or floor": {
		schemaVersion: 1,
		sources: [{ kind: "change", sourceTemplateId: "old" }],
	},
	"schema reference": { $schema: "x", ...recipe(rename) },
};

const INVALID: Record<string, unknown> = {
	"non-string schema reference": { $schema: 42, ...recipe(rename) },
	"whitespace path": recipe({ from: " ", to: "b" }),
	"whitespace note": recipe({ ...rename, note: " " }),
	"empty match pattern": recipe({
		...rename,
		when: { path: "a", matches: "" },
	}),
	"blank match pattern": recipe({
		...rename,
		when: { path: "a", matches: " " },
	}),
	"missing kind": { schemaVersion: 1, sources: [{ sourceTemplateId: "old" }] },
	"missing upgrade destination": {
		schemaVersion: 1,
		sources: [{ kind: "upgrade", sourceTemplateId: "old" }],
	},
	"unsafe destination": {
		schemaVersion: 1,
		sources: [
			{ kind: "upgrade", sourceTemplateId: "old", toVersion: 9007199254740992 },
		],
	},
	"negative floor": {
		schemaVersion: 1,
		sources: [
			{ kind: "change", sourceTemplateId: "old", minSourceVersion: -1 },
		],
	},
	"legacy marker": {
		schemaVersion: 1,
		sources: [{ kind: "change", sourceTemplateId: "old", minVersion: 1 }],
	},
	"missing schemaVersion": { sources: recipe(rename).sources },
	"newer schemaVersion": { ...recipe(rename), schemaVersion: 2 },
	"bare array": recipe(rename).sources,
	"empty sources": { schemaVersion: 1, sources: [] },
	"unknown top-level key": { ...recipe(rename), extra: 1 },
	"unknown entry key": recipe({ ...rename, remove: true }),
	"misspelled key": recipe({ form: "a", to: "b" }),
	"from and set": recipe({ from: "a", to: "b", set: "c" }),
	"no from, set or template": recipe({ to: "b" }),
	"ungated group": recipe({ rules: [rename] }),
	"empty group": recipe({ when: { path: "p", equals: "x" }, rules: [] }),
	"two guard operators": recipe({
		...rename,
		when: { path: "p", equals: "x", in: ["y"] },
	}),
	"not with exists": recipe({
		...rename,
		when: { path: "p", exists: true, not: true },
	}),
	"empty guard list": recipe({ ...rename, when: [] }),
	"unknown note level": recipe({
		...rename,
		note: { level: "error", message: "x" },
	}),
	"note without message": recipe({ ...rename, note: {} }),
	"empty value map rules": recipe({ ...rename, valueMap: { rules: [] } }),
	"fractional source floor": {
		schemaVersion: 1,
		sources: [
			{ kind: "change", sourceTemplateId: "old", minSourceVersion: 1.5 },
		],
	},
};

function parses(raw: unknown): boolean {
	try {
		parseRecipe(raw);
		return true;
	} catch {
		return false;
	}
}

describe("recipe schema and parser agree", () => {
	for (const [name, raw] of Object.entries(VALID)) {
		test(`accept: ${name}`, () => {
			assert.strictEqual(validate(raw), true, JSON.stringify(validate.errors));
			assert.strictEqual(parses(raw), true);
		});
	}
	for (const [name, raw] of Object.entries(INVALID)) {
		test(`reject: ${name}`, () => {
			assert.strictEqual(validate(raw), false);
			assert.strictEqual(parses(raw), false);
		});
	}
});

const guard = { path: "a", equals: "x" };
const mapRule = { match: "x*", value: "y" };
const group = { when: guard, rules: [rename] };
const source = { kind: "change", sourceTemplateId: "old" };

function withSources(...sources: unknown[]) {
	return { schemaVersion: 1, sources };
}

function withGuard(value: unknown) {
	return recipe({ ...rename, when: value });
}

function withMap(value: unknown) {
	return recipe({ ...rename, valueMap: value });
}

interface FieldCase {
	name: string;
	key: string;
	base: Record<string, unknown>;
	wrap: (value: Record<string, unknown>) => unknown;
	optional?: boolean;
	valid: unknown[];
	invalid: unknown[];
}

const nonStrings = [null, false, 0, [], {}];
const blankStrings = ["", " ", "\t\r\n", "\u00a0\ufeff"];
const strings = ["x", " x ", "\t x\n", "*"];
const nonScalars = [null, [], {}];
const scalars = [
	"",
	" ",
	"x",
	0,
	-1,
	1.5,
	Number.MAX_SAFE_INTEGER + 1,
	Number.MAX_VALUE,
	-Number.MAX_VALUE,
	Number.MIN_VALUE,
	true,
	false,
];
const nonVersions = [
	null,
	"0",
	false,
	[],
	{},
	-1,
	1.5,
	Number.MAX_SAFE_INTEGER + 1,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
];
const nonLists = [null, "x", false, 0, {}];
const fields: FieldCase[] = [
	{
		name: "recipe schema reference",
		key: "$schema",
		base: recipe(rename),
		wrap: (v) => v,
		optional: true,
		valid: [...blankStrings, ...strings],
		invalid: nonStrings,
	},
	{
		name: "recipe format version",
		key: "schemaVersion",
		base: recipe(rename),
		wrap: (v) => v,
		valid: [1],
		invalid: [...nonVersions, 0, 2],
	},
	{
		name: "recipe sources",
		key: "sources",
		base: recipe(rename),
		wrap: (v) => v,
		valid: [[source]],
		invalid: [...nonLists, [], [null], [[]], [{}]],
	},
];

for (const kind of ["upgrade", "change"] as const) {
	const base = {
		kind,
		sourceTemplateId: "old",
		...(kind === "upgrade" ? { toVersion: 1 } : {}),
	};
	fields.push(
		{
			name: `${kind} kind`,
			key: "kind",
			base,
			wrap: (v) => withSources(v),
			valid: [kind],
			invalid: [...nonStrings, "", " ", "other"],
		},
		{
			name: `${kind} source ID`,
			key: "sourceTemplateId",
			base,
			wrap: (v) => withSources(v),
			valid: strings,
			invalid: [...nonStrings, ...blankStrings],
		},
		{
			name: `${kind} version`,
			key: kind === "upgrade" ? "toVersion" : "minSourceVersion",
			base,
			wrap: (v) => withSources(v),
			optional: kind === "change",
			valid: [0, 1, Number.MAX_SAFE_INTEGER],
			invalid: nonVersions,
		},
		{
			name: `${kind} paths`,
			key: "paths",
			base,
			wrap: (v) => withSources(v),
			optional: true,
			valid: [[], [rename], [group]],
			invalid: [...nonLists, [null], [[]], [{}]],
		},
	);
}

for (const [name, base] of Object.entries({
	rename,
	set: { to: "b", set: "x" },
	template: { to: "b", template: `\${a}` },
})) {
	fields.push(
		{
			name: `${name} destination`,
			key: "to",
			base,
			wrap: (v) => recipe(v),
			valid: strings,
			invalid: [...nonStrings, ...blankStrings],
		},
		{
			name: `${name} guards`,
			key: "when",
			base,
			wrap: (v) => recipe(v),
			optional: true,
			valid: [guard, [guard]],
			invalid: [null, "x", false, 0, {}, [], [null], [[]]],
		},
		{
			name: `${name} note`,
			key: "note",
			base,
			wrap: (v) => recipe(v),
			optional: true,
			valid: [...strings, { message: "x" }],
			invalid: [null, false, 0, [], {}, ...blankStrings],
		},
	);
}

fields.push(
	{
		name: "rename source",
		key: "from",
		base: rename,
		wrap: (v) => recipe(v),
		valid: strings,
		invalid: [...nonStrings, ...blankStrings],
	},
	{
		name: "set scalar",
		key: "set",
		base: { to: "b", set: "x" },
		wrap: (v) => recipe(v),
		valid: scalars,
		invalid: nonScalars,
	},
	{
		name: "template expression",
		key: "template",
		base: { to: "b", template: `\${a}` },
		wrap: (v) => recipe(v),
		valid: strings,
		invalid: [...nonStrings, ...blankStrings],
	},
	{
		name: "group guards",
		key: "when",
		base: group,
		wrap: (v) => recipe(v),
		valid: [guard, [guard]],
		invalid: [null, "x", false, 0, {}, [], [null], [[]]],
	},
	{
		name: "group rules",
		key: "rules",
		base: group,
		wrap: (v) => recipe(v),
		valid: [[rename], [group]],
		invalid: [...nonLists, [], [null], [[]], [{}]],
	},
	{
		name: "note message",
		key: "message",
		base: { message: "x" },
		wrap: (v) => recipe({ ...rename, note: v }),
		valid: strings,
		invalid: [...nonStrings, ...blankStrings],
	},
	{
		name: "note level",
		key: "level",
		base: { message: "x" },
		wrap: (v) => recipe({ ...rename, note: v }),
		optional: true,
		valid: ["info", "warning"],
		invalid: [false, 0, [], {}, "", " ", "error"],
	},
	{
		name: "rename value map",
		key: "valueMap",
		base: rename,
		wrap: (v) => recipe(v),
		optional: true,
		valid: [{ rules: [mapRule] }],
		invalid: [null, "x", false, 0, [], {}],
	},
	{
		name: "value map rules",
		key: "rules",
		base: { rules: [mapRule] },
		wrap: withMap,
		valid: [[mapRule]],
		invalid: [...nonLists, [], [null], [[]], [{}]],
	},
	{
		name: "value map default",
		key: "default",
		base: { rules: [mapRule] },
		wrap: withMap,
		optional: true,
		valid: scalars,
		invalid: nonScalars,
	},
	{
		name: "value map match",
		key: "match",
		base: mapRule,
		wrap: (v) => withMap({ rules: [v] }),
		valid: strings,
		invalid: [...nonStrings, ...blankStrings],
	},
	{
		name: "value map value",
		key: "value",
		base: mapRule,
		wrap: (v) => withMap({ rules: [v] }),
		valid: scalars,
		invalid: nonScalars,
	},
);

for (const [operator, value, valid, invalid] of [
	["equals", "x", scalars, nonScalars],
	["matches", "x*", strings, [...nonStrings, ...blankStrings]],
	["in", ["x"], [[], scalars], [...nonLists, [null], [[]], [{}]]],
	["exists", true, [true, false], [null, "true", 0, [], {}]],
] satisfies [string, unknown, unknown[], unknown[]][]) {
	const base = { path: "a", [operator]: value };
	fields.push(
		{
			name: `${operator} guard path`,
			key: "path",
			base,
			wrap: withGuard,
			valid: strings,
			invalid: [...nonStrings, ...blankStrings],
		},
		{
			name: `${operator} guard operand`,
			key: operator,
			base,
			wrap: withGuard,
			valid,
			invalid,
		},
		{
			name: `${operator} guard negation`,
			key: "not",
			base,
			wrap: withGuard,
			optional: true,
			valid: operator === "exists" ? [] : [true, false],
			invalid:
				operator === "exists"
					? [null, "true", 0, [], {}, true, false]
					: [null, "true", 0, [], {}],
		},
	);
}

describe("Draft07 structural field boundaries", () => {
	for (const field of fields) {
		const variants = [
			{ name: "missing", value: undefined, accepted: field.optional === true },
			...field.valid.map((value) => ({
				name: `valid ${JSON.stringify(value)}`,
				value,
				accepted: true,
			})),
			...field.invalid.map((value) => ({
				name: `invalid ${typeof value === "number" ? String(value) : JSON.stringify(value)}`,
				value,
				accepted: false,
			})),
		];
		for (const variant of variants) {
			test(`${field.name}: ${variant.name}`, () => {
				const obj = { ...field.base, [field.key]: variant.value };
				if (variant.value === undefined) delete obj[field.key];
				const raw = field.wrap(obj);
				assert.strictEqual(
					validate(raw),
					variant.accepted,
					JSON.stringify(validate.errors),
				);
				assert.strictEqual(parses(raw), variant.accepted, "parser acceptance");
			});
		}
	}
});

const structures = [
	{ name: "recipe", base: recipe(rename), wrap: (v: unknown) => v },
	...(["upgrade", "change"] as const).map((kind) => ({
		name: `${kind} source`,
		base: {
			kind,
			sourceTemplateId: "old",
			...(kind === "upgrade" ? { toVersion: 1 } : {}),
		},
		wrap: (v: unknown) => withSources(v),
	})),
	...Object.entries({
		rename,
		set: { to: "b", set: "x" },
		template: { to: "b", template: `\${a}` },
		group,
	}).map(([name, base]) => ({ name, base, wrap: (v: unknown) => recipe(v) })),
	{
		name: "note",
		base: { message: "x" },
		wrap: (v: unknown) => recipe({ ...rename, note: v }),
	},
	{ name: "value map", base: { rules: [mapRule] }, wrap: withMap },
	{
		name: "value map rule",
		base: mapRule,
		wrap: (v: unknown) => withMap({ rules: [v] }),
	},
	...Object.entries({
		equals: "x",
		matches: "x*",
		in: ["x"],
		exists: true,
	}).map(([operator, value]) => ({
		name: `${operator} guard`,
		base: { path: "a", [operator]: value },
		wrap: withGuard,
	})),
];

describe("Draft07 object and branch boundaries", () => {
	for (const structure of structures) {
		for (const value of structure.name === "note"
			? [null, false, 0, []]
			: [null, "x", false, 0, []]) {
			test(`${structure.name}: rejects ${JSON.stringify(value)} in place of object`, () => {
				const raw = structure.wrap(value);
				assert.strictEqual(validate(raw), false);
				assert.strictEqual(parses(raw), false);
			});
		}
		test(`${structure.name}: rejects unknown keys`, () => {
			const raw = structure.wrap({ ...structure.base, extra: null });
			assert.strictEqual(validate(raw), false);
			assert.strictEqual(parses(raw), false);
		});
	}
	for (const kind of ["upgrade", "change"] as const) {
		for (const forbidden of kind === "upgrade"
			? ["minSourceVersion", "minVersion"]
			: ["toVersion", "minVersion"]) {
			for (const value of [null, 0]) {
				test(`${kind}: rejects ${forbidden} even when ${value}`, () => {
					const raw = withSources({
						kind,
						sourceTemplateId: "old",
						...(kind === "upgrade" ? { toVersion: 1 } : {}),
						[forbidden]: value,
					});
					assert.strictEqual(validate(raw), false);
					assert.strictEqual(parses(raw), false);
				});
			}
		}
	}
	for (const raw of [
		recipe({ from: "a", to: "b", template: "x" }),
		recipe({ to: "b", set: "x", template: "x" }),
		recipe({ ...group, ...rename }),
		recipe({ ...group, set: "x" }),
		recipe({ ...group, template: "x" }),
		recipe({ to: "b", set: "x", valueMap: { rules: [mapRule] } }),
		recipe({ to: "b", template: "x", valueMap: { rules: [mapRule] } }),
	]) {
		test(`rejects mixed path branches: ${JSON.stringify(raw)}`, () => {
			assert.strictEqual(validate(raw), false);
			assert.strictEqual(parses(raw), false);
		});
	}
	const operators = { equals: "x", matches: "x*", in: ["x"], exists: true };
	for (const [left, a] of Object.entries(operators)) {
		for (const [right, b] of Object.entries(operators)) {
			if (left === right) continue;
			test(`rejects simultaneous ${left} and ${right}`, () => {
				const raw = withGuard({ path: "a", [left]: a, [right]: b });
				assert.strictEqual(validate(raw), false);
				assert.strictEqual(parses(raw), false);
			});
		}
	}
});

describe("semantic validation is deliberately outside Draft07", () => {
	for (const [name, entry] of Object.entries({
		"upgrade marker": {
			kind: "upgrade",
			sourceTemplateId: "old",
			toVersion: 0,
		},
		"numeric change floor": { ...source, minSourceVersion: 0 },
		"omitted change floor": source,
	})) {
		for (const paths of [[], [rename]]) {
			test(`duplicate ${name} with paths ${JSON.stringify(paths)}`, () => {
				const raw = withSources(
					entry,
					{ kind: "change", sourceTemplateId: "other" },
					{ ...entry, paths },
				);
				assert.strictEqual(
					validate(raw),
					true,
					JSON.stringify(validate.errors),
				);
				assert.throws(() => parseRecipe(raw), {
					name: "RecipeError",
					message: /declared twice/,
				});
			});
		}
	}
	test("uniqueness keys distinguish kind, ID, numeric version and omitted floor", () => {
		const raw = withSources(
			{ kind: "upgrade", sourceTemplateId: "old", toVersion: 0 },
			{ kind: "upgrade", sourceTemplateId: "old", toVersion: 1 },
			{ kind: "upgrade", sourceTemplateId: "other", toVersion: 0 },
			source,
			{ ...source, minSourceVersion: 0 },
			{ ...source, minSourceVersion: 1 },
			{ kind: "change", sourceTemplateId: "other", minSourceVersion: 0 },
		);
		assert.strictEqual(validate(raw), true, JSON.stringify(validate.errors));
		assert.doesNotThrow(() => parseRecipe(raw));
	});
	for (const variant of [
		{
			name: "upgrade equal to owner version",
			entry: { kind: "upgrade", sourceTemplateId: "old", toVersion: 1 },
			owner: { id: "old", version: 1 },
			accepted: true,
		},
		{
			name: "upgrade zero at owner zero",
			entry: { kind: "upgrade", sourceTemplateId: "old", toVersion: 0 },
			owner: { id: "old", version: 0 },
			accepted: true,
		},
		{
			name: "upgrade below owner version",
			entry: { kind: "upgrade", sourceTemplateId: "old", toVersion: 1 },
			owner: { id: "old", version: 2 },
			accepted: true,
		},
		{
			name: "upgrade above owner version",
			entry: { kind: "upgrade", sourceTemplateId: "old", toVersion: 2 },
			owner: { id: "old", version: 1 },
			accepted: false,
		},
		{
			name: "upgrade without owner version",
			entry: { kind: "upgrade", sourceTemplateId: "old", toVersion: 0 },
			owner: { id: "old" },
			accepted: false,
		},
		{
			name: "upgrade with different owner ID",
			entry: { kind: "upgrade", sourceTemplateId: "old", toVersion: 1 },
			owner: { id: "new", version: 1 },
			accepted: false,
		},
		{
			name: "change with different owner ID",
			entry: source,
			owner: { id: "new" },
			accepted: true,
		},
		{
			name: "change with same owner ID",
			entry: source,
			owner: { id: "old", version: 1 },
			accepted: false,
		},
		{
			name: "change floor above owner version",
			entry: { ...source, minSourceVersion: 3 },
			owner: { id: "new", version: 1 },
			accepted: true,
		},
	]) {
		test(variant.name, () => {
			const raw = withSources(variant.entry);
			assert.strictEqual(validate(raw), true, JSON.stringify(validate.errors));
			const parsed = parseRecipe(raw);
			const check = () => validateRecipeOwner(parsed, variant.owner);
			if (variant.accepted) assert.doesNotThrow(check);
			else assert.throws(check, RecipeError);
		});
	}
});

describe("note and scalar validation across all consumers", () => {
	for (const [name, node] of Object.entries({
		rename,
		set: { to: "b", set: "x" },
		template: { to: "b", template: "x" },
	})) {
		test(`${name}: rejects explicit null note level`, () => {
			const raw = recipe({ ...node, note: { level: null, message: "x" } });
			assert.strictEqual(validate(raw), false);
			assert.throws(() => parseRecipe(raw), RecipeError);
		});
	}
	for (const value of [
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	]) {
		for (const [name, raw] of Object.entries({
			set: recipe({ to: "b", set: value }),
			"map value": withMap({ rules: [{ match: "x", value }] }),
			"map default": withMap({ rules: [mapRule], default: value }),
			"guard equals": withGuard({ path: "a", equals: value }),
			"guard in": withGuard({ path: "a", in: [value] }),
		})) {
			test(`${name}: rejects non-finite scalar ${String(value)}`, () => {
				assert.strictEqual(validate(raw), false);
				assert.throws(() => parseRecipe(raw), RecipeError);
			});
		}
	}
});
