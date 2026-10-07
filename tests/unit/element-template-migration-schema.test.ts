/**
 * The migration recipe JSON schema and the parser must accept and reject the
 * same recipes (default-plugins/element-template/migration/)
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import { Ajv } from "ajv";
import { parseRecipe } from "../../default-plugins/element-template/migration/recipe.ts";

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
		sources: [{ sourceTemplateId: "old", minVersion: 3, paths }],
	};
}

const rename = { from: "a", to: "b" };

const VALID: Record<string, unknown> = {
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
	"source without paths or minVersion": {
		schemaVersion: 1,
		sources: [{ sourceTemplateId: "old" }],
	},
	"schema reference": { $schema: "x", ...recipe(rename) },
};

const INVALID: Record<string, unknown> = {
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
	"fractional minVersion": {
		schemaVersion: 1,
		sources: [{ sourceTemplateId: "old", minVersion: 1.5 }],
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
