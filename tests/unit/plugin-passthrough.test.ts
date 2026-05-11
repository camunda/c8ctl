/**
 * Tests for the passthrough plugin contract (#366).
 *
 * The contract:
 * - A plugin command is **either** metadata-driven (declares typed `flags`)
 *   **or** passthrough (`passthrough: true` + `passthroughHint`). Mutually
 *   exclusive — declaring both must be rejected at load time.
 * - Passthrough dispatch: c8ctl strips GLOBAL_FLAGS from argv (they apply
 *   to the c8ctl runtime via `globalThis.c8ctl.*`) and forwards everything
 *   else verbatim to the bare-function handler.
 * - `c8ctl help <passthrough-cmd>` renders a clearly-formatted "Passthrough
 *   command" banner including the `passthroughHint` and any `flagsHint`.
 * - `c8ctl help <passthrough-cmd> --output json` returns a structured
 *   record with `kind: "passthrough"` so agents detect the boundary.
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
const FIXTURE_DIR = join(
	__dirname,
	"../fixtures/plugins/plugin-with-passthrough",
);
const CONFLICTING_FIXTURE_DIR = join(
	__dirname,
	"../fixtures/plugins/zzz-plugin-conflicting",
);

function makePluginDataDir(
	extraFixtures: { name: string; src: string }[] = [],
) {
	const dir = mkdtempSync(join(tmpdir(), "c8ctl-passthrough-test-"));
	writeFileSync(
		join(dir, "session.json"),
		JSON.stringify({ outputMode: "text" }),
	);
	const installRoot = join(dir, "plugins", "node_modules");
	const pluginInstallDir = join(installRoot, "plugin-with-passthrough");
	mkdirSync(pluginInstallDir, { recursive: true });
	cpSync(FIXTURE_DIR, pluginInstallDir, { recursive: true });
	for (const { name, src } of extraFixtures) {
		const dst = join(installRoot, name);
		mkdirSync(dst, { recursive: true });
		cpSync(src, dst, { recursive: true });
	}
	return dir;
}

const PLUGIN_DATA_DIR = makePluginDataDir();
const CONFLICT_DATA_DIR = makePluginDataDir([
	{ name: "zzz-plugin-conflicting", src: CONFLICTING_FIXTURE_DIR },
]);

async function c8(...args: string[]) {
	return asyncSpawn("node", ["--experimental-strip-types", CLI, ...args], {
		env: {
			...process.env,
			CAMUNDA_BASE_URL: "http://test-cluster/v2",
			HOME: "/tmp/c8ctl-passthrough-test-nonexistent-home",
			C8CTL_DATA_DIR: PLUGIN_DATA_DIR,
		},
	});
}

async function c8WithConflict(...args: string[]) {
	return asyncSpawn("node", ["--experimental-strip-types", CLI, ...args], {
		env: {
			...process.env,
			CAMUNDA_BASE_URL: "http://test-cluster/v2",
			HOME: "/tmp/c8ctl-passthrough-test-nonexistent-home",
			C8CTL_DATA_DIR: CONFLICT_DATA_DIR,
		},
	});
}

describe("Passthrough plugin contract (#366)", () => {
	describe("Dispatch", () => {
		test("forwards positional args verbatim to the handler", async () => {
			const result = await c8("pass-through-cmd", "subcmd", "value");
			assert.strictEqual(
				result.status,
				0,
				`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
			);
			const out = JSON.parse(result.stdout);
			assert.deepStrictEqual(
				out.args,
				["subcmd", "value"],
				"positional args must be forwarded unchanged",
			);
		});

		test("forwards unknown flags verbatim to the handler", async () => {
			const result = await c8(
				"pass-through-cmd",
				"--from",
				"URL",
				"--dry",
				"target-arg",
			);
			assert.strictEqual(
				result.status,
				0,
				`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
			);
			const out = JSON.parse(result.stdout);
			assert.deepStrictEqual(
				out.args,
				["--from", "URL", "--dry", "target-arg"],
				"unknown flags must reach the plugin handler unchanged",
			);
		});

		test("strips GLOBAL_FLAGS from forwarded args (boolean flag)", async () => {
			const result = await c8("pass-through-cmd", "--verbose", "--from", "URL");
			assert.strictEqual(
				result.status,
				0,
				`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
			);
			const out = JSON.parse(result.stdout);
			assert.ok(
				!out.args.includes("--verbose"),
				`--verbose (a GLOBAL_FLAG) must be stripped before forwarding. args=${JSON.stringify(out.args)}`,
			);
			assert.deepStrictEqual(
				out.args,
				["--from", "URL"],
				"non-global args must remain in order after stripping",
			);
		});

		test("strips GLOBAL_FLAGS from forwarded args (string flag with value)", async () => {
			const result = await c8(
				"pass-through-cmd",
				"--profile",
				"local",
				"--from",
				"URL",
			);
			assert.strictEqual(
				result.status,
				0,
				`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
			);
			const out = JSON.parse(result.stdout);
			assert.ok(
				!out.args.includes("--profile"),
				"--profile (a GLOBAL_FLAG) must be stripped",
			);
			assert.ok(
				!out.args.includes("local"),
				"the value following --profile must be stripped too",
			);
			assert.deepStrictEqual(out.args, ["--from", "URL"]);
		});

		test("strips --json (a GLOBAL_FLAG) but applies its effect to the runtime", async () => {
			// --json must be stripped from args reaching the plugin, AND it must
			// switch c8ctl.outputMode to json (which the bare-function plugin
			// here ignores — but the global override wiring still runs). The
			// args must not contain --json.
			const result = await c8("pass-through-cmd", "--json", "subcmd");
			assert.strictEqual(
				result.status,
				0,
				`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
			);
			const out = JSON.parse(result.stdout);
			assert.ok(
				!out.args.includes("--json"),
				"--json must be stripped before forwarding",
			);
			assert.deepStrictEqual(out.args, ["subcmd"]);
		});

		test("forwards `--` and everything after it verbatim", async () => {
			const result = await c8(
				"pass-through-cmd",
				"--",
				"--profile",
				"this-should-not-be-stripped",
			);
			assert.strictEqual(
				result.status,
				0,
				`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
			);
			const out = JSON.parse(result.stdout);
			assert.ok(
				out.args.includes("--profile") &&
					out.args.includes("this-should-not-be-stripped"),
				`args after -- must be forwarded verbatim. args=${JSON.stringify(out.args)}`,
			);
		});
	});

	describe("Load-time validation", () => {
		test("a command declaring both passthrough:true AND flags is rejected and unreachable", async () => {
			// The fixture's `bad-passthrough-with-flags` command violates the
			// mutual-exclusion rule. After load-time validation it must NOT
			// be registered; invoking it must produce the standard
			// unknown-command error path.
			const result = await c8("bad-passthrough-with-flags", "--something", "x");
			assert.notStrictEqual(
				result.status,
				0,
				`expected non-zero exit (unknown command), got ${result.status}. stdout: ${result.stdout}`,
			);
			// And the user must see why — at minimum a debug/warn line on stderr
			// during plugin load that mentions the rejected command.
			assert.ok(
				/passthrough.*flags|flags.*passthrough|bad-passthrough-with-flags/i.test(
					result.stderr,
				),
				`expected validation message about the conflicting passthrough+flags combination on stderr. stderr: ${result.stderr}`,
			);
		});
	});

	describe("Help rendering — text mode", () => {
		test("`c8 help <passthrough-cmd>` includes a Passthrough banner with the hint", async () => {
			const result = await c8("help", "pass-through-cmd");
			assert.strictEqual(
				result.status,
				0,
				`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
			);
			assert.ok(
				/passthrough command/i.test(result.stdout),
				`help must include a 'Passthrough command' banner. stdout: ${result.stdout}`,
			);
			assert.ok(
				result.stdout.includes("Forwards args to `external-tool`"),
				`help must include the passthroughHint text. stdout: ${result.stdout}`,
			);
		});

		test("`c8 help <passthrough-cmd>` lists flagsHint when present", async () => {
			const result = await c8("help", "pass-through-cmd");
			assert.strictEqual(result.status, 0);
			assert.ok(
				result.stdout.includes("--from <url>"),
				`flagsHint entries must appear in help. stdout: ${result.stdout}`,
			);
		});
	});

	describe("Help rendering — JSON mode", () => {
		test("`c8 help <passthrough-cmd> --json` returns kind: 'passthrough'", async () => {
			const result = await c8("--json", "help", "pass-through-cmd");
			assert.strictEqual(
				result.status,
				0,
				`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
			);
			const json = JSON.parse(result.stdout);
			assert.strictEqual(
				json.kind,
				"passthrough",
				`JSON help must carry kind:"passthrough" so agents detect the boundary. got: ${JSON.stringify(json)}`,
			);
			assert.strictEqual(
				json.passthroughHint,
				"Forwards args to `external-tool`",
				"passthroughHint must be present in the JSON help payload",
			);
			assert.deepStrictEqual(
				json.flagsHint,
				["--from <url>", "--to <path>", "--dry"],
				"flagsHint must be present in the JSON help payload",
			);
		});

		test("passthrough JSON help carries the same envelope as standard JSON help", async () => {
			// The shape contract: passthrough JSON help adds a `kind` and
			// passthrough-specific fields, but it must NOT omit the standard
			// `globalFlags` / `searchFlags` / `agentFlags` envelope that
			// callers and agents rely on for every help payload.
			const result = await c8("--json", "help", "pass-through-cmd");
			assert.strictEqual(result.status, 0);
			const json = JSON.parse(result.stdout);
			assert.ok(
				json.globalFlags && typeof json.globalFlags === "object",
				`passthrough JSON help must include globalFlags. got: ${JSON.stringify(json)}`,
			);
			assert.ok(
				json.searchFlags && typeof json.searchFlags === "object",
				`passthrough JSON help must include searchFlags. got: ${JSON.stringify(json)}`,
			);
			assert.ok(
				json.agentFlags && typeof json.agentFlags === "object",
				`passthrough JSON help must include agentFlags. got: ${JSON.stringify(json)}`,
			);
		});
	});

	describe("Duplicate command name policy (#366)", () => {
		// Class-scoped guard: c8ctl resolves plugin command-name conflicts
		// with explicit "first registration wins" semantics. This replaces
		// the previous implicit "last-loaded wins" Object.assign merge. The
		// fixture set in CONFLICT_DATA_DIR has both `plugin-with-passthrough`
		// (loads first; alphabetically earlier) and `zzz-plugin-conflicting`
		// (loads second), each declaring a `pass-through-cmd` handler that
		// prints a unique `from` field. The winning handler's payload
		// proves which plugin actually got dispatched.
		test("first registration wins; the loser's handler is unreachable", async () => {
			const result = await c8WithConflict("pass-through-cmd", "probe");
			assert.strictEqual(
				result.status,
				0,
				`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
			);
			const out = JSON.parse(result.stdout);
			assert.strictEqual(
				out.from,
				undefined,
				"the winning fixture (plugin-with-passthrough) must respond, " +
					`not the losing one. got: ${result.stdout}`,
			);
			assert.deepStrictEqual(out.args, ["probe"]);
		});

		test("the dropped duplicate is reported on stderr at load time", async () => {
			const result = await c8WithConflict("pass-through-cmd", "probe");
			assert.strictEqual(result.status, 0);
			assert.ok(
				/zzz-plugin-conflicting/.test(result.stderr) &&
					/pass-through-cmd/.test(result.stderr) &&
					/duplicate|already/i.test(result.stderr),
				`expected a load-time warning naming the losing plugin and the conflicting command. stderr: ${result.stderr}`,
			);
		});
	});
});
