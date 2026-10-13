/**
 * Bundled AI Agent v1 → v2 recipes
 * (default-plugins/element-template/recipes/) on the real upstream templates.
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { before, describe, test } from "node:test";
import { migrateElement } from "../../default-plugins/element-template/migration/apply.ts";
import {
	enumerateElementValues,
	getExtensionElements,
} from "../../default-plugins/element-template/migration/element-values.ts";
import {
	getModdleList,
	getModdleString,
} from "../../default-plugins/element-template/migration/moddle.ts";
import { parseRecipe } from "../../default-plugins/element-template/migration/recipe.ts";
import type { MigrationTemplate } from "../../default-plugins/element-template/migration/types.ts";
import { reportToJson } from "../../default-plugins/element-template/migration-output.ts";
import {
	createTestModeler,
	DIAGRAM,
	loadVendorBundle,
	type VendorBundle,
} from "../utils/element-template.ts";
import { readTemplate } from "../utils/realistic-diagram.ts";

const RECIPES = resolve(
	import.meta.dirname,
	"../../default-plugins/element-template/recipes",
);
const readRecipe = (name: string) =>
	JSON.parse(readFileSync(join(RECIPES, name), "utf-8"));

const SUBPROCESS_DIAGRAM = DIAGRAM.replace(
	'<bpmn:serviceTask id="Task_1" />',
	'<bpmn:adHocSubProcess id="Task_1" />',
).replace('bpmnElement="Task_1">', 'bpmnElement="Task_1" isExpanded="true">');

let vendor: VendorBundle;
before(() => {
	vendor = loadVendorBundle();
});

/**
 * Apply `source` to `Task_1` with `values` as template defaults, so conditional
 * properties materialise as the Modeler would create them, then migrate.
 */
async function migrate(
	source: MigrationTemplate,
	target: MigrationTemplate,
	recipeFile: string,
	values: Record<string, string>,
	xml = DIAGRAM,
) {
	const seeded = structuredClone(source);
	for (const property of seeded.properties) {
		const binding = property.binding;
		const key =
			binding?.type === "zeebe:taskDefinition"
				? `taskDefinition:${binding.property}`
				: (binding?.name ?? binding?.key);
		if (key !== undefined && key in values) property.value = values[key];
	}
	const modeler = await createTestModeler(vendor, xml);
	const elementTemplates = modeler.get("elementTemplates");
	elementTemplates.set([seeded]);
	const task = modeler.get("elementRegistry").get("Task_1");
	assert.ok(task);
	const element = elementTemplates.applyTemplate(task, seeded) ?? task;
	const result = migrateElement({
		modeler: { elementTemplates, modeling: modeler.get("modeling") },
		element,
		fromTemplate: source,
		target,
		templates: [source, target],
		recipe: parseRecipe(readRecipe(recipeFile)),
	});
	const after = enumerateElementValues(
		getExtensionElements(result.element.businessObject),
	);
	const taskDefinition = getModdleList(
		getExtensionElements(result.element.businessObject),
		"values",
	).find((v) => v.$type === "zeebe:TaskDefinition");
	assert.ok(taskDefinition);
	return {
		report: result.report,
		value: (key: string) => after.find((v) => v.key === key)?.value,
		has: (key: string) => after.some((v) => v.key === key),
		jobType: getModdleString(taskDefinition, "type"),
		notes: result.report.notes.map((n) => `${n.level}: ${n.message}`),
	};
}

describe("ai-agent-task.v2 recipe", () => {
	const V1 = readTemplate("aiagent-v1-v13.json");
	const V2 = readTemplate("ai-agent-task-v2-v1.json");
	const run = (values: Record<string, string>, source = V1) =>
		migrate(source, V2, "ai-agent-task.v2.recipe.json", values);

	test("OpenAI moves to chat completions on the OpenAI API", async () => {
		const r = await run({
			"provider.type": "openai",
			"provider.openai.authentication.apiKey": "key",
			"provider.openai.authentication.organizationId": "org",
			"provider.openai.authentication.projectId": "proj",
			"provider.openai.model.model": "gpt",
			"provider.openai.model.parameters.maxCompletionTokens": "500",
			"provider.openai.model.parameters.temperature": "0.2",
			"provider.openai.timeouts.timeout": "PT1M",
		});
		assert.strictEqual(r.value("provider.type"), "openai");
		assert.strictEqual(r.value("provider.openai.api.type"), "completions");
		assert.strictEqual(r.value("provider.openai.backend.type"), "openai-api");
		assert.strictEqual(r.value("provider.openai.backend.openai.apiKey"), "key");
		assert.strictEqual(
			r.value("provider.openai.backend.openai.organizationId"),
			"org",
		);
		assert.strictEqual(
			r.value("provider.openai.backend.openai.projectId"),
			"proj",
		);
		assert.strictEqual(r.value("provider.openai.model.model"), "gpt");
		assert.strictEqual(
			r.value("provider.openai.api.completions.maxCompletionTokens"),
			"=500",
		);
		assert.strictEqual(
			r.value("provider.openai.api.completions.temperature"),
			"=0.2",
		);
		assert.strictEqual(r.value("provider.openai.timeouts.timeout"), "PT1M");
		assert.strictEqual(r.report.lossless, true);
	});

	for (const auth of ["apiKey", "clientCredentials"]) {
		test(`Azure OpenAI with ${auth} moves to the Microsoft Foundry backend`, async () => {
			const r = await run({
				"provider.type": "azureOpenAi",
				"provider.azureOpenAi.endpoint": "https://res.openai.azure.com",
				"provider.azureOpenAi.authentication.type": auth,
				"provider.azureOpenAi.authentication.apiKey": "key",
				"provider.azureOpenAi.authentication.clientId": "client",
				"provider.azureOpenAi.authentication.clientSecret": "secret",
				"provider.azureOpenAi.authentication.tenantId": "tenant",
				"provider.azureOpenAi.authentication.authorityHost": "https://login",
				"provider.azureOpenAi.model.deploymentName": "deployment",
				"provider.azureOpenAi.model.parameters.maxTokens": "300",
				"provider.azureOpenAi.timeouts.timeout": "PT2M",
			});
			const foundry = "provider.openai.backend.foundry";
			assert.strictEqual(r.value("provider.type"), "openai");
			assert.strictEqual(r.value("provider.openai.api.type"), "completions");
			assert.strictEqual(r.value("provider.openai.backend.type"), "foundry");
			assert.strictEqual(
				r.value(`${foundry}.endpoint`),
				"https://res.openai.azure.com",
			);
			assert.strictEqual(r.value(`${foundry}.authentication.type`), auth);
			if (auth === "apiKey") {
				assert.strictEqual(r.value(`${foundry}.authentication.apiKey`), "key");
			} else {
				assert.strictEqual(
					r.value(`${foundry}.authentication.clientId`),
					"client",
				);
				assert.strictEqual(
					r.value(`${foundry}.authentication.clientSecret`),
					"secret",
				);
				assert.strictEqual(
					r.value(`${foundry}.authentication.tenantId`),
					"tenant",
				);
				assert.strictEqual(
					r.value(`${foundry}.authentication.authorityHost`),
					"https://login",
				);
			}
			assert.strictEqual(r.value("provider.openai.model.model"), "deployment");
			assert.strictEqual(
				r.value("provider.openai.api.completions.maxCompletionTokens"),
				"=300",
			);
			assert.strictEqual(r.value("provider.openai.timeouts.timeout"), "PT2M");
			assert.strictEqual(r.report.lossless, true);
		});
	}

	const compat = {
		"provider.type": "openaiCompatible",
		"provider.openaiCompatible.endpoint": "http://localhost:11434/v1",
		"provider.openaiCompatible.model.model": "llama",
	};

	test("OpenAI compatible with an API key moves to the custom backend", async () => {
		const r = await run({
			...compat,
			"provider.openaiCompatible.authentication.apiKey": "key",
			"provider.openaiCompatible.queryParameters": '={"a":"b"}',
			"provider.openaiCompatible.model.parameters.customParameters":
				'={"seed":1}',
			"provider.openaiCompatible.model.parameters.topP": "0.9",
		});
		const custom = "provider.openai.backend.custom";
		assert.strictEqual(r.value("provider.type"), "openai");
		assert.strictEqual(r.value("provider.openai.api.type"), "completions");
		assert.strictEqual(r.value("provider.openai.backend.type"), "custom");
		assert.strictEqual(
			r.value(`${custom}.endpoint`),
			"http://localhost:11434/v1",
		);
		assert.strictEqual(r.value(`${custom}.authentication.type`), "apiKey");
		assert.strictEqual(r.value(`${custom}.authentication.apiKey`), "key");
		assert.strictEqual(r.value(`${custom}.queryParameters`), '={"a":"b"}');
		assert.strictEqual(r.value(`${custom}.bodyProperties`), '={"seed":1}');
		assert.strictEqual(r.value("provider.openai.model.model"), "llama");
		assert.strictEqual(r.value("provider.openai.api.completions.topP"), "=0.9");
		assert.strictEqual(r.report.lossless, true);
	});

	for (const headers of [
		'={"Authorization":"Bearer token","X":"y"}',
		'={"authorization":"Bearer token"}',
		'={\n  X: "y",\n  Authorization: "Bearer token"\n}',
		'={Authorization: "Bearer token"}',
	]) {
		test(`OpenAI compatible keeps the Authorization header in ${JSON.stringify(headers)}`, async () => {
			const r = await run({
				...compat,
				"provider.openaiCompatible.authentication.apiKey": "key",
				"provider.openaiCompatible.headers": headers,
			});
			const custom = "provider.openai.backend.custom";
			assert.strictEqual(r.value(`${custom}.headers`), headers);
			assert.strictEqual(r.value(`${custom}.authentication.type`), "none");
			assert.strictEqual(r.has(`${custom}.authentication.apiKey`), false);
			assert.ok(r.notes.some((n) => n.startsWith("info: The Authorization")));
			assert.deepStrictEqual(
				r.report.skipped.guard.map((g) => g.from),
				["provider.openaiCompatible.authentication.apiKey"],
			);
		});
	}

	test("OpenAI compatible ignores Proxy-Authorization and X-Authorization headers", async () => {
		const headers =
			'={"Proxy-Authorization":"Basic abc","X-Authorization-Id":"1"}';
		const r = await run({
			...compat,
			"provider.openaiCompatible.authentication.apiKey": "key",
			"provider.openaiCompatible.headers": headers,
		});
		const custom = "provider.openai.backend.custom";
		assert.strictEqual(r.value(`${custom}.headers`), headers);
		assert.strictEqual(r.value(`${custom}.authentication.type`), "apiKey");
		assert.strictEqual(r.value(`${custom}.authentication.apiKey`), "key");
		assert.strictEqual(r.report.lossless, true);
	});

	test("OpenAI compatible without credentials uses no authentication", async () => {
		const r = await run(compat);
		assert.strictEqual(
			r.value("provider.openai.backend.custom.authentication.type"),
			"none",
		);
		assert.strictEqual(r.report.lossless, true);
	});

	const anthropic = {
		"provider.type": "anthropic",
		"provider.anthropic.authentication.apiKey": "key",
		"provider.anthropic.model.model": "claude",
		"provider.anthropic.model.parameters.topK": "5",
	};

	test("Anthropic without an endpoint uses the Anthropic API with v2 defaults", async () => {
		const r = await run(anthropic);
		assert.strictEqual(
			r.value("provider.anthropic.backend.type"),
			"anthropic-api",
		);
		assert.strictEqual(
			r.value("provider.anthropic.backend.anthropic.apiKey"),
			"key",
		);
		assert.strictEqual(r.value("provider.anthropic.model.model"), "claude");
		assert.strictEqual(
			r.value("provider.anthropic.model.parameters.topK"),
			"=5",
		);
		assert.strictEqual(
			r.value("provider.anthropic.model.parameters.promptCaching.enabled"),
			"=true",
		);
		assert.strictEqual(
			r.value("provider.anthropic.model.parameters.effort"),
			"modelDefault",
		);
		assert.strictEqual(
			r.value("provider.anthropic.model.parameters.thinking.mode"),
			"modelDefault",
		);
		assert.ok(r.notes.some((n) => n.startsWith("info: Anthropic prompt")));
		assert.strictEqual(r.report.lossless, true);
	});

	for (const host of [
		"https://res.services.ai.azure.com/anthropic/v1",
		"https://res.services.ai.azure.us/anthropic/v1",
		"https://res.services.ai.azure.cn/anthropic/v1",
	]) {
		test(`Anthropic on ${new URL(host).hostname} moves to Microsoft Foundry`, async () => {
			const r = await run({
				...anthropic,
				"provider.anthropic.endpoint": host,
			});
			const foundry = "provider.anthropic.backend.foundry";
			assert.strictEqual(r.value("provider.anthropic.backend.type"), "foundry");
			assert.strictEqual(r.value(`${foundry}.endpoint`), host);
			assert.strictEqual(r.value(`${foundry}.authentication.type`), "apiKey");
			assert.strictEqual(r.value(`${foundry}.authentication.apiKey`), "key");
			assert.ok(r.notes.some((n) => n.startsWith("warning: The Anthropic")));
			assert.strictEqual(r.report.lossless, true);
		});
	}

	test("Anthropic on another endpoint moves to the custom backend", async () => {
		const r = await run({
			...anthropic,
			"provider.anthropic.endpoint": "https://proxy.example.com/v1",
		});
		const custom = "provider.anthropic.backend.custom";
		assert.strictEqual(r.value("provider.anthropic.backend.type"), "custom");
		assert.strictEqual(
			r.value(`${custom}.endpoint`),
			"https://proxy.example.com/v1",
		);
		assert.strictEqual(r.value(`${custom}.authentication.type`), "apiKey");
		assert.strictEqual(r.value(`${custom}.authentication.apiKey`), "key");
		assert.ok(r.notes.some((n) => n.startsWith("warning: The Anthropic")));
		assert.strictEqual(r.report.lossless, true);
	});

	test("Bedrock keeps its settings and enables prompt caching", async () => {
		const r = await run({
			"provider.type": "bedrock",
			"provider.bedrock.region": "eu-west-1",
			"provider.bedrock.authentication.type": "apiKey",
			"provider.bedrock.authentication.apiKey": "key",
			"provider.bedrock.model.model": "anthropic.claude",
			"provider.bedrock.model.parameters.topP": "0.9",
		});
		assert.strictEqual(r.value("provider.type"), "bedrock");
		assert.strictEqual(r.value("provider.bedrock.region"), "eu-west-1");
		assert.strictEqual(
			r.value("provider.bedrock.authentication.apiKey"),
			"key",
		);
		assert.strictEqual(
			r.value("provider.bedrock.model.model"),
			"anthropic.claude",
		);
		assert.strictEqual(
			r.value("provider.bedrock.model.parameters.topP"),
			"=0.9",
		);
		assert.strictEqual(
			r.value("provider.bedrock.model.parameters.promptCaching.enabled"),
			"=true",
		);
		assert.ok(r.notes.some((n) => n.startsWith("info: AWS Bedrock prompt")));
		assert.strictEqual(r.report.lossless, true);
	});

	test("Vertex AI moves to Google Gemini on the Vertex AI backend", async () => {
		const r = await run({
			"provider.type": "google-vertex-ai",
			"provider.googleVertexAi.projectId": "project",
			"provider.googleVertexAi.region": "us-central1",
			"provider.googleVertexAi.endpoint": "https://vertex.example.com",
			"provider.googleVertexAi.authentication.type":
				"serviceAccountCredentials",
			"provider.googleVertexAi.authentication.jsonKey": "json",
			"provider.googleVertexAi.model.model": "gemini",
			"provider.googleVertexAi.model.parameters.maxOutputTokens": "800",
			"provider.googleVertexAi.model.parameters.topK": "40",
			"provider.googleVertexAi.timeouts.timeout": "PT3M",
		});
		const vertex = "provider.googleGemini.backend.googleVertexAi";
		assert.strictEqual(r.value("provider.type"), "google-gemini");
		assert.strictEqual(
			r.value("provider.googleGemini.backend.type"),
			"google-vertex-ai",
		);
		assert.strictEqual(r.value(`${vertex}.projectId`), "project");
		assert.strictEqual(r.value(`${vertex}.region`), "us-central1");
		assert.strictEqual(
			r.value(`${vertex}.endpoint`),
			"https://vertex.example.com",
		);
		assert.strictEqual(
			r.value(`${vertex}.authentication.type`),
			"serviceAccountCredentials",
		);
		assert.strictEqual(r.value(`${vertex}.authentication.jsonKey`), "json");
		assert.strictEqual(r.value("provider.googleGemini.model.model"), "gemini");
		assert.strictEqual(
			r.value("provider.googleGemini.model.parameters.maxTokens"),
			"=800",
		);
		assert.strictEqual(
			r.value("provider.googleGemini.model.parameters.topK"),
			"=40",
		);
		assert.strictEqual(
			r.value("provider.googleGemini.timeouts.timeout"),
			"PT3M",
		);
		assert.ok(r.notes.some((n) => n.startsWith("warning: The custom Vertex")));
		assert.strictEqual(r.report.lossless, true);
	});

	test("carries over agent settings unchanged", async () => {
		const r = await run({
			"provider.type": "bedrock",
			"data.systemPrompt.prompt": '="Be brief."',
			"data.limits.maxModelCalls": "7",
			resultVariable: "answer",
		});
		assert.strictEqual(r.value("data.systemPrompt.prompt"), '="Be brief."');
		assert.strictEqual(r.value("data.limits.maxModelCalls"), "=7");
		assert.strictEqual(r.value("resultVariable"), "answer");
		assert.deepStrictEqual(r.report.dropped, []);
	});

	test("refuses versions below 12, which lack the Vertex AI paths it reads", async () => {
		const refused = await run(
			{ "provider.type": "openai" },
			readTemplate("aiagent-v1-v10.json"),
		);
		assert.match(refused.report.refusal ?? "", /unmet source floor/);
	});
});

describe("ai-agent-subprocess.v2 recipe", () => {
	test("migrates an ad-hoc sub-process", async () => {
		const r = await migrate(
			readTemplate("aiagent-jobworker-v1-v13.json"),
			readTemplate("ai-agent-subprocess-v2-v1.json"),
			"ai-agent-subprocess.v2.recipe.json",
			{
				"provider.type": "openai",
				"provider.openai.authentication.apiKey": "key",
				"data.events.behavior": "INTERRUPT_TOOL_CALLS",
			},
			SUBPROCESS_DIAGRAM,
		);
		assert.strictEqual(r.value("provider.openai.backend.openai.apiKey"), "key");
		assert.strictEqual(r.value("data.events.behavior"), "INTERRUPT_TOOL_CALLS");
		assert.strictEqual(r.report.lossless, true);
	});

	test("the JSON report verifies an Azure OpenAI migration without the BPMN", async () => {
		const source = readTemplate("aiagent-jobworker-v1-v13.json");
		const target = readTemplate("ai-agent-subprocess-v2-v1.json");
		const r = await migrate(
			source,
			target,
			"ai-agent-subprocess.v2.recipe.json",
			{
				"provider.type": "azureOpenAi",
				"provider.azureOpenAi.endpoint": "https://res.openai.azure.com",
				"provider.azureOpenAi.authentication.type": "clientCredentials",
				"provider.azureOpenAi.authentication.clientId": "client",
				"provider.azureOpenAi.authentication.clientSecret": "{{secrets.abc}}",
				"provider.azureOpenAi.authentication.tenantId": "tenant",
				"provider.azureOpenAi.authentication.authorityHost": "a",
				"provider.azureOpenAi.timeouts.timeout": "PT10S",
				"provider.azureOpenAi.model.deploymentName": "deployment",
				"provider.azureOpenAi.model.parameters.maxTokens": "=1024",
				"provider.azureOpenAi.model.parameters.temperature": "=1",
				"provider.azureOpenAi.model.parameters.topP": "=10",
				"data.userPrompt.prompt": "=userRequest",
			},
			SUBPROCESS_DIAGRAM,
		);
		const json = reportToJson(r.report, {
			elementId: "Task_1",
			recipe: "file",
			dryRun: true,
			redaction: { templates: [source, target] },
		});
		const { moved, added, kept } = json.report;
		for (const item of moved) {
			assert.strictEqual(item.source, "recipe", item.to.key);
			if (item.value !== "[REDACTED]")
				assert.strictEqual(item.value, r.value(item.to.key), item.to.key);
		}
		const movedTo = (key: string) => moved.find((m) => m.to.key === key);
		assert.strictEqual(
			movedTo("provider.openai.api.completions.maxCompletionTokens")?.value,
			"=1024",
		);
		assert.deepStrictEqual(
			[
				movedTo("provider.openai.model.model")?.to.group,
				movedTo("provider.openai.model.model")?.to.groupLabel,
			],
			["model", "Model"],
		);
		assert.strictEqual(
			movedTo("provider.openai.backend.foundry.authentication.clientSecret")
				?.value,
			"[REDACTED]",
		);
		const sourceOf = (key: string) => added.find((a) => a.key === key)?.source;
		assert.strictEqual(
			sourceOf("provider.openai.api.completions.effort"),
			"default",
		);
		assert.strictEqual(sourceOf("provider.openai.api.type"), "recipe");
		assert.strictEqual(sourceOf("provider.openai.backend.type"), "recipe");
		assert.ok(kept.some((k) => k.key === "data.userPrompt.prompt"));
		assert.deepStrictEqual(json.counts, {
			moved: moved.length,
			added: added.length,
			changed: json.report.changed.length,
			dropped: json.report.dropped.length,
			kept: kept.length,
		});
		// Target template order: provider settings come before model options.
		const index = (key: string) => moved.findIndex((m) => m.to.key === key);
		assert.ok(
			index("provider.openai.timeouts.timeout") <
				index("provider.openai.api.completions.maxCompletionTokens"),
		);
	});
});

describe("hybrid recipes", () => {
	for (const [kind, from, to, recipe, xml, v1Type, v2Type] of [
		[
			"task",
			"aiagent-v1-hybrid-v13.json",
			"ai-agent-task-v2-hybrid-v1.json",
			"ai-agent-task.v2-hybrid.recipe.json",
			DIAGRAM,
			"io.camunda.agenticai:aiagent:1",
			"io.camunda.agenticai:aiagent:task:2",
		],
		[
			"sub-process",
			"aiagent-jobworker-v1-hybrid-v13.json",
			"ai-agent-subprocess-v2-hybrid-v1.json",
			"ai-agent-subprocess.v2-hybrid.recipe.json",
			SUBPROCESS_DIAGRAM,
			"io.camunda.agenticai:aiagent-job-worker:1",
			"io.camunda.agenticai:aiagent:subprocess:2",
		],
	]) {
		const run = (values: Record<string, string>) =>
			migrate(readTemplate(from), readTemplate(to), recipe, values, xml);

		// Template application, not the recipe, decides the job type.
		test(`${kind}: replaces the default v1 job type with the v2 default`, async () => {
			const r = await run({
				"provider.type": "openai",
				"provider.openai.authentication.apiKey": "key",
				"taskDefinition:type": v1Type,
			});
			assert.strictEqual(r.jobType, v2Type);
			assert.strictEqual(
				r.value("provider.openai.backend.openai.apiKey"),
				"key",
			);
		});

		test(`${kind}: keeps a custom job type`, async () => {
			const r = await run({
				"provider.type": "bedrock",
				"taskDefinition:type": "my-team:agent",
			});
			assert.strictEqual(r.jobType, "my-team:agent");
		});
	}
});

test("all four recipes share the same rules", () => {
	const paths = (name: string) => readRecipe(name).sources[0].paths;
	const reference = paths("ai-agent-task.v2.recipe.json");
	for (const name of [
		"ai-agent-subprocess.v2.recipe.json",
		"ai-agent-task.v2-hybrid.recipe.json",
		"ai-agent-subprocess.v2-hybrid.recipe.json",
	]) {
		assert.deepStrictEqual(paths(name), reference, name);
	}
});
