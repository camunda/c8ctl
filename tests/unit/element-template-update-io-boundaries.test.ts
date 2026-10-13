/**
 * UPD-001, UPD-002, UPD-007: input and output boundaries of the update command
 * (default-plugins/element-template/commands/migrate.ts)
 *
 * Each case pins the exit code, the stream, the message and, where the input
 * is a file, that the file is byte-identical afterwards.
 */

import assert from "node:assert";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { c8WithClosedStdout, c8WithEnv, c8WithOptions } from "../utils/cli.ts";
import {
	createUpdateWorkspace,
	TASK,
	V1,
	V2,
} from "../utils/update-workspace.ts";

const w = createUpdateWorkspace();
const { ws } = w;
const { run, dataDirWithCache, seedBpmn, seedMulti, copyOf, setup, teardown } =
	w;
before(setup);
after(teardown);

const cache = () => dataDirWithCache([V1, V2]);
// v3 declares one hop per version it can be reached from.
const V3 = {
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
const runWithStdin = (stdin: string, dataDir: string, ...args: string[]) =>
	c8WithOptions(
		{ stdin, env: { C8CTL_DATA_DIR: dataDir } },
		"element-template",
		...args,
	);

/** Assert a failed run: exit 1, nothing on stdout, `message` on stderr. */
function assertRejected(
	result: { status: number | null; stdout: string; stderr: string },
	message: RegExp,
	label: string,
) {
	assert.strictEqual(result.status, 1, `${label}: ${result.stderr}`);
	assert.strictEqual(result.stdout, "", `${label}: stdout`);
	assert.match(result.stderr, message, label);
}

describe("update reads BPMN from stdin", () => {
	test("a real change prints the migrated BPMN and reports on stderr", async () => {
		const xml = readFileSync(ws.versionedBpmn, "utf-8");
		const result = await runWithStdin(xml, cache(), "update", V1.id, TASK);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /modelerTemplateVersion="2"/);
		assert.match(result.stdout, /source="https:\/\/v1" target="url"/);
		assert.match(result.stderr, /1 element updated/);
	});

	test("an element id alone selects the element when the BPMN is on stdin", async () => {
		const xml = readFileSync(ws.versionedBpmn, "utf-8");
		const result = await runWithStdin(xml, cache(), "update", V1.id, TASK);
		assert.strictEqual(result.status, 0, result.stderr);
		const other = await runWithStdin(xml, cache(), "update", V1.id, "Nope");
		assertRejected(
			other,
			/Element "Nope" not found in the BPMN diagram/,
			"unknown element id",
		);
	});

	test("--dry-run --json prints one JSON document and leaves the diagram unprinted", async () => {
		const xml = readFileSync(ws.versionedBpmn, "utf-8");
		const result = await runWithStdin(
			xml,
			cache(),
			"update",
			V1.id,
			"--dry-run",
			"--json",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		const document = JSON.parse(result.stdout);
		assert.strictEqual(document.dryRun, true);
		assert.strictEqual(document.results[0].status, "updated");
		assert.strictEqual(result.stderr, "");
	});

	for (const [name, stdin] of [
		["empty", ""],
		["whitespace only", " \n\t\n"],
	] as const) {
		test(`${name} stdin is rejected as missing input`, async () => {
			const result = await runWithStdin(stdin, cache(), "update", V1.id);
			assertRejected(result, /No BPMN input provided/, name);
		});
	}

	test("--in-place cannot be combined with stdin", async () => {
		const result = await runWithStdin(
			"<x/>",
			cache(),
			"update",
			V1.id,
			"--in-place",
		);
		assertRejected(
			result,
			/--in-place cannot be used with stdin input/,
			"in-place",
		);
	});
});

describe("update file input errors", () => {
	test("a missing file is reported by path", async () => {
		const missing = join(ws.workDir, "does-not-exist.bpmn");
		const result = await run(cache(), "update", V1.id, missing);
		assertRejected(result, /File not found: .*does-not-exist\.bpmn/, "missing");
		assert.strictEqual(existsSync(missing), false);
	});

	test("invalid XML is rejected and the file stays as it was", async () => {
		const file = join(ws.workDir, "invalid.bpmn");
		writeFileSync(file, "<bpmn:definitions");
		const before = readFileSync(file, "utf-8");
		for (const flags of [[], ["--in-place"], ["--dry-run"]]) {
			const result = await run(cache(), "update", V1.id, file, ...flags);
			assert.strictEqual(result.status, 1, `${flags}: ${result.stderr}`);
			assert.strictEqual(result.stdout, "", `${flags}: stdout`);
			assert.notStrictEqual(result.stderr, "", `${flags}: stderr`);
			assert.strictEqual(readFileSync(file, "utf-8"), before);
		}
	});

	test("an unreadable file is rejected and the file stays as it was", {
		skip:
			process.platform === "win32" || process.getuid?.() === 0
				? "POSIX permission bits do not apply"
				: false,
	}, async () => {
		const { copy, before } = copyOf(ws.versionedBpmn, "unreadable.bpmn");
		chmodSync(copy, 0o000);
		try {
			const result = await run(cache(), "update", V1.id, copy, "--in-place");
			assertRejected(result, /EACCES|permission denied/i, "unreadable");
		} finally {
			chmodSync(copy, 0o600);
		}
		assert.strictEqual(readFileSync(copy, "utf-8"), before);
	});

	test("a directory in place of the file is rejected", async () => {
		const dir = join(ws.workDir, "a-directory.bpmn");
		mkdirSync(dir);
		const result = await run(cache(), "update", V1.id, dir);
		assert.strictEqual(result.status, 1, result.stderr);
		assert.strictEqual(result.stdout, "");
		assert.match(result.stderr, /EISDIR|directory/i);
	});
});

describe("update arguments", () => {
	test("three positionals after the template id are a usage error", async () => {
		const { copy, before } = copyOf(ws.versionedBpmn, "extra-arg.bpmn");
		const result = await run(cache(), "update", V1.id, TASK, copy, "extra");
		assertRejected(result, /Unexpected argument: extra\. Usage: /, "extra");
		assert.strictEqual(readFileSync(copy, "utf-8"), before);
	});

	test("-i is the short form of --in-place", async () => {
		const { copy } = copyOf(ws.versionedBpmn, "short-flag.bpmn");
		const result = await run(cache(), "update", V1.id, TASK, copy, "-i");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /Updated .*short-flag\.bpmn/);
		assert.match(readFileSync(copy, "utf-8"), /modelerTemplateVersion="2"/);
	});

	test("an unknown --to template is rejected before writing", async () => {
		const { copy, before } = copyOf(ws.versionedBpmn, "unknown-to.bpmn");
		const result = await run(
			cache(),
			"update",
			V1.id,
			TASK,
			copy,
			"--to",
			"io.example.nope",
			"--in-place",
		);
		assert.strictEqual(result.status, 1, result.stderr);
		assert.strictEqual(result.stdout, "");
		assert.match(result.stderr, /io\.example\.nope/);
		assert.strictEqual(readFileSync(copy, "utf-8"), before);
	});

	test("--to <id>@<n> below the applied version skips the element and writes nothing", async () => {
		const onV2 = await seedBpmn(V2, ["provider=azure", "url=https://x"], "v2");
		const { copy, before } = copyOf(onV2, "downgrade.bpmn");
		const result = await run(
			dataDirWithCache([V1, V2]),
			"update",
			V2.id,
			TASK,
			copy,
			"--to",
			`${V1.id}@1`,
			"--in-place",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /is on v2, newer than v1; skipped/);
		assert.match(result.stdout, /1 element skipped/);
		assert.strictEqual(readFileSync(copy, "utf-8"), before);
	});

	test("a --map destination that the recipe also writes is rejected", async () => {
		const { copy, before } = copyOf(ws.versionedBpmn, "map-conflict.bpmn");
		const result = await run(
			cache(),
			"update",
			V1.id,
			TASK,
			copy,
			"--map",
			"provider=url",
			"--in-place",
			"--allow-lossy",
		);
		assert.strictEqual(result.status, 1, result.stderr);
		assert.strictEqual(result.stdout.includes("Updated"), false);
		assert.match(result.stderr, /Ambiguous migration/);
		assert.strictEqual(readFileSync(copy, "utf-8"), before);
	});
});

describe("update on elements at different versions", () => {
	test("elements on v1 and v2 both reach v3 in one run", async () => {
		const file = await seedMulti("mixed", [
			[TASK, V1, ["provider=azure", "endpoint=https://a"]],
			["Task_B", V2, ["provider=azure", "url=https://b"]],
		]);
		const { copy } = copyOf(file, "mixed-copy.bpmn");
		const result = await run(
			dataDirWithCache([V1, V2, V3]),
			"update",
			V1.id,
			copy,
			"--in-place",
			"--allow-lossy",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /2 elements updated/);
		const xml = readFileSync(copy, "utf-8");
		for (const [id, value] of [
			[TASK, "https://a"],
			["Task_B", "https://b"],
		]) {
			const task = xml.match(
				new RegExp(`<bpmn:task id="${id}"[\\s\\S]*?</bpmn:task>`),
			)?.[0];
			assert.ok(task, id);
			assert.match(task, /modelerTemplateVersion="3"/, id);
			assert.match(task, new RegExp(`source="${value}" target="url"`), id);
		}
	});
});

describe("update output pipes", () => {
	test("closing stdout before the first write exits cleanly without a stack", {
		skip:
			process.platform === "win32"
				? "POSIX-only: a closed stdout reader raises EPIPE"
				: false,
	}, async () => {
		const result = await c8WithClosedStdout(
			{ env: { C8CTL_DATA_DIR: cache() } },
			"element-template",
			"update",
			V1.id,
			TASK,
			ws.versionedBpmn,
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.doesNotMatch(result.stderr, /EPIPE|Unhandled|at .*\.ts:\d+/);
	});
});

describe("update help text", () => {
	test("documents the update subcommand, its flags and --dry-run examples", async () => {
		const result = await c8WithEnv(
			{ C8CTL_OUTPUT_MODE: "text" },
			"help",
			"element-template",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		for (const text of [
			"update <template-id>",
			"--to",
			"--recipe",
			"--map",
			"--allow-lossy",
			"--dry-run",
			"c8ctl element-template update io.camunda.connectors.HttpJson.v2 process.bpmn --dry-run",
			"--to io.camunda.connectors.HttpJson.v2@15 --in-place",
		]) {
			assert.ok(result.stdout.includes(text), `help must mention: ${text}`);
		}
	});
});

test("removes every temp dir it created", w.assertCleanedUp);
