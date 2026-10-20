/**
 * Unit tests for the migration report presentation
 * (default-plugins/element-template/migration-output.ts)
 */

import assert from "node:assert";
import { afterEach, describe, test } from "node:test";
import type {
	Field,
	MigrationReport,
	MovedItem,
	ValueSource,
} from "../../default-plugins/element-template/migration/report.ts";
import type { MigrationTemplate } from "../../default-plugins/element-template/migration/types.ts";
import {
	redactMigrationDiagnostic,
	renderLegend,
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
		steps: [],
		dropped: [],
		kept: [],
		notes: [],
		skipped: { guard: [], template: [], noMatch: [], feel: [], unchecked: [] },
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
					recipe: "embedded",
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
				unchecked: [],
			},
		});
		const original = structuredClone(raw);
		assert.doesNotMatch(
			renderReportText(raw, { elementId: "Task", color: true, recipe: "none" }),
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
				recipe: "none",
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
			renderReportText(raw, {
				elementId: "Task",
				color: false,
				recipe: "none",
			}),
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
			recipe: "none",
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

	test("redacts a field the template marks secret, whatever its name", () => {
		const redaction = {
			templates: [
				{
					id: "new",
					properties: [
						{
							id: "accountValue",
							secret: true,
							binding: { type: "zeebe:input", name: "accountValue" },
						},
					],
				},
			],
		};
		const raw = report({
			added: [
				{
					key: "accountValue",
					bindingType: "zeebe:input",
					value: "PRIVATE-MARKED",
				},
			],
		});
		const options = {
			elementId: "Task",
			recipe: "none",
			dryRun: true,
			redaction,
		} as const;
		assert.doesNotMatch(
			JSON.stringify(reportToJson(raw, options)),
			/PRIVATE-MARKED/,
		);
		assert.doesNotMatch(
			renderReportText(raw, { ...options, color: false }),
			/PRIVATE-MARKED/,
		);
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
	const render = (
		input: MigrationReport,
		options: Partial<Parameters<typeof renderReportText>[1]> = {},
	) =>
		renderReportText(input, {
			elementId: "Agent_1",
			color: false,
			recipe: "file",
			recipePath: "r.json",
			...options,
		});
	const input = (key: string, label?: string, group?: string) => ({
		key,
		bindingType: "zeebe:input",
		...(label ? { label } : {}),
		...(group ? { group: group.toLowerCase(), groupLabel: group } : {}),
	});

	test("renders the element block, rows and a lossless footer", () => {
		const text = render(
			report({
				added: [
					{
						...input("backend", "Backend", "Model provider"),
						value: "foundry",
						valueName: "Microsoft Foundry (Azure)",
						source: "recipe",
					},
				],
				moved: [
					{
						from: input("provider", "Provider", "Model provider"),
						to: input("provider", "Provider", "Model provider"),
						valueChange: {
							from: "azure",
							to: "openai",
							fromName: "Azure OpenAI",
							toName: "OpenAI",
						},
					},
				],
				kept: [input("a"), input("b")],
			}),
			{ elementName: "Agent" },
		);
		assert.strictEqual(
			text,
			[
				"Agent (Agent_1)",
				"  AI Agent (job worker) (deprecated) v13  →  AI Agent Sub-process v1",
				"  old@13 → new@1",
				"  recipe: r.json",
				"",
				"  Model provider",
				"  + Backend   Microsoft Foundry (Azure) [foundry]  set by recipe",
				"  ~ Provider  Azure OpenAI → OpenAI [openai]       set by recipe",
				"",
				"  ✅ 2 updated, 2 kept unchanged, 0 lost",
				"",
			].join("\n"),
		);
	});

	test("shows the element ID alone for an unnamed element", () => {
		assert.match(render(report()), /^Agent_1\n/);
	});

	test("does not repeat a deprecated marker the template name already has", () => {
		const text = render(
			report({
				from: {
					id: "o",
					version: 2,
					name: "Agent (Deprecated)",
					deprecated: true,
				},
			}),
		);
		assert.match(text, /Agent \(deprecated\) v2 {2}→/);
		assert.doesNotMatch(text, /\(Deprecated\)/);
	});

	test("names the source of added, changed and moved values", () => {
		const text = render(
			report({
				added: [
					{ ...input("a", "A"), value: "1", source: "recipe" },
					{ ...input("b", "B"), value: "2", source: "default" },
					{ ...input("c", "C"), value: "3", source: "fixed" },
				],
				changed: [
					{
						...input("d", "D"),
						valueChange: { from: "x", to: "y" },
						source: "default",
					},
				],
				moved: [
					{
						from: input("e", "E"),
						to: input("f", "F"),
						value: "5",
						valueChange: { from: "4", to: "5" },
						source: "map",
					},
				],
			}),
		);
		assert.match(text, /\+ A +1 +set by recipe/);
		assert.match(text, /\+ B +2 +template default/);
		assert.match(text, /\+ C +3 +fixed by template/);
		assert.match(text, /~ D +x → y +template default/);
		assert.match(text, /~ F +4 → 5 +--map/);
	});

	test("a moved value says where it came from, and nothing when label and group are unchanged", () => {
		const moved = (from: Field, to: Field) => ({ from, to, value: "v" });
		const text = render(
			report({
				moved: [
					moved(input("a", "Endpoint", "Model"), input("b", "URL", "Model")),
					moved(input("c", "Temp", "Model"), input("d", "Temp", "Options")),
					moved(
						input("e", "Max", "Model"),
						input("f", "Max completion", "Options"),
					),
					moved(input("g", "Same", "Model"), input("h", "Same", "Model")),
				],
			}),
		);
		assert.match(text, /> URL +v +was Endpoint/);
		assert.match(text, /> Temp +v +was Model › Temp/);
		assert.match(text, /> Max completion +v +was Model › Max/);
		assert.match(text, /> Same +v\n/);
		assert.doesNotMatch(text, /Same.*was/);
	});

	test("shows the stored value of a choice when it differs, on added and changed rows", () => {
		const text = render(
			report({
				added: [
					{
						...input("e", "Effort"),
						value: "modelDefault",
						valueName: "default",
					},
				],
				changed: [
					{
						...input("m", "Mode"),
						valueChange: {
							from: "a",
							to: "b",
							fromName: "Old",
							toName: "New",
						},
					},
				],
			}),
		);
		assert.match(text, /\+ Effort +default \[modelDefault\]/);
		assert.match(text, /~ Mode +Old → New \[b\]/);
	});

	test("collapses key renames that share a prefix into one dim line per group", () => {
		const rename = (from: string, to: string, label: string) => ({
			from: input(from, label, "Provider"),
			to: input(to, label, "Provider"),
			value: "v",
		});
		const text = render(
			report({
				moved: [
					rename("p.old.auth.type", "p.new.auth.type", "Type"),
					rename("p.old.auth.id", "p.new.auth.id", "ID"),
					rename("p.old.auth.secret", "p.new.auth.secret", "Secret"),
					rename("p.old.timeout", "p.new.timeout", "Timeout"),
				],
			}),
		);
		assert.match(
			text,
			/keys renamed: p\.old\.auth\.\* → p\.new\.auth\.\* \(3\)/,
		);
		assert.match(text, /\n {18}p\.old\.timeout → p\.new\.timeout\n/);
	});

	test("shows the binding key of rows that share a group and label", () => {
		const text = render(
			report({
				lossless: false,
				added: [
					{
						...input("data.new.method", "Method", "Operation"),
						value: "=m",
					},
				],
				dropped: [
					{
						...input("data.old.method", "Method", "Operation"),
						value: "tools/call",
					},
				],
			}),
		);
		assert.match(
			text,
			/\+ Method +=m +template default\n +data\.new\.method\n/,
		);
		assert.match(
			text,
			/- Operation › Method +tools\/call\n +data\.old\.method\n/,
		);
		assert.doesNotMatch(text, /keys renamed/);
	});

	test("lists ungrouped fields under (no group) and keeps a field named like its group in that group", () => {
		const text = render(
			report({
				added: [
					{ ...input("a", "Loose"), value: "1" },
					{ ...input("b", "Model", "Model"), value: "2" },
				],
			}),
		);
		assert.match(text, /\n {2}\(no group\)\n {2}\+ Loose/);
		assert.match(text, /\n {2}Model\n {2}\+ Model/);
	});

	test("orders rows and groups like the target template", () => {
		const template = {
			id: "new",
			version: 1,
			groups: [
				{ id: "first", label: "First" },
				{ id: "second", label: "Second" },
			],
			properties: [
				{
					id: "p1",
					group: "first",
					binding: { type: "zeebe:input", name: "one" },
				},
				{
					id: "p2",
					group: "first",
					binding: { type: "zeebe:input", name: "two" },
				},
				{
					id: "p3",
					group: "second",
					binding: { type: "zeebe:input", name: "three" },
				},
			],
		} satisfies MigrationTemplate;
		const field = (key: string, group: string) => ({
			...input(key, key, group),
			group,
		});
		const text = render(
			report({
				added: [
					{ ...field("two", "first"), value: "2" },
					{ ...field("three", "second"), value: "3" },
				],
				moved: [
					{
						from: field("old", "first"),
						to: field("one", "first"),
						value: "1",
					},
				],
			}),
			{ targetTemplate: template },
		);
		const order = ["> one", "+ two", "+ three"].map((row) => text.indexOf(row));
		assert.deepStrictEqual(
			order,
			[...order].sort((a, b) => a - b),
		);
		assert.ok(order.every((i) => i >= 0));
	});

	test("prints one (no group) heading when the template declares no groups", () => {
		const template = {
			id: "new",
			version: 1,
			properties: [
				{ id: "p1", binding: { type: "zeebe:input", name: "loose" } },
				{
					id: "p2",
					group: "creds",
					binding: { type: "zeebe:input", name: "key" },
				},
				{ id: "p3", binding: { type: "zeebe:input", name: "other" } },
			],
		} satisfies MigrationTemplate;
		const text = render(
			report({
				added: [
					{ ...input("loose", "Loose"), value: "1" },
					{ ...input("key", "Key", "creds"), value: "2" },
					{ ...input("other", "Other"), value: "3" },
				],
			}),
			{ targetTemplate: template },
		);
		assert.strictEqual(text.match(/\(no group\)/g)?.length, 1, text);
		assert.ok(text.indexOf("creds") < text.indexOf("(no group)"));
	});

	test("truncates long values and keeps short ones", () => {
		const long = "x".repeat(60);
		const text = render(
			report({ added: [{ ...input("a", "A"), value: long }] }),
		);
		assert.match(text, new RegExp(`\\+ A +${"x".repeat(39)}…`));
		assert.doesNotMatch(text, /x{40}/);
	});

	test("moves the source below its row on a narrow terminal", () => {
		const added = report({ added: [{ ...input("a", "A"), value: "1" }] });
		assert.match(
			render(added, { columns: 99 }),
			/\+ A {2}1\n {7}template default\n/,
		);
		assert.match(
			render(added, { columns: 100 }),
			/\+ A {2}1 {2}template default\n/,
		);
	});

	test("lists dropped values under a Dropped heading and warns in the footer", () => {
		const text = render(
			report({
				lossless: false,
				dropped: [
					{ ...input("max", "Maximum tokens", "Model"), value: "2000" },
				],
			}),
		);
		assert.match(text, /\n {2}Dropped\n {2}- Model › Maximum tokens {2}2000\n/);
		assert.match(text, /⚠️ {2}0 updated, 0 kept unchanged, 1 lost\n$/);
	});

	test("the footer states the --allow-lossy outcome", () => {
		const lossy = report({ lossless: false });
		assert.match(
			render(lossy, { authorization: "required" }),
			/lost\. Requires --allow-lossy before writing\.\n$/,
		);
		assert.match(
			render(lossy, { authorization: "authorized" }),
			/lost\. Authorized with --allow-lossy\.\n$/,
		);
		assert.doesNotMatch(render(report()), /allow-lossy/);
	});

	test("renders info and warning notes and needs-attention items after the rows", () => {
		const text = render(
			report({
				lossless: false,
				added: [{ ...input("a", "A"), value: "1" }],
				notes: [
					{ level: "info", message: "moved for you" },
					{ level: "warning", message: "check IAM" },
				],
				skipped: {
					guard: [{ from: "a", to: "b" }],
					template: [{ to: "url", missing: ["host"] }],
					noMatch: [{ from: "c", to: "d" }],
					feel: [{ from: "e", to: "f" }],
					unchecked: [
						{
							key: "correlationKey",
							bindingType: "bpmn:Message#zeebe:subscription#property",
							label: "Correlation key",
						},
					],
				},
			}),
		);
		assert.match(
			text,
			/Not checked, bpmn:Message#zeebe:subscription#property binding not kept by the target: Correlation key/,
		);
		assert.match(text, /ℹ️ {2}moved for you/);
		assert.match(text, /⚠️ {2}check IAM/);
		assert.match(text, /Needs attention\n/);
		assert.match(text, /Not composed, missing host: url/);
		assert.ok(text.indexOf("+ A") < text.indexOf("Notes"));
		assert.ok(text.indexOf("Notes") < text.indexOf("Needs attention"));
	});

	test("names the recipe origin, its absence or its refusal", () => {
		assert.match(render(report()), /\n {2}recipe: r\.json\n/);
		assert.match(
			render(report(), { recipe: "embedded" }),
			/\n {2}recipe: embedded in new\n/,
		);
		assert.match(
			render(report({ usedRecipe: false }), { recipe: "none" }),
			/\n {2}no recipe: values carried over by key\n/,
		);
		assert.match(
			render(report({ usedRecipe: false, refusal: "log is incomplete" })),
			/\n {2}recipe not used: log is incomplete\n/,
		);
	});

	test("emits no escape sequence without colour", () => {
		assert.ok(
			!render(
				report({ added: [{ ...input("k"), value: "v" }], lossless: false }),
			).includes(ESC),
		);
	});

	test("colours each row type like git diff, without backgrounds", () => {
		const text = render(
			report({
				added: [{ ...input("a", "A"), value: "1" }],
				changed: [
					{ ...input("c", "C"), valueChange: { from: "old", to: "new" } },
				],
				moved: [{ from: input("m", "M"), to: input("n", "N"), value: "v" }],
				dropped: [{ ...input("d", "D"), value: "gone" }],
				lossless: false,
			}),
			{ color: true },
		);
		for (const colored of [
			`${ESC}32m+${ESC}39m`,
			`${ESC}33m~${ESC}39m`,
			`${ESC}31mold${ESC}39m`,
			`${ESC}32mnew${ESC}39m`,
			`${ESC}36m>${ESC}39m`,
			`${ESC}31m-${ESC}39m`,
			`${ESC}31mgone${ESC}39m`,
			`${ESC}33m  ⚠️`,
		]) {
			assert.ok(text.includes(colored), colored);
		}
		assert.doesNotMatch(
			text,
			new RegExp(`${String.fromCharCode(0x1b)}\\[(?:4\\d|10\\d)m`),
		);
	});

	test("prints the marker legend in the marker colours", () => {
		assert.strictEqual(
			renderLegend(false),
			"+ new  ~ changed  > moved  - dropped",
		);
		assert.ok(renderLegend(true).includes(`${ESC}36m> moved${ESC}39m`));
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

describe("implicit steps", () => {
	const steps: MigrationReport["steps"] = [
		{
			kind: "version",
			templateId: "old",
			fromVersion: 1,
			toVersion: 3,
			implicit: true,
		},
		{ kind: "hop", templateId: "new", fromVersion: 3, toVersion: 1 },
	];

	test("text marks the implicit step and leaves recipe steps out", () => {
		const text = renderReportText(report({ steps }), {
			elementId: "Task",
			color: false,
			recipe: "embedded",
		});
		assert.match(
			text,
			/The element is on v1, which is too old for this recipe\. Updating it to v3 first\./,
		);
		assert.doesNotMatch(text, /hop|v3 -> v1/);
	});

	test("text omits the line when no step is implicit", () => {
		const text = renderReportText(report({ steps: [steps[1]] }), {
			elementId: "Task",
			color: false,
			recipe: "embedded",
		});
		assert.doesNotMatch(text, /implicit/);
	});

	test("json flags the implicit step", () => {
		const json = reportToJson(report({ steps }), {
			elementId: "Task",
			recipe: "embedded",
			dryRun: false,
		});
		assert.deepStrictEqual(json.report.steps, steps);
		assert.strictEqual(json.report.steps[0].implicit, true);
		assert.strictEqual("implicit" in json.report.steps[1], false);
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
			owner: "new",
			used: true,
			refusal: null,
		});
		assert.strictEqual(json.lossless, true);
		assert.deepStrictEqual(Object.keys(json.report), [
			"steps",
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
	const options = {
		elementId: "Task_1",
		color: false,
		recipe: "none" as const,
	};

	test("an empty report renders the header, the carry-over note and the footer only", () => {
		const text = renderReportText(report({ usedRecipe: false }), options);
		assert.strictEqual(
			text,
			[
				"Task_1",
				"  AI Agent (job worker) (deprecated) v13  →  AI Agent Sub-process v1",
				"  old@13 → new@1",
				"  no recipe: values carried over by key",
				"",
				"  ✅ 0 updated, 0 kept unchanged, 0 lost",
				"",
			].join("\n"),
		);
	});

	test("a refusal replaces the recipe line and the footer warns", () => {
		const text = renderReportText(
			report({
				refusal: "wrong source ID",
				usedRecipe: false,
				lossless: false,
			}),
			options,
		);
		assert.match(text, /\n {2}recipe not used: wrong source ID\n/);
		assert.match(text, /⚠️ {2}0 updated, 0 kept unchanged, 0 lost\n$/);
	});

	test("the footer counts the lost values", () => {
		const dropped = (key: string) => ({
			key,
			bindingType: "zeebe:input",
			value: "v",
		});
		const two = renderReportText(
			report({ dropped: [dropped("a"), dropped("b")], lossless: false }),
			options,
		);
		assert.match(two, /⚠️ {2}0 updated, 0 kept unchanged, 2 lost\n$/);
	});

	test("a --map move that changes the value carries its source", () => {
		const text = renderReportText(
			report({
				moved: [
					{
						from: { key: "maxTokens", bindingType: null, label: "Limit" },
						to: { key: "limit", bindingType: null, label: "Limit" },
						valueChange: { from: "1", to: "2" },
						source: "map",
					},
				],
			}),
			options,
		);
		assert.match(text, /~ Limit +1 → 2 +--map/);
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
					unchecked: [],
				},
			}),
			options,
		);
		assert.match(text, /\n {2}Needs attention\n/);
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
		assert.match(text, /~ mode {4}slow → fast/);
		assert.match(text, /~ apiKey {2}\[REDACTED\] → \[REDACTED\]/);
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
		assert.match(text, /^Task_\[REDACTED\]\n {2}Old v1 {2}→ /);
		assert.match(text, /- password {2}\[REDACTED\]/);
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
			owner: "new",
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
