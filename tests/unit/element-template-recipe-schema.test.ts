import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRecipeSchemaVersion } from "../../default-plugins/element-template/recipe-schema.ts";

test("accepts the provisional recipe schema version", () => {
	assert.doesNotThrow(() =>
		validateRecipeSchemaVersion(
			{ schemaVersion: 1, sources: [] },
			"Template io.example.target@1",
		),
	);
});

test("rejects unknown schema versions with c8ctl-owned policy", () => {
	assert.throws(
		() =>
			validateRecipeSchemaVersion(
				{ schemaVersion: 2, sources: [] },
				"Template io.example.target@1",
			),
		/c8ctl currently accepts the provisional schemaVersion 1 format only/,
	);
});

test("leaves missing schema versions to recipe validation", () => {
	assert.doesNotThrow(() =>
		validateRecipeSchemaVersion({ sources: [] }, "Recipe file"),
	);
});
