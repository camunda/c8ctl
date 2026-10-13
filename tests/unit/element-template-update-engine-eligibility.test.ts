/**
 * MIG-005: engine compatibility of successors and steps
 * (default-plugins/element-template/commands/migrate.ts)
 */

import assert from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
	createUpdateWorkspace,
	NEW,
	OLD,
	TASK,
	V1,
	V2,
} from "../utils/update-workspace.ts";

const w = createUpdateWorkspace();
const { ws } = w;
const { run, dataDirWithCache, setup, teardown, assertCleanedUp } = w;
before(setup);
after(teardown);

test("rejects engine-incompatible explicit targets", async () => {
	const incompatible = { ...NEW, engines: { camunda: ">=99.0.0" } };
	const templatePath = join(ws.workDir, "incompatible.json");
	writeFileSync(templatePath, JSON.stringify(incompatible));
	for (const to of [templatePath, incompatible.id]) {
		const result = await run(
			dataDirWithCache([OLD, incompatible]),
			"update",
			OLD.id,
			TASK,
			ws.oldBpmn,
			"--to",
			to,
		);
		assert.strictEqual(result.status, 1, result.stdout);
		assert.match(result.stderr, /compatible|migration/);
	}
});

test("rejects missing engine metadata and incompatible required intermediate versions", async () => {
	const missingEngine = join(ws.workDir, "missing-engine.bpmn");
	writeFileSync(
		missingEngine,
		readFileSync(ws.versionedBpmn, "utf-8").replace(
			/ modeler:executionPlatformVersion="[^"]*"/,
			"",
		),
	);
	const missing = await run(
		dataDirWithCache([V1, V2]),
		"update",
		V1.id,
		TASK,
		missingEngine,
	);
	assert.strictEqual(missing.status, 1);
	assert.match(missing.stderr, /executionPlatformVersion/);
	const v3 = {
		...V2,
		version: 3,
		metadata: {
			migratesFrom: {
				schemaVersion: 1,
				sources: [
					{
						kind: "upgrade",
						sourceTemplateId: V1.id,
						toVersion: 2,
						paths: [{ from: "endpoint", to: "url" }],
					},
					{
						kind: "upgrade",
						sourceTemplateId: V1.id,
						toVersion: 3,
						paths: [],
					},
				],
			},
		},
	};
	const file = join(ws.workDir, "missing-intermediate.bpmn");
	const xml = readFileSync(ws.versionedBpmn, "utf-8");
	writeFileSync(file, xml);
	const result = await run(
		dataDirWithCache([V1, { ...V2, engines: { camunda: ">=99" } }, v3]),
		"update",
		V1.id,
		TASK,
		file,
		"--in-place",
	);
	assert.strictEqual(result.status, 1);
	assert.match(result.stderr, /version 2 is not available/);
	assert.strictEqual(readFileSync(file, "utf-8"), xml);
});

describe("migration engine eligibility", () => {
	for (const namespace of ["urn:unrelated", "", undefined]) {
		test(`rejects spoofed modeler namespace ${JSON.stringify(namespace)} on every selection path`, async () => {
			const file = join(
				ws.workDir,
				`spoofed-namespace-${String(namespace)}.bpmn`,
			);
			const xml = readFileSync(ws.versionedBpmn, "utf-8").replace(
				/ xmlns:modeler="[^"]*"/,
				namespace === undefined ? "" : ` xmlns:modeler="${namespace}"`,
			);
			writeFileSync(file, xml);
			for (const args of [
				["update", V1.id, TASK, file],
				["update", V1.id, TASK, file, "--to", `${V2.id}@2`],
				["update", V1.id, TASK, file, "--to", V2.id],
			]) {
				const result = await run(
					dataDirWithCache([V1, V2]),
					...args,
					"--in-place",
					"--allow-lossy",
				);
				assert.strictEqual(result.status, 1, result.stderr);
				assert.match(result.stderr, /Cannot verify template compatibility/);
				assert.strictEqual(result.stdout, "");
				assert.strictEqual(readFileSync(file, "utf-8"), xml);
				assert.ok(!existsSync(`${file}.migration.lock`));
			}
		});
	}
	for (const splitPrefixes of [false, true]) {
		test(`accepts namespace-qualified engine metadata with ${splitPrefixes ? "split" : "aliased"} prefixes`, async () => {
			const file = join(ws.workDir, `aliased-namespace-${splitPrefixes}.bpmn`);
			const xml = readFileSync(ws.versionedBpmn, "utf-8")
				.replaceAll("modeler:", "metadata:")
				.replace("xmlns:modeler=", "xmlns:metadata=")
				.replace(
					"metadata:executionPlatformVersion=",
					splitPrefixes
						? 'xmlns:engine="http://camunda.org/schema/modeler/1.0" engine:executionPlatformVersion='
						: "metadata:executionPlatformVersion=",
				);
			writeFileSync(file, xml);
			for (const [templates, args, version] of [
				[[V1, V2], ["update", V1.id, TASK, file], 2],
				[[V1, V2], ["update", V1.id, TASK, file, "--to", `${V2.id}@2`], 2],
				[[V1, V2], ["update", V1.id, TASK, file, "--to", V2.id], 2],
				[[V1, NEW], ["update", V1.id, TASK, file, "--to", NEW.id], 1],
			] as const) {
				const cache = templates.map((template) =>
					template.id === NEW.id
						? {
								...NEW,
								metadata: {
									migratesFrom: {
										schemaVersion: 1,
										sources: [{ kind: "change", sourceTemplateId: V1.id }],
									},
								},
							}
						: template,
				);
				const result = await run(dataDirWithCache(cache), ...args);
				assert.strictEqual(result.status, 0, result.stderr);
				assert.match(
					result.stdout,
					new RegExp(`modelerTemplateVersion="${version}"`),
				);
			}
		});
	}
	for (const version of [
		"release-8.8.0",
		"8.8.0-junk trailing",
		"8.8.0.1",
		"8",
		"8.08.0",
		"08.8",
		"v8.8.0",
		"8.8-alpha1",
		"8.8.0-01",
		"8.8.0-alpha..1",
		"8.8.0+build..1",
		"8.8.0&#10;",
		"8.8.0&#13;",
		"^8.8",
		"",
		undefined,
	]) {
		test(`rejects malformed document version ${JSON.stringify(version)} on every selection path`, async () => {
			const file = join(
				ws.workDir,
				`invalid-version-${encodeURIComponent(String(version))}.bpmn`,
			);
			const xml = readFileSync(ws.versionedBpmn, "utf-8").replace(
				/ modeler:executionPlatformVersion="[^"]*"/,
				version === undefined
					? ""
					: ` modeler:executionPlatformVersion="${version}"`,
			);
			writeFileSync(file, xml);
			for (const args of [
				["update", V1.id, TASK, file],
				["update", V1.id, TASK, file, "--to", `${V2.id}@2`],
				["update", V1.id, TASK, file, "--to", V2.id],
			]) {
				const result = await run(
					dataDirWithCache([V1, V2]),
					...args,
					"--in-place",
					"--allow-lossy",
				);
				assert.strictEqual(result.status, 1, result.stderr);
				assert.match(
					result.stderr,
					/Cannot verify template compatibility.*executionPlatformVersion/,
				);
				assert.strictEqual(result.stdout, "");
				assert.strictEqual(readFileSync(file, "utf-8"), xml);
				assert.ok(!existsSync(`${file}.migration.lock`));
			}
		});
	}
	for (const platform of [
		undefined,
		"",
		"Camunda Platform",
		"Camunda Cloud junk",
	]) {
		test(`rejects unsupported document platform ${JSON.stringify(platform)}`, async () => {
			const file = join(
				ws.workDir,
				`invalid-platform-${encodeURIComponent(String(platform))}.bpmn`,
			);
			const xml = readFileSync(ws.versionedBpmn, "utf-8").replace(
				/ modeler:executionPlatform="[^"]*"/,
				platform === undefined
					? ""
					: ` modeler:executionPlatform="${platform}"`,
			);
			writeFileSync(file, xml);
			for (const args of [
				["update", V1.id, TASK, file],
				["update", V1.id, TASK, file, "--to", `${V2.id}@2`],
				["update", V1.id, TASK, file, "--to", V2.id],
			]) {
				const result = await run(
					dataDirWithCache([V1, V2]),
					...args,
					"--in-place",
					"--allow-lossy",
				);
				assert.strictEqual(result.status, 1, result.stderr);
				assert.match(
					result.stderr,
					/Cannot verify template compatibility.*executionPlatform/,
				);
				assert.strictEqual(result.stdout, "");
				assert.strictEqual(readFileSync(file, "utf-8"), xml);
			}
		});
	}
	for (const [name, engines] of [
		["null engines", null],
		["string engines", "^8.8"],
		["array engines", []],
		["boolean engines", false],
		["null range", { camunda: null }],
		["numeric range", { camunda: 8.8 }],
		["boolean range", { camunda: false }],
		["object range", { camunda: {} }],
		["array range", { camunda: ["^8.8"] }],
		["empty range", { camunda: "" }],
		["blank range", { camunda: " " }],
		["junk range", { camunda: "release-8.8.0" }],
		["invalid prerelease range", { camunda: "8.8.0-01" }],
		["incompatible range", { camunda: ">=99.0.0" }],
	] as const) {
		test(`rejects explicit targets with ${name} before writing`, async () => {
			const target = { ...V2, engines };
			const templatePath = join(ws.workDir, `engine-target-${name}.json`);
			writeFileSync(templatePath, JSON.stringify(target));
			for (const to of [`${V2.id}@2`, templatePath]) {
				const file = join(ws.workDir, `engine-target-${name}.bpmn`);
				const xml = readFileSync(ws.versionedBpmn, "utf-8");
				writeFileSync(file, xml);
				const result = await run(
					dataDirWithCache([V1, target]),
					"update",
					V1.id,
					TASK,
					file,
					"--to",
					to,
					"--in-place",
					"--allow-lossy",
				);
				assert.strictEqual(result.status, 1, result.stderr);
				assert.match(result.stderr, /not compatible with Camunda/);
				assert.strictEqual(result.stdout, "");
				assert.strictEqual(readFileSync(file, "utf-8"), xml);
			}
		});
		test(`excludes ${name} from automatic targets and source lineage`, async () => {
			const invalidUpgrade = {
				...OLD,
				version: 2,
				engines,
				metadata: {
					migratesFrom: {
						schemaVersion: 1,
						sources: [
							{ kind: "upgrade", sourceTemplateId: OLD.id, toVersion: 2 },
						],
					},
				},
			};
			const successor = {
				...NEW,
				metadata: {
					migratesFrom: {
						schemaVersion: 1,
						sources: [
							{ kind: "change", sourceTemplateId: OLD.id, minSourceVersion: 2 },
						],
					},
				},
			};
			const cache = dataDirWithCache([OLD, invalidUpgrade, successor]);
			const discovered = await run(cache, "update", OLD.id, TASK, ws.oldBpmn);
			assert.strictEqual(discovered.status, 0, discovered.stderr);
			assert.strictEqual(discovered.stdout, readFileSync(ws.oldBpmn, "utf-8"));
			assert.match(discovered.stderr, /already on/);
			const update = await run(
				dataDirWithCache([V1, { ...V2, engines }]),
				"update",
				V1.id,
				TASK,
				ws.versionedBpmn,
			);
			assert.strictEqual(update.status, 0, update.stderr);
			assert.strictEqual(
				update.stdout,
				readFileSync(ws.versionedBpmn, "utf-8"),
			);
			const unpinned = await run(
				dataDirWithCache([V1, { ...V2, engines }]),
				"update",
				V1.id,
				TASK,
				ws.versionedBpmn,
				"--to",
				V2.id,
			);
			assert.strictEqual(unpinned.status, 0, unpinned.stderr);
			assert.strictEqual(
				unpinned.stdout,
				readFileSync(ws.versionedBpmn, "utf-8"),
			);
			const chosen = await run(
				dataDirWithCache([OLD, NEW, { ...NEW, version: 2, engines }]),
				"update",
				OLD.id,
				TASK,
				ws.oldBpmn,
				"--to",
				NEW.id,
			);
			assert.strictEqual(chosen.status, 0, chosen.stderr);
			assert.match(chosen.stdout, /modelerTemplateVersion="1"/);
		});
		test(`rejects a required source step with ${name} before mutation`, async () => {
			const latest = {
				...OLD,
				version: 3,
				metadata: {
					migratesFrom: {
						schemaVersion: 1,
						sources: [
							{ kind: "upgrade", sourceTemplateId: OLD.id, toVersion: 2 },
							{ kind: "upgrade", sourceTemplateId: OLD.id, toVersion: 3 },
						],
					},
				},
			};
			const file = join(ws.workDir, `engine-step-${name}.bpmn`);
			const xml = readFileSync(ws.oldBpmn, "utf-8");
			writeFileSync(file, xml);
			const result = await run(
				dataDirWithCache([OLD, { ...OLD, version: 2, engines }, latest, NEW]),
				"update",
				OLD.id,
				TASK,
				file,
				"--to",
				`${NEW.id}@1`,
				"--in-place",
				"--allow-lossy",
			);
			assert.strictEqual(result.status, 1, result.stderr);
			assert.match(result.stderr, /version 2 is not available/);
			assert.match(result.stderr, /Nothing was written/);
			assert.strictEqual(readFileSync(file, "utf-8"), xml);
		});
	}
	for (const version of ["8.8", "8.8.0", "8.8.0+build.1"]) {
		test(`accepts document version ${version} with absent legacy engine constraints`, async () => {
			const file = join(ws.workDir, `valid-engine-${version}.bpmn`);
			writeFileSync(
				file,
				readFileSync(ws.versionedBpmn, "utf-8").replace(
					/modeler:executionPlatformVersion="[^"]*"/,
					`modeler:executionPlatformVersion="${version}"`,
				),
			);
			for (const engines of [undefined, {}, { modeler: ">=5.0" }]) {
				const result = await run(
					dataDirWithCache([V1, { ...V2, engines }]),
					"update",
					V1.id,
					TASK,
					file,
				);
				assert.strictEqual(result.status, 0, result.stderr);
				assert.match(result.stdout, /modelerTemplateVersion="2"/);
			}
		});
	}
	test("preserves prerelease semantics instead of coercing to a stable engine", async () => {
		const file = join(ws.workDir, "prerelease-engine.bpmn");
		writeFileSync(
			file,
			readFileSync(ws.versionedBpmn, "utf-8").replace(
				/modeler:executionPlatformVersion="[^"]*"/,
				'modeler:executionPlatformVersion="8.8.0-alpha1"',
			),
		);
		const result = await run(
			dataDirWithCache([V1, V2]),
			"update",
			V1.id,
			TASK,
			file,
			"--to",
			`${V2.id}@2`,
		);
		assert.strictEqual(result.status, 1, result.stderr);
		assert.match(result.stderr, /not compatible with Camunda 8\.8\.0-alpha1/);
		assert.strictEqual(result.stdout, "");
	});
	test("automatically selects templates explicitly supporting a prerelease engine", async () => {
		const file = join(ws.workDir, "supported-prerelease-engine.bpmn");
		writeFileSync(
			file,
			readFileSync(ws.versionedBpmn, "utf-8").replace(
				/modeler:executionPlatformVersion="[^"]*"/,
				'modeler:executionPlatformVersion="8.8.0-alpha1"',
			),
		);
		const engines = { camunda: "8.8.0-alpha1" };
		for (const args of [
			["update", V1.id, TASK, file],
			["update", V1.id, TASK, file, "--to", V2.id],
		]) {
			const result = await run(
				dataDirWithCache([
					{ ...V1, engines },
					{ ...V2, engines },
				]),
				...args,
			);
			assert.strictEqual(result.status, 0, result.stderr);
			assert.match(result.stdout, /modelerTemplateVersion="2"/);
		}
	});
	test("preserves unconstrained legacy eligibility for prerelease engines on every target path", async () => {
		const file = join(ws.workDir, "legacy-prerelease-engine.bpmn");
		const xml = readFileSync(ws.oldBpmn, "utf-8").replace(
			/modeler:executionPlatformVersion="[^"]*"/,
			'modeler:executionPlatformVersion="8.8.0-alpha.1+build.2"',
		);
		writeFileSync(file, xml);
		for (const engines of [undefined, {}, { modeler: ">=5.0" }]) {
			const source = { ...OLD, engines };
			const successor = { ...NEW, engines };
			const upgrade = { ...source, version: 2 };
			const cache = dataDirWithCache([source, upgrade, successor]);
			for (const [args, expected] of [
				[["update", OLD.id, TASK, file], /modelerTemplateVersion="2"/],
				[
					["update", OLD.id, TASK, file, "--to", `${NEW.id}@1`],
					/modelerTemplate="io\.example\.new"/,
				],
				[
					["update", OLD.id, TASK, file, "--to", NEW.id],
					/modelerTemplate="io\.example\.new"/,
				],
			] as const) {
				const result = await run(cache, ...args);
				assert.strictEqual(result.status, 0, result.stderr);
				assert.match(result.stdout, expected);
			}
		}
	});
});

test("removes every temp dir it created", assertCleanedUp);
