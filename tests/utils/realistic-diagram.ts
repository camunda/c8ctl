/**
 * Shared setup for element-template tests that run on the synthetic templates in
 * tests/fixtures/element-templates/ and tests/fixtures/realistic-collaboration.bpmn.
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
export const REST = "io.example.rest";
export const AGENT_V1 = "io.example.agent.v1";
export const AGENT_V2 = "io.example.agent.v2";

/** Every template fixture, as the cache would hold it. */
export const TEMPLATE_FIXTURES = [
	"rest-v10.json",
	"rest-v12.json",
	"rest-v17.json",
	"agent-v1-v10.json",
	"agent-v1-v11.json",
	"agent-v2-v1.json",
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
 * plain tasks into templated elements: REST at versions 10, 12, 17 and 10
 * again, and agent v1 at version 10. Returns the file path.
 */
export async function writeTemplatedDiagram(dir: string): Promise<string> {
	const bpmn = join(dir, "process.bpmn");
	copyFileSync(REALISTIC_DIAGRAM, bpmn);
	// Each apply prints the whole diagram, so feed it back as the next input.
	for (const [file, id, sets] of [
		[
			"rest-v10.json",
			"Task_Http10",
			[
				"method=GET",
				"url=https://api.example.com/customers",
				"authentication.type=noAuth",
				"keepBody=true",
			],
		],
		[
			"rest-v12.json",
			"Task_Http12",
			[
				"method=POST",
				"url=https://api.example.com/prices",
				"authentication.type=bearer",
				"authentication.token=secrets.PRICES",
			],
		],
		[
			"rest-v17.json",
			"Task_Http17",
			[
				"method=PUT",
				"url=https://partner.example.com/notify",
				"authentication.type=noAuth",
			],
		],
		[
			"rest-v10.json",
			"Task_Http10b",
			[
				"method=DELETE",
				"url=https://partner.example.com/data",
				"authentication.type=noAuth",
			],
		],
		[
			"agent-v1-v10.json",
			"Task_Agent",
			["provider.type=alpha", "limits.maxRounds=7"],
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
