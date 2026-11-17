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
 * Env:
 *   C8CTL_SETUP_STUB_CLUSTER=up   — the health endpoint reports UP and
 *                                   the SDK deploy/instance endpoints
 *                                   answer; any other value (default)
 *                                   makes the cluster unreachable.
 *   C8CTL_SETUP_STUB_CAPTURE=file — the process-instance creation request
 *                                   body is written to this file.
 */

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

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

/** Blueprint project files, keyed by basename, served from raw.githubusercontent.com. */
const FILES: Record<string, string> = {
	"rocket-launch.bpmn": ROCKET_LAUNCH_BPMN,
	"plot-destination.dmn": PLOT_DESTINATION_DMN,
	"README.md": "# Rocket Launch\n",
};

const TREE = {
	tree: [
		{ path: "1-rocket-launch", type: "tree" },
		...Object.keys(FILES).map((name) => ({
			path: `1-rocket-launch/${name}`,
			type: "blob",
		})),
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

const clusterUp = process.env.C8CTL_SETUP_STUB_CLUSTER === "up";

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

	// Local cluster health.
	if (url.startsWith("http://localhost:9600/")) {
		if (!clusterUp) {
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
