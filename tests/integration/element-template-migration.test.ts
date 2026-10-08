import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { asyncSpawn } from "../utils/spawn.ts";

const TASK = "Activity_17s7axj";
const fixture = resolve("tests/fixtures/simple.bpmn");
const input = (name: string, value = "", extra: object = {}) => ({
	type: "String",
	label: name,
	value,
	binding: { type: "zeebe:input", name },
	...extra,
});
const template = (
	id: string,
	version: number,
	properties: object[],
	sources?: object[],
) => ({
	id,
	name: id,
	version,
	appliesTo: ["bpmn:Task"],
	engines: { camunda: "^8.8" },
	properties: [
		{
			type: "Hidden",
			value: id,
			binding: { type: "zeebe:taskDefinition", property: "type" },
		},
		...properties,
	],
	...(sources
		? { metadata: { migratesFrom: { schemaVersion: 1, sources } } }
		: {}),
});

test("simple recipe CLI integration: serialization, reports, authorization and repeated no-op", async () => {
	const dir = mkdtempSync(join(tmpdir(), "c8-migration-simple-"));
	const run = (...args: string[]) =>
		asyncSpawn("node", ["src/index.ts", "element-template", ...args], {
			env: {
				...process.env,
				C8CTL_DATA_DIR: dir,
				CAMUNDA_BASE_URL: "http://test-cluster/v2",
			},
		});
	try {
		const old = template("simple-old", 1, [
			input("a", "preserve"),
			input("drop", "remove"),
			input("empty"),
		]);
		const target = template(
			"simple-new",
			1,
			[input("b"), input("empty")],
			[
				{
					kind: "change",
					sourceTemplateId: old.id,
					paths: [{ from: "input:a", to: "input:b" }],
				},
			],
		);
		mkdirSync(join(dir, "element-templates"));
		writeFileSync(
			join(dir, "element-templates/templates.json"),
			JSON.stringify([old, target]),
		);
		const oldPath = join(dir, "old.json");
		const targetPath = join(dir, "target.json");
		const bpmn = join(dir, "process.bpmn");
		writeFileSync(oldPath, JSON.stringify(old));
		writeFileSync(targetPath, JSON.stringify(target));
		const seeded = await run("apply", oldPath, TASK, fixture);
		assert.equal(seeded.status, 0, seeded.stderr);
		writeFileSync(bpmn, seeded.stdout);
		const dry = await run(
			"change",
			targetPath,
			TASK,
			bpmn,
			"--in-place",
			"--dry-run",
			"--json",
		);
		assert.equal(dry.status, 0, dry.stderr);
		const preview = JSON.parse(dry.stdout);
		assert.equal(preview.requiresAuthorization, true);
		assert.equal(preview.report.dropped[0].key, "drop");
		assert.equal(readFileSync(bpmn, "utf-8"), seeded.stdout);
		const refused = await run("change", targetPath, TASK, bpmn, "--in-place");
		assert.notEqual(refused.status, 0);
		assert.equal(readFileSync(bpmn, "utf-8"), seeded.stdout);
		const changed = await run(
			"change",
			targetPath,
			TASK,
			bpmn,
			"--in-place",
			"--allow-lossy",
			"--json",
		);
		assert.equal(changed.status, 0, changed.stderr);
		const migrated = readFileSync(bpmn, "utf-8");
		const properties = await run("get-properties", targetPath, "--json");
		assert.equal(properties.status, 0, properties.stderr);
		const inspected = await run("edit", TASK, bpmn, "--set", "b=preserve");
		assert.equal(inspected.status, 0, inspected.stderr);
		assert.match(inspected.stdout, /source="preserve" target="b"/);
		const formatted = await asyncSpawn(
			"node",
			["src/index.ts", "bpmn", "format", bpmn],
			{ env: { ...process.env, C8CTL_DATA_DIR: dir } },
		);
		assert.equal(formatted.status, 0, formatted.stderr);
		assert.equal(formatted.stdout, migrated);
		assert.match(migrated, /name="Do Something"/);
		assert.match(migrated, /sourceRef="StartEvent_1"/);
		const noop = await run(
			"change",
			targetPath,
			TASK,
			bpmn,
			"--in-place",
			"--json",
		);
		assert.equal(noop.status, 0, noop.stderr);
		assert.equal(JSON.parse(noop.stdout).noop, true);
		assert.equal(readFileSync(bpmn, "utf-8"), migrated);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("complex recipe CLI integration: source upgrades, floors, nested guards and conditional values", async () => {
	const dir = mkdtempSync(join(tmpdir(), "c8-migration-complex-"));
	const run = (...args: string[]) =>
		asyncSpawn("node", ["src/index.ts", "element-template", ...args], {
			env: {
				...process.env,
				C8CTL_DATA_DIR: dir,
				CAMUNDA_BASE_URL: "http://test-cluster/v2",
			},
		});
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
		mkdirSync(join(dir, "element-templates"));
		writeFileSync(
			join(dir, "element-templates/templates.json"),
			JSON.stringify([source1, source2, source3, target]),
		);
		const oldPath = join(dir, "old.json");
		const targetPath = join(dir, "target.json");
		const recipePath = join(dir, "recipe.json");
		const bpmn = join(dir, "process.bpmn");
		writeFileSync(oldPath, JSON.stringify(source1));
		writeFileSync(targetPath, JSON.stringify(target));
		writeFileSync(recipePath, JSON.stringify(target.metadata?.migratesFrom));
		const seeded = await run("apply", oldPath, TASK, fixture);
		assert.equal(seeded.status, 0, seeded.stderr);
		writeFileSync(bpmn, seeded.stdout);
		for (const recipeArgs of [[], ["--recipe", recipePath]]) {
			const preview = await run(
				"change",
				targetPath,
				TASK,
				bpmn,
				...recipeArgs,
				"--dry-run",
				"--json",
			);
			assert.equal(preview.status, 0, preview.stderr);
			const report = JSON.parse(preview.stdout).report;
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
				"change",
				targetPath,
				TASK,
				bpmn,
				...recipeArgs,
			);
			assert.equal(changed.status, 0, changed.stderr);
			writeFileSync(join(dir, "result.bpmn"), changed.stdout);
			const reparsed = await asyncSpawn(
				"node",
				["src/index.ts", "bpmn", "format", join(dir, "result.bpmn")],
				{ env: { ...process.env, C8CTL_DATA_DIR: dir } },
			);
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
