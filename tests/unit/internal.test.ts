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
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
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
	requests: {
		method: string;
		url: string;
		headers: IncomingHttpHeaders;
		body: string;
	}[];
	/** Answer the next deployment with this RFC 9457 problem. */
	rejectNext: (problem: Record<string, unknown>) => void;
	/** Never answer the next request to `path`; call `onReceived` when it arrives. */
	holdNext: (path: string, onReceived: () => void) => void;
	close: () => void;
}

async function startFakeCluster(): Promise<FakeCluster> {
	const requests: FakeCluster["requests"] = [];
	let nextProblem: Record<string, unknown> | undefined;
	let held: { path: string; onReceived: () => void } | undefined;
	const server = createServer((req, res) => {
		const request = {
			method: req.method ?? "",
			url: req.url ?? "",
			headers: req.headers,
			body: "",
		};
		requests.push(request);
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			request.body += chunk;
		});
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
			if (held && url.endsWith(held.path)) {
				const { onReceived } = held;
				held = undefined;
				onReceived();
				return;
			}
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
			if (req.method === "POST" && url.endsWith("/process-instances")) {
				send(200, {
					processDefinitionId: PROCESS_ID,
					processDefinitionVersion: 3,
					processDefinitionKey: "2251799813685250",
					processInstanceKey: "2251799813690100",
					tenantId: "<default>",
				});
				return;
			}
			if (req.method === "POST" && url.endsWith("/expression/evaluation")) {
				if (request.body.includes("broken")) {
					send(400, {
						type: "about:blank",
						title: "INVALID_ARGUMENT",
						status: 400,
						detail: "Failed to parse expression 'broken('",
						instance: "/v2/expression/evaluation",
					});
					return;
				}
				send(200, { result: 42, warnings: [] });
				return;
			}
			if (req.method === "POST" && url.endsWith("/incidents/search")) {
				send(200, {
					items: [
						{
							incidentKey: "2251799813690001",
							errorType: "JOB_NO_RETRIES",
							state: "ACTIVE",
							processInstanceKey: "2251799813690000",
							tenantId: "<default>",
						},
					],
					page: { totalItems: 1 },
				});
				return;
			}
			if (req.method === "POST" && url.endsWith("/deployments")) {
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
		holdNext: (path, onReceived) => {
			held = { path, onReceived };
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

const SECRETS = [
	"secret-client-secret",
	"secret-password",
	"secret-header-value",
	"secret-modeler-password",
	"secret-cloud-secret",
];

/** Profiles and Modeler connections with every kind of secret. */
function createProfileDirs(baseUrl: string): {
	dataDir: string;
	modelerDir: string;
} {
	const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-internal-data-"));
	writeFileSync(
		join(dataDir, "profiles.json"),
		JSON.stringify({
			profiles: [
				{
					name: "basic",
					baseUrl,
					username: "demo",
					password: "secret-password",
					defaultTenantId: "tenant-a",
					headers: { "X-Api-Key": "secret-header-value" },
				},
				{
					name: "oauth",
					baseUrl: "https://cluster.example/v2",
					clientId: "client",
					clientSecret: "secret-client-secret",
					oAuthUrl: "https://login.example/oauth/token",
					audience: "zeebe",
				},
			],
		}),
	);
	const modelerDir = mkdtempSync(join(tmpdir(), "c8ctl-internal-modeler-"));
	writeFileSync(
		join(modelerDir, "settings.json"),
		JSON.stringify({
			"connectionManagerPlugin.c8connections": [
				{
					id: "connection-basic",
					name: "Local",
					targetType: "selfHosted",
					contactPoint: baseUrl,
					authType: "basic",
					basicAuthUsername: "modeler-user",
					basicAuthPassword: "secret-modeler-password",
				},
				{
					id: "connection-cloud",
					name: "SaaS",
					targetType: "camundaCloud",
					camundaCloudClusterUrl: "https://bru-2.zeebe.example/abc",
					camundaCloudClientId: "cloud-client",
					camundaCloudClientSecret: "secret-cloud-secret",
				},
			],
		}),
	);
	return { dataDir, modelerDir };
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
			"activateJobs",
			"addProfile",
			"assignGroup",
			"assignMappingRule",
			"assignRole",
			"assignUser",
			"awaitProcessInstance",
			"cancelProcessInstance",
			"completeJob",
			"completeUserTask",
			"createAuthorization",
			"createGroup",
			"createMappingRule",
			"createProcessInstance",
			"createRole",
			"createTenant",
			"createUser",
			"deleteAuthorization",
			"deleteGroup",
			"deleteMappingRule",
			"deleteRole",
			"deleteTenant",
			"deleteUser",
			"deploy",
			"evaluateExpression",
			"failJob",
			"getAuthorization",
			"getGroup",
			"getIncident",
			"getMappingRule",
			"getProcessDefinition",
			"getProcessDefinitionForm",
			"getProcessDefinitionXml",
			"getProcessInstance",
			"getProfile",
			"getRole",
			"getTenant",
			"getTopology",
			"getUser",
			"getUserTaskForm",
			"isC8ctlError",
			"listAuthorizations",
			"listGroups",
			"listIncidents",
			"listJobs",
			"listMappingRules",
			"listProcessDefinitions",
			"listProcessInstances",
			"listProfiles",
			"listRoles",
			"listTenants",
			"listUserTasks",
			"listUsers",
			"migrateProcessInstance",
			"migrateProcessInstances",
			"modifyProcessInstance",
			"modifyProcessInstances",
			"publishMessage",
			"removeProfile",
			"resolveDeployment",
			"resolveIncident",
			"resumeProcessInstance",
			"searchAuthorizations",
			"searchGroups",
			"searchIncidents",
			"searchJobs",
			"searchMappingRules",
			"searchProcessDefinitions",
			"searchProcessInstances",
			"searchRoles",
			"searchTenants",
			"searchUserTasks",
			"searchUsers",
			"searchVariables",
			"searchWaitStates",
			"setVariable",
			"suspendProcessInstance",
			"unassignGroup",
			"unassignMappingRule",
			"unassignRole",
			"unassignUser",
			"updateJob",
		]);
	});

	test("cluster services return the API objects and classify failures", async () => {
		const dataDir = createDataDir(cluster.baseUrl);

		const { items } = await api.listIncidents(
			{ target: { profile: "embedded" }, state: "ACTIVE" },
			{ dataDir },
		);
		assert.deepStrictEqual(
			items.map((incident) => incident.incidentKey),
			["2251799813690001"],
		);

		await assert.rejects(
			api.getIncident(
				{ target: { profile: "embedded" }, incidentKey: "404" },
				{ dataDir },
			),
			(error: unknown) => {
				assert.ok(api.isC8ctlError(error));
				assert.strictEqual(error.code, "not-found");
				assert.strictEqual(error.problem?.status, 404);
				return true;
			},
		);
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

		const incomplete = await codeOf(
			api.getTopology(
				{
					target: {
						cluster: {
							baseUrl: cluster.baseUrl,
							authStrategy: "BASIC",
							username: "demo",
						},
					},
				},
				{},
			),
		);
		assert.strictEqual(incomplete.code, "invalid-connection");
		assert.match(
			JSON.stringify(incomplete.details?.issues),
			/CAMUNDA_BASIC_AUTH_PASSWORD/,
		);
	});

	test("listProfiles returns profiles and Modeler connections without secrets", async () => {
		const dirs = createProfileDirs(cluster.baseUrl);

		const result = await api.listProfiles({}, dirs);

		assert.deepStrictEqual(result.items, [
			{
				name: "basic",
				ref: "basic",
				source: "c8ctl",
				baseUrl: cluster.baseUrl,
				authStrategy: "BASIC",
				tenantId: "tenant-a",
				username: "demo",
			},
			{
				name: "oauth",
				ref: "oauth",
				source: "c8ctl",
				baseUrl: "https://cluster.example/v2",
				authStrategy: "OAUTH",
				clientId: "client",
				oAuthUrl: "https://login.example/oauth/token",
				audience: "zeebe",
			},
			{
				name: "modeler:Local",
				ref: "modeler:connection-basic",
				source: "modeler",
				baseUrl: cluster.baseUrl,
				authStrategy: "BASIC",
				username: "modeler-user",
			},
			{
				name: "modeler:SaaS",
				ref: "modeler:connection-cloud",
				source: "modeler",
				baseUrl: "https://bru-2.zeebe.example/abc",
				authStrategy: "OAUTH",
				clientId: "cloud-client",
				oAuthUrl: "https://login.cloud.camunda.io/oauth/token",
			},
		]);
		const serialized = JSON.stringify(result);
		for (const secret of SECRETS) {
			assert.ok(!serialized.includes(secret), `leaked ${secret}`);
		}
	});

	test("listProfiles refs are targets for cluster services", async () => {
		const dirs = createProfileDirs(cluster.baseUrl);
		const { items } = await api.listProfiles({}, dirs);
		const local = items.filter((item) => item.baseUrl === cluster.baseUrl);

		for (const { ref } of local) {
			const topology = await api.getTopology(
				{ target: { profile: ref } },
				dirs,
			);
			assert.strictEqual(topology.gatewayVersion, "8.10.0");
		}
		const deployed = await api.deploy(
			{
				target: { profile: "modeler:connection-basic" },
				paths: [createProject()],
			},
			dirs,
		);

		assert.deepStrictEqual(
			local.map((item) => item.ref),
			["basic", "modeler:connection-basic"],
		);
		assert.strictEqual(deployed.deploymentKey, "2251799813685249");
	});

	test("getProfile resolves a profile or reports `profile-not-found`", async () => {
		const dirs = createProfileDirs(cluster.baseUrl);
		const missingDir = join(dirs.dataDir, "missing");

		const byRef = await api.getProfile(
			{ name: "modeler:connection-cloud" },
			dirs,
		);
		const missing = api.getProfile({ name: "nope" }, { dataDir: missingDir });

		assert.strictEqual(byRef.name, "modeler:SaaS");
		await assert.rejects(missing, (error: unknown) => {
			assert.ok(api.isC8ctlError(error));
			assert.strictEqual(error.code, "profile-not-found");
			assert.strictEqual(error.field, "name");
			return true;
		});
		assert.ok(!existsSync(missingDir), "a read created the data dir");
	});

	test("addProfile saves a profile and replaces one only when asked", async () => {
		const dataDir = join(
			mkdtempSync(join(tmpdir(), "c8ctl-internal-data-")),
			"new",
		);
		const profile = {
			name: "added",
			baseUrl: cluster.baseUrl,
			username: "demo",
			password: "secret-password",
		};

		const added = await api.addProfile({ profile }, { dataDir });
		const exists = api.addProfile({ profile }, { dataDir });
		await assert.rejects(exists, (error: unknown) => {
			assert.ok(api.isC8ctlError(error));
			assert.strictEqual(error.code, "profile-exists");
			assert.strictEqual(error.field, "profile.name");
			return true;
		});
		await api.addProfile(
			{
				profile: { name: "added", baseUrl: "http://other/v2", tenantId: "t" },
				replace: true,
			},
			{ dataDir },
		);

		assert.deepStrictEqual(added, { name: "added" });
		assert.deepStrictEqual(
			JSON.parse(readFileSync(join(dataDir, "profiles.json"), "utf-8")),
			{
				profiles: [
					{ name: "added", baseUrl: "http://other/v2", defaultTenantId: "t" },
				],
			},
		);
	});

	test("addProfile rejects reserved names and malformed fields", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-internal-data-"));
		const codeAndField = (promise: Promise<unknown>) =>
			promise.then(
				() => assert.fail("expected the service to fail"),
				(error: unknown) => {
					assert.ok(api.isC8ctlError(error), String(error));
					return [error.code, error.field];
				},
			);

		const reserved = await codeAndField(
			api.addProfile(
				{ profile: { name: "modeler:x", baseUrl: "http://x/v2" } },
				{ dataDir },
			),
		);
		const malformed = await codeAndField(
			api.addProfile(
				{
					profile: {
						name: "x",
						baseUrl: "http://x/v2",
						headers: JSON.parse('{ "X-Count": 1 }'),
					},
				},
				{ dataDir },
			),
		);

		assert.deepStrictEqual(reserved, ["invalid-input", "profile.name"]);
		assert.deepStrictEqual(malformed, ["invalid-input", "profile.headers"]);
		assert.ok(!existsSync(join(dataDir, "profiles.json")));
	});

	test("removeProfile removes c8ctl profiles only", async () => {
		const dirs = createProfileDirs(cluster.baseUrl);
		const codeOf = (promise: Promise<unknown>) =>
			promise.then(
				() => assert.fail("expected the service to fail"),
				(error: unknown) => {
					assert.ok(api.isC8ctlError(error), String(error));
					return error.code;
				},
			);

		const removed = await api.removeProfile({ name: "basic" }, dirs);
		const again = await codeOf(api.removeProfile({ name: "basic" }, dirs));
		const modeler = await codeOf(
			api.removeProfile({ name: "modeler:Local" }, dirs),
		);

		assert.deepStrictEqual(removed, { name: "basic" });
		assert.strictEqual(again, "profile-not-found");
		assert.strictEqual(modeler, "invalid-input");
		assert.deepStrictEqual(
			(await api.listProfiles({}, dirs)).items.map((item) => item.ref),
			["oauth", "modeler:connection-basic", "modeler:connection-cloud"],
		);
	});

	test("profile changes do nothing after the host aborted", async () => {
		// given
		const dirs = createProfileDirs(cluster.baseUrl);
		const signal = AbortSignal.abort();
		const before = (await api.listProfiles({}, dirs)).items;

		// when
		const results = await Promise.allSettled([
			api.addProfile(
				{ profile: { name: "new", baseUrl: "http://localhost:8080/v2" } },
				{ ...dirs, signal },
			),
			api.removeProfile({ name: "basic" }, { ...dirs, signal }),
		]);

		// then
		assert.deepStrictEqual(
			results.map((result) =>
				result.status === "rejected" && api.isC8ctlError(result.reason)
					? result.reason.code
					: result.status,
			),
			["cancelled", "cancelled"],
		);
		assert.deepStrictEqual((await api.listProfiles({}, dirs)).items, before);
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
		cluster.holdNext("/deployments", () => controller.abort());

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

	test("deploy rejects with `cancelled` when the host aborts the server check", async () => {
		const controller = new AbortController();
		cluster.holdNext("/topology", () => controller.abort());

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

	test("createProcessInstance starts an exact definition at an element", async () => {
		const dataDir = createDataDir(cluster.baseUrl);
		const requestsBefore = cluster.requests.length;

		const created = await api.createProcessInstance(
			{
				target: { profile: "embedded" },
				processDefinitionKey: "2251799813685250",
				startInstructions: [{ elementId: "Task_1" }],
				runtimeInstructions: [
					{ type: "TERMINATE_PROCESS_INSTANCE", afterElementId: "Task_1" },
				],
			},
			{ dataDir },
		);

		assert.strictEqual(created.processInstanceKey, "2251799813690100");
		const [request] = cluster.requests.slice(requestsBefore);
		assert.deepStrictEqual(JSON.parse(request.body), {
			processDefinitionKey: "2251799813685250",
			startInstructions: [{ elementId: "Task_1" }],
			runtimeInstructions: [
				{ type: "TERMINATE_PROCESS_INSTANCE", afterElementId: "Task_1" },
			],
		});

		await assert.rejects(
			api.createProcessInstance(
				{ target: { profile: "embedded" } },
				{ dataDir },
			),
			(error: unknown) => {
				assert.ok(api.isC8ctlError(error));
				assert.strictEqual(error.code, "invalid-input");
				return true;
			},
		);
	});

	test("evaluateExpression evaluates FEEL on the cluster", async () => {
		const dataDir = createDataDir(cluster.baseUrl);
		const requestsBefore = cluster.requests.length;

		const evaluation = await api.evaluateExpression(
			{
				target: { profile: "embedded" },
				expression: "a + 1",
				variables: { a: 41 },
			},
			{ dataDir },
		);

		assert.deepStrictEqual(evaluation, {
			expression: "a + 1",
			result: 42,
			warnings: [],
		});
		const [request] = cluster.requests.slice(requestsBefore);
		const body = JSON.parse(request.body);
		assert.strictEqual(body.expression, "= a + 1");
		assert.deepStrictEqual(body.variables, { a: 41 });
	});

	test("evaluateExpression reports a rejected expression as invalid input", async () => {
		await assert.rejects(
			api.evaluateExpression(
				{ target: { profile: "embedded" }, expression: "broken(" },
				{ dataDir: createDataDir(cluster.baseUrl) },
			),
			(error: unknown) => {
				assert.ok(api.isC8ctlError(error));
				assert.strictEqual(error.code, "invalid-input");
				assert.strictEqual(error.field, "expression");
				assert.strictEqual(error.problem?.status, 400);
				return true;
			},
		);
	});

	test("cluster services send nothing after the host aborted", async () => {
		const requestsBefore = cluster.requests.length;

		await assert.rejects(
			api.createProcessInstance(
				{
					target: { profile: "embedded" },
					processDefinitionId: PROCESS_ID,
				},
				{
					dataDir: createDataDir(cluster.baseUrl),
					signal: AbortSignal.abort(),
				},
			),
			(error: unknown) => {
				assert.ok(api.isC8ctlError(error));
				assert.strictEqual(error.code, "cancelled");
				return true;
			},
		);
		assert.strictEqual(cluster.requests.length, requestsBefore);
	});

	test("cluster services reject with `cancelled` when the host aborts the request in flight", async () => {
		const controller = new AbortController();
		cluster.holdNext("/incidents/search", () => controller.abort());

		const incidents = api.listIncidents(
			{ target: { profile: "embedded" } },
			{ dataDir: createDataDir(cluster.baseUrl), signal: controller.signal },
		);

		await assert.rejects(incidents, (error: unknown) => {
			assert.ok(api.isC8ctlError(error));
			assert.strictEqual(error.code, "cancelled");
			return true;
		});
	});

	test("searches stop paging when the host aborts", async () => {
		// given
		const controller = new AbortController();
		let pages = 0;
		const client = {
			searchProcessDefinitions: async () => {
				pages++;
				if (pages === 2) controller.abort();
				return {
					items: [{ processDefinitionId: PROCESS_ID, version: pages }],
					page: { endCursor: `cursor-${pages}`, totalItems: 100 },
				};
			},
		};
		// biome-ignore lint/plugin: test stub for CamundaClient with only the searched method
		const target = { client } as unknown as InternalApi.Target;

		// when
		const search = api.searchProcessDefinitions(
			{ target },
			{ signal: controller.signal },
		);

		// then
		await assert.rejects(search, (error: unknown) => {
			assert.ok(api.isC8ctlError(error));
			assert.strictEqual(error.code, "cancelled");
			return true;
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.strictEqual(pages, 2);
	});

	test("form lookups cancel the request when the host aborts", async () => {
		// given
		const controller = new AbortController();
		let cancelled = false;
		const client = {
			getUserTaskForm: () =>
				Object.assign(new Promise(() => {}), {
					cancel: () => {
						cancelled = true;
					},
				}),
		};
		// biome-ignore lint/plugin: test stub for CamundaClient with only the form method
		const target = { client } as unknown as InternalApi.Target;

		// when
		const form = api.getUserTaskForm(
			{ target, userTaskKey: "2251799813685251" },
			{ signal: controller.signal },
		);
		controller.abort();

		// then
		await assert.rejects(form, (error: unknown) => {
			assert.ok(api.isC8ctlError(error));
			assert.strictEqual(error.code, "cancelled");
			return true;
		});
		assert.ok(cancelled, "the SDK request was not cancelled");
	});
});
