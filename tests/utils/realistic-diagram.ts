/**
 * Shared setup for element-template tests that run on real released templates
 * and tests/fixtures/realistic-collaboration.bpmn.
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeTestEnv } from "./mocks.ts";
import { asyncSpawn } from "./spawn.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const CLI = join(ROOT, "src/index.ts");
const FIXTURES = join(ROOT, "tests/fixtures");
const TEMPLATES = join(FIXTURES, "element-templates");

export const REALISTIC_DIAGRAM = join(FIXTURES, "realistic-collaboration.bpmn");
export const HTTP = "io.camunda.connectors.HttpJson.v2";
export const AGENT_V1 = "io.camunda.connectors.agenticai.aiagent.v1";
export const AGENT_V2 = "io.camunda.connectors.agenticai.aiagent.v2";

/** Every template fixture, as the cache would hold it. */
export const TEMPLATE_FIXTURES = [
	"http-json-connector-v10.json",
	"http-json-connector-v12.json",
	"http-json-connector-v17.json",
	"aiagent-v1-v10.json",
	"aiagent-v1-v11.json",
	"aiagent-v2-derived.json",
];

export const readTemplate = (name: string) =>
	JSON.parse(readFileSync(join(TEMPLATES, name), "utf-8"));

export function writeTemplateCache(dir: string, names = TEMPLATE_FIXTURES) {
	mkdirSync(join(dir, "element-templates"), { recursive: true });
	writeFileSync(
		join(dir, "element-templates/templates.json"),
		JSON.stringify(names.map(readTemplate)),
	);
}

/**
 * Copy the realistic diagram to `<dir>/process.bpmn` and turn five of its
 * plain tasks into templated elements: HttpJson at versions 10, 12, 17 and 10
 * again, and AI Agent v1 at version 10. Returns the file path.
 */
export async function writeTemplatedDiagram(dir: string): Promise<string> {
	const bpmn = join(dir, "process.bpmn");
	copyFileSync(REALISTIC_DIAGRAM, bpmn);
	// Each apply prints the whole diagram, so feed it back as the next input.
	for (const [file, id, sets] of [
		[
			"http-json-connector-v10.json",
			"Task_Http10",
			[
				"method=GET",
				"url=https://api.example.com/customers",
				"authentication.type=noAuth",
				"storeResponse=true",
			],
		],
		[
			"http-json-connector-v12.json",
			"Task_Http12",
			[
				"method=POST",
				"url=https://api.example.com/prices",
				"authentication.type=bearer",
				"authentication.token=secrets.PRICES",
			],
		],
		[
			"http-json-connector-v17.json",
			"Task_Http17",
			[
				"method=PUT",
				"url=https://partner.example.com/notify",
				"authentication.type=noAuth",
			],
		],
		[
			"http-json-connector-v10.json",
			"Task_Http10b",
			[
				"method=DELETE",
				"url=https://partner.example.com/data",
				"authentication.type=noAuth",
			],
		],
		[
			"aiagent-v1-v10.json",
			"Task_Agent",
			["provider.type=openai", "data.limits.maxModelCalls=7"],
		],
	] as const) {
		const applied = await asyncSpawn(
			"node",
			[
				CLI,
				"element-template",
				"apply",
				join(TEMPLATES, file),
				id,
				bpmn,
				...sets.flatMap((set) => ["--set", set]),
			],
			{
				cwd: ROOT,
				env: makeTestEnv({ C8CTL_DATA_DIR: dir }),
				timeout: 30_000,
			},
		);
		if (applied.status !== 0) {
			throw new Error(`apply ${id} failed: ${applied.stderr}`);
		}
		writeFileSync(bpmn, applied.stdout);
	}
	return bpmn;
}
