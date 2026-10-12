/**
 * MIG-011: reports and diagnostics redact sensitive values
 * (default-plugins/element-template/commands/migrate.ts)
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { c8WithEnv } from "../utils/cli.ts";
import { input, seedTemplateCache } from "../utils/element-template.ts";

const TASK = "Activity_17s7axj";
const PRIVATE = "PRIVATE-UNCHANGED-4839";
const secrets = [
	PRIVATE,
	"PRIVATE-DROP-4839",
	"PRIVATE-ADD-4839",
	"PRIVATE-MAPPED-4839",
	"PRIVATE-SOURCE-MAPPED-4839",
	"PRIVATE-CHANGED-4839",
	"PRIVATE-ADDED-4839",
	"PRIVATE-RESET-OLD-4839",
];
const dir = mkdtempSync(join(tmpdir(), "c8ctl-redaction-cli-"));
const bpmn = join(dir, "input.bpmn");
const targetPath = join(dir, "target.json");
const recipePath = join(dir, "recipe.json");
const env = { C8CTL_DATA_DIR: dir, C8CTL_OUTPUT_MODE: "text" };
const source = {
	id: "redaction.source",
	name: "Source",
	version: 1,
	appliesTo: ["bpmn:Task"],
	groups: [{ id: "auth", label: "Credentials" }],
	properties: [
		input("unchanged", PRIVATE, { id: "apiKey" }),
		input("removed", secrets[1], { label: "Password" }),
		input("mapped", secrets[4], { group: "auth" }),
		input("changed", secrets[5], { group: "credentials" }),
		input("reset", secrets[7], { id: "password" }),
		input("maxTokens", "2000", { label: "Maximum tokens" }),
	],
};
const recipe = {
	schemaVersion: 1,
	sources: [
		{
			kind: "change",
			sourceTemplateId: source.id,
			paths: [
				{
					from: "mapped",
					to: "destination",
					valueMap: { rules: [{ match: "*", value: secrets[3] }] },
				},
				{
					to: "changed",
					set: secrets[2],
					note: `unchanged credential ${PRIVATE}`,
				},
			],
		},
	],
};
const target = {
	id: "redaction.target",
	name: "Target",
	version: 1,
	appliesTo: ["bpmn:Task"],
	metadata: { migratesFrom: recipe },
	properties: [
		input("unchanged", "", { id: "apiKey" }),
		input("destination", ""),
		input("changed", "", { group: "credentials" }),
		input("added", secrets[6], { id: "accessToken" }),
		input("reset", "", { id: "password", feel: "required" }),
		input("maxTokens", "2000", { label: "Maximum tokens" }),
	],
};

function assertPrivateAbsent(output: string) {
	for (const secret of secrets) assert.ok(!output.includes(secret), output);
}

before(async () => {
	// The explicit target's metadata must win over the same cached identity.
	seedTemplateCache(dir, [
		source,
		{
			...target,
			properties: target.properties.map((p) => input(p.binding.name, "")),
		},
	]);
	const sourcePath = join(dir, "source.json");
	writeFileSync(sourcePath, JSON.stringify(source));
	const seeded = await c8WithEnv(
		env,
		"element-template",
		"apply",
		sourcePath,
		TASK,
		"tests/fixtures/simple.bpmn",
	);
	assert.equal(seeded.status, 0, seeded.stderr);
	writeFileSync(bpmn, seeded.stdout);
	writeFileSync(targetPath, JSON.stringify(target));
});
after(() => rmSync(dir, { recursive: true, force: true }));

for (const flags of [
	["--dry-run"],
	["--dry-run", "--json"],
	["--dry-run", "--allow-lossy"],
	[],
	["--in-place", "--allow-lossy", "--json"],
]) {
	test(`redacts metadata-driven diffs and known credentials in notes: ${flags.join(" ") || "XML"}`, async () => {
		const original = readFileSync(bpmn, "utf8");
		const file = join(dir, `case-${flags.join("-") || "xml"}.bpmn`);
		writeFileSync(file, original);
		const result = await c8WithEnv(
			env,
			"element-template",
			"update",
			source.id,
			TASK,
			file,
			"--to",
			targetPath,
			...flags,
		);
		// A lossy dry run predicts the blocked write without --allow-lossy.
		const blocked =
			flags.includes("--dry-run") && !flags.includes("--allow-lossy");
		assert.equal(result.status, blocked ? 1 : 0, result.stderr);
		const xmlOutput = flags.length === 0;
		assertPrivateAbsent(result.stderr);
		if (!xmlOutput) assertPrivateAbsent(result.stdout);
		const reporting = xmlOutput ? result.stderr : result.stdout;
		assert.match(reporting, /\[REDACTED\]/);
		assert.match(reporting, /unchanged credential/);
		if (flags.includes("--json")) {
			const diff = JSON.parse(reporting).results[0].report;
			for (const collection of ["dropped", "added", "changed", "moved"])
				assert.ok(diff[collection].length > 0, reporting);
		} else {
			for (const section of ["Dropped", "Added", "Changed", "Moved"])
				assert.ok(reporting.includes(section), reporting);
		}
		assert.equal(readFileSync(bpmn, "utf8"), original);
		if (flags.includes("--dry-run"))
			assert.equal(readFileSync(file, "utf8"), original);
		else {
			// XML is the model artifact, intentionally containing real credentials.
			const xml = xmlOutput ? result.stdout : readFileSync(file, "utf8");
			for (const secret of [
				PRIVATE,
				secrets[2],
				secrets[3],
				secrets[6],
				secrets[7],
			])
				assert.ok(xml.includes(secret), xml);
		}
	});
}

for (const json of [false, true]) {
	test(`redacts update reports and no-ops in ${json ? "JSON" : "text"}`, async () => {
		const data = join(dir, `update-${json}`);
		const upgraded = {
			...source,
			version: 2,
			name: `Updated ${PRIVATE}`,
			metadata: {
				migratesFrom: {
					schemaVersion: 1,
					sources: [
						{
							kind: "upgrade",
							sourceTemplateId: source.id,
							toVersion: 2,
							paths: [{ to: "changed", set: secrets[2], note: PRIVATE }],
						},
					],
				},
			},
		};
		seedTemplateCache(data, [source, upgraded]);
		const file = join(data, "update.bpmn");
		writeFileSync(file, readFileSync(bpmn));
		for (const dryRun of [true, false, false]) {
			const original = readFileSync(file, "utf8");
			const result = await c8WithEnv(
				{ ...env, C8CTL_DATA_DIR: data },
				"element-template",
				"update",
				source.id,
				TASK,
				file,
				"--in-place",
				"--allow-lossy",
				...(dryRun ? ["--dry-run"] : []),
				...(json ? ["--json"] : []),
			);
			assert.equal(result.status, 0, result.stderr);
			assertPrivateAbsent(result.stdout);
			assertPrivateAbsent(result.stderr);
			assert.match(result.stdout, /\[REDACTED\]/);
			if (dryRun) assert.equal(readFileSync(file, "utf8"), original);
			else assert.ok(readFileSync(file, "utf8").includes(PRIVATE));
		}
	});
}

for (const json of [false, true]) {
	test(`redacts embedded recipe and target validation diagnostics in ${json ? "JSON" : "text"}`, async () => {
		for (const invalid of [
			{ ...target, metadata: { migratesFrom: { ...recipe, [PRIVATE]: true } } },
			{
				...target,
				properties: target.properties.map((p) =>
					p.binding.name === "destination"
						? { ...p, constraints: { pattern: `^${PRIVATE}$` } }
						: p,
				),
			},
		]) {
			const path = join(dir, "invalid-target.json");
			writeFileSync(path, JSON.stringify(invalid));
			const original = readFileSync(bpmn, "utf8");
			const result = await c8WithEnv(
				env,
				"element-template",
				"update",
				source.id,
				TASK,
				bpmn,
				"--to",
				path,
				"--in-place",
				"--verbose",
				...(json ? ["--json"] : []),
			);
			assert.equal(result.status, 1, result.stdout);
			assertPrivateAbsent(result.stdout);
			assertPrivateAbsent(result.stderr);
			assert.equal(readFileSync(bpmn, "utf8"), original);
		}
	});
}

for (const flags of [
	[],
	["--dry-run"],
	["--dry-run", "--json"],
	["--in-place", "--json"],
]) {
	test(`redacts no-op identity text without rewriting BPMN: ${flags.join(" ") || "XML"}`, async () => {
		const noopPath = join(dir, "noop.json");
		writeFileSync(
			noopPath,
			JSON.stringify({ ...source, name: `Source ${PRIVATE}` }),
		);
		const original = readFileSync(bpmn, "utf8");
		const result = await c8WithEnv(
			env,
			"element-template",
			"update",
			source.id,
			TASK,
			bpmn,
			"--to",
			noopPath,
			...flags,
		);
		assert.equal(result.status, 0, result.stderr);
		assertPrivateAbsent(result.stderr);
		if (flags.length === 0) assert.equal(result.stdout, original);
		else assertPrivateAbsent(result.stdout);
		assert.equal(readFileSync(bpmn, "utf8"), original);
		if (flags.includes("--json"))
			assert.equal(JSON.parse(result.stdout).results[0].noop, true);
	});
}

for (const json of [false, true]) {
	for (const malformed of [false, true]) {
		test(`redacts explicit recipe ${malformed ? "JSON syntax" : "validation"} errors in ${json ? "JSON" : "text"}`, async () => {
			writeFileSync(
				recipePath,
				malformed
					? `{"${PRIVATE}": invalid}`
					: JSON.stringify({ ...recipe, [PRIVATE]: true }),
			);
			const original = readFileSync(bpmn, "utf8");
			const result = await c8WithEnv(
				env,
				"element-template",
				"update",
				source.id,
				TASK,
				bpmn,
				"--to",
				targetPath,
				"--recipe",
				recipePath,
				"--in-place",
				"--verbose",
				...(json ? ["--json"] : []),
			);
			assert.equal(result.status, 1);
			assertPrivateAbsent(result.stdout);
			assertPrivateAbsent(result.stderr);
			assert.match(result.stderr, /recipe/i);
			assert.equal(readFileSync(bpmn, "utf8"), original);
		});
	}
}
