/**
 * Opt-in check that `update` migrates the real AI Agent v1 templates to v2
 * through the recipes the v2 templates embed. Set C8CTL_FIDELITY=1 to run it.
 *
 * The templates are fetched from camunda/connectors at run time. They MUST NOT
 * be committed: they are not under a license compatible with c8ctl's.
 */

import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { c8WithOptions } from "../utils/cli.ts";
import { DIAGRAM } from "../utils/element-template.ts";

// Head of camunda/connectors#9430. Re-pin to its merge commit once it lands.
const REF = "43fa2216f96dd52493ea05159afed98e11199bbb";
const BASE = `https://raw.githubusercontent.com/camunda/connectors/${REF}/connectors/agentic-ai/connector-agentic-ai/element-templates`;
const FILES = [
	"agenticai-aiagent-outbound-connector.json",
	"agenticai-aiagent-job-worker.json",
	"agenticai-ai-agent-task.v2.json",
	"agenticai-ai-agent-subprocess.v2.json",
];

const SUBPROCESS_DIAGRAM = DIAGRAM.replace(
	'<bpmn:serviceTask id="Task_1" />',
	'<bpmn:subProcess id="Task_1" />',
).replace('bpmnElement="Task_1">', 'bpmnElement="Task_1" isExpanded="true">');

describe("AI Agent v1 to v2 on the upstream templates", {
	skip: process.env.C8CTL_FIDELITY !== "1" && "set C8CTL_FIDELITY=1 to run",
}, () => {
	let dir = "";
	const run = (...args: string[]) =>
		c8WithOptions(
			{ env: { C8CTL_DATA_DIR: dir }, timeout: 60_000 },
			"element-template",
			...args,
		);

	before(async () => {
		dir = mkdtempSync(join(tmpdir(), "c8-migration-fidelity-"));
		const templates = await Promise.all(
			FILES.map(async (file) => {
				const response = await fetch(`${BASE}/${file}`);
				assert.ok(response.ok, `${file}: HTTP ${response.status}`);
				const text = await response.text();
				writeFileSync(join(dir, file), text);
				return JSON.parse(text);
			}),
		);
		mkdirSync(join(dir, "element-templates"));
		writeFileSync(
			join(dir, "element-templates/templates.json"),
			JSON.stringify(templates),
		);
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	for (const [kind, diagram, source, from, to] of [
		[
			"task",
			DIAGRAM,
			"agenticai-aiagent-outbound-connector.json",
			"io.camunda.connectors.agenticai.aiagent.v1",
			"io.camunda.connectors.agenticai.ai-agent-task.v2",
		],
		[
			"sub-process",
			SUBPROCESS_DIAGRAM,
			"agenticai-aiagent-job-worker.json",
			"io.camunda.connectors.agenticai.aiagent.jobworker.v1",
			"io.camunda.connectors.agenticai.ai-agent-subprocess.v2",
		],
	]) {
		test(`${kind}: an OpenAI agent migrates through the embedded recipe`, async () => {
			const bpmn = join(dir, `${kind}.bpmn`);
			writeFileSync(bpmn, diagram);
			const applied = await run(
				"apply",
				join(dir, source),
				"Task_1",
				bpmn,
				"--set",
				"provider.type=openai",
				"--set",
				"provider.openai.authentication.apiKey=key",
				"--set",
				"provider.openai.model.model=model",
			);
			assert.equal(applied.status, 0, applied.stderr);
			writeFileSync(bpmn, applied.stdout);

			const result = await run(
				"update",
				from,
				"Task_1",
				bpmn,
				"--to",
				to,
				"--in-place",
				"--json",
			);
			assert.equal(result.status, 0, result.stderr);
			const [element] = JSON.parse(result.stdout).results;
			assert.equal(element.status, "updated");
			assert.equal(element.to.id, to);
			assert.equal(element.recipe.source, "embedded");
			assert.equal(element.recipe.used, true);
			assert.match(
				readFileSync(bpmn, "utf-8"),
				/target="provider\.openai\.backend\.openai\.apiKey"/,
			);
		});
	}
});
