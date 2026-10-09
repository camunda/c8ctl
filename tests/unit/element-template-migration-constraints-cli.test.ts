import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { asyncSpawn } from "../utils/spawn.ts";

const TASK = "Activity_17s7axj";
const FIXTURE = resolve(import.meta.dirname, "../fixtures/simple.bpmn");

function input(name: string, value: string, extra: object = {}) {
	return {
		type: "String",
		label: name,
		value,
		binding: { type: "zeebe:input", name },
		...extra,
	};
}

describe("migration destination constraints through CLI", () => {
	for (const action of ["change", "update"] as const) {
		for (const scenario of [
			{
				name: "cyclic destination condition",
				value: "SECRET",
				extra: { id: "b", condition: { property: "b", isActive: true } },
				rule: /unsupported or cyclic condition/,
			},
			{
				name: "unsupported destination condition",
				value: "SECRET",
				extra: { condition: { property: "mode", custom: true } },
				rule: /unsupported or cyclic condition/,
			},
			{
				name: "required carry-over",
				value: "   ",
				extra: { constraints: { notEmpty: true } },
				rule: /notEmpty/,
			},
			{
				name: "choice carry-over",
				value: "SECRET",
				extra: {
					type: "Dropdown",
					choices: [{ name: "Allowed", value: "allowed" }],
				},
				rule: /choice/,
			},
			{
				name: "pattern carry-over",
				value: "SECRET",
				extra: { constraints: { pattern: { value: "^allowed$" } } },
				rule: /pattern/,
			},
			{
				name: "unsupported carry-over",
				value: "SECRET",
				extra: { constraints: { minLength: 1 } },
				rule: /unsupported constraint minLength/,
			},
			{
				name: "active conditional carry-over",
				value: "SECRET",
				extra: {
					condition: { property: "mode", equals: "on" },
					constraints: { pattern: { value: "^allowed$" } },
				},
				rule: /pattern/,
			},
			{
				name: "discriminator activates invalid write",
				value: "SECRET",
				extra: {
					condition: { property: "mode", equals: "on" },
					constraints: { pattern: { value: "^allowed$" } },
				},
				rule: /pattern/,
				paths: [
					{ to: "b", set: "SECRET" },
					{ to: "mode", set: "on" },
				],
			},
		]) {
			test(`${action} rejects ${scenario.name} without output or file changes`, async (t) => {
				const dir = mkdtempSync(join(tmpdir(), "c8ctl-constraints-"));
				t.after(() => rmSync(dir, { recursive: true, force: true }));
				const dataDir = join(dir, "data");
				mkdirSync(join(dataDir, "element-templates"), { recursive: true });
				const old = {
					id: "io.example.constraints",
					version: 1,
					name: "Source",
					appliesTo: ["bpmn:Task"],
					properties: [
						input("b", scenario.value),
						input("mode", "on", { id: "mode" }),
					],
				};
				const target = {
					...old,
					id: action === "change" ? "io.example.constraints.new" : old.id,
					version: 2,
					name: "Destination",
					properties: [
						input("mode", scenario.paths ? "off" : "on", { id: "mode" }),
						input("b", "allowed", scenario.extra),
					],
					...(scenario.paths
						? {
								metadata: {
									migratesFrom: {
										schemaVersion: 1,
										sources: [
											{
												kind: action === "change" ? "change" : "upgrade",
												sourceTemplateId: old.id,
												...(action === "update" ? { toVersion: 2 } : {}),
												paths: scenario.paths,
											},
										],
									},
								},
							}
						: {}),
				};
				writeFileSync(
					join(dataDir, "element-templates/templates.json"),
					JSON.stringify([old, target]),
				);
				writeFileSync(
					join(dataDir, "element-templates/fetched-at"),
					String(Date.now()),
				);
				const oldPath = join(dir, "old.json");
				const targetPath = join(dir, "target.json");
				writeFileSync(oldPath, JSON.stringify(old));
				writeFileSync(targetPath, JSON.stringify(target));
				const run = (...args: string[]) =>
					asyncSpawn(
						"node",
						[
							"--experimental-strip-types",
							"src/index.ts",
							"element-template",
							...args,
						],
						{
							env: {
								...process.env,
								CAMUNDA_BASE_URL: "http://test-cluster/v2",
								C8CTL_DATA_DIR: dataDir,
								HOME: dir,
								C8CTL_OUTPUT_MODE: "text",
							},
						},
					);
				const seeded = await run("apply", oldPath, TASK, FIXTURE);
				assert.equal(seeded.status, 0, seeded.stderr);
				const file = join(dir, "diagram.bpmn");
				writeFileSync(file, seeded.stdout);
				const bytes = readFileSync(file);
				const mtime = statSync(file).mtimeMs;
				for (const flags of [
					["--in-place", "--json"],
					[],
					["--dry-run", "--json"],
				]) {
					const result = await run(
						action,
						...(action === "change" ? [targetPath] : []),
						TASK,
						file,
						...flags,
					);
					assert.equal(result.status, 1, result.stderr);
					assert.equal(result.stdout, "");
					assert.match(result.stderr, /input:b/);
					assert.match(result.stderr, scenario.rule);
					assert.match(
						result.stderr,
						scenario.paths ? /paths\[/ : /carry-over/,
					);
					assert.doesNotMatch(result.stderr, /SECRET/);
					assert.deepEqual(readFileSync(file), bytes);
					assert.equal(statSync(file).mtimeMs, mtime);
				}
			});
		}
	}
});
