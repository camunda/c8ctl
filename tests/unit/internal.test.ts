/**
 * Contract tests for the embedding API, `@camunda8/cli/internal`.
 *
 * Hosts such as Desktop Modeler load this entry point instead of
 * spawning the CLI, so these tests use it exactly as such a host does:
 * `require()` from CommonJS, an explicit `C8ctlContext`, and no CLI
 * runtime. The CLI's own runtime state is poisoned and the host's
 * environment carries bogus `CAMUNDA_*` settings, so a service that
 * reads either fails here.
 */

import assert from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type * as InternalApi from "../../src/internal/index.ts";
import { listenOnLoopback } from "../utils/http-server.ts";

const require = createRequire(import.meta.url);

const PROCESS_ID = "embedded-process";

const BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1">
  <bpmn:process id="${PROCESS_ID}" isExecutable="true" />
</bpmn:definitions>
`;

interface FakeCluster {
	baseUrl: string;
	requests: { method: string; url: string; headers: IncomingHttpHeaders }[];
	/** Answer the next deployment with this RFC 9457 problem. */
	rejectNext: (problem: Record<string, unknown>) => void;
	/** Never answer the next deployment; call `onReceived` when it arrives. */
	holdNext: (onReceived: () => void) => void;
	close: () => void;
}

async function startFakeCluster(): Promise<FakeCluster> {
	const requests: FakeCluster["requests"] = [];
	let nextProblem: Record<string, unknown> | undefined;
	let onHeld: (() => void) | undefined;
	const server = createServer((req, res) => {
		requests.push({
			method: req.method ?? "",
			url: req.url ?? "",
			headers: req.headers,
		});
		req.resume();
		req.on("end", () => {
			const send = (status: number, body: unknown) => {
				res.writeHead(status, {
					"Content-Type":
						status >= 400 ? "application/problem+json" : "application/json",
					Connection: "close",
				});
				res.end(JSON.stringify(body));
			};
			const url = req.url ?? "";
			if (req.method === "GET" && url.endsWith("/topology")) {
				send(200, {
					brokers: [],
					clusterSize: 1,
					partitionsCount: 1,
					replicationFactor: 1,
					gatewayVersion: "8.10.0",
					lastCompletedChangeId: "-1",
				});
				return;
			}
			if (req.method === "POST" && url.endsWith("/deployments")) {
				if (onHeld) {
					const received = onHeld;
					onHeld = undefined;
					received();
					return;
				}
				if (nextProblem) {
					const problem = nextProblem;
					nextProblem = undefined;
					send(400, problem);
					return;
				}
				send(200, {
					deploymentKey: "2251799813685249",
					tenantId: "<default>",
					deployments: [
						{
							processDefinition: {
								processDefinitionId: PROCESS_ID,
								processDefinitionVersion: 3,
								resourceName: "process.bpmn",
								tenantId: "<default>",
								processDefinitionKey: "2251799813685250",
							},
							decisionDefinition: null,
							decisionRequirements: null,
							form: null,
							resource: null,
						},
					],
				});
				return;
			}
			send(404, { title: "NOT_FOUND", status: 404 });
		});
	});
	const port = await listenOnLoopback(server);
	return {
		baseUrl: `http://127.0.0.1:${port}/v2`,
		requests,
		rejectNext: (problem) => {
			nextProblem = problem;
		},
		holdNext: (onReceived) => {
			onHeld = onReceived;
		},
		close: () => {
			server.closeAllConnections();
			server.close();
		},
	};
}

/** A Camunda project: camunda.json, one BPMN file and a README. */
function createProject(descriptor = "{}"): string {
	const dir = mkdtempSync(join(tmpdir(), "c8ctl-internal-project-"));
	writeFileSync(join(dir, "camunda.json"), descriptor);
	writeFileSync(join(dir, "process.bpmn"), BPMN);
	writeFileSync(join(dir, "README.md"), "# Not a resource\n");
	return dir;
}

/** A c8ctl data dir with one profile, separate from the isolated default. */
function createDataDir(baseUrl: string): string {
	const dir = mkdtempSync(join(tmpdir(), "c8ctl-internal-data-"));
	writeFileSync(
		join(dir, "profiles.json"),
		JSON.stringify({ profiles: [{ name: "embedded", baseUrl }] }),
	);
	return dir;
}

/** A Modeler user-data dir with one connection, as Modeler stores it. */
function createModelerDir(baseUrl: string): string {
	const dir = mkdtempSync(join(tmpdir(), "c8ctl-internal-modeler-"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "settings.json"),
		JSON.stringify({
			"connectionManagerPlugin.c8connections": [
				{
					id: "connection-1",
					name: "Local",
					targetType: "selfHosted",
					contactPoint: baseUrl,
					authType: "none",
				},
			],
		}),
	);
	return dir;
}

/**
 * Make every read of the CLI runtime throw. The runtime module is shared
 * with the internal entry point, so a service that reads session or
 * per-invocation state fails the test.
 */
function poisonCliRuntime(): void {
	const { c8ctl } = require("@camunda8/cli/runtime");
	const keys = new Set([
		...Object.getOwnPropertyNames(c8ctl),
		...Object.getOwnPropertyNames(Object.getPrototypeOf(c8ctl)),
	]);
	keys.delete("constructor");
	for (const key of keys) {
		Object.defineProperty(c8ctl, key, {
			get() {
				throw new Error(`service read the CLI runtime: c8ctl.${key}`);
			},
			set() {
				throw new Error(`service wrote the CLI runtime: c8ctl.${key}`);
			},
		});
	}
}

describe("@camunda8/cli/internal", () => {
	const api: typeof InternalApi = require("@camunda8/cli/internal");
	let cluster: FakeCluster;

	before(async () => {
		cluster = await startFakeCluster();
		// A host's environment must not reach the cluster client.
		process.env.CAMUNDA_AUTH_STRATEGY = "BASIC";
		process.env.CAMUNDA_BASIC_AUTH_USERNAME = "host-user";
		process.env.CAMUNDA_BASIC_AUTH_PASSWORD = "host-password";
		poisonCliRuntime();
	});

	after(() => {
		cluster.close();
	});

	test("exports the services and the contract types' runtime values", () => {
		assert.deepStrictEqual(Object.keys(api).sort(), [
			"C8CTL_ERROR_CODES",
			"C8ctlError",
			"deploy",
			"isC8ctlError",
			"resolveDeployment",
		]);
	});

	test("deploy sends a project to a profile from an explicit data dir and reports progress", async () => {
		const project = createProject();
		const events: InternalApi.C8ctlEvent[] = [];
		const requestsBefore = cluster.requests.length;

		const result = await api.deploy(
			{ target: { profile: "embedded" }, paths: [project] },
			{
				dataDir: createDataDir(cluster.baseUrl),
				onProgress: (event) => events.push(event),
			},
		);

		assert.strictEqual(result.deploymentKey, "2251799813685249");
		assert.strictEqual(result.tenantId, "<default>");
		assert.deepStrictEqual(result.resources, [
			{
				type: "process",
				id: PROCESS_ID,
				version: 3,
				key: "2251799813685250",
				resourceName: "process.bpmn",
				file: {
					path: join(project, "process.bpmn"),
					name: "process.bpmn",
					group: { kind: "project", root: project },
				},
			},
		]);
		assert.deepStrictEqual(
			events.flatMap((event) =>
				event.type === "progress" ? [event.phase] : [],
			),
			["check-server", "resolve", "resolved", "deploy"],
		);
		assert.ok(
			cluster.requests
				.slice(requestsBefore)
				.every((request) => request.headers.authorization === undefined),
			"the host's CAMUNDA_* credentials leaked into the request",
		);
	});

	test("deploy resolves a Desktop Modeler connection from the Modeler dir", async () => {
		const result = await api.deploy(
			{ target: { profile: "modeler:connection-1" }, paths: [createProject()] },
			{ modelerDir: createModelerDir(cluster.baseUrl) },
		);

		assert.deepStrictEqual(
			result.resources.map((resource) => resource.id),
			[PROCESS_ID],
		);
	});

	test("resolveDeployment lists the files without contacting a cluster", async () => {
		const project = createProject(
			JSON.stringify({ deployResources: ["*.bpmn", "*.md"] }),
		);
		const requestsBefore = cluster.requests.length;

		const result = await api.resolveDeployment({ paths: [project] });

		assert.deepStrictEqual(result.files.map((file) => file.name).sort(), [
			"README.md",
			"process.bpmn",
		]);
		assert.deepStrictEqual(result.descriptorRoots, [project]);
		assert.strictEqual(cluster.requests.length, requestsBefore);
	});

	test("failures carry stable codes", async () => {
		const dataDir = createDataDir(cluster.baseUrl);
		const codeOf = (promise: Promise<unknown>) =>
			promise.then(
				() => assert.fail("expected the service to fail"),
				(error: unknown) => {
					assert.ok(api.isC8ctlError(error), String(error));
					return error;
				},
			);

		const unknownProfile = await codeOf(
			api.deploy(
				{ target: { profile: "missing" }, paths: [createProject()] },
				{ dataDir },
			),
		);
		assert.strictEqual(unknownProfile.code, "profile-not-found");
		assert.strictEqual(unknownProfile.field, "target.profile");

		const invalidConfig = await codeOf(
			api.resolveDeployment({
				paths: [createProject('{ "deployResources": "x" }')],
			}),
		);
		assert.strictEqual(invalidConfig.code, "invalid-config");

		cluster.rejectNext({
			type: "about:blank",
			title: "INVALID_ARGUMENT",
			status: 400,
			detail: "Command 'CREATE' rejected",
			instance: "/v2/deployments",
		});
		const rejected = await codeOf(
			api.deploy(
				{ target: { profile: "embedded" }, paths: [createProject()] },
				{ dataDir },
			),
		);
		assert.strictEqual(rejected.code, "deployment-rejected");
		assert.strictEqual(rejected.problem?.title, "INVALID_ARGUMENT");
		assert.strictEqual(rejected.problem?.status, 400);
		assert.deepStrictEqual(rejected.toJSON().code, "deployment-rejected");

		const closed = createServer();
		const closedPort = await listenOnLoopback(closed);
		closed.close();
		const unreachable = await codeOf(
			api.deploy(
				{
					target: {
						cluster: {
							baseUrl: `http://127.0.0.1:${closedPort}/v2`,
							authStrategy: "NONE",
						},
					},
					paths: [createProject()],
				},
				{},
			),
		);
		assert.strictEqual(unreachable.code, "connection-failed");
	});

	test("deploy rejects with `cancelled` when the host aborts during progress", async () => {
		const controller = new AbortController();

		const deployment = api.deploy(
			{ target: { profile: "embedded" }, paths: [createProject()] },
			{
				dataDir: createDataDir(cluster.baseUrl),
				signal: controller.signal,
				onProgress: (event) => {
					if (event.type === "progress" && event.phase === "deploy") {
						controller.abort();
					}
				},
			},
		);

		await assert.rejects(deployment, (error: unknown) => {
			assert.ok(api.isC8ctlError(error));
			assert.strictEqual(error.code, "cancelled");
			return true;
		});
	});

	test("deploy rejects with `cancelled` when the host aborts the request in flight", async () => {
		const controller = new AbortController();
		cluster.holdNext(() => controller.abort());

		const deployment = api.deploy(
			{ target: { profile: "embedded" }, paths: [createProject()] },
			{ dataDir: createDataDir(cluster.baseUrl), signal: controller.signal },
		);

		await assert.rejects(deployment, (error: unknown) => {
			assert.ok(api.isC8ctlError(error));
			assert.strictEqual(error.code, "cancelled");
			return true;
		});
	});
});
