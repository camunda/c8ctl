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
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	writeFileSync,
} from "node:fs";
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

		test("strips GLOBAL_FLAGS in `--flag=value` form", async () => {
			// stripGlobalFlags() and sliceArgvAfterVerb() both branch on the
			// `=` syntax. Without this case, a regression in either path
			// could silently leak `--profile=local` through to the plugin,
			// or break verb detection when the verb is preceded by a
			// `--flag=value`-shaped global.
			const result = await c8(
				"--profile=test-profile",
				"pass-through-cmd",
				"--from=URL",
			);
			assert.strictEqual(
				result.status,
				0,
				`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
			);
			const out = JSON.parse(result.stdout);
			assert.ok(
				!out.args.some((a: string) => a.startsWith("--profile")),
				`--profile=value must be stripped before forwarding. args=${JSON.stringify(out.args)}`,
			);
			assert.deepStrictEqual(
				out.args,
				["--from=URL"],
				"non-global --flag=value entries must be forwarded verbatim",
			);
		});

		test("verb-detection is robust when a string global flag's value equals the verb name", async () => {
			// Regression guard for sliceArgvAfterVerb(): when a string
			// global flag (e.g. --profile) takes a value that happens to
			// match the verb token (`pass-through-cmd`), the slicer must
			// consume the value as a flag-value and only treat the LATER
			// occurrence as the verb. If it didn't, we'd dispatch on the
			// flag-value and forward the real verb to the handler.
			const result = await c8(
				"--profile",
				"pass-through-cmd",
				"pass-through-cmd",
				"actual-positional",
			);
			assert.strictEqual(
				result.status,
				0,
				`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
			);
			const out = JSON.parse(result.stdout);
			assert.deepStrictEqual(
				out.args,
				["actual-positional"],
				`expected only the post-verb positional to reach the handler; the flag-value occurrence of the verb must not be forwarded. args=${JSON.stringify(out.args)}`,
			);
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

		test("handles a leading `--` separator before the verb (GNU convention)", async () => {
			// `c8ctl -- <verb> <args...>` is the GNU "end of options"
			// convention. The leading `--` must be skipped by the verb
			// slicer rather than causing it to bail with an empty post-verb
			// slice. Regression guard for sliceArgvAfterVerb().
			const result = await c8(
				"--",
				"pass-through-cmd",
				"arg1",
				"--from",
				"URL",
			);
			assert.strictEqual(
				result.status,
				0,
				`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
			);
			const out = JSON.parse(result.stdout);
			assert.deepStrictEqual(
				out.args,
				["arg1", "--from", "URL"],
				`leading -- must be consumed, post-verb args must reach the handler verbatim. args=${JSON.stringify(out.args)}`,
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

	describe("Duplicate command name policy (#363)", () => {
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

		// Class-scoped guard for the side-effect-free duplicate-name
		// rejection. The loader must check `loadedPlugins.has(name)`
		// BEFORE `await import(pluginUrl)` — otherwise a
		// duplicate-name plugin's module body still executes (running
		// any top-level side effects) only for the result to be
		// thrown away. The fixture under
		// `tests/fixtures/plugins/zzz-plugin-name-collider` declares
		// the same package.json#name as the canonical
		// `plugin-with-passthrough` fixture and writes a sentinel file
		// at module-evaluation time. After running c8ctl with both
		// installed, the sentinel must NOT exist.
		test("duplicate-name plugin's module body is never evaluated (no top-level side effects)", async () => {
			const dir = mkdtempSync(join(tmpdir(), "c8ctl-dup-sideeffect-"));
			writeFileSync(
				join(dir, "session.json"),
				JSON.stringify({ outputMode: "text" }),
			);
			const installRoot = join(dir, "plugins", "node_modules");
			const canonicalDst = join(installRoot, "plugin-with-passthrough");
			mkdirSync(canonicalDst, { recursive: true });
			cpSync(FIXTURE_DIR, canonicalDst, { recursive: true });
			const colliderSrc = join(
				__dirname,
				"../fixtures/plugins/zzz-plugin-name-collider",
			);
			const colliderDst = join(installRoot, "zzz-plugin-name-collider");
			mkdirSync(colliderDst, { recursive: true });
			cpSync(colliderSrc, colliderDst, { recursive: true });

			const sentinelPath = join(dir, "duplicate-side-effect.sentinel");

			const result = await asyncSpawn(
				"node",
				["--experimental-strip-types", CLI, "pass-through-cmd", "probe"],
				{
					env: {
						...process.env,
						CAMUNDA_BASE_URL: "http://test-cluster/v2",
						HOME: "/tmp/c8ctl-dup-sideeffect-nonexistent-home",
						C8CTL_DATA_DIR: dir,
						C8CTL_TEST_DUP_SIDE_EFFECT_SENTINEL: sentinelPath,
					},
				},
			);
			assert.strictEqual(
				result.status,
				0,
				`expected exit 0; stderr: ${result.stderr}`,
			);
			assert.ok(
				!existsSync(sentinelPath),
				`duplicate-name plugin's module body must not be evaluated, but the sentinel file was created at ${sentinelPath}. The loader is importing the duplicate before checking loadedPlugins.has(name).`,
			);
		});
	});

	describe("Shell completion (#366 — passthrough verbs)", () => {
		// Class-scoped guard: c8ctl cannot know what flags the wrapped
		// external tool accepts, so for any verb that opted into the
		// passthrough contract the completion generators must (a) offer
		// file completion at the resource position and (b) restrict
		// flag completion to GLOBAL_FLAGS only. The fixture's
		// `pass-through-cmd` exercises this — if the gate ever stops
		// honouring `passthrough: true` these tests fail.

		test("bash completion offers file completion for the passthrough verb", async () => {
			const result = await c8("completion", "bash");
			assert.strictEqual(result.status, 0);
			assert.ok(
				/pass-through-cmd\)\s*\n\s*COMPREPLY=\(\s*\$\(compgen -f /.test(
					result.stdout,
				),
				`bash completion must use file completion for passthrough verbs. stdout did not match.`,
			);
		});

		// Class-scoped guard: the bash file-completion case branch must
		// include verb aliases too, not just the canonical verb. This
		// covers fileComplete aliases (e.g. `w` → `watch`) and any
		// future passthrough verbs that declare aliases. Without
		// alias support, `c8ctl w <TAB>` would fall through to the
		// generic `*)` arm and offer the wrong completion set.
		test("bash file-completion case branch includes verb aliases (e.g. w → watch)", async () => {
			const result = await c8("completion", "bash");
			assert.strictEqual(result.status, 0);
			// The watch verb has alias `w`. Both must appear in a single
			// alternation pattern that maps to compgen -f.
			assert.ok(
				/watch\|w\)\s*\n\s*COMPREPLY=\(\s*\$\(compgen -f /.test(result.stdout),
				`bash completion for fileComplete verb 'watch' must include its alias 'w' in the case pattern. stdout did not match.`,
			);
		});

		test("bash completion restricts flag completion to GLOBAL_FLAGS for passthrough verbs", async () => {
			const result = await c8("completion", "bash");
			assert.strictEqual(result.status, 0);
			assert.ok(
				/passthrough_verbs="[^"]*pass-through-cmd[^"]*"/.test(result.stdout),
				`bash completion must list passthrough verbs in passthrough_verbs. stdout did not match.`,
			);
			assert.ok(
				/local global_flags=/.test(result.stdout) &&
					/flag_set="\$\{global_flags\}"/.test(result.stdout),
				`bash completion must switch to \${global_flags} when current verb is a passthrough verb.`,
			);
		});

		test("zsh completion uses _files for the passthrough verb", async () => {
			const result = await c8("completion", "zsh");
			assert.strictEqual(result.status, 0);
			assert.ok(
				/pass-through-cmd\)\s*\n\s*_files\s*\n\s*;;/.test(result.stdout),
				`zsh completion must use _files for passthrough verbs. stdout did not match.`,
			);
		});

		test("zsh completion exposes a global_flags array and routes passthrough verbs to it", async () => {
			const result = await c8("completion", "zsh");
			assert.strictEqual(result.status, 0);
			assert.ok(
				/global_flags=\(/.test(result.stdout),
				`zsh completion must declare a global_flags array.`,
			);
			assert.ok(
				/pass-through-cmd\) _arguments \$\{global_flags\[@\]\}/.test(
					result.stdout,
				),
				`zsh completion must route passthrough verbs to _arguments \${global_flags[@]}.`,
			);
		});

		test("fish completion offers file completion (-F) for the passthrough verb", async () => {
			const result = await c8("completion", "fish");
			assert.strictEqual(result.status, 0);
			assert.ok(
				/__fish_seen_subcommand_from pass-through-cmd' -F/.test(result.stdout),
				`fish completion must offer file completion (-F) for passthrough verbs. stdout did not match.`,
			);
		});

		// Class-scoped guard: the fish fileComplete branch must also emit
		// `complete -F`, not only the passthrough branch. Previously the
		// fish generator silently skipped fileComplete verbs, so users
		// got the generic verb list at the resource position instead of
		// file completion. bash and zsh already handled this; fish now
		// does too. (The fileComplete set is derived in deriveVerbInfos
		// from `!requiresResource && resources.length === 0` — currently
		// `deploy` and `watch`. `run` takes a positional path but is
		// classified as requiresResource, so it falls outside this set.)
		test("fish completion offers file completion (-F) for fileComplete verbs (deploy/watch)", async () => {
			const result = await c8("completion", "fish");
			assert.strictEqual(result.status, 0);
			for (const verb of ["deploy", "watch"]) {
				assert.ok(
					new RegExp(`__fish_seen_subcommand_from ${verb}[^']*' -F`).test(
						result.stdout,
					),
					`fish completion must offer file completion (-F) for fileComplete verb '${verb}'. stdout did not match.`,
				);
			}
		});

		// Class-scoped guard for the fish flag-completion contract under
		// passthrough verbs. bash and zsh switch to a globals-only flag
		// set; fish achieves the same thing by gating every non-global
		// flag with a `not __fish_seen_subcommand_from <pt> ...`
		// predicate. If any non-global flag escapes that predicate the
		// passthrough contract is broken — c8ctl would suggest its own
		// per-command flags instead of the wrapped tool's.
		test("fish completion suppresses non-global flags under passthrough verbs", async () => {
			const result = await c8("completion", "fish");
			assert.strictEqual(result.status, 0);

			// Pick a flag that exists somewhere in the registry but is
			// definitely not in GLOBAL_FLAGS. `--variables` is owned by
			// `run` and is NOT a global.
			const nonGlobalFlag = "variables";
			const lines = result.stdout
				.split("\n")
				.filter(
					(l) =>
						l.startsWith("complete -c c8") && l.includes(`-l ${nonGlobalFlag}`),
				);
			assert.ok(
				lines.length > 0,
				`expected at least one fish completion line for --${nonGlobalFlag}`,
			);
			for (const line of lines) {
				assert.ok(
					line.includes("-n 'not __fish_seen_subcommand_from pass-through-cmd"),
					`every fish completion for non-global flag '--${nonGlobalFlag}' must be gated against passthrough verbs. line was: ${line}`,
				);
			}
		});

		test("fish completion offers global flags unconditionally", async () => {
			const result = await c8("completion", "fish");
			assert.strictEqual(result.status, 0);
			// `--profile` is a GLOBAL_FLAG. Its fish completion line(s)
			// must NOT carry the passthrough guard — globals stay
			// available even after the user types a passthrough verb.
			const lines = result.stdout
				.split("\n")
				.filter(
					(l) => l.startsWith("complete -c c8") && l.includes("-l profile"),
				);
			assert.ok(lines.length > 0, "expected fish completion for --profile");
			for (const line of lines) {
				assert.ok(
					!line.includes("__fish_seen_subcommand_from"),
					`global flag '--profile' must not be guarded by __fish_seen_subcommand_from. line was: ${line}`,
				);
			}
		});
	});
});
