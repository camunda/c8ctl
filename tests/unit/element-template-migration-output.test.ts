/**
 * Unit tests for the migration report presentation
 * (default-plugins/element-template/migration-output.ts)
 */

import assert from "node:assert";
import { afterEach, describe, test } from "node:test";
import type {
	MigrationReport,
	MovedItem,
	ValueSource,
} from "../../default-plugins/element-template/migration/report.ts";
import {
	redactMigrationDiagnostic,
	renderReportText,
	reportToJson,
	shouldUseColor,
} from "../../default-plugins/element-template/migration-output.ts";

type WithSource<T> = Omit<T, "source"> & { source?: ValueSource };

/** Report fixtures; `source` and the moved `value` default when left out. */
type ReportFixture = Omit<
	Partial<MigrationReport>,
	"added" | "changed" | "moved"
> & {
	added?: WithSource<MigrationReport["added"][number]>[];
	changed?: WithSource<MigrationReport["changed"][number]>[];
	moved?: (Omit<MovedItem, "source" | "value"> &
		Partial<Pick<MovedItem, "source" | "value">>)[];
};

function report({
	added = [],
	changed = [],
	moved = [],
	...partial
}: ReportFixture = {}): MigrationReport {
	return {
		from: {
			id: "old",
			version: 13,
			name: "AI Agent (job worker)",
			deprecated: true,
		},
		to: {
			id: "new",
			version: 1,
			name: "AI Agent Sub-process",
			deprecated: false,
		},
		usedRecipe: true,
		refusal: null,
		dropped: [],
		kept: [],
		notes: [],
		skipped: { guard: [], template: [], noMatch: [], feel: [] },
		lossless: true,
		...partial,
		added: added.map((item) => ({ source: "default", ...item })),
		changed: changed.map((item) => ({ source: "default", ...item })),
		moved: moved.map((item) => ({ value: "", source: "recipe", ...item })),
	};
}

const ESC = "\u001b[";

describe("redaction", () => {
	test("uses binding-qualified template identity metadata across all value collections", () => {
		const field = { key: "opaque", bindingType: "zeebe:input" };
		for (const metadata of [
			{ id: "accessToken" },
			{ label: "Password" },
			{ group: "credentials" },
			{ group: "auth" },
		]) {
			const redaction = {
				templates: [
					{
						id: "old",
						groups: [{ id: "auth", label: "Credentials" }],
						properties: [
							{ ...metadata, binding: { type: "zeebe:input", name: "opaque" } },
						],
					},
				],
			};
			const raw = report({
				dropped: [
					{ ...field, value: "PRIVATE-DROP", valueName: "PRIVATE-DROP-NAME" },
				],
				added: [
					{ ...field, value: "PRIVATE-ADD", valueName: "PRIVATE-ADD-NAME" },
					{
						key: "opaque",
						bindingType: "zeebe:taskHeader",
						value: "public-header",
					},
				],
				changed: [
					{
						...field,
						valueChange: {
							from: "PRIVATE-OLD",
							to: "PRIVATE-NEW",
							fromName: "PRIVATE-OLD-NAME",
							toName: "PRIVATE-NEW-NAME",
						},
					},
				],
				moved: [
					{
						from: field,
						to: { key: "public", bindingType: "zeebe:input" },
						valueChange: { from: "PRIVATE-FROM", to: "PRIVATE-TO" },
					},
					{
						from: { key: "public", bindingType: "zeebe:input" },
						to: field,
						valueChange: { from: "PRIVATE-REVERSE", to: "PRIVATE-RESULT" },
					},
				],
			});
			const original = structuredClone(raw);
			for (const dryRun of [false, true]) {
				const text = renderReportText(raw, {
					elementId: "Task",
					color: false,
					dryRun,
					redaction,
				});
				const json = JSON.stringify(
					reportToJson(raw, {
						elementId: "Task",
						recipe: "embedded",
						dryRun,
						redaction,
					}),
				);
				for (const output of [text, json]) {
					assert.doesNotMatch(output, /PRIVATE-/);
					assert.match(output, /\[REDACTED\]/);
					assert.match(output, /public-header/);
				}
			}
			assert.deepStrictEqual(raw, original);
		}
	});

	test("scrubs known sensitive values from notes, refusals, skipped diagnostics and other report strings", () => {
		const secret = 'LONG-PRIVATE-"VALUE"\\line\nend';
		const raw = report({
			dropped: [{ key: "password", bindingType: "zeebe:input", value: secret }],
			added: [
				{
					key: "public",
					bindingType: "zeebe:input",
					value: `copied ${secret}`,
				},
			],
			notes: [{ level: "warning", message: `failed: ${secret}` }],
			refusal: `cannot use ${secret}`,
			skipped: {
				guard: [{ from: secret, to: "b" }],
				template: [{ to: "c", missing: [secret] }],
				noMatch: [{ from: "d", to: secret }],
				feel: [{ from: secret, to: "e" }],
			},
		});
		const original = structuredClone(raw);
		assert.doesNotMatch(
			renderReportText(raw, { elementId: "Task", color: true, dryRun: true }),
			/LONG-PRIVATE/,
		);
		assert.doesNotMatch(
			JSON.stringify(
				reportToJson(raw, {
					elementId: "Task",
					recipe: "file",
					dryRun: true,
				}),
			),
			/LONG-PRIVATE/,
		);
		assert.deepStrictEqual(raw, original);
	});

	test("diagnostics redact unchanged credentials and sensitive defaults using the same context", () => {
		const redaction = {
			templates: [
				{
					id: "old",
					properties: [
						{
							id: "password",
							binding: { type: "zeebe:input", name: "opaque" },
							value: "PRIVATE-DEFAULT",
						},
					],
				},
			],
			values: [
				{
					key: "opaque",
					bindingType: "zeebe:input",
					value: "PRIVATE-UNCHANGED",
					isFeel: false,
				},
			],
		};
		const message =
			"Invalid value PRIVATE-UNCHANGED; default PRIVATE-DEFAULT; keep useful reason";
		assert.strictEqual(
			redactMigrationDiagnostic(message, redaction),
			"Invalid value [REDACTED]; default [REDACTED]; keep useful reason",
		);
		const raw = report({ notes: [{ level: "info", message }] });
		assert.doesNotMatch(
			renderReportText(raw, {
				elementId: "Task",
				color: false,
				dryRun: true,
				redaction,
			}),
			/PRIVATE-/,
		);
		assert.doesNotMatch(
			JSON.stringify(
				reportToJson(raw, {
					elementId: "Task",
					recipe: "none",
					dryRun: true,
					redaction,
				}),
			),
			/PRIVATE-/,
		);
	});

	test("redacts overlapping and JSON-escaped known values without hiding token limits or empty strings", () => {
		const values = ["abc", "abcdef", 'quoted"password\\value'];
		const raw = report({
			dropped: values.map((value) => ({
				key: "token",
				bindingType: "zeebe:input",
				value,
			})),
			added: [
				{
					key: "maxTokens",
					label: "Maximum tokens",
					bindingType: "zeebe:input",
					value: "2000",
				},
			],
		});
		const message = `${values.join(" ")} ${JSON.stringify(values[2])}`;
		assert.strictEqual(
			redactMigrationDiagnostic(message, { report: raw }),
			'[REDACTED] [REDACTED] [REDACTED] "[REDACTED]"',
		);
		assert.strictEqual(
			redactMigrationDiagnostic("ordinary diagnostic", {
				values: [
					{
						key: "token",
						bindingType: "zeebe:input",
						value: "",
						isFeel: false,
					},
				],
			}),
			"ordinary diagnostic",
		);
		assert.match(
			renderReportText(raw, { elementId: "Task", color: false, dryRun: false }),
			/2000/,
		);
	});

	test("keeps token limits visible and redacts token credentials", () => {
		const limits = [
			[
				"provider.openai.api.completions.maxCompletionTokens",
				"Max completion tokens",
			],
			[
				"provider.bedrock.model.parameters.maxOutputTokens",
				"Max output tokens",
			],
			["provider.anthropic.thinking.budgetTokens", "Budget tokens"],
		];
		const credentials = ["token", "accessToken", "apiToken", "refreshToken"];
		const raw = report({
			added: [
				...limits.map(([key, label], index) => ({
					key,
					label,
					bindingType: "zeebe:input",
					value: `=${1000 + index}`,
				})),
				...credentials.map((key) => ({
					key,
					bindingType: "zeebe:input",
					value: `secret-${key}`,
				})),
			],
		});
		const json = reportToJson(raw, {
			elementId: "Task",
			recipe: "none",
			dryRun: true,
		});
		assert.deepStrictEqual(
			json.report.added.map((item) => item.value),
			["=1000", "=1001", "=1002", ...credentials.map(() => "[REDACTED]")],
		);
	});

	test("redacts sensitive values in every report collection without changing the source", () => {
		const field = { key: "authentication.token", bindingType: "zeebe:input" };
		const raw = report({
			dropped: [{ ...field, value: "SECRET-DROP", valueName: "SECRET-NAME" }],
			added: [{ ...field, value: "SECRET-ADD" }],
			changed: [
				{ ...field, valueChange: { from: "SECRET-OLD", to: "SECRET-NEW" } },
			],
			moved: [
				{
					from: field,
					to: { ...field, key: "renamed" },
					valueChange: { from: "SECRET-FROM", to: "SECRET-TO" },
				},
			],
		});
		const snapshot = structuredClone(raw);
		const text = renderReportText(raw, {
			elementId: "Task",
			color: false,
			dryRun: true,
		});
		assert.doesNotMatch(text, /SECRET/);
		assert.strictEqual(text.match(/\[REDACTED\]/g)?.length, 6);
		const json = reportToJson(raw, {
			elementId: "Task",
			recipe: "embedded",
			dryRun: true,
		}).report;
		assert.doesNotMatch(JSON.stringify(json), /SECRET/);
		assert.strictEqual(json.dropped[0].value, "[REDACTED]");
		assert.strictEqual(json.added[0].value, "[REDACTED]");
		assert.deepStrictEqual(json.changed[0].valueChange, {
			from: "[REDACTED]",
			to: "[REDACTED]",
		});
		assert.deepStrictEqual(json.moved[0].valueChange, {
			from: "[REDACTED]",
			to: "[REDACTED]",
		});
		assert.deepStrictEqual(raw, snapshot);
		assert.strictEqual(raw.dropped[0].value, "SECRET-DROP");
	});

	test("short credentials cannot corrupt redaction markers", () => {
		const raw = report({
			dropped: [{ key: "password", bindingType: "zeebe:input", value: "RED" }],
		});
		const json = reportToJson(raw, {
			elementId: "Task",
			recipe: "none",
			dryRun: true,
		});
		assert.strictEqual(json.report.dropped[0].value, "[REDACTED]");
	});

	test("checks every duplicate metadata property and conservatively handles unknown binding types", () => {
		const redaction = {
			templates: [
				{
					id: "old",
					properties: [
						{
							label: "Public",
							binding: { type: "zeebe:input", name: "opaque" },
						},
						{ id: "apiKey", binding: { type: "zeebe:input", name: "opaque" } },
					],
				},
			],
		};
		for (const bindingType of ["zeebe:input", null]) {
			const raw = report({
				added: [{ key: "opaque", bindingType, value: "PRIVATE-DUPLICATE" }],
			});
			assert.doesNotMatch(
				JSON.stringify(
					reportToJson(raw, {
						elementId: "Task",
						recipe: "none",
						dryRun: true,
						redaction,
					}),
				),
				/PRIVATE-DUPLICATE/,
			);
		}
	});
});

describe("renderReportText", () => {
	test("renders the header, sections and a lossless footer", () => {
		const text = renderReportText(
			report({
				dropped: [],
				added: [
					{
						key: "backend",
						bindingType: "zeebe:input",
						groupLabel: "Model provider",
						label: "Backend",
						value: "foundry",
						valueName: "Microsoft Foundry (Azure)",
					},
				],
				moved: [
					{
						from: {
							key: "provider",
							bindingType: null,
							label: "Provider",
							groupLabel: "Model provider",
						},
						to: {
							key: "provider",
							bindingType: null,
							label: "Provider",
							groupLabel: "Model provider",
						},
						valueChange: {
							from: "azure",
							to: "openai",
							fromName: "Azure OpenAI",
							toName: "OpenAI",
						},
					},
					{
						from: { key: "endpoint", bindingType: null, label: "Endpoint" },
						to: {
							key: "apiEndpoint",
							bindingType: null,
							label: "API endpoint",
						},
					},
				],
			}),
			{ elementId: "Agent_1", color: false, dryRun: false },
		);
		assert.match(
			text,
			/🔄 Agent_1 {2}AI Agent \(job worker\) v13 \(deprecated\) → AI Agent Sub-process v1/,
		);
		assert.match(text, /➕ Added \(1\)/);
		assert.match(
			text,
			/Model provider › Backend {2}Microsoft Foundry \(Azure\)/,
		);
		assert.match(text, /↪️ {2}Moved \(2\)/);
		assert.match(text, /Model provider › Provider {2}Azure OpenAI → OpenAI/);
		assert.match(text, /Endpoint → API endpoint/);
		assert.match(text, /✅ No values lost/);
		assert.doesNotMatch(text, /Dropped/);
	});

	test("does not repeat a deprecated marker the template name already has", () => {
		const text = renderReportText(
			report({
				from: {
					id: "o",
					version: 2,
					name: "Agent (Deprecated)",
					deprecated: true,
				},
			}),
			{ elementId: "A", color: false, dryRun: false },
		);
		assert.match(text, /Agent \(Deprecated\) v2 →/);
		assert.doesNotMatch(text, /\(deprecated\)/);
	});

	test("names the group once when a value moves within it", () => {
		const text = renderReportText(
			report({
				moved: [
					{
						from: {
							key: "a",
							bindingType: null,
							label: "Endpoint",
							groupLabel: "Model",
						},
						to: {
							key: "b",
							bindingType: null,
							label: "URL",
							groupLabel: "Model",
						},
					},
				],
			}),
			{ elementId: "A", color: false, dryRun: false },
		);
		assert.match(text, /Model › Endpoint → URL/);
	});

	test("lists dropped values and warns in the footer", () => {
		const text = renderReportText(
			report({
				lossless: false,
				dropped: [
					{
						key: "maxTokens",
						bindingType: "zeebe:input",
						groupLabel: "Model",
						label: "Maximum tokens",
						value: "2000",
					},
				],
			}),
			{ elementId: "A", color: false, dryRun: false },
		);
		assert.match(text, /➖ Dropped \(1\)/);
		assert.match(text, /Model › Maximum tokens {2}2000/);
		assert.match(text, /⚠️ {2}1 value dropped, review above/);
	});

	test("renders info and warning notes and needs-attention items", () => {
		const text = renderReportText(
			report({
				lossless: false,
				notes: [
					{ level: "info", message: "moved for you" },
					{ level: "warning", message: "check IAM" },
				],
				skipped: {
					guard: [{ from: "a", to: "b" }],
					template: [{ to: "url", missing: ["host"] }],
					noMatch: [{ from: "c", to: "d" }],
					feel: [{ from: "e", to: "f" }],
				},
			}),
			{ elementId: "A", color: false, dryRun: false },
		);
		assert.match(text, /ℹ️ {2}moved for you/);
		assert.match(text, /⚠️ {2}check IAM/);
		assert.match(text, /Needs attention \(4\)/);
		assert.match(text, /Not composed, missing host: url/);
	});

	test("explains a missing or refused recipe and marks a dry run", () => {
		const none = renderReportText(report({ usedRecipe: false }), {
			elementId: "A",
			color: false,
			dryRun: true,
		});
		assert.match(none, /No recipe: values carried over by key/);
		assert.match(none, /Dry run: nothing was written/);
		const refused = renderReportText(
			report({ usedRecipe: false, refusal: "log is incomplete" }),
			{
				elementId: "A",
				color: false,
				dryRun: false,
			},
		);
		assert.match(refused, /Recipe not used: log is incomplete/);
	});

	test("emits ANSI colours only when enabled", () => {
		const input = report({
			added: [{ key: "k", bindingType: null, value: "v" }],
		});
		assert.ok(
			!renderReportText(input, {
				elementId: "A",
				color: false,
				dryRun: false,
			}).includes(ESC),
		);
		assert.ok(
			renderReportText(input, {
				elementId: "A",
				color: true,
				dryRun: false,
			}).includes(ESC),
		);
	});
});

describe("shouldUseColor", () => {
	const saved = {
		NO_COLOR: process.env.NO_COLOR,
		FORCE_COLOR: process.env.FORCE_COLOR,
	};
	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	test("follows the TTY, with NO_COLOR and FORCE_COLOR overriding", () => {
		delete process.env.NO_COLOR;
		delete process.env.FORCE_COLOR;
		assert.strictEqual(shouldUseColor({ isTTY: true }), true);
		assert.strictEqual(shouldUseColor({ isTTY: false }), false);
		process.env.FORCE_COLOR = "1";
		assert.strictEqual(shouldUseColor({ isTTY: false }), true);
		process.env.NO_COLOR = "1";
		assert.strictEqual(shouldUseColor({ isTTY: true }), false);
	});
});

describe("reportToJson", () => {
	test("exposes the report as plain data", () => {
		const json = reportToJson(report(), {
			elementId: "A",
			recipe: "embedded",
			dryRun: true,
			file: "p.bpmn",
		});
		assert.strictEqual(json.elementId, "A");
		assert.strictEqual(json.dryRun, true);
		assert.strictEqual(json.file, "p.bpmn");
		assert.deepStrictEqual(json.recipe, {
			source: "embedded",
			used: true,
			refusal: null,
		});
		assert.strictEqual(json.lossless, true);
		assert.deepStrictEqual(Object.keys(json.report), [
			"moved",
			"added",
			"changed",
			"dropped",
			"kept",
			"notes",
			"skipped",
		]);
		assert.strictEqual("elementName" in json, false);
	});

	test("carries the element name, the recipe path and counts that match the arrays", () => {
		const field = { key: "k", bindingType: "zeebe:input" };
		const json = reportToJson(
			report({
				moved: [{ from: field, to: field, value: "v" }],
				added: [{ ...field, value: "a" }],
				kept: [field, field],
			}),
			{
				elementId: "A",
				elementName: "Recipe assistant",
				recipe: "file",
				recipePath: "recipes/x.recipe.json",
				dryRun: true,
			},
		);
		assert.strictEqual(json.elementName, "Recipe assistant");
		assert.deepStrictEqual(json.recipe, {
			source: "file",
			path: "recipes/x.recipe.json",
			used: true,
			refusal: null,
		});
		assert.deepStrictEqual(json.counts, {
			moved: 1,
			added: 1,
			changed: 0,
			dropped: 0,
			kept: 2,
		});
	});

	test("redacts the value of a moved credential that kept its value", () => {
		const secret = { key: "auth.clientSecret", bindingType: "zeebe:input" };
		const json = reportToJson(
			report({
				moved: [
					{
						from: secret,
						to: { ...secret, key: "x.clientSecret" },
						value: "S3CRET",
					},
				],
			}),
			{ elementId: "A", recipe: "none", dryRun: true },
		);
		assert.strictEqual(json.report.moved[0].value, "[REDACTED]");
		assert.doesNotMatch(JSON.stringify(json), /S3CRET/);
	});
});

describe("output boundary cases", () => {
	const options = { elementId: "Task_1", color: false, dryRun: false };

	test("an empty report renders the header, the carry-over note and the lossless footer only", () => {
		const text = renderReportText(report({ usedRecipe: false }), options);
		assert.strictEqual(
			text,
			[
				"🔄 Task_1  AI Agent (job worker) v13 (deprecated) → AI Agent Sub-process v1",
				"   ℹ️  No recipe: values carried over by key",
				"",
				"✅ No values lost",
				"",
			].join("\n"),
		);
	});

	test("a refusal replaces the recipe line and a dry run adds its footer", () => {
		const text = renderReportText(
			report({
				refusal: "wrong source ID",
				usedRecipe: false,
				lossless: false,
			}),
			{ ...options, dryRun: true },
		);
		assert.match(text, /⚠️ {2}Recipe not used: wrong source ID/);
		assert.match(text, /⚠️ {2}Some values were not migrated, review above/);
		assert.match(text, /🔍 Dry run: nothing was written\n$/);
	});

	test("the footer counts dropped values in singular and plural", () => {
		const dropped = (key: string) => ({
			key,
			bindingType: "zeebe:input",
			value: "v",
		});
		const one = renderReportText(
			report({ dropped: [dropped("a")], lossless: false }),
			options,
		);
		assert.match(one, /⚠️ {2}1 value dropped, review above/);
		const two = renderReportText(
			report({ dropped: [dropped("a"), dropped("b")], lossless: false }),
			options,
		);
		assert.match(two, /⚠️ {2}2 values dropped, review above/);
	});

	test("a --map move carries its source tag, and a renamed key is hinted inside one group", () => {
		const text = renderReportText(
			report({
				moved: [
					{
						from: {
							key: "maxTokens",
							bindingType: null,
							groupLabel: "g",
							label: "Limit",
						},
						to: {
							key: "limit",
							bindingType: null,
							groupLabel: "g",
							label: "Limit",
						},
						source: "map",
					},
				],
			}),
			options,
		);
		assert.match(text, /g › Limit \(maxTokens → limit\) \[--map\]/);
	});

	test("every needs-attention kind is listed with its own wording", () => {
		const text = renderReportText(
			report({
				lossless: false,
				skipped: {
					guard: [{ from: "a", to: "b" }],
					template: [{ to: "c", missing: ["x", "y"] }],
					noMatch: [{ from: "d", to: "e" }],
					feel: [{ from: "f", to: "g" }],
				},
			}),
			options,
		);
		assert.match(text, /⏭️ {2}Needs attention \(4\)/);
		assert.match(text, /Condition not met, not moved: a → b/);
		assert.match(text, /Not composed, missing x, y: c/);
		assert.match(text, /No value rule matched, target default kept: d → e/);
		assert.match(
			text,
			/FEEL expression moved as-is, value rules not applied: f → g/,
		);
	});

	test("the changed section shows unredacted values for ordinary fields and redacts sensitive ones", () => {
		const text = renderReportText(
			report({
				changed: [
					{
						key: "mode",
						bindingType: "zeebe:input",
						valueChange: { from: "slow", to: "fast" },
					},
					{
						key: "apiKey",
						bindingType: "zeebe:input",
						valueChange: { from: "OLD-SECRET", to: "NEW-SECRET" },
					},
				],
			}),
			options,
		);
		assert.match(text, /mode {2}slow → fast/);
		assert.match(text, /apiKey {2}\[REDACTED\] → \[REDACTED\]/);
		assert.doesNotMatch(text, /OLD-SECRET|NEW-SECRET/);
	});

	test("a short secret redacts the element id and values but leaves the version header intact", () => {
		const text = renderReportText(
			report({
				from: { id: "old", version: 1, name: "Old", deprecated: false },
				dropped: [{ key: "password", bindingType: "zeebe:input", value: "1" }],
				lossless: false,
			}),
			{
				...options,
				elementId: "Task_1",
				redaction: {
					values: [
						{
							bindingType: "zeebe:input",
							key: "password",
							value: "1",
							isFeel: false,
						},
					],
				},
			},
		);
		assert.match(text, /🔄 Task_\[REDACTED\] {2}Old v1 → /);
		assert.match(text, /password {2}\[REDACTED\]/);
	});

	test("JSON output carries the same content as the text, not only its keys", () => {
		const raw = report({
			dropped: [
				{
					key: "provider",
					bindingType: "zeebe:input",
					label: "Provider",
					group: "model",
					value: "azure",
					valueName: "Azure OpenAI",
				},
			],
			notes: [{ level: "warning", message: "Provider changed" }],
			lossless: false,
		});
		const json = reportToJson(raw, {
			elementId: "Task_1",
			recipe: "embedded",
			dryRun: true,
			file: "process.bpmn",
		});
		assert.deepStrictEqual(json.report.dropped, raw.dropped);
		assert.deepStrictEqual(json.report.notes, raw.notes);
		assert.deepStrictEqual(json.recipe, {
			source: "embedded",
			used: true,
			refusal: null,
		});
		assert.strictEqual(json.lossless, false);
		assert.strictEqual(json.file, "process.bpmn");
		const text = renderReportText(raw, options);
		assert.match(text, /Azure OpenAI/);
		assert.match(text, /Provider changed/);
	});

	test("the element id and the file are redacted in JSON output", () => {
		const secret = {
			bindingType: "zeebe:input",
			key: "token",
			value: "TOK-1",
			isFeel: false,
		};
		const json = reportToJson(report(), {
			elementId: "Task_TOK-1",
			recipe: "none",
			dryRun: false,
			file: "/work/TOK-1/process.bpmn",
			redaction: { values: [secret] },
		});
		assert.strictEqual(json.elementId, "Task_[REDACTED]");
		assert.strictEqual(json.file, "/work/[REDACTED]/process.bpmn");
	});
});
