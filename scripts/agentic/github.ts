import {
	type ChangeReport,
	type CreateCommitInput,
	createCommitInput,
	type ExistingFile,
	parseChangeReport,
} from "./changes.ts";
import { parseCIReceipt, parseCITask } from "./ci.ts";
import {
	type FitnessEnvelope,
	isCommitSha,
	parseFitnessEnvelope,
	parseReviewEnvelope,
	parseWorkerTask,
	type ReviewEnvelope,
	type WorkerKind,
} from "./contracts.ts";
import type { CISlot, Slot } from "./state.ts";
import { MAX_ARCHIVE_BYTES, readReportArchive } from "./zip.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function object(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new TypeError("Expected JSON object");
	return value;
}

export function array(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new TypeError("Expected JSON array");
	return value;
}

export function string(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("Expected JSON string");
	return value;
}

export function integer(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
		throw new TypeError("Expected positive integer");
	return value;
}

export class GitHubError extends Error {
	readonly status: number;
	constructor(status: number) {
		super(`GitHub API request failed (HTTP ${status})`);
		this.name = "GitHubError";
		this.status = status;
	}
}

async function readBounded(response: Response, limit: number): Promise<Buffer> {
	const length = Number(response.headers.get("content-length"));
	if (length > limit) throw new Error("GitHub response exceeds size limit");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	const reader = response.body?.getReader();
	if (!reader) return Buffer.alloc(0);
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.length;
			if (bytes > limit) throw new Error("GitHub response exceeds size limit");
			chunks.push(chunk.value);
		}
	} finally {
		await reader.cancel();
	}
	return Buffer.concat(chunks);
}

/** No automatic write retries: a lost response may already have committed. */
export class GitHub {
	readonly #token: string;
	readonly #base: URL;
	readonly #fetch: typeof fetch;
	constructor(options: {
		token: string;
		apiUrl?: string;
		fetch?: typeof fetch;
	}) {
		this.#token = options.token;
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#base = new URL(options.apiUrl ?? "https://api.github.com");
		if (
			this.#base.protocol !== "https:" ||
			this.#base.username ||
			this.#base.password ||
			this.#base.search ||
			this.#base.hash
		)
			throw new TypeError("Invalid GitHub API origin");
		if (!options.token) throw new TypeError("Missing GitHub token");
	}

	#url(path: string): URL {
		if (
			!path.startsWith("/") ||
			path.startsWith("//") ||
			/[\\#\r\n]/.test(path)
		)
			throw new TypeError("Invalid relative API endpoint");
		const decoded = decodeURIComponent(path.split("?")[0] ?? "");
		if (
			decoded.includes("\\") ||
			decoded.split("/").some((part) => part === "." || part === "..")
		)
			throw new TypeError("Invalid relative API endpoint");
		return new URL(
			`${this.#base.pathname.replace(/\/$/, "")}${path}`,
			this.#base.origin,
		);
	}

	async #send(
		url: URL,
		method: string,
		body?: unknown,
		authorized = true,
	): Promise<Response> {
		try {
			return await this.#fetch(url, {
				method,
				redirect: "manual",
				signal: AbortSignal.timeout(30000),
				headers: {
					accept: "application/vnd.github+json",
					"x-github-api-version": "2022-11-28",
					...(authorized ? { authorization: `Bearer ${this.#token}` } : {}),
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch {
			throw new Error("GitHub transport failed");
		}
	}

	async request(
		method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
		path: string,
		body?: unknown,
	): Promise<unknown> {
		const response = await this.#send(this.#url(path), method, body);
		if (!response.ok) throw new GitHubError(response.status);
		if (response.status === 204) return null;
		const bytes = await readBounded(response, 16 * 1024 * 1024);
		try {
			return JSON.parse(bytes.toString("utf8"));
		} catch {
			throw new Error("GitHub returned invalid JSON");
		}
	}

	async list(path: string, key?: string): Promise<unknown[]> {
		const result: unknown[] = [];
		let expected = 0;
		for (let page = 1; page <= 1000; page++) {
			const url = this.#url(path);
			url.searchParams.set("per_page", "100");
			url.searchParams.set("page", String(page));
			const response = await this.#send(url, "GET");
			if (!response.ok) throw new GitHubError(response.status);
			let data: unknown;
			try {
				data = JSON.parse(
					(await readBounded(response, 16 * 1024 * 1024)).toString("utf8"),
				);
			} catch {
				throw new Error("GitHub returned invalid or oversized JSON");
			}
			const container = key ? object(data) : undefined;
			const items = array(container && key ? container[key] : data);
			if (typeof container?.total_count === "number")
				expected = container.total_count;
			result.push(...items);
			const next = response.headers.get("link")?.includes('rel="next"');
			if (!next && items.length < 100) {
				if (result.length < expected)
					throw new Error("GitHub list was truncated");
				return result;
			}
		}
		throw new Error("GitHub pagination limit exceeded");
	}

	async graphql(
		query: string,
		variables: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const response = object(
			await this.request("POST", "/graphql", { query, variables }),
		);
		if (response.errors !== undefined && array(response.errors).length > 0)
			throw new Error("GitHub GraphQL operation failed");
		return object(response.data);
	}

	async artifact(path: string, digest?: string): Promise<unknown> {
		let url = this.#url(path);
		let authorized = true;
		for (let redirects = 0; redirects < 4; redirects++) {
			const response = await this.#send(url, "GET", undefined, authorized);
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				const location = response.headers.get("location");
				if (!location) throw new Error("Missing artifact redirect");
				const next = new URL(location, url);
				if (next.protocol !== "https:" || next.username || next.password)
					throw new Error("Unsafe artifact redirect");
				authorized = authorized && next.origin === this.#base.origin;
				url = next;
				continue;
			}
			if (!response.ok) throw new GitHubError(response.status);
			return readReportArchive(
				await readBounded(response, MAX_ARCHIVE_BYTES),
				digest,
			);
		}
		throw new Error("Too many artifact redirects");
	}
}

export type GitHubClient = Pick<
	GitHub,
	"request" | "list" | "graphql" | "artifact"
>;
export const workerPath = (kind: WorkerKind) =>
	`.github/workflows/agentic-${kind}.lock.yml`;

export interface ChangeEnvelope {
	schema_version: 1;
	repository: string;
	task: Slot["task"];
	engine: "copilot";
	run_id: number;
	run_attempt: number;
	workflow_sha: string;
	report: ChangeReport;
}
export type WorkerResult =
	| { status: "waiting" }
	| {
			status: "completed";
			envelope: FitnessEnvelope | ReviewEnvelope | ChangeEnvelope;
	  };

export async function observeWorker(input: {
	github: GitHubClient;
	repository: string;
	appBotLogin: string;
	slot: Slot;
}): Promise<WorkerResult> {
	const { github, repository, appBotLogin, slot } = input;
	const task = parseWorkerTask(slot.task);
	if (task.repository !== repository)
		throw new Error("Reserved task repository mismatch");
	const path = workerPath(task.kind);
	const workflow = object(
		await github.request(
			"GET",
			`/repos/${repository}/actions/workflows/${path.split("/").at(-1)}`,
		),
	);
	if (workflow.path !== path)
		throw new Error("Unexpected worker workflow path");
	const createdSince = `${slot.dispatched_at.slice(0, 19)}Z`;
	const runs = (
		await github.list(
			`/repos/${repository}/actions/workflows/${integer(workflow.id)}/runs?event=workflow_dispatch&branch=main&created=${encodeURIComponent(`>=${createdSince}`)}`,
			"workflow_runs",
		)
	).map(object);
	const matching = runs.filter(
		(run) => run.display_title === `c8ctl-${task.correlation}`,
	);
	if (matching.length > 1)
		throw new Error("Multiple worker runs claim one reserved dispatch");
	const run = matching[0];
	if (!run) {
		if (slot.run_id !== null)
			throw new Error("Previously claimed worker run disappeared");
		return { status: "waiting" };
	}
	const actor = object(run.actor);
	if (
		run.workflow_id !== workflow.id ||
		run.path !== path ||
		run.event !== "workflow_dispatch" ||
		run.head_branch !== "main" ||
		actor.login !== appBotLogin ||
		actor.type !== "Bot" ||
		run.run_attempt !== 1 ||
		!isCommitSha(run.head_sha) ||
		(slot.run_id !== null && slot.run_id !== run.id)
	)
		throw new Error("Invalid worker run provenance or manual rerun");
	slot.run_id = integer(run.id);
	slot.run_attempt = 1;
	if (run.status !== "completed") return { status: "waiting" };
	if (run.conclusion !== "success")
		throw new Error("Worker did not complete successfully");
	const artifacts = (
		await github.list(
			`/repos/${repository}/actions/runs/${slot.run_id}/artifacts`,
			"artifacts",
		)
	)
		.map(object)
		.filter(
			(artifact) => artifact.name === `worker-report-${task.correlation}-1`,
		);
	const artifact = artifacts[0];
	if (
		artifacts.length !== 1 ||
		!artifact ||
		artifact.expired !== false ||
		(slot.artifact_id !== null && slot.artifact_id !== artifact.id)
	)
		throw new Error(
			"Missing, duplicate, expired or changed worker report artifact",
		);
	if (artifact.workflow_run !== undefined && artifact.workflow_run !== null) {
		const source = object(artifact.workflow_run);
		if (source.id !== run.id || source.head_sha !== run.head_sha)
			throw new Error("Artifact run provenance mismatch");
	}
	const value = object(
		await github.artifact(
			`/repos/${repository}/actions/artifacts/${integer(artifact.id)}/zip`,
			artifact.digest == null ? undefined : string(artifact.digest),
		),
	);
	const expectedKeys = [
		"schema_version",
		"repository",
		"task",
		"engine",
		"run_id",
		"run_attempt",
		"workflow_sha",
		"report",
	];
	if (
		Object.keys(value).length !== expectedKeys.length ||
		!expectedKeys.every((key) => Object.hasOwn(value, key)) ||
		value.schema_version !== 1 ||
		value.repository !== repository ||
		value.run_id !== run.id ||
		value.run_attempt !== 1 ||
		value.workflow_sha !== run.head_sha ||
		value.engine !== (task.kind === "review-claude" ? "claude" : "copilot") ||
		JSON.stringify(parseWorkerTask(value.task)) !== JSON.stringify(task)
	)
		throw new Error("Worker envelope provenance mismatch");
	let envelope: FitnessEnvelope | ReviewEnvelope | ChangeEnvelope;
	if (task.kind === "fitness") envelope = parseFitnessEnvelope(value);
	else if (task.kind === "review-copilot" || task.kind === "review-claude")
		envelope = parseReviewEnvelope(value);
	else
		envelope = {
			schema_version: 1,
			repository,
			task,
			engine: "copilot",
			run_id: slot.run_id,
			run_attempt: 1,
			workflow_sha: run.head_sha,
			report: parseChangeReport(value.report),
		};
	slot.artifact_id = integer(artifact.id);
	return { status: "completed", envelope };
}

const CI_JOBS = [
	"Lint",
	"Typecheck",
	...[22, 24].flatMap((node) =>
		["ubuntu-latest", "macos-latest", "windows-latest"].map(
			(os) => `Unit Test (Node ${node} / ${os})`,
		),
	),
	...[22, 24].flatMap((node) =>
		["8.8", "8.9", "8.10"].map(
			(camunda) =>
				`Integration Test (Node ${node} / Camunda ${camunda} / ubuntu-latest)`,
		),
	),
];
export interface CIResult {
	status: "pending" | "success" | "failure" | "blocked";
	evidence: string;
}
export async function inspectCI(input: {
	github: GitHubClient;
	repository: string;
	number: number;
	headSha: string;
	baseSha: string;
	mergeSha: string | null;
	ci?: CISlot | null;
	appBotLogin?: string;
}): Promise<CIResult> {
	const { github, repository, number, headSha, baseSha, ci, appBotLogin } =
		input;
	if (!ci)
		return {
			status: "pending",
			evidence:
				"Awaiting reserved immutable Test CI; ordinary PR runs are not convergence proof",
		};
	try {
		const task = parseCITask(ci.task);
		if (
			task.repository !== repository ||
			task.number !== number ||
			task.head_sha !== headSha ||
			task.base_sha !== baseSha ||
			!appBotLogin?.endsWith("[bot]") ||
			appBotLogin === "github-actions[bot]"
		)
			throw new Error(
				"CI reservation does not match the current PR snapshot or App identity",
			);
		const workflow = object(
			await github.request(
				"GET",
				`/repos/${repository}/actions/workflows/test.yml`,
			),
		);
		if (workflow.path !== ".github/workflows/test.yml")
			throw new Error("Unexpected Test workflow path");
		const runs = (
			await github.list(
				`/repos/${repository}/actions/workflows/${integer(workflow.id)}/runs?event=workflow_dispatch&branch=main&created=${encodeURIComponent(`>=${ci.dispatched_at.slice(0, 19)}Z`)}`,
				"workflow_runs",
			)
		).map(object);
		const matching = runs.filter(
			(run) => run.display_title === `c8ctl-ci-${task.correlation}`,
		);
		if (matching.length > 1)
			throw new Error("Multiple Test runs claim one reserved CI dispatch");
		const run = matching[0];
		if (!run) {
			if (ci.run_id !== null)
				throw new Error("Previously claimed CI run disappeared");
			return {
				status: "pending",
				evidence:
					"Discovering the reserved Test correlation; never redispatching ambiguously",
			};
		}
		if (
			run.workflow_id !== workflow.id ||
			run.path !== workflow.path ||
			run.event !== "workflow_dispatch" ||
			run.head_branch !== "main" ||
			run.head_sha !== task.base_sha ||
			run.run_attempt !== 1 ||
			object(run.actor).login !== appBotLogin ||
			object(run.actor).type !== "Bot" ||
			(ci.run_id !== null && ci.run_id !== run.id) ||
			(ci.run_attempt !== null && ci.run_attempt !== 1)
		)
			throw new Error(
				"Invalid CI run provenance, workflow base or manual rerun",
			);
		ci.run_id = integer(run.id);
		ci.run_attempt = 1;
		const url = `https://github.com/${repository}/actions/runs/${integer(run.id)}`;
		if (run.status !== "completed") return { status: "pending", evidence: url };
		if (run.conclusion !== "success" && run.conclusion !== "failure")
			throw new Error("Reserved Test run was cancelled or did not complete");
		const commit = object(
			await github.request(
				"GET",
				`/repos/${repository}/commits/${task.merge_sha}`,
			),
		);
		const parents = array(commit.parents).map((parent) => object(parent).sha);
		if (
			commit.sha !== task.merge_sha ||
			parents.length !== 2 ||
			parents[0] !== baseSha ||
			parents[1] !== headSha
		)
			throw new Error("Reserved synthetic merge commit parent mismatch");
		const artifacts = (
			await github.list(
				`/repos/${repository}/actions/runs/${run.id}/artifacts`,
				"artifacts",
			)
		)
			.map(object)
			.filter(
				(artifact) => artifact.name === `ci-report-${task.correlation}-1`,
			);
		const artifact = artifacts[0];
		if (
			artifacts.length !== 1 ||
			!artifact ||
			artifact.expired !== false ||
			(ci.artifact_id !== null && ci.artifact_id !== artifact.id)
		)
			throw new Error(
				"Missing, duplicate, expired or changed CI receipt artifact",
			);
		if (artifact.workflow_run !== undefined && artifact.workflow_run !== null) {
			const source = object(artifact.workflow_run);
			if (source.id !== run.id || source.head_sha !== task.base_sha)
				throw new Error("CI artifact run provenance mismatch");
		}
		const receipt = parseCIReceipt(
			await github.artifact(
				`/repos/${repository}/actions/artifacts/${integer(artifact.id)}/zip`,
				artifact.digest == null ? undefined : string(artifact.digest),
			),
		);
		if (
			receipt.repository !== repository ||
			receipt.run_id !== run.id ||
			receipt.run_attempt !== 1 ||
			receipt.workflow_sha !== task.base_sha ||
			receipt.tested_sha !== task.merge_sha ||
			JSON.stringify(receipt.task) !== JSON.stringify(task)
		)
			throw new Error("CI receipt does not match the reserved task and run");
		const jobs = (
			await github.list(
				`/repos/${repository}/actions/runs/${integer(run.id)}/attempts/${integer(run.run_attempt)}/jobs`,
				"jobs",
			)
		).map(object);
		const failedPrerequisite = jobs.some(
			(job) =>
				["Lint", "Typecheck"].includes(string(job.name)) &&
				["failure", "timed_out"].includes(string(job.conclusion)),
		);
		// GitHub skips a dependency-blocked job before expanding its matrix.
		const collapsedUnitName = `Unit Test (Node \${{ matrix.node }} / \${{ matrix.os }})`;
		const collapsedUnits = jobs.filter((job) => job.name === collapsedUnitName);
		const skippedUnitMatrix =
			failedPrerequisite &&
			collapsedUnits.length === 1 &&
			collapsedUnits[0]?.status === "completed" &&
			collapsedUnits[0]?.conclusion === "skipped" &&
			!jobs.some(
				(job) =>
					CI_JOBS.includes(string(job.name)) &&
					string(job.name).startsWith("Unit Test"),
			);
		if (collapsedUnits.length > 0 && !skippedUnitMatrix)
			throw new Error("Unexpected or duplicate unexpanded unit matrix");
		const expectedJobs = skippedUnitMatrix
			? [
					...CI_JOBS.filter((name) => !name.startsWith("Unit Test")),
					collapsedUnitName,
				]
			: CI_JOBS;
		for (const name of [
			...expectedJobs,
			"Agentic CI Revision",
			"Agentic CI Receipt",
		]) {
			const selected = jobs.filter((job) => job.name === name);
			if (selected.length !== 1 || selected[0]?.status !== "completed")
				return {
					status: "blocked",
					evidence: `${url}: missing, incomplete or duplicate job ${name}`,
				};
		}
		if (
			jobs.some(
				(job) =>
					(job.name === "Agentic CI Revision" ||
						job.name === "Agentic CI Receipt") &&
					job.conclusion !== "success",
			)
		)
			throw new Error("Trusted CI revision or receipt job did not succeed");
		const groups = {
			lint: ["Lint"],
			typecheck: ["Typecheck"],
			unit: expectedJobs.filter((name) => name.startsWith("Unit Test")),
			integration: CI_JOBS.filter((name) =>
				name.startsWith("Integration Test"),
			),
		};
		for (const key of ["lint", "typecheck", "unit", "integration"] as const) {
			const conclusions = jobs
				.filter((job) => groups[key].includes(string(job.name)))
				.map((job) => job.conclusion);
			const outcome =
				conclusions.includes("failure") || conclusions.includes("timed_out")
					? "failure"
					: conclusions.includes("cancelled")
						? "cancelled"
						: conclusions.every((value) => value === "success")
							? "success"
							: conclusions.every((value) => value === "skipped")
								? "skipped"
								: null;
			if (outcome === null || receipt.jobs[key] !== outcome)
				throw new Error("CI receipt outcomes disagree with actual matrix jobs");
		}
		const required = jobs.filter((job) =>
			expectedJobs.includes(string(job.name)),
		);
		ci.artifact_id = integer(artifact.id);
		if (
			required.some(
				(job) =>
					job.conclusion === "cancelled" ||
					(job.conclusion === "skipped" &&
						!(failedPrerequisite && string(job.name).startsWith("Unit Test"))),
			)
		)
			return {
				status: "blocked",
				evidence: `${url}: required matrix jobs were skipped or cancelled`,
			};
		const failures = required.filter(
			(job) => job.conclusion === "failure" || job.conclusion === "timed_out",
		);
		if (failures.length)
			return run.conclusion === "failure"
				? {
						status: "failure",
						evidence: `${url}: ${failures.map((job) => job.name).join(", ")}`,
					}
				: {
						status: "blocked",
						evidence: "Test run conclusion contradicts failed matrix jobs",
					};
		if (
			run.conclusion !== "success" ||
			required.some(
				(job) => job.status !== "completed" || job.conclusion !== "success",
			)
		)
			return {
				status: "blocked",
				evidence: `${url}: required jobs did not all succeed (including skipped jobs)`,
			};
		return { status: "success", evidence: url };
	} catch (error) {
		return {
			status: "blocked",
			evidence:
				error instanceof Error
					? error.message.slice(0, 1000)
					: "Invalid CI proof",
		};
	}
}

export interface InheritedFile {
	path: string;
	deleted: boolean;
}

export async function prepareCommit(input: {
	github: GitHubClient;
	repository: string;
	branch: string;
	expectedHeadOid: string;
	report: ChangeReport;
	reimplementation: boolean;
	inheritedFiles?: readonly InheritedFile[];
}): Promise<CreateCommitInput> {
	const { github, repository, expectedHeadOid } = input;
	const report = parseChangeReport(input.report);
	const tree = object(
		await github.request(
			"GET",
			`/repos/${repository}/git/trees/${expectedHeadOid}?recursive=1`,
		),
	);
	if (tree.truncated !== false)
		throw new Error("Cannot write using a truncated Git tree");
	const existingFiles: ExistingFile[] = [];
	for (const value of array(tree.tree)) {
		const entry = object(value);
		const path = string(entry.path),
			mode = string(entry.mode),
			type = string(entry.type);
		const target = report.files.find(
			(file) => file.path === path && file.content !== null,
		);
		let content: string | undefined;
		if (target && type === "blob" && mode === "100644") {
			if (!isCommitSha(entry.sha)) throw new Error("Invalid tree blob SHA");
			const blob = object(
				await github.request(
					"GET",
					`/repos/${repository}/git/blobs/${entry.sha}`,
				),
			);
			if (blob.encoding !== "base64")
				throw new Error("Unsupported Git blob encoding");
			try {
				content = new TextDecoder("utf-8", { fatal: true }).decode(
					Buffer.from(string(blob.content), "base64"),
				);
			} catch {
				throw new Error("Cannot replace a non-UTF-8 blob");
			}
		}
		existingFiles.push({
			path,
			mode,
			type,
			...(content === undefined ? {} : { content }),
		});
	}
	const byPath = new Map(
		existingFiles.map((file) => [file.path, file] as const),
	);
	for (const file of input.inheritedFiles ?? []) {
		const segments = file.path.split("/");
		for (let index = 1; index <= segments.length; index++) {
			const path = segments.slice(0, index).join("/");
			const entry = byPath.get(path);
			const target = index === segments.length;
			if (file.deleted && !entry) continue;
			if (
				!entry ||
				(target && file.deleted) ||
				(target
					? entry.mode !== "100644" || entry.type !== "blob"
					: entry.mode !== "040000" || entry.type !== "tree")
			)
				throw new Error(
					"Inherited fork diff contains an unsafe or missing Git target or ancestor",
				);
		}
	}
	return createCommitInput({ ...input, report, existingFiles });
}
