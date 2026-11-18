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
 *    OS, so tests never download or install a real application.
 *    (Builtin fs is patched before the CLI's imports load, and
 *    syncBuiltinESMExports() publishes the patches to named ESM imports.)
 *
 * Child processes: `c8ctl cluster install|start` self-invocations are
 * faked (a successful `start` flips the health endpoint to UP), `gh`
 * skill installs report success, and browser openers exit quietly.
 * `C8CTL_SETUP_STUB_FAIL=<step id>` makes one step's child process exit
 * 1 so failure handling is exercised. Everything else passes through.
 *
 * Env:
 *   C8CTL_SETUP_STUB_CLUSTER=up   — the health endpoint reports UP from
 *                                   the start (before any `cluster
 *                                   start`); any other value starts it
 *                                   down.
 *   C8CTL_SETUP_STUB_CAPTURE=file — the process-instance creation request
 *                                   body is written to this file.
 *   C8CTL_SETUP_STUB_FAIL=step    — the given step's child process fails
 *                                   (e.g. "install-c8run", "install-skills").
 */

import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { PassThrough } from "node:stream";

// ── Desktop Modeler looks installed ────────────────────────────────
// macOS and Windows look the app up at fixed paths. The Linux lookup
// searches PATH for a `camunda-modeler` executable instead — the tests
// put a real fixture file on PATH for that.

const originalExistsSync = fs.existsSync;
fs.existsSync = (path: fs.PathLike): boolean =>
	/Camunda Modeler\.app$|Camunda Modeler\.exe$/.test(String(path)) ||
	originalExistsSync(path);

syncBuiltinESMExports();

// ── Fixtures ───────────────────────────────────────────────────────

const COMMIT_SHA = "a".repeat(40);

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

const AI_AGENT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_2" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="ai-agent-chat-with-tools" isExecutable="true">
    <bpmn:startEvent id="start" />
  </bpmn:process>
</bpmn:definitions>
`;

/** Blueprint project files, keyed by basename, served from raw.githubusercontent.com. */
const FILES: Record<string, string> = {
	"rocket-launch.bpmn": ROCKET_LAUNCH_BPMN,
	"plot-destination.dmn": PLOT_DESTINATION_DMN,
	"README.md": "# Blueprint\n",
	"ai-agent-chat-with-tools.bpmn": AI_AGENT_BPMN,
};

const TREE = {
	tree: [
		{ path: "1-rocket-launch", type: "tree" },
		{ path: "1-rocket-launch/rocket-launch.bpmn", type: "blob" },
		{ path: "1-rocket-launch/plot-destination.dmn", type: "blob" },
		{ path: "1-rocket-launch/README.md", type: "blob" },
		{ path: "solutions/ai-agent-chat-with-tools", type: "tree" },
		{
			path: "solutions/ai-agent-chat-with-tools/ai-agent-chat-with-tools.bpmn",
			type: "blob",
		},
		{ path: "solutions/ai-agent-chat-with-tools/README.md", type: "blob" },
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

/**
 * Flipped by a successful fake `cluster start`; the health endpoint
 * follows it, so the setup flow observes a cluster that actually came up.
 */
let clusterRunning = clusterUpAtBoot;

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

/** What the fake `cluster install|start` children print on their streams. */
const CLUSTER_CHILD_OUTPUT: Record<string, { stdout: string }> = {
	"install-c8run": {
		stdout:
			'Resolved alias "stable" → 8.10\n' +
			"Downloading Camunda 8.10 for darwin...\n" +
			"//> 5% (43.0 MB / 860.6 MB) at 10.0 MB/s, ETA 1m 22s\n" +
			"//> 100% (860.6 MB / 860.6 MB) at 10.8 MB/s\n" +
			"c8run 8.10 installed successfully.\n",
	},
	"start-cluster": {
		stdout: "Starting Camunda 8 local cluster...\n" + "Cluster is ready!\n",
	},
};

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

// defineProperty replaces the functions without a static type check on
// the stand-ins — no `as` assertions needed for the overloaded originals.
const realSpawn = childProcess.spawn;
Object.defineProperty(childProcess, "spawn", {
	value: (...args: unknown[]) => {
		const [command, rest] = [args[0], args.slice(1)];
		const argv = [command, ...(Array.isArray(rest[0]) ? rest[0] : [])].map(
			String,
		);
		// setup self-invokes the cluster plugin for install/start.
		if (argv.includes("cluster")) {
			const subcommand = argv.includes("install")
				? "install-c8run"
				: argv.includes("start")
					? "start-cluster"
					: undefined;
			if (subcommand !== undefined) {
				// The real plugin exits 1 when install has no version argument;
				// mirror that so a missing version fails the test, not the user.
				if (subcommand === "install-c8run" && !argv.includes("stable")) {
					return fakeChild(1);
				}
				if (failStep === subcommand) {
					// Like the real plugin: chatter on stdout, diagnostics on stderr.
					return fakeChild(1, {
						stdout: CLUSTER_CHILD_OUTPUT[subcommand].stdout,
						stderr: "stubbed cluster failure diagnostics\n",
					});
				}
				if (subcommand === "start-cluster") clusterRunning = true;
				return fakeChild(0, CLUSTER_CHILD_OUTPUT[subcommand]);
			}
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
		// Skills install through the GitHub CLI (`gh skill install …`).
		if (basename(String(args[0])) === "gh") {
			if (failStep === "install-skills") {
				return { status: 1, stdout: "", stderr: "stubbed gh failure" };
			}
			return { status: 0, stdout: "", stderr: "" };
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
		return json(DEPLOYMENT_RESULT);
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
