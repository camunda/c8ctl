/**
 * Project scaffolding for `c8ctl setup`.
 *
 * The three blueprints are intentionally curated here and are not exposed as
 * a CLI command. Files are enumerated through GitHub's tree API and each file
 * is downloaded from its raw URL, so setup does not require git.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isRecord } from "../../core/index.ts";

export interface BlueprintSource {
	readonly owner: string;
	readonly repo: string;
	readonly ref: string;
	readonly path: string;
}

export interface SetupBlueprint {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly guideUrl: string;
	readonly source: BlueprintSource;
}

export const SETUP_BLUEPRINTS = [
	{
		id: "rocket-launch",
		name: "Rocket Launch",
		description: "A fully automated hello-world process with a decision.",
		guideUrl:
			"https://docs.camunda.io/docs/guides/getting-started-hello-world/",
		source: {
			owner: "camunda",
			repo: "camunda-8-get-started",
			ref: "main",
			path: "1-rocket-launch",
		},
	},
	{
		id: "service-worker",
		name: "Service worker",
		description: "An order process with service worker implementations.",
		guideUrl: "https://docs.camunda.io/docs/guides/getting-started-example/",
		source: {
			owner: "camunda",
			repo: "camunda-8-get-started",
			ref: "main",
			path: "2-order-process-with-service-workers",
		},
	},
	{
		id: "ai-agent",
		name: "AI agent",
		description: "An agentic chat process with tools and user feedback.",
		guideUrl:
			"https://docs.camunda.io/docs/guides/getting-started-agentic-orchestration/",
		source: {
			owner: "camunda",
			repo: "camunda-8-tutorials",
			ref: "main",
			path: "solutions/ai-agent-chat-with-tools",
		},
	},
] as const satisfies readonly SetupBlueprint[];

export type SetupBlueprintId = (typeof SETUP_BLUEPRINTS)[number]["id"];

export interface BlueprintResponse {
	readonly ok: boolean;
	readonly status: number;
	readonly statusText: string;
	json(): Promise<unknown>;
	arrayBuffer(): Promise<ArrayBuffer>;
}

export type BlueprintFetch = (
	url: string,
	init: {
		headers: Record<string, string>;
		signal: AbortSignal;
	},
) => Promise<BlueprintResponse>;

export type BlueprintProgressPhase =
	| "listing"
	| "downloading"
	| "writing"
	| "complete";

export interface BlueprintProgress {
	readonly phase: BlueprintProgressPhase;
	readonly message: string;
	readonly totalFiles?: number;
}

export interface ScaffoldSetupBlueprintOptions {
	readonly id: string;
	/** Exact project directory. Defaults to `<cwd>/<blueprint id>`. */
	readonly destinationDir?: string;
	/** Base directory used when `destinationDir` is relative or omitted. */
	readonly cwd?: string;
	readonly fetch?: BlueprintFetch;
	readonly onProgress?: (event: BlueprintProgress) => void;
	readonly timeoutMs?: number;
}

export interface ScaffoldedSetupBlueprint {
	readonly blueprint: SetupBlueprint;
	readonly directory: string;
	readonly files: string[];
}

export class BlueprintScaffoldError extends Error {
	readonly hint?: string;

	constructor(
		message: string,
		options: { hint?: string; cause?: unknown } = {},
	) {
		super(message, { cause: options.cause });
		this.name = "BlueprintScaffoldError";
		this.hint = options.hint;
	}
}

interface GitHubTreeEntry {
	readonly path: string;
	readonly type: string;
}

interface DownloadedFile {
	readonly relativePath: string;
	readonly contents: Buffer;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function blueprintById(id: string): SetupBlueprint {
	const blueprint = SETUP_BLUEPRINTS.find((candidate) => candidate.id === id);
	if (blueprint) return blueprint;
	const ids = SETUP_BLUEPRINTS.map((candidate) => candidate.id).join(", ");
	throw new BlueprintScaffoldError(
		`Unknown blueprint "${id}". Available blueprints: ${ids}.`,
	);
}

function githubCommitUrl(source: BlueprintSource): string {
	return (
		`https://api.github.com/repos/${source.owner}/${source.repo}/commits/` +
		encodeURIComponent(source.ref)
	);
}

function githubTreeUrl(source: BlueprintSource, revision: string): string {
	return (
		`https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/` +
		`${encodeURIComponent(revision)}?recursive=1`
	);
}

function encodeGitHubPath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

function rawFileUrl(
	source: BlueprintSource,
	revision: string,
	path: string,
): string {
	return (
		`https://raw.githubusercontent.com/${source.owner}/${source.repo}/` +
		`${encodeURIComponent(revision)}/${encodeGitHubPath(path)}`
	);
}

function githubHeaders(): Record<string, string> {
	return {
		Accept: "application/vnd.github+json",
		"User-Agent": "c8ctl",
		"X-GitHub-Api-Version": "2022-11-28",
	};
}

async function request<T>({
	fetch,
	url,
	timeoutMs,
	failureMessage,
	read,
}: {
	fetch: BlueprintFetch;
	url: string;
	timeoutMs: number;
	failureMessage: string;
	read: (response: BlueprintResponse) => Promise<T>;
}): Promise<T> {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	try {
		const response = await fetch(url, {
			headers: githubHeaders(),
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new BlueprintScaffoldError(
				`${failureMessage}: HTTP ${response.status} ${response.statusText} (${url}).`,
			);
		}
		return await read(response);
	} catch (error) {
		if (error instanceof BlueprintScaffoldError) throw error;
		throw new BlueprintScaffoldError(
			`${failureMessage}${timedOut ? ` after ${timeoutMs / 1000}s` : ""}.`,
			{
				hint: "Check your network connection. If you use a proxy, make sure Node.js is configured to use it.",
				cause: error,
			},
		);
	} finally {
		clearTimeout(timer);
	}
}

function parseCommitSha(value: unknown): string {
	if (
		isRecord(value) &&
		typeof value.sha === "string" &&
		/^[0-9a-f]{40}$/i.test(value.sha)
	) {
		return value.sha;
	}
	throw new BlueprintScaffoldError(
		"GitHub returned an unexpected blueprint revision.",
		{
			hint: "Try again later; the GitHub commit response format may have changed.",
		},
	);
}

function isGitHubTreeEntry(value: unknown): value is GitHubTreeEntry {
	return (
		isRecord(value) &&
		typeof value.path === "string" &&
		typeof value.type === "string"
	);
}

function parseGitHubTree(value: unknown): GitHubTreeEntry[] {
	if (!isRecord(value) || !Array.isArray(value.tree)) {
		throw new BlueprintScaffoldError(
			"GitHub returned an unexpected blueprint file list.",
			{
				hint: "Try again later; the GitHub tree response format may have changed.",
			},
		);
	}
	if (value.truncated === true) {
		throw new BlueprintScaffoldError(
			"GitHub returned a truncated blueprint file list; the project was not written.",
			{ hint: "Try again later or reduce the blueprint size." },
		);
	}
	return value.tree.map((entry) => {
		if (!isGitHubTreeEntry(entry)) {
			throw new BlueprintScaffoldError(
				"GitHub returned an unexpected entry in the blueprint file list.",
			);
		}
		return { path: entry.path, type: entry.type };
	});
}

function isSafeRelativePath(path: string): boolean {
	return (
		path.length > 0 &&
		!path.startsWith("/") &&
		!/^[A-Za-z]:/.test(path) &&
		!path.includes("\\") &&
		!path.includes("\0") &&
		path
			.split("/")
			.every((part) => part !== "" && part !== "." && part !== "..")
	);
}

function projectFilePaths(
	tree: readonly GitHubTreeEntry[],
	source: BlueprintSource,
): string[] {
	const prefix = `${source.path}/`;
	return tree
		.filter((entry) => entry.type === "blob" && entry.path.startsWith(prefix))
		.map((entry) => entry.path.slice(prefix.length))
		.map((relativePath) => {
			if (!isSafeRelativePath(relativePath)) {
				throw new BlueprintScaffoldError(
					`GitHub returned an unsafe path in the blueprint: ${source.path}/${relativePath}.`,
				);
			}
			return relativePath;
		})
		.sort();
}

function assertDestinationAvailable(directory: string): void {
	if (!existsSync(directory)) return;
	if (!statSync(directory).isDirectory()) {
		throw new BlueprintScaffoldError(
			`Blueprint destination ${directory} already exists and is not a directory.`,
			{ hint: "Choose an empty or new destination directory." },
		);
	}
	if (readdirSync(directory).length > 0) {
		throw new BlueprintScaffoldError(
			`Blueprint destination ${directory} already exists and is not empty.`,
			{
				hint: "Choose an empty or new destination directory; existing files are never overwritten.",
			},
		);
	}
}

function destinationPath(directory: string, relativePath: string): string {
	return join(directory, ...relativePath.split("/"));
}

async function downloadFiles({
	blueprint,
	revision,
	paths,
	fetch,
	timeoutMs,
}: {
	blueprint: SetupBlueprint;
	revision: string;
	paths: readonly string[];
	fetch: BlueprintFetch;
	timeoutMs: number;
}): Promise<DownloadedFile[]> {
	const files: DownloadedFile[] = [];
	for (const relativePath of paths) {
		const contents = await request({
			fetch,
			url: rawFileUrl(
				blueprint.source,
				revision,
				`${blueprint.source.path}/${relativePath}`,
			),
			timeoutMs,
			failureMessage: `Could not download ${relativePath} from GitHub`,
			read: async (response) => Buffer.from(await response.arrayBuffer()),
		});
		files.push({ relativePath, contents });
	}
	return files;
}

function writeFiles(directory: string, files: readonly DownloadedFile[]): void {
	mkdirSync(directory, { recursive: true });
	for (const file of files) {
		const destination = destinationPath(directory, file.relativePath);
		mkdirSync(dirname(destination), { recursive: true });
		writeFileSync(destination, file.contents, { flag: "wx" });
	}
}

/** Download one curated setup blueprint into a new or empty directory. */
export async function scaffoldSetupBlueprint({
	id,
	destinationDir,
	cwd = process.cwd(),
	fetch = globalThis.fetch,
	onProgress,
	timeoutMs = DEFAULT_TIMEOUT_MS,
}: ScaffoldSetupBlueprintOptions): Promise<ScaffoldedSetupBlueprint> {
	const blueprint = blueprintById(id);
	const directory = resolve(cwd, destinationDir ?? blueprint.id);
	assertDestinationAvailable(directory);

	onProgress?.({
		phase: "listing",
		message: `Fetching the ${blueprint.name} file list…`,
	});
	const revision = parseCommitSha(
		await request({
			fetch,
			url: githubCommitUrl(blueprint.source),
			timeoutMs,
			failureMessage: "Could not resolve the blueprint revision from GitHub",
			read: (response) => response.json(),
		}),
	);
	const tree = await request({
		fetch,
		url: githubTreeUrl(blueprint.source, revision),
		timeoutMs,
		failureMessage: "Could not fetch the blueprint file list from GitHub",
		read: (response) => response.json(),
	});
	const files = projectFilePaths(parseGitHubTree(tree), blueprint.source);
	if (files.length === 0) {
		throw new BlueprintScaffoldError(
			`GitHub did not list any files for ${blueprint.name}.`,
		);
	}

	onProgress?.({
		phase: "downloading",
		message: `Downloading ${files.length} ${blueprint.name} files…`,
		totalFiles: files.length,
	});
	const downloaded = await downloadFiles({
		blueprint,
		revision,
		paths: files,
		fetch,
		timeoutMs,
	});

	onProgress?.({
		phase: "writing",
		message: `Writing ${blueprint.name} to ${directory}…`,
		totalFiles: files.length,
	});
	assertDestinationAvailable(directory);
	writeFiles(directory, downloaded);
	onProgress?.({
		phase: "complete",
		message: `${blueprint.name} is ready in ${directory}.`,
		totalFiles: files.length,
	});

	return { blueprint, directory, files };
}
