import assert from "node:assert/strict";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import {
	labelledInput as input,
	seedTemplateCache,
	template,
} from "../utils/element-template.ts";
import { makeTestEnv } from "../utils/mocks.ts";
import {
	AGENT_V1,
	AGENT_V2,
	HTTP,
	TEMPLATE_FIXTURES,
	writeTemplateCache,
	writeTemplatedDiagram,
} from "../utils/realistic-diagram.ts";
import { asyncSpawn, asyncSpawnWithStdin } from "../utils/spawn.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const CLI = join(ROOT, "src/index.ts");
const FIXTURES = join(ROOT, "tests/fixtures");
const CLI_TIMEOUT = 30_000;
const TASK = "Activity_17s7axj";
const FIXTURE = join(FIXTURES, "simple.bpmn");
const cliEnv = (dir: string) =>
	makeTestEnv({
		C8CTL_DATA_DIR: dir,
		CAMUNDA_BASE_URL: "http://test-cluster/v2",
	});
const spawnCli = (dir: string, args: string[]) =>
	asyncSpawn("node", [CLI, ...args], {
		cwd: ROOT,
		env: cliEnv(dir),
		timeout: CLI_TIMEOUT,
	});
test("simple recipe CLI integration: serialization, reports, authorization and repeated no-op", async () => {
	const dir = mkdtempSync(join(tmpdir(), "c8-migration-simple-"));
	const run = (...args: string[]) =>
		spawnCli(dir, ["element-template", ...args]);
	try {
		const old = template("simple-old", 1, [
			input("a", "preserve"),
			input("keep", "carried"),
			input("drop", "remove"),
			input("empty"),
		]);
		const target = template(
			"simple-new",
			1,
			[input("b"), input("keep", "target-default"), input("empty")],
			[
				{
					kind: "change",
					sourceTemplateId: old.id,
					paths: [{ from: "input:a", to: "input:b" }],
				},
			],
		);
		seedTemplateCache(dir, [old, target]);
		const oldPath = join(dir, "old.json");
		const targetPath = join(dir, "target.json");
		const bpmn = join(dir, "process.bpmn");
		writeFileSync(oldPath, JSON.stringify(old));
		writeFileSync(targetPath, JSON.stringify(target));
		const seeded = await run("apply", oldPath, TASK, FIXTURE);
		assert.equal(seeded.status, 0, seeded.stderr);
		writeFileSync(bpmn, seeded.stdout);
		const dry = await run(
			"update",
			old.id,
			TASK,
			bpmn,
			"--to",
			targetPath,
			"--in-place",
			"--dry-run",
			"--json",
		);
		// A lossy preview exits 1 because the equivalent --in-place run is blocked.
		assert.equal(dry.status, 1, dry.stderr);
		const previewDoc = JSON.parse(dry.stdout);
		assert.equal(previewDoc.summary.blocked, 1);
		const preview = previewDoc.results[0];
		assert.equal(preview.requiresAuthorization, true);
		assert.equal(preview.report.dropped[0].key, "drop");
		assert.equal(readFileSync(bpmn, "utf-8"), seeded.stdout);
		const refused = await run(
			"update",
			old.id,
			TASK,
			bpmn,
			"--to",
			targetPath,
			"--in-place",
		);
		assert.notEqual(refused.status, 0);
		assert.equal(readFileSync(bpmn, "utf-8"), seeded.stdout);
		const changed = await run(
			"update",
			old.id,
			TASK,
			bpmn,
			"--to",
			targetPath,
			"--in-place",
			"--allow-lossy",
			"--json",
		);
		assert.equal(changed.status, 0, changed.stderr);
		const migrated = readFileSync(bpmn, "utf-8");
		assert.match(migrated, /source="preserve" target="b"/);
		assert.match(migrated, /source="carried" target="keep"/);
		assert.match(migrated, /source="" target="empty"/);
		assert.doesNotMatch(migrated, /target="drop"/);
		const piped = await asyncSpawnWithStdin(
			"node",
			[CLI, "element-template", "update", old.id, TASK, "--to", targetPath],
			(stdin) => {
				stdin.write(seeded.stdout);
			},
			{ cwd: ROOT, env: cliEnv(dir), timeout: CLI_TIMEOUT },
		);
		assert.equal(piped.status, 0, piped.stderr);
		assert.equal(piped.stdout, migrated);
		assert.match(piped.stderr, /drop/);
		const properties = await run("get-properties", targetPath, "--json");
		assert.equal(properties.status, 0, properties.stderr);
		const inspected = await run("edit", TASK, bpmn, "--set", "b=preserve");
		assert.equal(inspected.status, 0, inspected.stderr);
		assert.match(inspected.stdout, /source="preserve" target="b"/);
		const formatted = await spawnCli(dir, ["bpmn", "format", bpmn]);
		assert.equal(formatted.status, 0, formatted.stderr);
		assert.equal(formatted.stdout, migrated);
		assert.match(migrated, /name="Do Something"/);
		assert.match(migrated, /sourceRef="StartEvent_1"/);
		const noop = await run(
			"update",
			target.id,
			TASK,
			bpmn,
			"--in-place",
			"--json",
		);
		assert.equal(noop.status, 0, noop.stderr);
		assert.equal(JSON.parse(noop.stdout).results[0].noop, true);
		assert.equal(readFileSync(bpmn, "utf-8"), migrated);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("complex recipe CLI integration: source upgrades, floors, nested guards and conditional values", async () => {
	const dir = mkdtempSync(join(tmpdir(), "c8-migration-complex-"));
	const run = (...args: string[]) =>
		spawnCli(dir, ["element-template", ...args]);
	try {
		const source1 = template("chain", 1, [
			input("a", "azure"),
			input("host", "https://example.com"),
			input("expr", "=order.provider", { feel: "optional" }),
		]);
		const source2 = template("chain", 2, [
			input("b"),
			input("host"),
			input("expr", "", { feel: "optional" }),
		]);
		const source3 = template(
			"chain",
			3,
			[input("c"), input("host"), input("expr", "", { feel: "optional" })],
			[
				{
					kind: "upgrade",
					sourceTemplateId: "chain",
					toVersion: 3,
					paths: [{ from: "b", to: "c" }],
				},
				{
					kind: "upgrade",
					sourceTemplateId: "chain",
					toVersion: 2,
					paths: [{ from: "a", to: "b" }],
				},
				{ kind: "change", sourceTemplateId: "unrelated" },
			],
		);
		const target = template(
			"final",
			1,
			[
				input("provider"),
				input("url"),
				input("kind", "off", { id: "kind" }),
				input("child", "", { condition: { property: "kind", equals: "on" } }),
				input("expr", "", { feel: "optional" }),
				input("fallback"),
				input("unmatched", "default"),
				input("missing", "default"),
			],
			[
				{
					kind: "change",
					sourceTemplateId: "chain",
					paths: [{ to: "provider", set: "wrong-floor" }],
				},
				{
					kind: "change",
					sourceTemplateId: "chain",
					minSourceVersion: 5,
					paths: [{ to: "provider", set: "unreachable" }],
				},
				{
					kind: "change",
					sourceTemplateId: "chain",
					minSourceVersion: 3,
					paths: [
						{
							when: [
								{ path: "c", equals: "azure" },
								{ path: "c", matches: "a*" },
								{ path: "c", in: ["azure"] },
								{ path: "absent", exists: false },
							],
							rules: [
								{
									from: "input:c",
									to: "input:provider",
									valueMap: {
										rules: [{ match: "az*", value: "openai" }],
										default: "other",
									},
									note: { level: "warning", message: "Provider translated" },
								},
								{
									when: { path: "c", equals: "other", not: true },
									rules: [
										{ to: "kind", set: "on" },
										{ from: "c", to: "child", note: "Child migrated" },
									],
								},
								{ to: "url", template: `\${host}/\${c}` },
							],
						},
						{
							from: "expr",
							to: "expr",
							valueMap: { rules: [{ match: "*", value: "incorrect" }] },
						},
						{
							from: "c",
							to: "fallback",
							valueMap: {
								rules: [{ match: "no", value: "no" }],
								default: "fallback",
							},
							when: [
								{ path: "c", matches: "z*", not: true },
								{ path: "c", in: ["no"], not: true },
								{ path: "host", exists: true },
							],
						},
						{
							from: "c",
							to: "unmatched",
							valueMap: { rules: [{ match: "no", value: "no" }] },
						},
						{ to: "missing", template: `\${absent}` },
					],
				},
			],
		);
		seedTemplateCache(dir, [source1, source2, source3, target]);
		const oldPath = join(dir, "old.json");
		const targetPath = join(dir, "target.json");
		const recipePath = join(dir, "recipe.json");
		const bpmn = join(dir, "process.bpmn");
		writeFileSync(oldPath, JSON.stringify(source1));
		writeFileSync(targetPath, JSON.stringify(target));
		writeFileSync(recipePath, JSON.stringify(target.metadata?.migratesFrom));
		const seeded = await run("apply", oldPath, TASK, FIXTURE);
		assert.equal(seeded.status, 0, seeded.stderr);
		writeFileSync(bpmn, seeded.stdout);
		for (const recipeArgs of [[], ["--recipe", recipePath]]) {
			const preview = await run(
				"update",
				source1.id,
				TASK,
				bpmn,
				"--to",
				targetPath,
				...recipeArgs,
				"--dry-run",
				"--json",
			);
			// The migration drops values, so the equivalent write would be blocked.
			assert.equal(preview.status, 1, preview.stderr);
			const previewDoc = JSON.parse(preview.stdout);
			assert.equal(previewDoc.summary.blocked, 1);
			const report = previewDoc.results[0].report;
			assert.equal(report.skipped.feel.length, 1, preview.stdout);
			assert.equal(report.skipped.noMatch.length, 1);
			assert.equal(report.skipped.template.length, 1);
			assert.ok(
				report.moved.some(
					(item: { from: { key: string }; to: { key: string } }) =>
						item.from.key === "a" && item.to.key === "provider",
				),
			);
			const changed = await run(
				"update",
				source1.id,
				TASK,
				bpmn,
				"--to",
				targetPath,
				...recipeArgs,
			);
			assert.equal(changed.status, 0, changed.stderr);
			writeFileSync(join(dir, "result.bpmn"), changed.stdout);
			const reparsed = await spawnCli(dir, [
				"bpmn",
				"format",
				join(dir, "result.bpmn"),
			]);
			assert.equal(reparsed.status, 0, reparsed.stderr);
			for (const [name, value] of [
				["provider", "openai"],
				["url", "https://example.com/azure"],
				["child", "azure"],
				["kind", "on"],
				["expr", "=order.provider"],
				["fallback", "fallback"],
			]) {
				assert.ok(
					reparsed.stdout.includes(`source="${value}" target="${name}"`),
					`${name}: ${reparsed.stdout}`,
				);
			}
			assert.doesNotMatch(reparsed.stdout, /wrong-floor|unreachable|incorrect/);
			assert.equal(readFileSync(bpmn, "utf-8"), seeded.stdout);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// Elements that no scenario migrates: they must come back byte-identical.
const UNRELATED = [
	"Start_Order",
	"Boundary_Timeout",
	"Task_Plain",
	"End_Order",
	"End_Timeout",
	"Partner_Start",
	"Partner_End",
];
const ALL_TEMPLATED = [
	"Task_Http10",
	"Task_Http12",
	"Task_Http17",
	"Task_Http10b",
	"Task_Agent",
];

function elementXml(xml: string, id: string): string {
	const match = xml.match(
		new RegExp(`<bpmn:(\\w+) id="${id}"[\\s\\S]*?</bpmn:\\1>`),
	);
	assert.ok(match, `element ${id} not found`);
	return match[0];
}

function templateOf(xml: string, id: string) {
	const element = elementXml(xml, id);
	return {
		id: element.match(/zeebe:modelerTemplate="([^"]+)"/)?.[1],
		version: element.match(/zeebe:modelerTemplateVersion="(\d+)"/)?.[1],
	};
}

function inputOf(xml: string, id: string, target: string) {
	return elementXml(xml, id).match(
		new RegExp(`<zeebe:input source="([^"]*)" target="${target}" />`),
	)?.[1];
}

function assertUntouched(before: string, after: string, ids: string[]) {
	for (const id of [...ids, ...UNRELATED]) {
		assert.equal(elementXml(after, id), elementXml(before, id), id);
	}
	// A migrated element's shape moves to the end of the diagram, so order is ignored.
	const shapes = (xml: string) =>
		(
			xml.match(
				/<bpmndi:BPMN(?:Shape|Edge)\b[\s\S]*?<\/bpmndi:BPMN(?:Shape|Edge)>/g,
			) ?? []
		).sort();
	assert.deepEqual(shapes(after), shapes(before));
	for (const pattern of [
		/<bpmn:collaboration\b[\s\S]*?<\/bpmn:collaboration>/,
		/<bpmn:message\b[^>]*\/>/,
		/<bpmn:sequenceFlow[^>]*\/>/g,
	]) {
		assert.deepEqual(
			[...(after.match(pattern) ?? [])],
			[...(before.match(pattern) ?? [])],
			String(pattern),
		);
	}
}

describe("element-template update on real templates and a realistic diagram", () => {
	const dirs: string[] = [];
	let templated: string;

	function workspace(cache = TEMPLATE_FIXTURES) {
		const dir = mkdtempSync(join(tmpdir(), "c8-migration-scenario-"));
		dirs.push(dir);
		writeTemplateCache(dir, cache);
		const bpmn = join(dir, "process.bpmn");
		writeFileSync(bpmn, templated);
		return {
			dir,
			bpmn,
			run: (...args: string[]) => spawnCli(dir, ["element-template", ...args]),
			leftovers: () =>
				readdirSync(dir).filter(
					(name) => name.endsWith(".tmp") || name.endsWith(".lock"),
				),
		};
	}

	before(async () => {
		const dir = mkdtempSync(join(tmpdir(), "c8-migration-seed-"));
		dirs.push(dir);
		templated = readFileSync(await writeTemplatedDiagram(dir), "utf-8");
		assert.deepEqual(
			ALL_TEMPLATED.map((id) => templateOf(templated, id).version),
			["10", "12", "17", "10", "10"],
		);
	});

	after(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	test("REST connector v10 moves to the latest version on one element and refuses to lose a value unauthorized", async () => {
		const { bpmn, run, leftovers } = workspace();
		const refused = await run(
			"update",
			HTTP,
			"Task_Http10",
			bpmn,
			"--in-place",
		);
		assert.equal(refused.status, 1, refused.stderr);
		assert.match(refused.stderr, /--allow-lossy/);
		assert.equal(readFileSync(bpmn, "utf-8"), templated);
		const result = await run(
			"update",
			HTTP,
			"Task_Http10",
			bpmn,
			"--in-place",
			"--allow-lossy",
			"--json",
		);
		assert.equal(result.status, 0, result.stderr);
		const document = JSON.parse(result.stdout);
		assert.deepEqual(document.summary, {
			updated: 1,
			skipped: 0,
			unchanged: 0,
			failed: 0,
			dropped: 1,
			blocked: 0,
		});
		const [element] = document.results;
		assert.equal(element.from.version, 10);
		assert.equal(element.to.version, 17);
		assert.deepEqual(element.report.dropped, [
			{
				key: "storeResponse",
				bindingType: "zeebe:input",
				label: "Store response",
				group: "HTTP endpoint",
				value: "=true",
			},
		]);
		const xml = readFileSync(bpmn, "utf-8");
		assert.deepEqual(templateOf(xml, "Task_Http10"), {
			id: HTTP,
			version: "17",
		});
		assert.equal(inputOf(xml, "Task_Http10", "method"), "GET");
		assert.equal(
			inputOf(xml, "Task_Http10", "url"),
			"https://api.example.com/customers",
		);
		assert.equal(inputOf(xml, "Task_Http10", "authentication.type"), "noAuth");
		assert.equal(inputOf(xml, "Task_Http10", "storeResponse"), undefined);
		assert.equal(inputOf(xml, "Task_Http10", "followRedirects"), "=false");
		assertUntouched(templated, xml, [
			"Task_Http12",
			"Task_Http17",
			"Task_Http10b",
			"Task_Agent",
		]);
		assert.deepEqual(leftovers(), []);
	});

	test("AI Agent v1 moves from version 10 to 11 and keeps its values", async () => {
		const { bpmn, run, leftovers } = workspace();
		const result = await run("update", AGENT_V1, bpmn, "--in-place", "--json");
		assert.equal(result.status, 0, result.stderr);
		const document = JSON.parse(result.stdout);
		assert.equal(document.summary.updated, 1);
		assert.equal(document.results[0].lossless, true);
		assert.equal(document.results[0].to.version, 11);
		assert.equal(document.results[0].recipe.source, "none");
		const xml = readFileSync(bpmn, "utf-8");
		assert.deepEqual(templateOf(xml, "Task_Agent"), {
			id: AGENT_V1,
			version: "11",
		});
		assert.equal(inputOf(xml, "Task_Agent", "provider.type"), "openai");
		assert.equal(inputOf(xml, "Task_Agent", "data.limits.maxModelCalls"), "=7");
		assertUntouched(templated, xml, [
			"Task_Http10",
			"Task_Http12",
			"Task_Http17",
			"Task_Http10b",
		]);
		assert.deepEqual(leftovers(), []);
	});

	test("AI Agent v1 moves to the v2 template through the recipe it embeds", async () => {
		const { bpmn, run, leftovers } = workspace();
		const result = await run(
			"update",
			AGENT_V1,
			"Task_Agent",
			bpmn,
			"--to",
			AGENT_V2,
			"--in-place",
			"--json",
		);
		assert.equal(result.status, 0, result.stderr);
		const [element] = JSON.parse(result.stdout).results;
		assert.equal(element.to.id, AGENT_V2);
		assert.equal(element.recipe.source, "embedded");
		assert.equal(element.recipe.used, true);
		assert.equal(element.lossless, true);
		assert.deepEqual(
			element.report.moved.map(
				(item: { from: { key: string }; to: { key: string } }) => [
					item.from.key,
					item.to.key,
				],
			),
			[["data.limits.maxModelCalls", "data.limits.maxCalls"]],
		);
		const xml = readFileSync(bpmn, "utf-8");
		assert.deepEqual(templateOf(xml, "Task_Agent"), {
			id: AGENT_V2,
			version: "1",
		});
		assert.equal(inputOf(xml, "Task_Agent", "data.limits.maxCalls"), "=7");
		assert.equal(
			inputOf(xml, "Task_Agent", "data.limits.maxModelCalls"),
			undefined,
		);
		assert.equal(inputOf(xml, "Task_Agent", "provider.type"), "openai");
		assertUntouched(templated, xml, [
			"Task_Http10",
			"Task_Http12",
			"Task_Http17",
			"Task_Http10b",
		]);
		assert.deepEqual(leftovers(), []);
	});

	test("every element of one template, across participants and a subprocess, is written once", async () => {
		const { bpmn, run, leftovers } = workspace();
		const result = await run(
			"update",
			HTTP,
			bpmn,
			"--in-place",
			"--allow-lossy",
		);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.match(/Updated /g)?.length, 1, result.stdout);
		assert.match(
			result.stdout,
			/Summary: 3 updated, 0 skipped, 1 unchanged, 0 failed, 3 values dropped\./,
		);
		const xml = readFileSync(bpmn, "utf-8");
		for (const [id, url] of [
			["Task_Http10", "https://api.example.com/customers"],
			["Task_Http12", "https://api.example.com/prices"],
			["Task_Http17", "https://partner.example.com/notify"],
			["Task_Http10b", "https://partner.example.com/data"],
		]) {
			assert.deepEqual(templateOf(xml, id), { id: HTTP, version: "17" }, id);
			assert.equal(inputOf(xml, id, "url"), url, id);
		}
		assert.equal(
			inputOf(xml, "Task_Http12", "authentication.token"),
			"secrets.PRICES",
		);
		assert.equal(
			elementXml(xml, "Task_Http17"),
			elementXml(templated, "Task_Http17"),
		);
		assertUntouched(templated, xml, ["Task_Http17", "Task_Agent"]);
		assert.deepEqual(leftovers(), []);
	});

	test("--map carries a value the new version has no binding for", async () => {
		const { bpmn, run, leftovers } = workspace();
		const result = await run(
			"update",
			HTTP,
			bpmn,
			"--map",
			"storeResponse=followRedirects",
			"--in-place",
			"--json",
		);
		assert.equal(result.status, 0, result.stderr);
		const document = JSON.parse(result.stdout);
		assert.equal(document.summary.updated, 3);
		assert.equal(document.summary.dropped, 0);
		for (const item of document.results.filter(
			(entry: { status: string }) => entry.status === "updated",
		)) {
			assert.equal(item.lossless, true, item.elementId);
			assert.deepEqual(
				item.report.moved.map(
					(move: {
						from: { key: string };
						to: { key: string };
						via?: string;
					}) => [move.from.key, move.to.key, move.via],
				),
				[["storeResponse", "followRedirects", "--map"]],
			);
		}
		const xml = readFileSync(bpmn, "utf-8");
		assert.equal(inputOf(xml, "Task_Http10", "followRedirects"), "=true");
		assert.equal(inputOf(xml, "Task_Http10b", "followRedirects"), "=false");
		for (const id of ["Task_Http10", "Task_Http12", "Task_Http10b"])
			assert.equal(inputOf(xml, id, "storeResponse"), undefined, id);
		assertUntouched(templated, xml, ["Task_Http17", "Task_Agent"]);
		assert.deepEqual(leftovers(), []);
	});

	test("--to <id>@<n> pins the target version", async () => {
		const { bpmn, run, leftovers } = workspace();
		const result = await run(
			"update",
			HTTP,
			"Task_Http10b",
			bpmn,
			"--to",
			`${HTTP}@12`,
			"--in-place",
			"--json",
		);
		assert.equal(result.status, 0, result.stderr);
		const [element] = JSON.parse(result.stdout).results;
		assert.equal(element.from.version, 10);
		assert.equal(element.to.version, 12);
		assert.equal(element.lossless, true);
		const xml = readFileSync(bpmn, "utf-8");
		assert.deepEqual(templateOf(xml, "Task_Http10b"), {
			id: HTTP,
			version: "12",
		});
		assert.equal(
			inputOf(xml, "Task_Http10b", "url"),
			"https://partner.example.com/data",
		);
		assert.equal(inputOf(xml, "Task_Http10b", "method"), "DELETE");
		assertUntouched(templated, xml, [
			"Task_Http10",
			"Task_Http12",
			"Task_Http17",
			"Task_Agent",
		]);
		assert.deepEqual(leftovers(), []);
	});

	test("an element already on a higher version than the --to pin is skipped", async () => {
		const { bpmn, run, leftovers } = workspace();
		const result = await run(
			"update",
			HTTP,
			bpmn,
			"--to",
			`${HTTP}@12`,
			"--in-place",
			"--json",
		);
		assert.equal(result.status, 0, result.stderr);
		const document = JSON.parse(result.stdout);
		assert.deepEqual(
			Object.fromEntries(
				document.results.map((entry: { elementId: string; status: string }) => [
					entry.elementId,
					entry.status,
				]),
			),
			{
				Task_Http10: "updated",
				Task_Http12: "unchanged",
				Task_Http17: "skipped",
				Task_Http10b: "updated",
			},
		);
		assert.deepEqual(
			document.results.find(
				(entry: { elementId: string }) => entry.elementId === "Task_Http17",
			),
			{
				status: "skipped",
				elementId: "Task_Http17",
				from: { id: HTTP, version: 17 },
				to: { id: HTTP, version: 12 },
			},
		);
		assert.deepEqual(document.summary, {
			updated: 2,
			skipped: 1,
			unchanged: 1,
			failed: 0,
			dropped: 0,
			blocked: 0,
		});
		const xml = readFileSync(bpmn, "utf-8");
		for (const id of ["Task_Http10", "Task_Http10b"])
			assert.equal(templateOf(xml, id).version, "12", id);
		assert.equal(templateOf(xml, "Task_Http12").version, "12");
		assert.equal(templateOf(xml, "Task_Http17").version, "17");
		assertUntouched(templated, xml, [
			"Task_Http12",
			"Task_Http17",
			"Task_Agent",
		]);
		assert.deepEqual(leftovers(), []);
	});

	test("one element that cannot migrate leaves the whole file byte-identical", async () => {
		const { bpmn, run, leftovers } = workspace();
		// ignoreNullValues exists from version 12, so only the two v10 elements fail.
		const args = [
			"update",
			HTTP,
			bpmn,
			"--map",
			"ignoreNullValues=followRedirects",
			"--in-place",
			"--allow-lossy",
		];
		const result = await run(...args, "--json");
		assert.equal(result.status, 1, result.stderr);
		const document = JSON.parse(result.stdout);
		assert.deepEqual(
			Object.fromEntries(
				document.results.map((entry: { elementId: string; status: string }) => [
					entry.elementId,
					entry.status,
				]),
			),
			{
				Task_Http10: "failed",
				Task_Http12: "updated",
				Task_Http17: "unchanged",
				Task_Http10b: "failed",
			},
		);
		for (const entry of document.results.filter(
			(item: { status: string }) => item.status === "failed",
		))
			assert.match(
				entry.error,
				/ignoreNullValues.*is not a binding in template .*HttpJson\.v2@10/,
			);
		assert.equal(document.summary.failed, 2);
		assert.equal(readFileSync(bpmn, "utf-8"), templated);
		const text = await run(...args);
		assert.equal(text.status, 1, text.stderr);
		assert.match(text.stderr, /Nothing was written because an element failed/);
		assert.equal(readFileSync(bpmn, "utf-8"), templated);
		assert.deepEqual(leftovers(), []);
	});
});
