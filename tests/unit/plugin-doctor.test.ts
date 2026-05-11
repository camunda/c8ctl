/**
 * Tests for `c8ctl doctor plugin` (#363) — surfaces plugin-loading
 * collisions detected at startup.
 *
 * Class-scoped guards:
 * - With no collisions, doctor reports loaded plugins and "no
 *   collisions detected".
 * - With a command-name collision, doctor reports the winner, the
 *   loser, the affected command, and `kind: "command-name"`.
 * - With a plugin-name collision (same `package.json#name`), doctor
 *   reports the duplicate name and `kind: "plugin-name"`.
 * - The `--json` form is structured so it can be piped into `jq`.
 *
 * Together these encode the visibility contract of #363: every
 * dropped plugin or command is recoverable on demand even if the
 * load-time `logger.warn` was missed.
 */

import assert from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { asyncSpawn } from "../utils/spawn.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = "src/index.ts";

const PASSTHROUGH_FIXTURE_DIR = join(
	__dirname,
	"../fixtures/plugins/plugin-with-passthrough",
);
const COMMAND_CONFLICT_FIXTURE_DIR = join(
	__dirname,
	"../fixtures/plugins/zzz-plugin-conflicting",
);
const NAME_COLLIDER_FIXTURE_DIR = join(
	__dirname,
	"../fixtures/plugins/zzz-plugin-name-collider",
);

function makeDataDir(
	extraFixtures: { installDirName: string; src: string }[] = [],
) {
	const dir = mkdtempSync(join(tmpdir(), "c8ctl-doctor-test-"));
	writeFileSync(
		join(dir, "session.json"),
		JSON.stringify({ outputMode: "text" }),
	);
	const installRoot = join(dir, "plugins", "node_modules");
	const baseDst = join(installRoot, "plugin-with-passthrough");
	mkdirSync(baseDst, { recursive: true });
	cpSync(PASSTHROUGH_FIXTURE_DIR, baseDst, { recursive: true });
	for (const { installDirName, src } of extraFixtures) {
		const dst = join(installRoot, installDirName);
		mkdirSync(dst, { recursive: true });
		cpSync(src, dst, { recursive: true });
	}
	return dir;
}

async function runDoctor(
	dataDir: string,
	extraArgs: string[] = [],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return asyncSpawn(
		"node",
		["--experimental-strip-types", CLI, "doctor", "plugin", ...extraArgs],
		{
			env: {
				...process.env,
				CAMUNDA_BASE_URL: "http://test-cluster/v2",
				HOME: "/tmp/c8ctl-doctor-test-nonexistent-home",
				C8CTL_DATA_DIR: dataDir,
			},
		},
	);
}

interface DoctorReport {
	loaded: { name: string; commands: string[] }[];
	collisions: {
		kind: "command-name" | "plugin-name";
		winner: string;
		loser: string;
		command?: string;
	}[];
}

function parseDoctorJson(stdout: string): DoctorReport {
	// biome-ignore lint/plugin: parsed-JSON contract boundary; shape asserted by callers
	const parsed = JSON.parse(stdout) as DoctorReport;
	return parsed;
}

describe("c8ctl doctor plugin (#363)", () => {
	describe("No collisions", () => {
		const DATA_DIR = makeDataDir();

		test("text output names every loaded plugin and reports no collisions", async () => {
			const result = await runDoctor(DATA_DIR);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			assert.match(
				result.stdout,
				/Loaded plugins/,
				"expected a Loaded plugins header",
			);
			assert.match(
				result.stdout,
				/plugin-with-passthrough/,
				"expected the canonical plugin to be listed",
			);
			assert.match(
				result.stdout,
				/No plugin collisions detected/,
				"expected explicit no-collisions message",
			);
		});

		test("json output shape: { loaded[], collisions[] }", async () => {
			const result = await runDoctor(DATA_DIR, ["--json"]);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			const report = parseDoctorJson(result.stdout);
			assert.ok(Array.isArray(report.loaded), "loaded must be an array");
			assert.ok(
				Array.isArray(report.collisions),
				"collisions must be an array",
			);
			assert.strictEqual(report.collisions.length, 0);
			const passthroughEntry = report.loaded.find(
				(p) => p.name === "plugin-with-passthrough",
			);
			assert.ok(
				passthroughEntry,
				`plugin-with-passthrough should be in loaded list; got ${JSON.stringify(report.loaded)}`,
			);
			assert.ok(
				passthroughEntry.commands.includes("pass-through-cmd"),
				"pass-through-cmd should be among the registered commands",
			);
		});
	});

	describe("Command-name collision", () => {
		const DATA_DIR = makeDataDir([
			{
				installDirName: "zzz-plugin-conflicting",
				src: COMMAND_CONFLICT_FIXTURE_DIR,
			},
		]);

		test("doctor reports the dropped command with kind=command-name", async () => {
			const result = await runDoctor(DATA_DIR, ["--json"]);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			const report = parseDoctorJson(result.stdout);
			const commandCollisions = report.collisions.filter(
				(c) => c.kind === "command-name",
			);
			assert.ok(
				commandCollisions.length >= 1,
				`expected at least one command-name collision; got ${JSON.stringify(report.collisions)}`,
			);
			const collision = commandCollisions.find(
				(c) => c.command === "pass-through-cmd",
			);
			assert.ok(
				collision,
				`expected the pass-through-cmd command-name collision; got ${JSON.stringify(commandCollisions)}`,
			);
			assert.strictEqual(collision.winner, "plugin-with-passthrough");
			assert.strictEqual(collision.loser, "zzz-plugin-conflicting");
		});

		test("doctor text output names winner, loser, and command", async () => {
			const result = await runDoctor(DATA_DIR);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			assert.match(
				result.stdout,
				/Detected collisions/,
				"expected a Detected collisions header",
			);
			assert.match(result.stdout, /command-name/);
			assert.match(result.stdout, /plugin-with-passthrough/);
			assert.match(result.stdout, /zzz-plugin-conflicting/);
			assert.match(result.stdout, /pass-through-cmd/);
		});
	});

	describe("Plugin-name collision", () => {
		const DATA_DIR = makeDataDir([
			{
				installDirName: "zzz-plugin-name-collider",
				src: NAME_COLLIDER_FIXTURE_DIR,
			},
		]);

		test("doctor reports the duplicate plugin name with kind=plugin-name", async () => {
			const result = await runDoctor(DATA_DIR, ["--json"]);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			const report = parseDoctorJson(result.stdout);
			const nameCollisions = report.collisions.filter(
				(c) => c.kind === "plugin-name",
			);
			assert.ok(
				nameCollisions.length >= 1,
				`expected at least one plugin-name collision; got ${JSON.stringify(report.collisions)}`,
			);
			const collision = nameCollisions.find(
				(c) => c.winner === "plugin-with-passthrough",
			);
			assert.ok(
				collision,
				`expected a plugin-name collision naming plugin-with-passthrough; got ${JSON.stringify(nameCollisions)}`,
			);
			assert.strictEqual(collision.loser, "plugin-with-passthrough");
			assert.strictEqual(collision.command, undefined);
		});

		test("doctor text output names the duplicate plugin name", async () => {
			const result = await runDoctor(DATA_DIR);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			assert.match(result.stdout, /plugin-name/);
			assert.match(result.stdout, /plugin-with-passthrough/);
		});
	});

	describe("Exit code policy", () => {
		// The doctor reports state, it does not enforce policy. Exit
		// code must remain 0 even when collisions exist so scripted
		// callers can pipe `--json` output into `jq` without
		// `set -e` aborting them.
		test("exit code is 0 even when collisions are present", async () => {
			const dir = makeDataDir([
				{
					installDirName: "zzz-plugin-conflicting",
					src: COMMAND_CONFLICT_FIXTURE_DIR,
				},
			]);
			const result = await runDoctor(dir);
			assert.strictEqual(
				result.status,
				0,
				`expected exit 0 with collisions present; stderr: ${result.stderr}`,
			);
		});
	});
});
