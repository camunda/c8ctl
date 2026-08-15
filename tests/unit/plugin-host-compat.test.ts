/**
 * Tests for the plugin → host version contract (#523): a plugin declares the
 * c8ctl it needs via `engines.c8ctl`, and c8ctl enforces it.
 *
 * Class-scoped guards:
 * - A plugin that declares nothing is `undeclared` — the pre-#523 behaviour,
 *   which must stay untouched for every plugin already published.
 * - A host below the declared floor is `incompatible`, and the message names
 *   the requirement, the running version, and the way out.
 * - Prereleases order the way semver says they do, so a plugin needing
 *   `>=4.0.0-alpha.1` is not "satisfied" by 3.3.0 and is not held back by
 *   4.0.0 — this is the exact pairing that motivated the issue.
 * - An unpublished development build and an unreadable range both fail *open*
 *   (`unverifiable`): c8ctl never disables a plugin because it could not
 *   evaluate the question.
 * - On an unmet requirement the loader keeps the plugin (and its place in help)
 *   but every command refuses to run — both command forms, `{ flags, handler }`
 *   included, since a command that lost its flags would fail with a parse error
 *   rather than the explanation.
 * - `doctor plugin` can recover all of it after the fact, in text and JSON.
 */

import assert from "node:assert";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	checkHostCompat,
	readHostRequirement,
	satisfiesRange,
} from "../../src/framework/plugins/plugin-compat.ts";
import {
	clearLoadedPlugins,
	getPluginCollisions,
	getPluginCommands,
	getPluginIncompatibilities,
	loadInstalledPlugins,
} from "../../src/framework/plugins/plugin-loader.ts";
import { asyncSpawn } from "../utils/spawn.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = "src/index.ts";
const FIXTURE_DIR = join(
	__dirname,
	"../fixtures/plugins/plugin-with-host-requirement",
);
const PLUGIN_NAME = "c8ctl-plugin-host-requirement";

/** Every data dir staged by this file, removed in `after`. */
const stagedDirs: string[] = [];

after(() => {
	for (const dir of stagedDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Stage a plugin in a throwaway data dir, optionally rewriting the declared
 * range. Rewriting beats carrying one fixture per range: the declaration is the
 * variable under test, and every other file stays identical.
 *
 * `installDirName` exists for the collision cases, where load order matters —
 * the loader scans `node_modules` lexicographically, so the directory name is
 * what decides who loads first.
 */
function stagePlugin(
	declaredRange?: string | null,
	{
		installDirName = PLUGIN_NAME,
		pluginName = PLUGIN_NAME,
		dataDir = mkdtempSync(join(tmpdir(), "c8ctl-host-compat-")),
	}: {
		installDirName?: string;
		pluginName?: string;
		dataDir?: string;
	} = {},
): string {
	if (!stagedDirs.includes(dataDir)) stagedDirs.push(dataDir);
	writeFileSync(
		join(dataDir, "session.json"),
		JSON.stringify({ outputMode: "text" }),
	);
	const installDir = join(dataDir, "plugins", "node_modules", installDirName);
	mkdirSync(installDir, { recursive: true });
	cpSync(FIXTURE_DIR, installDir, { recursive: true });

	if (declaredRange !== undefined || pluginName !== PLUGIN_NAME) {
		const manifestPath = join(installDir, "package.json");
		const manifest = {
			name: pluginName,
			version: "2.1.0",
			type: "module",
			main: "c8ctl-plugin.js",
			keywords: ["c8ctl-plugin"],
			...(declaredRange === null || declaredRange === undefined
				? {}
				: { engines: { c8ctl: declaredRange } }),
		};
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	}
	return dataDir;
}

/**
 * A copy of the fixture *package* (not an installed store) with its declared
 * range rewritten — an install source for `load plugin --from file://…`.
 */
function stageFixtureCopy(declaredRange: string): string {
	const dir = mkdtempSync(join(tmpdir(), "c8ctl-host-compat-src-"));
	stagedDirs.push(dir);
	cpSync(FIXTURE_DIR, dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify(
			{
				name: PLUGIN_NAME,
				version: "2.1.0",
				type: "module",
				main: "c8ctl-plugin.js",
				keywords: ["c8ctl-plugin"],
				engines: { c8ctl: declaredRange },
			},
			null,
			2,
		),
	);
	return dir;
}

describe("readHostRequirement", () => {
	test("reads engines.c8ctl", () => {
		assert.equal(
			readHostRequirement({ engines: { c8ctl: ">=4.0.0-alpha.1" } }),
			">=4.0.0-alpha.1",
		);
	});

	test("trims surrounding whitespace", () => {
		assert.equal(
			readHostRequirement({ engines: { c8ctl: "  >=3.0.0 " } }),
			">=3.0.0",
		);
	});

	test("returns null when nothing is declared", () => {
		assert.equal(readHostRequirement({ engines: { node: ">=22" } }), null);
		assert.equal(readHostRequirement({ engines: {} }), null);
		assert.equal(readHostRequirement({}), null);
	});

	test("returns null for non-string and empty declarations", () => {
		assert.equal(readHostRequirement({ engines: { c8ctl: 4 } }), null);
		assert.equal(readHostRequirement({ engines: { c8ctl: "" } }), null);
		assert.equal(readHostRequirement({ engines: { c8ctl: "   " } }), null);
	});

	test("survives a package.json that is not an object", () => {
		assert.equal(readHostRequirement(null), null);
		assert.equal(readHostRequirement("not json"), null);
		assert.equal(readHostRequirement({ engines: "broken" }), null);
	});
});

describe("satisfiesRange", () => {
	const cases: {
		range: string;
		satisfied: string[];
		unsatisfied: string[];
	}[] = [
		{
			range: ">=4.0.0-alpha.1",
			satisfied: ["4.0.0-alpha.1", "4.0.0-alpha.2", "4.0.0", "4.1.0", "5.0.0"],
			unsatisfied: ["3.3.0", "3.4.0-alpha.3", "0.9.0"],
		},
		{
			range: ">=3.3.0",
			// A prerelease sorts below its own release, so 3.3.0-alpha.10 does
			// not satisfy a >=3.3.0 floor.
			satisfied: ["3.3.0", "3.3.1", "4.0.0-alpha.1"],
			unsatisfied: ["3.3.0-alpha.10", "3.2.9"],
		},
		{
			range: ">3.3.0",
			satisfied: ["3.3.1", "4.0.0"],
			unsatisfied: ["3.3.0", "3.2.0"],
		},
		{
			range: "<4.0.0",
			satisfied: ["3.9.9", "4.0.0-alpha.1"],
			unsatisfied: ["4.0.0", "4.0.1"],
		},
		{
			range: "<=3.3.0",
			satisfied: ["3.3.0", "3.2.0"],
			unsatisfied: ["3.3.1"],
		},
		{
			range: "3.3.0",
			satisfied: ["3.3.0"],
			unsatisfied: ["3.3.1", "3.2.9"],
		},
		{
			range: "=3.3.0",
			satisfied: ["3.3.0"],
			unsatisfied: ["3.4.0"],
		},
		{
			range: "^4.1.0",
			satisfied: ["4.1.0", "4.2.0", "4.9.9"],
			unsatisfied: ["4.0.9", "5.0.0", "3.9.0"],
		},
		{
			// npm's 0.x caret semantics: the minor is the breaking axis.
			range: "^0.2.1",
			satisfied: ["0.2.1", "0.2.9"],
			unsatisfied: ["0.3.0", "0.2.0"],
		},
		{
			range: "~4.1.0",
			satisfied: ["4.1.0", "4.1.9"],
			unsatisfied: ["4.2.0", "4.0.9"],
		},
		{
			range: "*",
			satisfied: ["0.0.1", "3.3.0", "99.0.0"],
			unsatisfied: [],
		},
		{
			// Multiple comparators are ANDed, like npm.
			range: ">=3.3.0 <5.0.0",
			satisfied: ["3.3.0", "4.9.9"],
			unsatisfied: ["3.2.0", "5.0.0"],
		},
	];

	for (const { range, satisfied, unsatisfied } of cases) {
		for (const version of satisfied) {
			test(`'${range}' is satisfied by ${version}`, () => {
				assert.equal(satisfiesRange({ version, range }), true);
			});
		}
		for (const version of unsatisfied) {
			test(`'${range}' is not satisfied by ${version}`, () => {
				assert.equal(satisfiesRange({ version, range }), false);
			});
		}
	}

	test("returns null for a range c8ctl cannot parse", () => {
		// `null` is "cannot evaluate", which callers fail open on — distinct
		// from `false`, which disables the plugin's commands.
		for (const range of ["latest", ">=four", ">=", "not-a-range", "1.2.3.4"]) {
			assert.equal(satisfiesRange({ version: "4.0.0", range }), null, range);
		}
	});

	test("returns null for a host version that is not a version", () => {
		assert.equal(satisfiesRange({ version: "wat", range: ">=3.3.0" }), null);
	});

	test("set unions and hyphen ranges are evaluated, not treated as unsupported", () => {
		// Delegating to `semver` gets the full npm range grammar for free — these
		// forms are valid npm syntax that a hand-rolled comparator parser would
		// have to special-case.
		assert.equal(
			satisfiesRange({ version: "4.1.0", range: "^3.0.0 || ^4.0.0" }),
			true,
		);
		assert.equal(
			satisfiesRange({ version: "2.9.0", range: "^3.0.0 || ^4.0.0" }),
			false,
		);
		assert.equal(
			satisfiesRange({ version: "1.5.0", range: ">=5.0.0 || >=1.0.0" }),
			true,
		);
		assert.equal(
			satisfiesRange({ version: "3.5.0", range: "3.3.0 - 4.0.0" }),
			true,
		);
		assert.equal(
			satisfiesRange({ version: "4.0.1", range: "3.3.0 - 4.0.0" }),
			false,
		);
	});

	test("a union with one unparseable branch still fails open", () => {
		// `semver` rejects the whole range rather than evaluating the readable
		// half — this stays `null` ("cannot evaluate"), not a partial verdict.
		assert.equal(
			satisfiesRange({ version: "4.1.0", range: ">=4.0.0 || garbage" }),
			null,
		);
	});

	test("prerelease tags order by identifier, not just by trailing number", () => {
		// `4.0.0-rc.1` satisfies `>=4.0.0-alpha.5`; reading the tags as
		// interchangeable and comparing only the trailing numbers (1 < 5) would
		// disable a plugin on a host that meets its floor.
		assert.equal(
			satisfiesRange({ version: "4.0.0-rc.1", range: ">=4.0.0-alpha.5" }),
			true,
		);
		assert.equal(
			satisfiesRange({ version: "4.0.0-alpha.5", range: ">=4.0.0-beta.1" }),
			false,
		);
		// A shorter identifier set sorts lower: 4.0.0-alpha < 4.0.0-alpha.5.
		assert.equal(
			satisfiesRange({ version: "4.0.0-alpha", range: ">=4.0.0-alpha.5" }),
			false,
		);
		// Numeric identifiers rank below alphanumeric ones.
		assert.equal(
			satisfiesRange({ version: "4.0.0-1", range: ">=4.0.0-alpha" }),
			false,
		);
	});

	test("build metadata is ignored rather than corrupting the comparison", () => {
		// Semver excludes build metadata from precedence. Letting `+build` reach
		// a numeric parse yields NaN, and NaN comparisons make every operator
		// answer the same way regardless of the versions involved.
		assert.equal(
			satisfiesRange({ version: "4.0.0+build.5", range: ">=4.0.1" }),
			false,
		);
		assert.equal(
			satisfiesRange({ version: "4.0.2+build.5", range: ">=4.0.1" }),
			true,
		);
		assert.equal(
			satisfiesRange({ version: "4.0.0", range: ">=4.0.0+build" }),
			true,
		);
		assert.equal(
			satisfiesRange({ version: "3.9.0", range: "<4.0.0+build" }),
			true,
		);
	});

	test("a space between operator and operand is one comparator, not two", () => {
		assert.equal(satisfiesRange({ version: "4.0.0", range: ">= 4.0.0" }), true);
		assert.equal(
			satisfiesRange({ version: "3.9.0", range: ">= 4.0.0" }),
			false,
		);
		assert.equal(
			satisfiesRange({ version: "4.1.0", range: ">=  3.3.0  <5.0.0" }),
			true,
		);
	});

	test("caret and tilde exclude prereleases of the version they bound", () => {
		// c8ctl's own main branch publishes X.Y.0-alpha.N of the *next* version,
		// so someone on the alpha channel would otherwise read as satisfying a
		// caret range on the major that range excludes.
		assert.equal(
			satisfiesRange({ version: "5.0.0-alpha.1", range: "^4.1.0" }),
			false,
		);
		assert.equal(
			satisfiesRange({ version: "4.2.0-alpha.1", range: "~4.1.0" }),
			false,
		);
		// Prereleases *inside* the range still satisfy it.
		assert.equal(
			satisfiesRange({ version: "4.2.0-alpha.1", range: "^4.1.0" }),
			true,
		);
	});
});

describe("checkHostCompat", () => {
	const pluginName = "c8ctl-plugin-os";

	test("undeclared requirements are left alone", () => {
		const verdict = checkHostCompat({
			pluginName,
			declaredRange: null,
			hostVersion: "3.3.0",
		});
		assert.equal(verdict.status, "undeclared");
		assert.equal(verdict.range, undefined);
		assert.equal(verdict.message, undefined);
	});

	test("a satisfied requirement carries the range and no message", () => {
		const verdict = checkHostCompat({
			pluginName,
			declaredRange: ">=4.0.0-alpha.1",
			hostVersion: "4.0.0-alpha.1",
		});
		assert.equal(verdict.status, "satisfied");
		assert.equal(verdict.range, ">=4.0.0-alpha.1");
		assert.equal(verdict.message, undefined);
	});

	test("an unmet requirement explains itself actionably", () => {
		const verdict = checkHostCompat({
			pluginName,
			declaredRange: ">=4.0.0-alpha.1",
			hostVersion: "3.3.0",
		});
		assert.equal(verdict.status, "incompatible");
		assert.equal(verdict.range, ">=4.0.0-alpha.1");
		const message = verdict.message ?? "";
		assert.match(message, /c8ctl-plugin-os/);
		assert.match(message, />=4\.0\.0-alpha\.1/);
		assert.match(message, /3\.3\.0/);
		// The way out has to be in the message itself — this string is the
		// only thing a user sees when a plugin command refuses to run.
		assert.match(message, /npm install -g @camunda8\/cli@latest/);
	});

	test("an unpublished development build fails open", () => {
		const verdict = checkHostCompat({
			pluginName,
			declaredRange: ">=4.0.0-alpha.1",
			hostVersion: "0.0.0-semantically-released",
		});
		assert.equal(verdict.status, "unverifiable");
		assert.equal(verdict.range, ">=4.0.0-alpha.1");
		assert.match(verdict.message ?? "", /development build/);
	});

	test("an unreadable host version blames the host, not the plugin", () => {
		// Both cases make `satisfiesRange` answer `null`, but only one of them is
		// the plugin author's to fix. Collapsing them would have every plugin
		// declaring a range — including the `"*"` the scaffold ships — warn about
		// itself on a host whose version string this check cannot parse.
		const verdict = checkHostCompat({
			pluginName,
			declaredRange: "*",
			hostVersion: "nightly-build",
		});
		assert.equal(verdict.status, "unverifiable");
		assert.equal(verdict.reason, "unreadable-host-version");
		assert.match(verdict.message ?? "", /this c8ctl reports its version/);
		assert.match(verdict.message ?? "", /nightly-build/);
		assert.doesNotMatch(verdict.message ?? "", /not a version range/);
	});

	test("a range c8ctl cannot read fails open and points at npm's range syntax", () => {
		const verdict = checkHostCompat({
			pluginName,
			declaredRange: "latest",
			hostVersion: "4.0.0",
		});
		assert.equal(verdict.status, "unverifiable");
		assert.equal(verdict.range, "latest");
		assert.match(verdict.message ?? "", /latest/);
		assert.match(verdict.message ?? "", /node-semver/);
	});
});

describe("loader enforcement of engines.c8ctl", () => {
	/**
	 * `hostVersion` is injected rather than read off the runtime because a
	 * source checkout always reports the unpublished development version, which
	 * by design answers `unverifiable` — the blocking path would be unreachable
	 * from a test otherwise.
	 */
	async function loadDataDir(dataDir: string, hostVersion: string) {
		const previous = process.env.C8CTL_DATA_DIR;
		process.env.C8CTL_DATA_DIR = dataDir;
		clearLoadedPlugins();
		try {
			await loadInstalledPlugins({ hostVersion });
			// Snapshot inside the try: the `finally` clears the loader's
			// bookkeeping, so anything read after this call would come back empty.
			return {
				commands: getPluginCommands(),
				incompatibilities: getPluginIncompatibilities(),
				collisions: getPluginCollisions(),
			};
		} finally {
			clearLoadedPlugins();
			if (previous === undefined) delete process.env.C8CTL_DATA_DIR;
			else process.env.C8CTL_DATA_DIR = previous;
		}
	}

	async function loadFixture(
		declaredRange: string | null | undefined,
		hostVersion: string,
	) {
		return loadDataDir(stagePlugin(declaredRange), hostVersion);
	}

	test("a satisfied requirement leaves the plugin's commands runnable", async () => {
		const { commands, incompatibilities } = await loadFixture(
			">=4.0.0-alpha.1",
			"4.0.0",
		);
		assert.deepEqual(incompatibilities, []);
		const bare = commands["host-bare"];
		assert.equal(typeof bare, "function");
		if (typeof bare === "function") await bare([]);
	});

	test("an unmet requirement is recorded with both versions", async () => {
		const { incompatibilities } = await loadFixture(">=4.0.0-alpha.1", "3.3.0");
		assert.equal(incompatibilities.length, 1);
		const [record] = incompatibilities;
		assert.equal(record.plugin, PLUGIN_NAME);
		assert.equal(record.pluginVersion, "2.1.0");
		assert.equal(record.required, ">=4.0.0-alpha.1");
		assert.equal(record.running, "3.3.0");
		assert.match(record.message, /npm install -g @camunda8\/cli@latest/);
	});

	test("an unmet requirement makes a bare-function command refuse to run", async () => {
		const { commands } = await loadFixture(">=4.0.0-alpha.1", "3.3.0");
		const bare = commands["host-bare"];
		assert.equal(typeof bare, "function");
		if (typeof bare !== "function") return;
		await assert.rejects(
			async () => bare([]),
			/requires c8ctl >=4\.0\.0-alpha\.1, but this is c8ctl 3\.3\.0/,
		);
	});

	test("an unmet requirement keeps the declared flags of a `{ flags, handler }` command", async () => {
		const { commands } = await loadFixture(">=4.0.0-alpha.1", "3.3.0");
		const flagged = commands["host-flagged"];
		assert.notEqual(typeof flagged, "function");
		if (typeof flagged === "function") return;
		// The flags have to survive: without them argv parsing rejects
		// `--label` before dispatch ever reaches the refusing handler.
		assert.deepEqual(Object.keys(flagged.flags), ["label"]);
		await assert.rejects(
			async () => flagged.handler([], { label: "x" }),
			/requires c8ctl >=4\.0\.0-alpha\.1/,
		);
	});

	test("a plugin declaring nothing is untouched", async () => {
		const { commands, incompatibilities } = await loadFixture(null, "3.3.0");
		assert.deepEqual(incompatibilities, []);
		const bare = commands["host-bare"];
		assert.equal(typeof bare, "function");
		if (typeof bare === "function") await bare([]);
	});

	test("a development build never disables a plugin", async () => {
		const { commands, incompatibilities } = await loadFixture(
			">=999.0.0",
			"0.0.0-semantically-released",
		);
		assert.deepEqual(incompatibilities, []);
		const bare = commands["host-bare"];
		assert.equal(typeof bare, "function");
		if (typeof bare === "function") await bare([]);
	});

	test("a range c8ctl cannot read never disables a plugin", async () => {
		const { commands, incompatibilities } = await loadFixture(
			"latest",
			"3.3.0",
		);
		assert.deepEqual(incompatibilities, []);
		const bare = commands["host-bare"];
		assert.equal(typeof bare, "function");
		if (typeof bare === "function") await bare([]);
	});

	test("a disabled plugin loses a command-name collision to a working one", async () => {
		// Load order is lexicographic by install directory, so `aaa-` loads first
		// and would otherwise reserve the command name under the usual
		// first-registration-wins rule — leaving the user with a command that only
		// throws while `zzz-`'s working implementation is dropped as a duplicate.
		const dataDir = stagePlugin(">=999.0.0", {
			installDirName: "aaa-plugin-disabled",
			pluginName: "c8ctl-plugin-aaa-disabled",
		});
		stagePlugin(null, {
			dataDir,
			installDirName: "zzz-plugin-working",
			pluginName: "c8ctl-plugin-zzz-working",
		});

		const { commands, incompatibilities } = await loadDataDir(dataDir, "3.3.0");
		assert.equal(incompatibilities.length, 1);
		assert.equal(incompatibilities[0].plugin, "c8ctl-plugin-aaa-disabled");

		const bare = commands["host-bare"];
		assert.equal(typeof bare, "function");
		// The surviving handler must be the working one — it resolves rather than
		// throwing the incompatibility message.
		if (typeof bare === "function") await bare([]);
	});

	test("a takeover re-points earlier records without erasing them", async () => {
		// Two disabled plugins then a working one. `mmm` genuinely loses the
		// command to `aaa`, then `zzz` takes it over from `aaa`. Both losses are
		// real and must still be reported — but neither may credit `aaa`, which no
		// longer owns the name. Deleting the first record would drop `mmm`'s
		// collision from `doctor plugin` altogether; leaving it unedited would
		// assert a win for `aaa`.
		const dataDir = stagePlugin(">=999.0.0", {
			installDirName: "aaa-plugin-disabled",
			pluginName: "c8ctl-plugin-aaa-disabled",
		});
		stagePlugin(">=999.0.0", {
			dataDir,
			installDirName: "mmm-plugin-disabled",
			pluginName: "c8ctl-plugin-mmm-disabled",
		});
		stagePlugin(null, {
			dataDir,
			installDirName: "zzz-plugin-working",
			pluginName: "c8ctl-plugin-zzz-working",
		});

		const { collisions } = await loadDataDir(dataDir, "3.3.0");
		const forCommand = collisions.filter(
			(collision) => collision.command === "host-bare",
		);
		// Every record credits the plugin that actually owns the name…
		assert.deepEqual(
			[...new Set(forCommand.map((collision) => collision.winner))],
			["c8ctl-plugin-zzz-working"],
		);
		// …and both plugins that lost it are still accounted for.
		assert.deepEqual(forCommand.map((collision) => collision.loser).sort(), [
			"c8ctl-plugin-aaa-disabled",
			"c8ctl-plugin-mmm-disabled",
		]);
	});
});

interface DoctorReport {
	loaded: { name: string; commands: string[]; requires?: string }[];
	collisions: {
		kind: "command-name" | "plugin-name";
		winner: string;
		loser: string;
		command?: string;
	}[];
	incompatible: {
		plugin: string;
		pluginVersion: string;
		required: string;
		running: string;
		message: string;
	}[];
}

function parseDoctorJson(stdout: string): DoctorReport {
	// biome-ignore lint/plugin: parsed-JSON contract boundary; shape asserted by callers
	const parsed = JSON.parse(stdout) as DoctorReport;
	return parsed;
}

function findLoaded(report: DoctorReport, name: string) {
	return report.loaded.find((plugin) => plugin.name === name);
}

describe("doctor plugin surfaces the declared requirement", () => {
	async function runDoctor(dataDir: string, extraArgs: string[] = []) {
		return asyncSpawn(
			"node",
			["--experimental-strip-types", CLI, "doctor", "plugin", ...extraArgs],
			{
				env: {
					...process.env,
					CAMUNDA_BASE_URL: "http://test-cluster/v2",
					C8CTL_DATA_DIR: dataDir,
				},
			},
		);
	}

	test("--json reports the range under the loaded plugin", async () => {
		const dataDir = stagePlugin(">=4.0.0-alpha.1");
		const { status, stdout } = await runDoctor(dataDir, ["--json"]);
		assert.equal(status, 0);
		const report = parseDoctorJson(stdout);
		const entry = findLoaded(report, PLUGIN_NAME);
		assert.ok(entry, `${PLUGIN_NAME} should be loaded: ${stdout}`);
		assert.equal(entry.requires, ">=4.0.0-alpha.1");
		// This CLI runs from source, so its version is the unpublished
		// development placeholder and the requirement is deliberately not
		// enforced — the plugin is reported, never quarantined.
		assert.deepEqual(report.incompatible, []);
	});

	test("text output has a Requires column", async () => {
		const dataDir = stagePlugin(">=4.0.0-alpha.1");
		const { status, stdout } = await runDoctor(dataDir);
		assert.equal(status, 0);
		assert.match(stdout, /Requires/);
		assert.match(stdout, />=4\.0\.0-alpha\.1/);
	});

	test("a plugin declaring nothing shows no requirement", async () => {
		const dataDir = stagePlugin(null);
		const { status, stdout } = await runDoctor(dataDir, ["--json"]);
		assert.equal(status, 0);
		const report = parseDoctorJson(stdout);
		const entry = findLoaded(report, PLUGIN_NAME);
		assert.ok(entry, `${PLUGIN_NAME} should be loaded: ${stdout}`);
		assert.equal(entry.requires, undefined);
	});
});

/**
 * End-to-end coverage of the half that reads the *running* c8ctl version
 * (`c8ctl.version`) rather than an injected one: the `load plugin` gate, and
 * `doctor plugin` with a populated incompatibility.
 *
 * A source checkout always reports `0.0.0-semantically-released`, which by
 * design answers "unverifiable" — so from `src/` these paths are unreachable.
 * The workaround is to run the *built* CLI from a tree whose `package.json`
 * carries a real version: `dist/` is copied next to a hand-written manifest,
 * inside the repo so Node still resolves the real `node_modules`. Requires
 * `npm run build` (which `npm test` documents as a prerequisite); skipped with a
 * reason when `dist/` is absent so a source-only run stays green.
 *
 * These assert against `dist/`, so a **stale** build fails them — that is the
 * intended signal, not a flake. `npm run build && npm test` is the documented
 * order for exactly this reason.
 */
describe("enforcement against a published host version (built dist)", () => {
	const REPO_ROOT = join(__dirname, "../..");
	const DIST_DIR = join(REPO_ROOT, "dist");
	const distMissing = !existsSync(join(DIST_DIR, "index.js"));
	const skip = distMissing
		? "requires `npm run build` — dist/index.js is absent"
		: false;

	/** A copy of `dist/` under a package.json claiming `version`. */
	function stageHost(version: string): string {
		const hostDir = mkdtempSync(join(REPO_ROOT, "tests", ".tmp-hostver-"));
		stagedDirs.push(hostDir);
		cpSync(DIST_DIR, join(hostDir, "dist"), { recursive: true });
		writeFileSync(
			join(hostDir, "package.json"),
			JSON.stringify({ name: "@camunda8/cli", version, type: "module" }),
		);
		return join(hostDir, "dist", "index.js");
	}

	async function runHost(
		cli: string,
		args: string[],
		dataDir: string,
	): Promise<{ status: number | null; stdout: string; stderr: string }> {
		return asyncSpawn("node", [cli, ...args], {
			env: {
				...process.env,
				CAMUNDA_BASE_URL: "http://test-cluster/v2",
				C8CTL_DATA_DIR: dataDir,
				// The staged host reports a *real* semver version, which is exactly
				// what makes `startUpdateCheck` fire: it self-suppresses only for the
				// development sentinel. A registry round-trip would then print an
				// update notice into the output these tests assert on, so the result
				// would depend on the machine's network and notification cache.
				// `CI` is the switch update-check already honours.
				CI: "1",
			},
		});
	}

	test("the built CLI reports the staged version", { skip }, async () => {
		// Guards the harness itself: if the staged package.json stopped being
		// the version source, every assertion below would silently degrade
		// into the fail-open path and keep passing.
		const cli = stageHost("3.3.0");
		const { stdout } = await runHost(cli, ["--version"], stagePlugin(null));
		assert.match(stdout, /3\.3\.0/);
	});

	test("a disabled plugin's command exits 1 with one actionable line", {
		skip,
	}, async () => {
		const cli = stageHost("3.3.0");
		const dataDir = stagePlugin(">=4.0.0-alpha.1");
		const { status, stdout, stderr } = await runHost(
			cli,
			["host-bare"],
			dataDir,
		);
		assert.equal(status, 1);
		const output = stdout + stderr;
		assert.match(output, /requires c8ctl >=4\.0\.0-alpha\.1/);
		assert.match(output, /this is c8ctl 3\.3\.0/);
		assert.match(output, /npm install -g @camunda8\/cli@latest/);
		// The failure this replaces: a raw stack trace out of the plugin.
		assert.doesNotMatch(output, /Unexpected error/);
		assert.doesNotMatch(output, /\bat \w+ \(/);
	});

	test("doctor plugin reports the incompatibility in --json", {
		skip,
	}, async () => {
		const cli = stageHost("3.3.0");
		const dataDir = stagePlugin(">=4.0.0-alpha.1");
		const { status, stdout } = await runHost(
			cli,
			["doctor", "plugin", "--json"],
			dataDir,
		);
		assert.equal(status, 0);
		const report = parseDoctorJson(stdout);
		assert.equal(report.incompatible.length, 1);
		const [record] = report.incompatible;
		assert.equal(record.plugin, PLUGIN_NAME);
		assert.equal(record.required, ">=4.0.0-alpha.1");
		assert.equal(record.running, "3.3.0");
		// Still listed as loaded: a disabled plugin keeps its help entry so the
		// command a user already knows about is the one that explains itself.
		assert.ok(findLoaded(report, PLUGIN_NAME));
	});

	test("doctor plugin names the incompatibility in text output", {
		skip,
	}, async () => {
		const cli = stageHost("3.3.0");
		const dataDir = stagePlugin(">=4.0.0-alpha.1");
		const { status, stdout } = await runHost(
			cli,
			["doctor", "plugin"],
			dataDir,
		);
		assert.equal(status, 0);
		assert.match(stdout, /Incompatible with this c8ctl \(1\)/);
		assert.match(stdout, new RegExp(PLUGIN_NAME));
	});

	test("load plugin fails instead of reporting success", { skip }, async () => {
		const cli = stageHost("3.3.0");
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-host-compat-load-"));
		stagedDirs.push(dataDir);
		const { status, stdout, stderr } = await runHost(
			cli,
			["load", "plugin", "--from", pathToFileURL(FIXTURE_DIR).href],
			dataDir,
		);
		const output = stdout + stderr;
		assert.equal(status, 1, `expected a failing exit: ${output}`);
		assert.match(output, /is not compatible with this c8ctl/);
		assert.match(output, /requires c8ctl >=4\.0\.0-alpha\.1/);
		// The two claims a failing install must not make.
		assert.doesNotMatch(output, /will be available on next command/);
		assert.doesNotMatch(output, /Plugin loaded successfully/);
	});

	test("a missing required flag does not shadow the explanation", {
		skip,
	}, async () => {
		// A required flag is validated by the host before dispatch. Without an
		// exemption for a disabled plugin, `c8ctl host-required-flag` answers
		// "--label is required" — sending the user to satisfy a flag for a command
		// that cannot run whatever they pass.
		const cli = stageHost("3.3.0");
		const dataDir = stagePlugin(">=4.0.0-alpha.1");
		const { status, stdout, stderr } = await runHost(
			cli,
			["host-required-flag"],
			dataDir,
		);
		const output = stdout + stderr;
		assert.equal(status, 1);
		assert.match(output, /requires c8ctl >=4\.0\.0-alpha\.1/);
		assert.doesNotMatch(output, /--label is required/);
	});

	test("a required flag is still enforced for a working plugin", {
		skip,
	}, async () => {
		// The exemption must not leak into the normal path.
		const cli = stageHost("4.0.0");
		const dataDir = stagePlugin(">=4.0.0-alpha.1");
		const { status, stdout, stderr } = await runHost(
			cli,
			["host-required-flag"],
			dataDir,
		);
		assert.equal(status, 1);
		assert.match(stdout + stderr, /--label is required/);
	});

	test("a disabled plugin's commands stay listed in help", {
		skip,
	}, async () => {
		// The design trade: a disabled command stays visible and explains itself
		// when run, rather than vanishing into "unknown command".
		const cli = stageHost("3.3.0");
		const dataDir = stagePlugin(">=4.0.0-alpha.1");
		const { status, stdout } = await runHost(cli, ["--help"], dataDir);
		assert.equal(status, 0);
		assert.match(stdout, /host-bare/);
	});

	test("an unreadable range warns but installs cleanly", {
		skip,
	}, async () => {
		// Fail-open, end to end: a range c8ctl cannot evaluate must not turn into
		// a failed install.
		const cli = stageHost("3.3.0");
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-host-compat-warn-"));
		stagedDirs.push(dataDir);
		const fixture = stageFixtureCopy("latest");
		const { status, stdout, stderr } = await runHost(
			cli,
			["load", "plugin", "--from", pathToFileURL(fixture).href],
			dataDir,
		);
		const output = stdout + stderr;
		assert.equal(status, 0, output);
		assert.match(output, /not a version range c8ctl understands/);
		assert.match(output, /Plugin loaded successfully/);
	});

	test("a satisfied requirement installs and runs normally", {
		skip,
	}, async () => {
		const cli = stageHost("4.0.0");
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-host-compat-ok-"));
		stagedDirs.push(dataDir);
		const install = await runHost(
			cli,
			["load", "plugin", "--from", pathToFileURL(FIXTURE_DIR).href],
			dataDir,
		);
		assert.equal(
			install.status,
			0,
			`expected a clean install: ${install.stdout}${install.stderr}`,
		);
		assert.match(install.stdout, /Plugin loaded successfully/);

		const run = await runHost(cli, ["host-bare"], dataDir);
		assert.equal(run.status, 0, run.stdout + run.stderr);
		assert.match(run.stdout, /"ran":"host-bare"/);
	});

	// Regression guard for the Windows-only failure where the temp dir sits under
	// an 8.3 short path (`…\RUNNER~1\…`): `pathToFileURL` percent-encodes the `~`
	// to `%7E`, and a raw `file://` URL handed to `npm install` ENOENTs on the
	// still-encoded path. Staging the fixture under a directory whose name
	// literally contains `~` reproduces the `%7E` encoding on every platform, so
	// this locks in the `fileURLToPath()` decode in `load plugin --from`.
	test("a file:// --from with a percent-encoded path installs cleanly", {
		skip,
	}, async () => {
		const cli = stageHost("4.0.0");
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-host-compat-enc-"));
		stagedDirs.push(dataDir);

		// A parent dir whose name contains a literal `~`.
		const encodedParent = join(dataDir, "RUNNER~1");
		mkdirSync(encodedParent, { recursive: true });
		const fixture = join(encodedParent, "plugin-src");
		cpSync(FIXTURE_DIR, fixture, { recursive: true });

		// `~` is an unreserved character in RFC 3986, so whether pathToFileURL
		// percent-encodes it is platform/Node-version dependent. Force the
		// encoding so this guard deterministically exercises the fileURLToPath()
		// decode path regardless of how pathToFileURL serialized the `~`.
		const fromUrl = pathToFileURL(fixture).href.replace(/~/g, "%7E");
		assert.match(
			fromUrl,
			/%7E/,
			`expected an encoded ~ in the file URL, got ${fromUrl}`,
		);

		const install = await runHost(
			cli,
			["load", "plugin", "--from", fromUrl],
			dataDir,
		);
		assert.equal(
			install.status,
			0,
			`expected a clean install from an encoded file URL: ${install.stdout}${install.stderr}`,
		);
		assert.match(install.stdout, /Plugin loaded successfully/);
	});
});
