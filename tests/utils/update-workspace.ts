/**
 * Fixtures and a per-file workspace for the `element-template update` CLI tests.
 */

import assert from "node:assert";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { c8WithOptions } from "./cli.ts";
import { input, seedTemplateCache } from "./element-template.ts";

export const FIXTURE_BPMN = join(
	resolve(import.meta.dirname, "..", "fixtures"),
	"simple.bpmn",
);
export const TASK = "Activity_17s7axj";

export const OLD = {
	id: "io.example.old",
	name: "Old connector",
	version: 1,
	deprecated: true,
	appliesTo: ["bpmn:Task"],
	engines: { camunda: "^8.8" },
	groups: [{ id: "model", label: "Model" }],
	properties: [
		{
			type: "Hidden",
			value: "io.example.old",
			binding: { type: "zeebe:taskDefinition", property: "type" },
		},
		input("provider", "azure", { label: "Provider", group: "model" }),
		input("endpoint", "", { label: "Endpoint", group: "model" }),
		input("maxTokens", "", { label: "Maximum tokens", group: "model" }),
	],
};

export const NEW = {
	id: "io.example.new",
	name: "New connector",
	version: 1,
	appliesTo: ["bpmn:Task"],
	engines: { camunda: "^8.8" },
	groups: [{ id: "model", label: "Model" }],
	metadata: {
		migratesFrom: {
			schemaVersion: 1,
			sources: [
				{
					kind: "change",
					sourceTemplateId: "io.example.old",
					paths: [
						{ from: "provider", to: "backend.provider" },
						{ from: "endpoint", to: "backend.endpoint" },
						{
							to: "backend.type",
							set: "foundry",
							note: { level: "warning", message: "Backend chosen for you" },
						},
					],
				},
			],
		},
	},
	properties: [
		{
			type: "Hidden",
			value: "io.example.new",
			binding: { type: "zeebe:taskDefinition", property: "type" },
		},
		input("backend.provider", "", { label: "Provider", group: "model" }),
		input("backend.endpoint", "", { label: "API endpoint", group: "model" }),
		input("backend.type", "", { label: "Backend", group: "model" }),
		input("effort", "default", { label: "Effort", group: "model" }),
	],
};

export const V2 = {
	...OLD,
	id: "io.example.versioned",
	name: "Versioned connector",
	version: 2,
	deprecated: undefined,
	engines: { camunda: "^8.8" },
	metadata: {
		migratesFrom: {
			schemaVersion: 1,
			sources: [
				{
					kind: "upgrade",
					sourceTemplateId: "io.example.versioned",
					toVersion: 2,
					paths: [{ from: "endpoint", to: "url" }],
				},
			],
		},
	},
	properties: [
		{
			type: "Hidden",
			value: "io.example.versioned",
			binding: { type: "zeebe:taskDefinition", property: "type" },
		},
		input("provider", "azure", { label: "Provider", group: "model" }),
		input("url", "", { label: "URL", group: "model" }),
	],
};
export const V1 = {
	...OLD,
	id: "io.example.versioned",
	name: "Versioned connector",
	version: 1,
	deprecated: undefined,
	engines: { camunda: "^8.8" },
	properties: [
		{
			type: "Hidden",
			value: "io.example.versioned",
			binding: { type: "zeebe:taskDefinition", property: "type" },
		},
		input("provider", "azure", { label: "Provider", group: "model" }),
		input("endpoint", "", { label: "Endpoint", group: "model" }),
	],
};
export const V3 = { ...V2, version: 3, metadata: undefined };
export const SRC = {
	...OLD,
	id: "io.example.mapsrc",
	name: "Map source",
	deprecated: undefined,
	properties: [
		{
			type: "Hidden",
			value: "io.example.mapsrc",
			binding: { type: "zeebe:taskDefinition", property: "type" },
		},
		input("provider", "azure", { label: "Provider", group: "model" }),
		input("endpoint", "", { label: "Endpoint", group: "model" }),
	],
};
export const DST = {
	...NEW,
	id: "io.example.mapdst",
	name: "Map destination",
	metadata: undefined,
	properties: [
		{
			type: "Hidden",
			value: "io.example.mapdst",
			binding: { type: "zeebe:taskDefinition", property: "type" },
		},
		input("provider", "azure", { label: "Provider", group: "model" }),
		input("url", "", { label: "URL", group: "model" }),
	],
};

/** simple.bpmn plus extra tasks, each with a shape so the modeler registers it. */
function multiTaskXml(): string {
	const tasks = ["Task_B", "Task_C", "Task_X"];
	return readFileSync(FIXTURE_BPMN, "utf-8")
		.replace(
			"</bpmn:process>",
			`${tasks.map((id) => `<bpmn:task id="${id}" />`).join("")}</bpmn:process>`,
		)
		.replace(
			"</bpmndi:BPMNPlane>",
			`${tasks
				.map(
					(id, i) =>
						`<bpmndi:BPMNShape id="${id}_di" bpmnElement="${id}"><dc:Bounds x="270" y="${200 + i * 100}" width="100" height="80" /></bpmndi:BPMNShape>`,
				)
				.join("")}</bpmndi:BPMNPlane>`,
		);
}

export function taskXml(xml: string, id: string): string {
	const match = xml.match(
		new RegExp(`<bpmn:task id="${id}"(?:[^>]*/>|[\\s\\S]*?</bpmn:task>)`),
	);
	assert.ok(match, `task ${id} not found`);
	return match[0];
}

export function versionOf(xml: string, id: string): string | undefined {
	return taskXml(xml, id).match(/modelerTemplateVersion="(\d+)"/)?.[1];
}

/** The fixtures above as one object, for destructuring inside a describe scope. */
export const updateFixtures = {
	TASK,
	OLD,
	NEW,
	V1,
	V2,
	V3,
	SRC,
	DST,
	FIXTURE_BPMN,
};

/** Temp dirs, seeded diagrams and CLI runners for one test file. */
export function createUpdateWorkspace() {
	const cleanups: string[] = [];
	const ws = {
		workDir: "",
		oldBpmn: "",
		versionedBpmn: "",
	};

	function dataDirWithCache(templates: object[]): string {
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-migrate-data-"));
		cleanups.push(dataDir);
		seedTemplateCache(dataDir, templates);
		return dataDir;
	}

	function run(dataDir: string, ...args: string[]) {
		return c8WithOptions(
			{ env: { C8CTL_DATA_DIR: dataDir } },
			"element-template",
			...args,
		);
	}

	function runWithPreload(dataDir: string, preload: string, args: string[]) {
		return c8WithOptions(
			{ env: { C8CTL_DATA_DIR: dataDir }, nodeArgs: ["--require", preload] },
			"element-template",
			...args,
		);
	}

	function failingSaveXmlPreload(): string {
		const bundle = resolve(
			import.meta.dirname,
			"..",
			"..",
			"dist",
			"vendor",
			"bpmn-element-templates.cjs",
		);
		const preload = join(ws.workDir, "fail-save-xml.cjs");
		writeFileSync(
			preload,
			`const v = require(${JSON.stringify(bundle)});
v.Modeler.prototype.saveXML = () => Promise.reject(new Error("saveXML must not run"));
`,
		);
		return preload;
	}

	async function seedBpmn(
		template: object,
		values: string[],
		name: string,
	): Promise<string> {
		const templatePath = join(ws.workDir, `${name}.template.json`);
		writeFileSync(templatePath, JSON.stringify(template));
		const dataDir = dataDirWithCache([]);
		const result = await run(
			dataDir,
			"apply",
			templatePath,
			TASK,
			FIXTURE_BPMN,
			...values.flatMap((v) => ["--set", v]),
		);
		assert.strictEqual(result.status, 0, result.stderr);
		const out = join(ws.workDir, `${name}.bpmn`);
		writeFileSync(out, result.stdout);
		return out;
	}

	/** Applies each template to its element, one `apply` per element, and returns the file. */
	async function seedMulti(
		name: string,
		applications: [elementId: string, template: object, values: string[]][],
	): Promise<string> {
		const file = join(ws.workDir, `${name}.bpmn`);
		writeFileSync(file, multiTaskXml());
		for (const [
			index,
			[elementId, template, values],
		] of applications.entries()) {
			const templatePath = join(ws.workDir, `${name}.${index}.template.json`);
			writeFileSync(templatePath, JSON.stringify(template));
			const result = await run(
				dataDirWithCache([]),
				"apply",
				templatePath,
				elementId,
				file,
				...values.flatMap((v) => ["--set", v]),
			);
			assert.strictEqual(result.status, 0, result.stderr);
			writeFileSync(file, result.stdout);
		}
		return file;
	}

	function copyOf(
		file: string,
		name: string,
	): { copy: string; before: string } {
		const copy = join(ws.workDir, name);
		const before = readFileSync(file, "utf-8");
		writeFileSync(copy, before);
		return { copy, before };
	}

	/** Create the work dir and the two seeded diagrams; call from `before`. */
	async function setup(): Promise<void> {
		ws.workDir = mkdtempSync(join(tmpdir(), "c8ctl-migrate-"));
		cleanups.push(ws.workDir);
		ws.oldBpmn = await seedBpmn(
			OLD,
			["provider=azure", "endpoint=https://x", "maxTokens=2000"],
			"old",
		);
		ws.versionedBpmn = await seedBpmn(
			V1,
			["provider=azure", "endpoint=https://v1"],
			"v1",
		);
	}

	/** Remove every temp dir; call from `after`. */
	function teardown(): void {
		for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
	}

	/** Remove and assert; register as the last test of a file. */
	function assertCleanedUp(): void {
		teardown();
		for (const dir of cleanups)
			assert.strictEqual(
				existsSync(dir),
				false,
				`temp dir left behind: ${dir}`,
			);
	}

	return {
		ws,
		dataDirWithCache,
		run,
		runWithPreload,
		failingSaveXmlPreload,
		seedBpmn,
		seedMulti,
		copyOf,
		setup,
		teardown,
		assertCleanedUp,
	};
}
