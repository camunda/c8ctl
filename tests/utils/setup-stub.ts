/**
 * Offline stub for `c8ctl setup` execution tests, loaded into the CLI
 * subprocess with `--import` (before any CLI module loads).
 *
 * Two seams:
 *
 * 1. `globalThis.fetch` — every host the setup flow talks to is answered
 *    from fixtures: the Camunda download host (prerequisite check),
 *    GitHub (blueprint scaffolding), the local cluster health endpoint,
 *    and the Orchestration Cluster API the SDK calls through fetch. Any
 *    other URL throws, so a regression that touches the real network
 *    fails loudly instead of depending on CI connectivity.
 *
 * 2. Desktop Modeler detection — the installer skips when Modeler is
 *    already installed; the fs patches make it look installed on every
 *    OS, so tests never download or install a real application. The
 *    `c8ctl modeler install` child process setup spawns loads this stub
 *    too (setup forwards its `--import` preloads), so the patch applies
 *    there as well.
 *    (Builtin fs is patched before the CLI's imports load, and
 *    syncBuiltinESMExports() publishes the patches to named ESM imports.)
 *
 * Child processes: the `c8ctl cluster start` and `stop` self-invocations
 * are faked (a successful `start` flips the health endpoint to UP), `gh`
 * skill installs report success, and browser openers exit quietly. The
 * `modeler uninstall` self-invocation is faked too — running it for real
 * could uninstall a developer's actual Desktop Modeler. The modeler
 * install and skills children run their real plugin code under this
 * stub. `C8CTL_SETUP_STUB_FAIL=<step id>` makes one step's child process
 * exit 1 so failure handling is exercised. Everything else passes
 * through.
 *
 * Env:
 *   C8CTL_SETUP_STUB_CLUSTER=up   — the health endpoint reports UP from
 *                                   the start (before any `cluster
 *                                   start`); any other value starts it
 *                                   down.
 *   C8CTL_SETUP_STUB_CAPTURE=file — the process-instance creation request
 *                                   body is written to this file.
 *   C8CTL_SETUP_STUB_DEPLOY_CAPTURE=file — the deployment request's
 *                                   authorization header and body are
 *                                   written to this file as JSON.
 *   C8CTL_SETUP_STUB_FAIL=step    — the given step's child process fails
 *                                   (e.g. "start-cluster", "stop-cluster",
 *                                   "purge-cluster", "delete-cluster",
 *                                   "probe-cluster-status",
 *                                   "probe-cluster-status-after-first-probe",
 *                                   "install-skills", "list-skills",
 *                                   "remove-modeler", "probe-modeler",
 *                                   "list-blueprint-directories").
 *   C8CTL_SETUP_STUB_MARKER_PATH=relative-path and
 *   C8CTL_SETUP_STUB_MARKER_ERROR=EACCES|EPERM — fail lstat for this
 *                                   blueprint marker path.
 *   C8RUN_CACHE_DIR=dir           — the fake `cluster purge`/`delete`
 *                                   children mirror the real plugin's
 *                                   effects, but only inside this dir.
 *   C8CTL_SETUP_STUB_MODELER=absent — the faked `modeler uninstall --dry-run`
 *                                   probe reports no managed installation,
 *                                   so removal previews omit Modeler.
 *   C8CTL_SETUP_STUB_MODELER=malformed — the probe omits `wouldChange` to
 *                                   simulate an invalid response.
 *   C8CTL_SETUP_STUB_MODELER=malformed-target — the probe says removal
 *                                   would change state but omits its target.
 *   C8CTL_SETUP_STUB_MODELER=homebrew — preview a Homebrew-managed app.
 *   C8CTL_SETUP_STUB_CLUSTER_WARN=1 — the fake `cluster start` prints a
 *                                   warning on stderr while succeeding.
 *   C8CTL_SETUP_STUB_CLUSTER_DIES_BEFORE_DEPLOY=1 — the first local
 *                                   health check passes; the next fails.
 *   C8CTL_SETUP_STUB_MODELER_WARN=1 — fake `modeler install` as a skip
 *                                   that prints an update warning among
 *                                   routine stderr.
 *   C8CTL_SETUP_STUB_SKILL_PATH=path — report a listed skill at this
 *                                   path, for removal safety tests.
 *   C8CTL_SETUP_STUB_SKILL_SECOND_PATH=path — report a second path for each
 *                                   installed skill.
 *   C8CTL_SETUP_STUB_SKILL_APPEAR_AFTER_FIRST_LIST=path and
 *   C8CTL_SETUP_STUB_SKILL_APPEAR_STATE=file — report an extra path only
 *                                   after the first `gh skill list`.
 *   C8CTL_SETUP_STUB_SKILL_NAME_AFTER_FIRST_LIST=name and
 *   C8CTL_SETUP_STUB_SKILL_NAME_STATE=file — report a changed skill identity
 *                                   after the first `gh skill list`.
 *   C8CTL_SETUP_STUB_UNMANAGED_SKILLS=1 — list camunda-c8ctl without a
 *                                   source, as another installer leaves
 *                                   it, and refuse installs over existing
 *                                   skill directories, as gh does.
 *   C8CTL_SETUP_STUB_MCP_CONFLICT_PATH=file — replace the orchestration
 *                                   entry with a foreign one before the
 *                                   first `mcp uninstall` child.
 */

import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { PassThrough } from "node:stream";

// ── Desktop Modeler looks installed ────────────────────────────────
// macOS and Windows look the app up at fixed paths. The Linux lookup
// searches PATH for a `camunda-modeler` executable instead — the tests
// put a real fixture file on PATH for that.

const originalExistsSync = fs.existsSync;
fs.existsSync = (path: fs.PathLike): boolean =>
	/Camunda Modeler\.app$|Camunda Modeler\.exe$/.test(String(path)) ||
	originalExistsSync(path);

const originalReaddirSync = fs.readdirSync;
Object.defineProperty(fs, "readdirSync", {
	value: (...args: unknown[]) => {
		const options = args[1];
		if (
			process.env.C8CTL_SETUP_STUB_FAIL === "list-blueprint-directories" &&
			String(args[0]) === process.cwd() &&
			typeof options === "object" &&
			options !== null &&
			"withFileTypes" in options &&
			options.withFileTypes === true
		) {
			throw Object.assign(
				new Error("stubbed blueprint directory listing failure"),
				{ code: "EACCES" },
			);
		}
		return Reflect.apply(originalReaddirSync, fs, args);
	},
});

const originalLstatSync = fs.lstatSync;
Object.defineProperty(fs, "lstatSync", {
	value: (...args: unknown[]) => {
		const markerPath = process.env.C8CTL_SETUP_STUB_MARKER_PATH;
		const markerError = process.env.C8CTL_SETUP_STUB_MARKER_ERROR;
		if (
			markerPath &&
			markerError &&
			relative(process.cwd(), String(args[0])) === markerPath
		) {
			throw Object.assign(
				new Error("stubbed blueprint marker inspection failure"),
				{ code: markerError },
			);
		}
		return Reflect.apply(originalLstatSync, fs, args);
	},
});

syncBuiltinESMExports();

// ── Fixtures ───────────────────────────────────────────────────────

const COMMIT_SHA = "a".repeat(40);
const CAMUNDA_SKILL_NAMES = ["camunda-c8ctl"];

const ROCKET_LAUNCH_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="rocket-launch" isExecutable="true">
    <bpmn:startEvent id="start" />
  </bpmn:process>
</bpmn:definitions>
`;

const PLOT_DESTINATION_DMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="definitions" name="Plot destination" namespace="http://camunda.org/schema/1.0/dmn">
  <decision id="plot-destination" name="Plot destination">
    <decisionTable id="dt">
      <input id="i"><inputExpression typeRef="string"><text>destination</text></inputExpression></input>
      <output id="o" name="plot" typeRef="string" />
    </decisionTable>
  </decision>
</definitions>
`;

/** Blueprint project files, keyed by basename, served from raw.githubusercontent.com. */
const FILES: Record<string, string> = {
	"rocket-launch.bpmn": ROCKET_LAUNCH_BPMN,
	"plot-destination.dmn": PLOT_DESTINATION_DMN,
	"README.md": "# Blueprint\n",
};

const TREE = {
	tree: [
		{ path: "1-rocket-launch", type: "tree" },
		{ path: "1-rocket-launch/rocket-launch.bpmn", type: "blob" },
		{ path: "1-rocket-launch/plot-destination.dmn", type: "blob" },
		{ path: "1-rocket-launch/README.md", type: "blob" },
	],
};

const DEPLOYMENT_RESULT = {
	deploymentKey: "2251799813686749",
	tenantId: "<default>",
	deployments: [
		{
			processDefinition: {
				processDefinitionId: "rocket-launch",
				processDefinitionVersion: 1,
				resourceName: "rocket-launch.bpmn",
				tenantId: "<default>",
				processDefinitionKey: "2251799813686750",
			},
			decisionDefinition: null,
			decisionRequirements: null,
			form: null,
			resource: null,
		},
		{
			processDefinition: null,
			decisionDefinition: null,
			decisionRequirements: {
				decisionRequirementsId: "plot-destination",
				decisionRequirementsName: "Plot destination",
				version: 1,
				resourceName: "plot-destination.dmn",
				tenantId: "<default>",
				decisionRequirementsKey: "2251799813686752",
			},
			form: null,
			resource: null,
		},
	],
};

const PROCESS_INSTANCE_RESULT = {
	processDefinitionId: "rocket-launch",
	processDefinitionVersion: 1,
	tenantId: "<default>",
	variables: {},
	processDefinitionKey: "2251799813686750",
	processInstanceKey: "2251799813686751",
	tags: [],
	businessId: null,
};

// ── fetch stub ─────────────────────────────────────────────────────

function requestUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	if (input instanceof Request) return input.url;
	return String(input);
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

const clusterUpAtBoot = process.env.C8CTL_SETUP_STUB_CLUSTER === "up";
const failStep = process.env.C8CTL_SETUP_STUB_FAIL;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Flipped by a successful fake `cluster start`; the health endpoint
 * follows it, so the setup flow observes a cluster that actually came up.
 * A marker file in C8RUN_CACHE_DIR mirrors the real plugin's
 * cluster.active marker, so a running cluster stays visible across the
 * separate CLI processes of a test (setup run, then removal run).
 */
let clusterRunning = clusterUpAtBoot;
let clusterHealthChecks = 0;
let clusterStatusProbes = 0;
let mcpConflictInjected = false;

function clusterMarkerPath(): string | null {
	const dir = process.env.C8RUN_CACHE_DIR;
	return dir ? join(dir, "cluster.running") : null;
}

/** The marker doubles as the durable record: its content is the version. */
function clusterMarkerVersion(): string | null {
	const marker = clusterMarkerPath();
	if (marker === null || !fs.existsSync(marker)) return null;
	const version = fs.readFileSync(marker, "utf-8").trim();
	return version.length > 0 ? version : null;
}

function isClusterRunning(): boolean {
	return clusterRunning || clusterMarkerVersion() !== null;
}

// ── Child processes ────────────────────────────────────────────────

class FakeChild extends EventEmitter {
	pid = 123456;
	stdin = null;
	stdout = new PassThrough();
	stderr = new PassThrough();
	unref(): void {}
	kill(): boolean {
		return true;
	}
}

/** What the fake `cluster start` child prints on its streams. */
const CLUSTER_CHILD_OUTPUT = {
	stdout:
		'Resolved alias "stable" → 8.10\n' +
		"Downloading Camunda 8.10 for darwin...\n" +
		"//> 5% (43.0 MB / 860.6 MB) at 10.0 MB/s, ETA 1m 22s\n" +
		"//> 100% (860.6 MB / 860.6 MB) at 10.8 MB/s\n" +
		"c8run 8.10 installed successfully.\n" +
		"Starting Camunda 8 local cluster...\n" +
		"Cluster is ready!\n",
};

/** A plugin warning that a successful `cluster start` can still print. */
const CLUSTER_CHILD_WARNING =
	"Could not persist the durable cluster PID record (disk full); the cluster is still tracked via its markers and pidfiles.\n";

/** A skipped `modeler install`: an update warning after routine stderr. */
const MODELER_INSTALL_UPDATE_WARNING =
	"routine modeler stderr\n" +
	"Camunda Modeler 5.51.0 is installed, but 5.52.0 is available. Run `c8ctl modeler update` to update it.\n";

function fakeChild(
	exitCode: number,
	{ stdout = "", stderr = "" }: { stdout?: string; stderr?: string } = {},
): FakeChild {
	const child = new FakeChild();
	// close only after the streams were read to their end, so forwarded
	// output can never race the step's status line.
	let open = 2;
	const done = () => {
		open -= 1;
		if (open === 0) child.emit("close", exitCode, null);
	};
	process.nextTick(() => {
		child.stdout.on("end", done);
		child.stderr.on("end", done);
		child.stdout.end(stdout);
		child.stderr.end(stderr);
	});
	return child;
}

/**
 * The fake GitHub CLI for skill discovery, installation and updates.
 * Shared by the spawn and spawnSync patches: listing reports skill
 * directories, installing creates them, and
 * C8CTL_SETUP_STUB_FAIL=install-skills or list-skills simulates a CLI error.
 */
function fakeGh(commandArgs: string[]): {
	status: number;
	stdout: string;
	stderr: string;
} {
	const skillRoot = join(process.env.HOME ?? "", ".claude", "skills");
	const skillMarker = join(skillRoot, ".c8ctl-installed");
	const installedSkillNames = fs.existsSync(skillMarker)
		? fs
				.readFileSync(skillMarker, "utf8")
				.split(/\r?\n/)
				.filter((name) => name.length > 0)
		: [];
	const capture = process.env.C8CTL_SETUP_STUB_GH_CAPTURE;
	if (capture) {
		fs.appendFileSync(capture, `${JSON.stringify(commandArgs)}\n`);
	}
	const unmanagedSkills = process.env.C8CTL_SETUP_STUB_UNMANAGED_SKILLS === "1";
	if (commandArgs[1] === "list" && unmanagedSkills) {
		return {
			status: 0,
			stdout: JSON.stringify(
				CAMUNDA_SKILL_NAMES.filter((skillName) =>
					fs.existsSync(join(skillRoot, skillName)),
				).map((skillName) => ({
					skillName,
					sourceURL: "",
					path: join(skillRoot, skillName),
				})),
			),
			stderr: "",
		};
	}
	if (commandArgs[1] === "list") {
		if (failStep === "list-skills") {
			return {
				status: 1,
				stdout: "",
				stderr: 'unknown command "skill" for "gh"',
			};
		}
		const appearAfterFirstPath =
			commandArgs[3] === "claude-code"
				? process.env.C8CTL_SETUP_STUB_SKILL_APPEAR_AFTER_FIRST_LIST
				: undefined;
		const appearState =
			commandArgs[3] === "claude-code"
				? process.env.C8CTL_SETUP_STUB_SKILL_APPEAR_STATE
				: undefined;
		const nameAfterFirstList =
			commandArgs[3] === "claude-code"
				? process.env.C8CTL_SETUP_STUB_SKILL_NAME_AFTER_FIRST_LIST
				: undefined;
		const nameState =
			commandArgs[3] === "claude-code"
				? process.env.C8CTL_SETUP_STUB_SKILL_NAME_STATE
				: undefined;
		const includeAppearingPath =
			appearAfterFirstPath !== undefined &&
			appearState !== undefined &&
			fs.existsSync(appearState);
		const includeChangedName =
			nameAfterFirstList !== undefined &&
			nameState !== undefined &&
			fs.existsSync(nameState);
		if (
			appearAfterFirstPath !== undefined &&
			appearState !== undefined &&
			!includeAppearingPath
		) {
			fs.writeFileSync(appearState, "listed");
		}
		if (
			nameAfterFirstList !== undefined &&
			nameState !== undefined &&
			!includeChangedName
		) {
			fs.writeFileSync(nameState, "listed");
		}
		// C8CTL_SETUP_STUB_SKILL_UNLIST_AFTER_FIRST=<state file>: the first
		// list reports installed skills, later lists report none — simulating
		// an inventory that changed between preview and deletion.
		const unlistState = process.env.C8CTL_SETUP_STUB_SKILL_UNLIST_AFTER_FIRST;
		if (unlistState) {
			if (fs.existsSync(unlistState)) {
				return { status: 0, stdout: "[]", stderr: "" };
			}
			fs.writeFileSync(unlistState, "listed");
		}
		return {
			status: 0,
			stdout: JSON.stringify(
				installedSkillNames.flatMap((skillName) => {
					const paths = [
						process.env.C8CTL_SETUP_STUB_SKILL_PATH ??
							join(skillRoot, skillName),
						...(commandArgs[3] === "claude-code" &&
						process.env.C8CTL_SETUP_STUB_SKILL_SECOND_PATH
							? [process.env.C8CTL_SETUP_STUB_SKILL_SECOND_PATH]
							: []),
						...(includeAppearingPath &&
						appearAfterFirstPath !== undefined &&
						basename(appearAfterFirstPath) === skillName
							? [appearAfterFirstPath]
							: []),
					];
					return paths
						.filter(
							(path) => basename(path) === skillName && fs.existsSync(path),
						)
						.map((path) => ({
							skillName:
								includeChangedName && nameAfterFirstList !== undefined
									? nameAfterFirstList
									: skillName,
							sourceURL: "https://github.com/camunda/skills",
							path,
						}));
				}),
			),
			stderr: "",
		};
	}
	if (commandArgs[1] === "install" && commandArgs.length === 3) {
		return {
			status: 0,
			stdout: CAMUNDA_SKILL_NAMES.map(
				(skillName) => `${skillName}\tCamunda skill`,
			).join("\n"),
			stderr: "",
		};
	}
	if (
		failStep === "install-skills" &&
		commandArgs[1] === "install" &&
		commandArgs.length > 3
	) {
		return { status: 1, stdout: "", stderr: "stubbed gh failure" };
	}
	if (commandArgs[1] === "install") {
		fs.mkdirSync(skillRoot, { recursive: true });
		const requestedSkills = commandArgs.includes("--all")
			? CAMUNDA_SKILL_NAMES
			: [commandArgs[3]].filter((skillName) => skillName !== undefined);
		const existing = requestedSkills.filter((skillName) =>
			fs.existsSync(join(skillRoot, skillName)),
		);
		if (unmanagedSkills && existing.length > 0) {
			return {
				status: 1,
				stdout: "",
				stderr: `skills already installed: ${existing.join(", ")} (use --force to overwrite)`,
			};
		}
		for (const skillName of requestedSkills) {
			fs.mkdirSync(join(skillRoot, skillName), { recursive: true });
		}
		fs.writeFileSync(
			skillMarker,
			[...new Set([...installedSkillNames, ...requestedSkills])].join("\n"),
		);
	}
	return { status: 0, stdout: "", stderr: "" };
}

// defineProperty replaces the functions without a static type check on
// the stand-ins — no `as` assertions needed for the overloaded originals.
const realSpawn = childProcess.spawn;
Object.defineProperty(childProcess, "spawn", {
	value: (...args: unknown[]) => {
		const [command, rest] = [args[0], args.slice(1)];
		const argv = [command, ...(Array.isArray(rest[0]) ? rest[0] : [])].map(
			String,
		);
		const mcpConflictPath = process.env.C8CTL_SETUP_STUB_MCP_CONFLICT_PATH;
		if (
			!mcpConflictInjected &&
			mcpConflictPath &&
			argv.includes("mcp") &&
			argv.includes("uninstall")
		) {
			const config: unknown = JSON.parse(
				fs.readFileSync(mcpConflictPath, "utf-8"),
			);
			if (!isRecord(config) || !isRecord(config.mcpServers)) {
				throw new Error("setup-stub: expected an MCP server config");
			}
			config.mcpServers.camunda = {
				url: "https://foreign.example.invalid/mcp",
			};
			fs.writeFileSync(mcpConflictPath, JSON.stringify(config));
			mcpConflictInjected = true;
		}
		// setup self-invokes the cluster plugin to start the cluster.
		if (argv.includes("cluster")) {
			// The running version is the newest install dir present right now,
			// so a test can change it between the preview and the confirmation.
			const stubCacheDirNow = process.env.C8RUN_CACHE_DIR;
			const runningVersion = () => {
				if (!stubCacheDirNow || !fs.existsSync(stubCacheDirNow)) return null;
				return (
					fs
						.readdirSync(stubCacheDirNow)
						.filter((name) => name.startsWith("c8run-"))
						.map((name) => name.slice("c8run-".length))
						.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
						.at(-1) ?? null
				);
			};
			const purgeVersionData = (version: string): string[] => {
				const deleted: string[] = [];
				if (!stubCacheDirNow) return deleted;
				const installDir = join(stubCacheDirNow, `c8run-${version}`);
				if (!fs.existsSync(installDir)) return deleted;
				const camundaData = join(installDir, "camunda-data");
				if (fs.existsSync(camundaData)) {
					fs.rmSync(camundaData, { recursive: true, force: true });
					deleted.push("camunda-data");
				}
				for (const entry of fs.readdirSync(installDir, {
					withFileTypes: true,
				})) {
					if (!entry.isDirectory() || !entry.name.startsWith("camunda-zeebe-"))
						continue;
					const journalDir = join(installDir, entry.name, "data");
					if (fs.existsSync(journalDir)) {
						fs.rmSync(journalDir, { recursive: true, force: true });
						deleted.push(`${entry.name}/data`);
					}
				}
				return deleted;
			};
			if (argv.includes("status")) {
				clusterStatusProbes += 1;
				if (
					failStep === "probe-cluster-status" ||
					(failStep === "probe-cluster-status-after-first-probe" &&
						clusterStatusProbes > 1)
				) {
					return fakeChild(1, {
						stderr: "stubbed cluster status failure diagnostics\n",
					});
				}
				const running = isClusterRunning();
				// The durable record keeps identifying an orphaned running
				// cluster even when another install is present.
				const version = running
					? (clusterMarkerVersion() ?? runningVersion())
					: null;
				return fakeChild(0, {
					stdout: `${JSON.stringify({
						status: running ? "running" : "stopped",
						version,
					})}\n`,
				});
			}
			if (argv.includes("start")) {
				if (failStep === "start-cluster") {
					// Like the real plugin: chatter on stdout, diagnostics on stderr.
					return fakeChild(1, {
						stdout: CLUSTER_CHILD_OUTPUT.stdout,
						stderr: "stubbed cluster failure diagnostics\n",
					});
				}
				clusterRunning = true;
				const marker = clusterMarkerPath();
				if (marker) {
					fs.mkdirSync(dirname(marker), { recursive: true });
					fs.writeFileSync(marker, runningVersion() ?? "8.10");
				}
				return fakeChild(0, {
					...CLUSTER_CHILD_OUTPUT,
					...(process.env.C8CTL_SETUP_STUB_CLUSTER_WARN === "1"
						? { stderr: CLUSTER_CHILD_WARNING }
						: {}),
				});
			}
			if (argv.includes("stop")) {
				if (failStep === "stop-cluster") {
					return fakeChild(1, {
						stderr: "stubbed cluster stop failure diagnostics\n",
					});
				}
				if (!isClusterRunning()) {
					return fakeChild(0, {
						stderr: "No cluster is currently running.\n",
					});
				}
				const stoppedVersion = clusterMarkerVersion() ?? runningVersion();
				clusterRunning = false;
				const stoppedMarker = clusterMarkerPath();
				if (stoppedMarker) fs.rmSync(stoppedMarker, { force: true });
				let stdout = "Stopped local Camunda 8 cluster.\n";
				// stop --purge purges the stopped version's runtime data, like
				// the real plugin.
				if (argv.includes("--purge") && stoppedVersion) {
					const deleted = purgeVersionData(stoppedVersion);
					if (deleted.length > 0) {
						stdout += `Purged runtime data for ${stoppedVersion}:\n${deleted.map((d) => `  deleted: ${d}\n`).join("")}`;
					}
				}
				return fakeChild(0, { stdout });
			}
			// purge/delete mirror the real plugin's fs effects, but only inside
			// the cache dir the test pinned via C8RUN_CACHE_DIR — without it the
			// fake must not touch a developer's real c8run cache.
			const stubCacheDir = process.env.C8RUN_CACHE_DIR;
			const versionArg = argv[argv.length - 1];
			if (argv.includes("purge")) {
				if (failStep === "purge-cluster") {
					return fakeChild(1, {
						stderr: "stubbed cluster purge failure diagnostics\n",
					});
				}
				// Real layout: runtime data sits next to the version's binary —
				// camunda-data plus the camunda-zeebe-* journal directory.
				const deleted = purgeVersionData(versionArg);
				const stdout =
					deleted.length > 0
						? `Purged runtime data for ${versionArg}:\n${deleted.map((d) => `  deleted: ${d}\n`).join("")}`
						: `No runtime data found for ${versionArg} — nothing to delete.\n`;
				return fakeChild(0, { stdout });
			}
			if (argv.includes("delete")) {
				if (failStep === "delete-cluster") {
					return fakeChild(1, {
						stderr: "stubbed cluster delete failure diagnostics\n",
					});
				}
				if (
					stubCacheDir &&
					fs.existsSync(join(stubCacheDir, `c8run-${versionArg}`))
				) {
					fs.rmSync(join(stubCacheDir, `c8run-${versionArg}`), {
						recursive: true,
						force: true,
					});
					return fakeChild(0, {
						stdout: `Version ${versionArg} has been deleted.\n`,
					});
				}
				return fakeChild(0, {
					stdout: `Version ${versionArg} is not installed locally.\n`,
				});
			}
			return fakeChild(1);
		}
		if (
			process.env.C8CTL_SETUP_STUB_MODELER_WARN === "1" &&
			argv.includes("modeler") &&
			argv.includes("install")
		) {
			return fakeChild(0, {
				stdout:
					"Camunda Modeler is already installed at /usr/bin/camunda-modeler; skipping installation.\n",
				stderr: MODELER_INSTALL_UPDATE_WARNING,
			});
		}
		// `modeler uninstall` would uninstall a real Modeler — fake it like the
		// cluster children. The dry-run probe answers a JSON payload; the
		// actual removal pretends an app-bundle removal. `modeler install`
		// keeps running its real plugin code under this stub.
		if (argv.includes("modeler") && argv.includes("uninstall")) {
			const modelerMode = process.env.C8CTL_SETUP_STUB_MODELER;
			const modelerTarget =
				modelerMode === "homebrew"
					? {
							method: "homebrew-cask",
							path: "/opt/homebrew/Caskroom/camunda-modeler/5.52.0/Camunda Modeler.app",
						}
					: {
							method: "macos-app-bundle",
							path: "/Applications/Camunda Modeler.app",
						};
			if (argv.includes("--dry-run")) {
				if (failStep === "probe-modeler") {
					return fakeChild(1, { stderr: "stubbed modeler probe failure\n" });
				}
				if (modelerMode === "malformed") {
					return fakeChild(0, {
						stdout: `${JSON.stringify({
							dryRun: true,
							command: "modeler uninstall",
							message: "Unexpected probe response",
						})}\n`,
					});
				}
				if (modelerMode === "malformed-target") {
					return fakeChild(0, {
						stdout: `${JSON.stringify({
							dryRun: true,
							command: "modeler uninstall",
							message: "Unexpected probe response",
							wouldChange: true,
						})}\n`,
					});
				}
				const absent = modelerMode === "absent";
				return fakeChild(0, {
					stdout: `${JSON.stringify({
						dryRun: true,
						command: "modeler uninstall",
						message: absent
							? "Camunda Modeler is not installed; run `c8ctl modeler install` first."
							: modelerMode === "homebrew"
								? "Dry run: would remove Camunda Modeler with `brew uninstall --cask camunda-modeler`."
								: "Dry run: would remove the Camunda Modeler app bundle at /Applications/Camunda Modeler.app.",
						wouldChange: !absent,
						...(!absent ? { removalTarget: modelerTarget } : {}),
					})}\n`,
				});
			}
			const spawnOptions = args[2];
			const childEnv =
				isRecord(spawnOptions) && isRecord(spawnOptions.env)
					? spawnOptions.env
					: undefined;
			if (
				childEnv?.C8CTL_SETUP_MODELER_REMOVAL_TARGET !==
				JSON.stringify(modelerTarget)
			) {
				return fakeChild(1, {
					stderr: "stubbed Modeler target did not match the preview\n",
				});
			}
			if (failStep === "remove-modeler") {
				return fakeChild(1, {
					stderr: "stubbed modeler uninstall failure diagnostics\n",
				});
			}
			return fakeChild(0, {
				stdout:
					modelerMode === "homebrew"
						? "Removed Camunda Modeler with Homebrew.\n"
						: "Removed Camunda Modeler from /Applications/Camunda Modeler.app.\n",
			});
		}
		// Skill discovery, installation, and updates use the GitHub CLI.
		if (basename(String(command)) === "gh") {
			const { status, stdout, stderr } = fakeGh(argv.slice(1));
			return fakeChild(status, { stdout, stderr });
		}
		// Browser openers: open (macOS), xdg-open (Linux), cmd.exe /c start.
		if (["open", "xdg-open", "cmd.exe"].includes(basename(String(command)))) {
			return fakeChild(0);
		}
		return Reflect.apply(realSpawn, childProcess, args);
	},
});

const realSpawnSync = childProcess.spawnSync;
Object.defineProperty(childProcess, "spawnSync", {
	value: (...args: unknown[]) => {
		// Skill discovery, installation, and updates use the GitHub CLI.
		if (basename(String(args[0])) === "gh") {
			const commandArgs = Array.isArray(args[1]) ? args[1].map(String) : [];
			return fakeGh(commandArgs);
		}
		// `modeler install` checks winget for an update to the Modeler the
		// existsSync patch reports; answer "no applications found" so tests
		// never query the host's real winget.
		if (basename(String(args[0])) === "winget") {
			return { status: 0x8a150014, stdout: "", stderr: "" };
		}
		return Reflect.apply(realSpawnSync, childProcess, args);
	},
});

syncBuiltinESMExports();

globalThis.fetch = async (
	input: string | URL | Request,
	_init?: RequestInit,
): Promise<Response> => {
	const url = requestUrl(input);

	// Prerequisite check: the Camunda download host answers.
	if (url.startsWith("https://downloads.camunda.cloud/")) {
		return new Response(null, { status: 200 });
	}

	// Blueprint scaffolding from GitHub.
	if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/commits\//.test(url)) {
		return json({ sha: COMMIT_SHA });
	}
	if (
		/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/git\/trees\//.test(url)
	) {
		return json(TREE);
	}
	if (url.startsWith("https://raw.githubusercontent.com/")) {
		const name = url.slice(url.lastIndexOf("/") + 1);
		const contents = FILES[name];
		return contents === undefined
			? new Response("not found", { status: 404 })
			: new Response(contents, { status: 200 });
	}

	// Local cluster health — UP once the fake `cluster start` ran.
	if (url.startsWith("http://localhost:9600/")) {
		clusterHealthChecks += 1;
		if (
			process.env.C8CTL_SETUP_STUB_CLUSTER_DIES_BEFORE_DEPLOY === "1" &&
			clusterHealthChecks > 1
		) {
			clusterRunning = false;
		}
		if (!clusterRunning) {
			throw Object.assign(new Error("connect ECONNREFUSED"), {
				code: "ECONNREFUSED",
			});
		}
		return json({ status: "UP" });
	}

	// The Orchestration Cluster API of the built-in local profile, which
	// setup's deploy step pins explicitly.
	if (url === "http://localhost:8080/v2/deployments") {
		// Capture the deployment request so tests can assert which profile
		// credentials and tenant the deploy child used.
		const deployCapture = process.env.C8CTL_SETUP_STUB_DEPLOY_CAPTURE;
		const request = input instanceof Request ? input : undefined;
		const body = request ? await request.clone().text() : "";
		if (deployCapture && request) {
			fs.writeFileSync(
				deployCapture,
				JSON.stringify({
					authorization: request.headers.get("authorization"),
					body,
				}),
			);
		}
		if (failStep === "deploy-blueprint") {
			return json(
				{
					title: "INVALID_ARGUMENT",
					detail: "stubbed invalid deployment",
					status: 400,
				},
				400,
			);
		}
		const resourceNames = [...body.matchAll(/filename="([^"]+)"/g)].map(
			(match) => match[1],
		);
		const deployments = resourceNames.map(
			(resourceName) =>
				DEPLOYMENT_RESULT.deployments.find(
					(deployment) =>
						deployment.processDefinition?.resourceName === resourceName ||
						deployment.decisionRequirements?.resourceName === resourceName,
				) ?? {
					processDefinition: null,
					decisionDefinition: null,
					decisionRequirements: null,
					form: null,
					resource: null,
				},
		);
		return json({ ...DEPLOYMENT_RESULT, deployments });
	}
	if (url === "http://localhost:8080/v2/process-instances") {
		// Capture the request body so tests can assert the start variables.
		const capture = process.env.C8CTL_SETUP_STUB_CAPTURE;
		if (capture && input instanceof Request) {
			fs.writeFileSync(capture, await input.text());
		}
		return json(PROCESS_INSTANCE_RESULT);
	}

	throw new Error(`setup-stub: unexpected fetch to ${url}`);
};
