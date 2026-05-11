/**
 * Tests for `c8ctl list plugin` collision summary (#363).
 *
 * The full per-collision breakdown lives in `c8ctl doctor plugin`.
 * `list plugin` is the verb users reach for first when they want to
 * inspect installed plugins, so the policy here is: surface a brief
 * stderr summary pointing at `doctor plugin`. The JSON shape of
 * `list plugin --json` (a plain array) must not change so existing
 * scripted callers keep working.
 *
 * Class-scoped guards:
 * - With no collisions, the summary line is absent.
 * - With a command-name collision, stderr names the collision count
 *   and points at `doctor plugin`.
 * - With a plugin-name collision, stderr names that count too.
 * - In `--json` mode the stdout payload remains a plain array
 *   (no extra `collisions` field appended) so the contract is
 *   preserved.
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
	const dir = mkdtempSync(join(tmpdir(), "c8ctl-list-collisions-"));
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

async function runListPlugin(
	dataDir: string,
	extraArgs: string[] = [],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return asyncSpawn(
		"node",
		["--experimental-strip-types", CLI, "list", "plugin", ...extraArgs],
		{
			env: {
				...process.env,
				CAMUNDA_BASE_URL: "http://test-cluster/v2",
				HOME: "/tmp/c8ctl-list-collisions-nonexistent-home",
				C8CTL_DATA_DIR: dataDir,
			},
		},
	);
}

describe("c8ctl list plugin — collision summary (#363)", () => {
	describe("No collisions", () => {
		const DATA_DIR = makeDataDir();

		test("no collision summary appears on stderr", async () => {
			const result = await runListPlugin(DATA_DIR);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			assert.ok(
				!/collision/i.test(result.stderr),
				`stderr must not mention collisions when there are none. stderr: ${result.stderr}`,
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

		test("stderr summarises command-name collision and points at doctor plugin", async () => {
			const result = await runListPlugin(DATA_DIR);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			assert.ok(
				/command-name collision/i.test(result.stderr),
				`expected command-name collision summary on stderr. stderr: ${result.stderr}`,
			);
			assert.ok(
				/doctor plugin/.test(result.stderr),
				`summary must point at doctor plugin. stderr: ${result.stderr}`,
			);
		});

		test("--json stdout payload remains a plain array (no shape change)", async () => {
			const result = await runListPlugin(DATA_DIR, ["--json"]);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			// biome-ignore lint/plugin: parsed-JSON contract boundary; shape asserted below
			const parsed = JSON.parse(result.stdout) as unknown;
			assert.ok(
				Array.isArray(parsed),
				`list plugin --json must remain a plain array; got: ${result.stdout}`,
			);
			// Collision summary still goes to stderr in JSON mode so the
			// stdout payload is unchanged but the user is still warned.
			assert.ok(
				/collision/i.test(result.stderr),
				`collision summary must still surface on stderr in JSON mode. stderr: ${result.stderr}`,
			);
		});
	});

	describe("Plugin-name collision", () => {
		const DATA_DIR = makeDataDir([
			{
				installDirName: "zzz-plugin-name-collider",
				src: NAME_COLLIDER_FIXTURE_DIR,
			},
		]);

		test("stderr summarises plugin-name collision", async () => {
			const result = await runListPlugin(DATA_DIR);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			assert.ok(
				/plugin-name collision/i.test(result.stderr),
				`expected plugin-name collision summary on stderr. stderr: ${result.stderr}`,
			);
		});
	});
});
