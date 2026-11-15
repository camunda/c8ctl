/**
 * Shared helpers for the `deployResources` test suites: building projects
 * from the tool-agnostic parity fixtures, and driving `c8 deploy --dry-run`
 * so assertions see exactly the resources the CLI would submit.
 */

import assert from "node:assert";
import { spawn } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "../../src/core/index.ts";
import { decodeCamundaJson } from "../../src/utils/index.ts";
import { listenOnLoopback } from "./http-server.ts";
import { asyncSpawn, type SpawnResult } from "./spawn.ts";

const CLI = resolve(import.meta.dirname, "..", "..", "src", "index.ts");
export const MUTATE_AFTER_READS = pathToFileURL(
	resolve(import.meta.dirname, "mutate-after-reads.ts"),
).href;
const VANISH_ON_READ = pathToFileURL(
	resolve(import.meta.dirname, "vanish-on-read.ts"),
).href;
// `--import` takes a URL; a bare Windows path (C:\...) is rejected.
const FAKE_TTY = pathToFileURL(
	resolve(import.meta.dirname, "fake-tty.ts"),
).href;

/** Directory holding the shared parity fixtures. */
export const PARITY_FIXTURES_DIR = resolve(
	import.meta.dirname,
	"..",
	"fixtures",
	"deploy-resources-parity",
);

/** Expected outcome of a parity case (see the fixtures README). */
export type ParityExpectation =
	| { kind: "selected"; selected: string[] }
	| { kind: "error"; error: "invalid-config" | "empty-selection" };

export interface ParityCase {
	name: string;
	description: string;
	spec: string;
	expected: ParityExpectation;
	/** Whether the case's camunda.json declares `deployResources`. */
	declaresField: boolean;
}

/** Load every parity case, sorted by name. */
export function loadParityCases(): ParityCase[] {
	return readdirSync(PARITY_FIXTURES_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
		.map((name) => {
			const dir = join(PARITY_FIXTURES_DIR, name);
			const raw: unknown = JSON.parse(
				readFileSync(join(dir, "expected.json"), "utf-8"),
			);
			assert.ok(isRecord(raw), `${name}/expected.json must be an object`);
			const { description, spec, selected, error } = raw;
			assert.ok(typeof description === "string", `${name}: description`);
			assert.ok(typeof spec === "string", `${name}: spec`);
			let expected: ParityExpectation;
			if (error === "invalid-config" || error === "empty-selection") {
				expected = { kind: "error", error };
			} else {
				assert.ok(
					Array.isArray(selected) &&
						selected.every((s) => typeof s === "string"),
					`${name}: expected.json needs "selected" (string[]) or a known "error"`,
				);
				expected = { kind: "selected", selected: selected.map(String) };
			}
			// Fixtures may carry a UTF-8 or UTF-16LE BOM.
			const descriptor: unknown = JSON.parse(
				decodeCamundaJson(readFileSync(join(dir, "camunda.json"))),
			);
			const declaresField =
				isRecord(descriptor) && Object.hasOwn(descriptor, "deployResources");
			return { name, description, spec, expected, declaresField };
		});
}

/**
 * Materialise a parity case into a fresh temp project root: copy the
 * literal files (everything except files.txt / expected.json) and create
 * an empty file for each line of files.txt.
 */
export function buildParityProject(caseName: string, parent: string): string {
	const source = join(PARITY_FIXTURES_DIR, caseName);
	const root = join(parent, caseName);
	mkdirSync(root, { recursive: true });
	for (const entry of readdirSync(source)) {
		if (entry === "files.txt" || entry === "expected.json") continue;
		cpSync(join(source, entry), join(root, entry), { recursive: true });
	}
	const manifest = readFileSync(join(source, "files.txt"), "utf-8");
	for (const line of manifest.split(/\r?\n/)) {
		if (line.trim() === "") continue;
		writeProjectFile(root, line, "");
	}
	return root;
}

/** Write a project file at a `/`-separated relative path. */
export function writeProjectFile(
	root: string,
	relPath: string,
	content: string,
): string {
	const full = join(root, ...relPath.split("/"));
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content);
	return full;
}

/** Create a project from a descriptor and a map of relative path → content. */
export function createProject(
	root: string,
	descriptor: unknown,
	files: Record<string, string> | string[],
): string {
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(root, "camunda.json"),
		typeof descriptor === "string" ? descriptor : JSON.stringify(descriptor),
	);
	const entries = Array.isArray(files)
		? files.map((f): [string, string] => [f, ""])
		: Object.entries(files);
	for (const [rel, content] of entries) writeProjectFile(root, rel, content);
	return root;
}

/** Result of a `c8 deploy --dry-run` invocation. */
export interface DryRunOutcome extends SpawnResult {
	/** Sorted resource names of the dry-run body, or `null` on failure. */
	names: string[] | null;
}

/**
 * Run `c8 deploy <args> --dry-run` in JSON mode. The data dir lives in its
 * own temp folder — never inside the project — so it cannot be selected.
 */
export async function deployDryRun(
	args: string[],
	{
		cwd = tmpdir(),
		vanishOnRead,
		mutateAfterReads,
	}: {
		cwd?: string;
		/** Absolute path deleted right before its first content read. */
		vanishOnRead?: string;
		/** `<path>|<n>|<"delete" or content>`: change a file after n reads. */
		mutateAfterReads?: string;
	} = {},
): Promise<DryRunOutcome> {
	const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-deploy-resources-data-"));
	writeFileSync(
		join(dataDir, "session.json"),
		JSON.stringify({ outputMode: "json" }),
	);
	try {
		const result = await asyncSpawn(
			"node",
			[
				"--experimental-strip-types",
				...(vanishOnRead ? ["--import", VANISH_ON_READ] : []),
				...(mutateAfterReads ? ["--import", MUTATE_AFTER_READS] : []),
				CLI,
				"deploy",
				...args,
				"--dry-run",
			],
			{
				cwd,
				env: {
					PATH: process.env.PATH,
					CAMUNDA_BASE_URL: "http://test-cluster/v2",
					HOME: "/tmp/c8ctl-test-nonexistent-home",
					C8CTL_DATA_DIR: dataDir,
					...(vanishOnRead ? { C8CTL_TEST_VANISH_ON_READ: vanishOnRead } : {}),
					...(mutateAfterReads
						? { C8CTL_TEST_MUTATE_AFTER_READS: mutateAfterReads }
						: {}),
					...(process.env.C8CTL_TEST_TRACE_READS
						? { C8CTL_TEST_TRACE_READS: process.env.C8CTL_TEST_TRACE_READS }
						: {}),
				},
			},
		);
		return { ...result, names: parseDryRunNames(result) };
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
}

function parseDryRunNames(result: SpawnResult): string[] | null {
	if (result.status !== 0) return null;
	const out: unknown = JSON.parse(result.stdout);
	assert.ok(isRecord(out) && isRecord(out.body), "dry-run body expected");
	const resources = out.body.resources;
	assert.ok(Array.isArray(resources), "dry-run body.resources expected");
	return resources
		.map((r: unknown) => {
			assert.ok(isRecord(r) && typeof r.name === "string");
			return r.name;
		})
		.sort();
}

/** Sorted basenames of project-relative paths (dry-run reports names). */
export function basenames(paths: readonly string[]): string[] {
	return paths.map((p) => p.split("/").at(-1) ?? p).sort();
}

/** CLI output signature of each tool-agnostic error class. */
export const CLI_ERROR_SIGNATURE: Record<
	"invalid-config" | "empty-selection",
	RegExp
> = {
	// JSON output mode escapes the quotes around the field name.
	"invalid-config": /Invalid \\?"deployResources\\?"/,
	"empty-selection": /No deployable files found: \\?"deployResources\\?"/,
};

/** A local stand-in for the cluster's `/topology` and `/deployments`. */
export interface MockCluster {
	baseUrl: string;
	/** File names of each received deployment request, in order. */
	deployments: string[][];
	/** Raw multipart body of each received deployment request, in order. */
	deploymentBodies: string[];
	/**
	 * Hold the response to the next deployment request until the returned
	 * release function is called (simulates a slow in-flight deploy).
	 */
	holdNextDeployment: () => () => void;
	/** Number of `GET /topology` calls (the <8.10 extension check). */
	topologyCalls: () => number;
	close: () => Promise<void>;
}

/**
 * Start a mock cluster on an ephemeral loopback port. `/topology` reports
 * `gatewayVersion`; `/deployments` records the multipart file names and
 * answers with an empty successful deployment, or with an RFC 9457
 * INVALID_ARGUMENT problem when `rejectDeployments` is set.
 */
export async function startMockCluster({
	gatewayVersion = "8.10.0",
	rejectDeployments = false,
}: {
	gatewayVersion?: string;
	rejectDeployments?: boolean;
} = {}): Promise<MockCluster> {
	const deployments: string[][] = [];
	const deploymentBodies: string[] = [];
	let holdArmed = false;
	let releaseHeld: (() => void) | undefined;
	let releasedEarly = false;
	let topology = 0;
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
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
				topology++;
				send(200, {
					brokers: [],
					clusterSize: 1,
					partitionsCount: 1,
					replicationFactor: 1,
					gatewayVersion,
					lastCompletedChangeId: "-1",
				});
				return;
			}
			if (req.method === "POST" && url.endsWith("/deployments")) {
				const body = Buffer.concat(chunks).toString("latin1");
				deploymentBodies.push(body);
				deployments.push(
					[...body.matchAll(/filename="([^"]+)"/g)].map((m) => m[1]).sort(),
				);
				if (rejectDeployments) {
					send(400, {
						type: "about:blank",
						title: "INVALID_ARGUMENT",
						status: 400,
						detail: "Command 'CREATE' rejected: unsupported resource type",
						instance: "/v2/deployments",
					});
					return;
				}
				const succeed = () =>
					send(200, {
						deploymentKey: "2251799813685249",
						tenantId: "<default>",
						deployments: [],
					});
				if (holdArmed) {
					holdArmed = false;
					if (releasedEarly) succeed();
					else releaseHeld = succeed;
					return;
				}
				succeed();
				return;
			}
			send(404, { title: "NOT_FOUND", status: 404 });
		});
	});
	const port = await listenOnLoopback(server);
	return {
		baseUrl: `http://127.0.0.1:${port}/v2`,
		deployments,
		deploymentBodies,
		holdNextDeployment: () => {
			holdArmed = true;
			releasedEarly = false;
			releaseHeld = undefined;
			return () => {
				if (releaseHeld) releaseHeld();
				else releasedEarly = true;
				releaseHeld = undefined;
			};
		},
		topologyCalls: () => topology,
		close: () =>
			new Promise<void>((done) => {
				server.close(() => done());
				server.closeAllConnections();
			}),
	};
}

/** Run a real `c8 deploy <args>` (no dry-run) against `baseUrl`. */
export async function deployTo(
	baseUrl: string,
	args: string[],
	{ mutateAfterReads }: { mutateAfterReads?: string } = {},
): Promise<SpawnResult> {
	const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-deploy-resources-data-"));
	try {
		return await asyncSpawn(
			"node",
			[
				"--experimental-strip-types",
				...(mutateAfterReads ? ["--import", MUTATE_AFTER_READS] : []),
				CLI,
				"deploy",
				...args,
				"--yes",
			],
			{
				cwd: tmpdir(),
				env: {
					PATH: process.env.PATH,
					CAMUNDA_BASE_URL: baseUrl,
					HOME: "/tmp/c8ctl-test-nonexistent-home",
					C8CTL_DATA_DIR: dataDir,
					...(mutateAfterReads
						? { C8CTL_TEST_MUTATE_AFTER_READS: mutateAfterReads }
						: {}),
				},
			},
		);
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
}

/** Keystrokes understood by the interactive `select` prompt. */
export const KEY = { down: "\u001b[B", enter: "\r" } as const;

/**
 * Run a real `c8 deploy <args>` against `baseUrl` as if in a terminal.
 * Once stderr shows `promptText`, `keys` are written to stdin.
 */
export async function deployInteractively(
	baseUrl: string,
	args: string[],
	{ promptText, keys }: { promptText: string; keys: string },
): Promise<SpawnResult> {
	const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-deploy-resources-data-"));
	try {
		return await new Promise<SpawnResult>((resolveRun, rejectRun) => {
			const child = spawn(
				"node",
				[
					"--experimental-strip-types",
					"--import",
					FAKE_TTY,
					CLI,
					"deploy",
					...args,
				],
				{
					cwd: tmpdir(),
					stdio: ["pipe", "pipe", "pipe"],
					env: {
						PATH: process.env.PATH,
						CAMUNDA_BASE_URL: baseUrl,
						HOME: "/tmp/c8ctl-test-nonexistent-home",
						C8CTL_DATA_DIR: dataDir,
						C8CTL_INTERACTIVE: "true",
						NO_COLOR: "1",
					},
				},
			);
			let stdout = "";
			let stderr = "";
			let sent = false;
			child.stdout.setEncoding("utf-8");
			child.stderr.setEncoding("utf-8");
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
				if (!sent && stderr.includes(promptText)) {
					sent = true;
					child.stdin.end(keys);
				}
			});
			// Safety net only: a stuck prompt must not hang the test runner.
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, 60_000);
			child.on("error", rejectRun);
			child.on("close", (status, signal) => {
				clearTimeout(timer);
				resolveRun({ status, signal, stdout, stderr, timedOut });
			});
		});
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
}
