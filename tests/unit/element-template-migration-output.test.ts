/**
 * Unit tests for the migration report presentation
 * (default-plugins/element-template/migration-output.ts)
 */

import assert from "node:assert";
import { afterEach, describe, test } from "node:test";
import type { MigrationReport } from "../../default-plugins/element-template/migration/report.ts";
import {
	renderReportText,
	reportToJson,
	shouldUseColor,
} from "../../default-plugins/element-template/migration-output.ts";

function report(partial: Partial<MigrationReport> = {}): MigrationReport {
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
		added: [],
		changed: [],
		moved: [],
		notes: [],
		skipped: { guard: [], template: [], noMatch: [], feel: [] },
		lossless: true,
		...partial,
	};
}

const ESC = "\u001b[";

describe("renderReportText", () => {
	test("renders the header, sections and a lossless footer", () => {
		const text = renderReportText(
			report({
				dropped: [],
				added: [
					{
						key: "backend",
						bindingType: "zeebe:input",
						group: "Model provider",
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
							group: "Model provider",
						},
						to: {
							key: "provider",
							bindingType: null,
							label: "Provider",
							group: "Model provider",
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

	test("lists dropped values and warns in the footer", () => {
		const text = renderReportText(
			report({
				lossless: false,
				dropped: [
					{
						key: "maxTokens",
						bindingType: "zeebe:input",
						group: "Model",
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
			action: "change",
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
			"dropped",
			"added",
			"changed",
			"moved",
			"notes",
			"skipped",
		]);
	});
});
