/**
 * Project scaffolding for `c8ctl setup`.
 *
 * The blueprints are intentionally curated here and are not exposed as
 * a CLI command. Files are enumerated through GitHub's tree API and each file
 * is downloaded from its raw URL, so setup does not require git.
 *
 * Scaffolding is idempotent: a finished scaffold carries a marker file
 * (`.c8ctl-blueprint.json`) with its blueprint id and file list. A rerun
 * against the same blueprint reuses the directory without touching the
 * network; a directory marked with a different blueprint — or a foreign
 * non-empty directory — is an actionable error, never an overwrite.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isRecord } from "../../src/core/index.ts";

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
	/**
	 * Directory to deploy, relative to the scaffolded project root. Some
	 * projects carry several copies of a model (e.g. one per worker
	 * language); deploying the whole project would deploy the same
	 * definition twice, which Camunda rejects. Default: the project root.
	 */
	readonly deployPath?: string;
	/**
	 * The BPMN file whose process setup starts after deploying, relative
	 * to the scaffolded project root.
	 */
	readonly processFile: string;
	/**
	 * Variables for the first process instance, where the model needs
	 * inputs to run through without an incident.
	 */
	readonly startVariables?: Record<string, unknown>;
	/**
	 * Actionable closing lines for the setup "What's next" box, given the
	 * scaffolded project directory and the key of the process instance
	 * setup started. Rendered ahead of the generic Project / Guide /
	 * Operate lines, so each blueprint can say what the run left behind
	 * and what to do with it.
	 */
	readonly nextSteps: (context: {
		readonly projectDir: string;
		readonly processInstanceKey: string;
	}) => readonly string[];
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
		processFile: "rocket-launch.bpmn",
		// The mission decision reads these; the upstream quick-start's
		// "full send" launch.
		startVariables: { missionName: "Apollo", fuelLevel: 80 },
		// Fully automated: setup already deployed and launched an
		// instance, so the next step is looking at it. The deeplink opens
		// the started instance in Operate directly — no filter clearing.
		// The CLI lines pin the local profile (the session's active
		// profile may point elsewhere), and the run path is quoted: the
		// working directory may contain spaces. All lines stay printable
		// ASCII so the box keeps its borders.
		nextSteps: ({ projectDir, processInstanceKey }) => [
			"Process instance is running on the local cluster.",
			`Watch it:   http://localhost:8080/operate/processes/${processInstanceKey}`,
			"            (login using demo / demo as username / password)",
			`Inspect it: c8ctl get process-instance ${processInstanceKey} --profile local`,
			`Run again:  c8ctl run "${join(projectDir, "rocket-launch.bpmn")}" --profile local`,
			"            (deploys and starts the process; no Tasklist needed)",
		],
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
		// The worker implementations each embed a copy of the model; only
		// the bpmn/ directory is deployed.
		deployPath: "bpmn",
		processFile: "bpmn/order-process.bpmn",
		// The started instance stalls at its first service task until a
		// worker connects — starting one is the whole point of the box.
		// One block per shipped worker language, kept to copy-pasteable
		// commands that work from any directory: --prefix, --project and
		// -f stand in for cd, and paths are quoted (the working directory
		// may contain spaces). npm and pip keep their install step on a
		// separate line: && is a syntax error in Windows PowerShell 5.1.
		// All lines stay printable ASCII so the box keeps its borders.
		nextSteps: ({ projectDir, processInstanceKey }) => [
			"Process instance is running on the local cluster.",
			"It waits at the first service task until a worker connects.",
			`Open it:  http://localhost:8080/operate/processes/${processInstanceKey}`,
			"          (login using demo / demo as username / password)",
			"",
			"Start a worker in your language:",
			`  Node.js:  npm --prefix "${join(projectDir, "nodejs")}" install`,
			`            npm --prefix "${join(projectDir, "nodejs")}" start`,
			`  Python:   pip install -r "${join(projectDir, "python", "requirements.txt")}"`,
			`            python "${join(projectDir, "python", "main.py")}"`,
			`  Java:     mvn -f "${join(projectDir, "java")}" spring-boot:run`,
			`  C#:       dotnet run --project "${join(projectDir, "csharp")}"`,
		],
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

export interface SetupBlueprintRemoval {
	readonly blueprint: SetupBlueprint;
	readonly directory: string;
	readonly files: readonly string[];
	readonly markerContent: string;
}

export interface SetupBlueprintRemovalResult {
	readonly removedFiles: readonly string[];
	readonly remainingFiles: readonly string[];
	readonly directoryExists: boolean;
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

/** The curated blueprint with this id; throws an error listing the valid ids. */
export function setupBlueprintById(id: string): SetupBlueprint {
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

// ── Idempotency marker ─────────────────────────────────────────────

/** Written into every finished scaffold; makes a rerun reuse the project. */
const MARKER_FILE = ".c8ctl-blueprint.json";

interface BlueprintMarker {
	readonly id: string;
	readonly files: string[];
}

function isBlueprintMarker(value: unknown): value is BlueprintMarker {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		Array.isArray(value.files) &&
		value.files.every((file) => typeof file === "string")
	);
}

/**
 * The marker of a previously scaffolded project, or undefined when the
 * directory has none (fresh, empty, or foreign). A corrupt marker reads
 * as no marker: the directory is then foreign and refuses scaffolding.
 */
function readMarker(directory: string): BlueprintMarker | undefined {
	const markerPath = join(directory, MARKER_FILE);
	if (!existsSync(markerPath)) return undefined;
	try {
		const value: unknown = JSON.parse(readFileSync(markerPath, "utf-8"));
		if (isBlueprintMarker(value)) return { id: value.id, files: value.files };
	} catch {
		// Unreadable or invalid JSON — treat the directory as foreign.
	}
	return undefined;
}

function readRemovalMarker(
	directory: string,
): { marker: BlueprintMarker; content: string } | undefined {
	const rootInfo = lstatSync(directory, { throwIfNoEntry: false });
	if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
		return undefined;
	}

	const markerPath = join(directory, MARKER_FILE);
	const markerInfo = lstatSync(markerPath, { throwIfNoEntry: false });
	if (!markerInfo) return undefined;
	if (markerInfo.isSymbolicLink() || !markerInfo.isFile()) {
		throw new BlueprintScaffoldError(
			`Cannot safely inspect the blueprint marker in ${directory}.`,
			{ hint: "Inspect the marker manually before removing this project." },
		);
	}

	const content = readFileSync(markerPath, "utf-8");
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch (error) {
		throw new BlueprintScaffoldError(
			`Cannot safely remove the blueprint in ${directory}: its marker is invalid.`,
			{
				hint: "Repair or remove the marker manually before trying again.",
				cause: error,
			},
		);
	}
	if (!isBlueprintMarker(value)) {
		throw new BlueprintScaffoldError(
			`Cannot safely remove the blueprint in ${directory}: its marker is invalid.`,
			{ hint: "Repair or remove the marker manually before trying again." },
		);
	}

	const blueprint = SETUP_BLUEPRINTS.find(
		(candidate) => candidate.id === value.id,
	);
	if (!blueprint) {
		throw new BlueprintScaffoldError(
			`Cannot safely remove the blueprint in ${directory}: "${value.id}" is not a supported setup blueprint.`,
		);
	}
	if (
		value.files.some(
			(file) => !isSafeRelativePath(file) || file === MARKER_FILE,
		) ||
		new Set(value.files).size !== value.files.length
	) {
		throw new BlueprintScaffoldError(
			`Cannot safely remove the blueprint in ${directory}: its file list is invalid.`,
			{ hint: "Repair or remove the marker manually before trying again." },
		);
	}

	return {
		marker: { id: value.id, files: value.files },
		content,
	};
}

/**
 * Find setup-generated blueprint projects in the current directory or its
 * immediate children. Only projects with a valid setup marker are included.
 */
export function planSetupBlueprintRemovals({
	cwd = process.cwd(),
	onError,
}: {
	cwd?: string;
	onError?: (directory: string, error: unknown) => void;
} = {}): SetupBlueprintRemoval[] {
	const root = resolve(cwd);
	const directories = [
		root,
		...SETUP_BLUEPRINTS.map((blueprint) => resolve(root, blueprint.id)),
	];
	const seen = new Set<string>();
	const removals: SetupBlueprintRemoval[] = [];

	for (const directory of directories) {
		if (seen.has(directory)) continue;
		seen.add(directory);

		try {
			const result = readRemovalMarker(directory);
			if (!result) continue;
			const blueprint = SETUP_BLUEPRINTS.find(
				(candidate) => candidate.id === result.marker.id,
			);
			if (!blueprint) {
				throw new BlueprintScaffoldError(
					`Cannot safely remove the blueprint in ${directory}: its marker is unsupported.`,
				);
			}
			removals.push({
				blueprint,
				directory,
				files: result.marker.files,
				markerContent: result.content,
			});
		} catch (error) {
			if (!onError) throw error;
			onError(directory, error);
		}
	}
	return removals;
}

function isWithinBlueprint(directory: string, candidate: string): boolean {
	const relativePath = relative(resolve(directory), resolve(candidate));
	return (
		relativePath === "" ||
		(relativePath !== ".." &&
			!relativePath.startsWith(`..${sep}`) &&
			!isAbsolute(relativePath))
	);
}

function hasSafeDirectoryChain(directory: string, candidate: string): boolean {
	const root = resolve(directory);
	const target = resolve(candidate);
	if (!isWithinBlueprint(root, target)) return false;
	const rootInfo = lstatSync(root, { throwIfNoEntry: false });
	if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
		return false;
	}
	const relativePath = relative(root, target);
	if (relativePath === "") return true;

	let current = root;
	for (const segment of relativePath.split(sep)) {
		current = join(current, segment);
		const info = lstatSync(current, { throwIfNoEntry: false });
		if (!info || info.isSymbolicLink() || !info.isDirectory()) return false;
	}
	return true;
}

/**
 * Remove only files listed by a valid setup marker. The caller must display
 * the file list and get explicit confirmation before calling this function.
 */
export function removeSetupBlueprint(
	removal: SetupBlueprintRemoval,
): SetupBlueprintRemovalResult {
	const directory = resolve(removal.directory);
	const current = readRemovalMarker(directory);
	if (
		!current ||
		current.content !== removal.markerContent ||
		current.marker.id !== removal.blueprint.id
	) {
		throw new BlueprintScaffoldError(
			`The blueprint in ${directory} changed after the removal preview. Review it and try again.`,
		);
	}

	const rootInfo = lstatSync(directory, { throwIfNoEntry: false });
	if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
		throw new BlueprintScaffoldError(
			`Cannot safely remove the blueprint in ${directory}: its project directory changed.`,
		);
	}

	const removedFiles: string[] = [];
	const remainingFiles: string[] = [];
	for (const relativePath of current.marker.files) {
		let parent = directory;
		let missingParent = false;
		let unsafeParent = false;
		for (const segment of relativePath.split("/").slice(0, -1)) {
			parent = join(parent, segment);
			const parentInfo = lstatSync(parent, { throwIfNoEntry: false });
			if (!parentInfo) {
				missingParent = true;
				break;
			}
			if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
				unsafeParent = true;
				break;
			}
		}
		if (missingParent) continue;
		if (unsafeParent) {
			remainingFiles.push(relativePath);
			continue;
		}

		const target = join(parent, relativePath.split("/").at(-1) ?? "");
		if (!isWithinBlueprint(directory, target)) {
			throw new BlueprintScaffoldError(
				`Cannot safely remove the blueprint file ${relativePath} from ${directory}.`,
			);
		}
		const targetInfo = lstatSync(target, { throwIfNoEntry: false });
		if (!targetInfo) continue;
		if (targetInfo.isSymbolicLink() || targetInfo.isFile()) {
			unlinkSync(target);
			removedFiles.push(relativePath);
		} else {
			remainingFiles.push(relativePath);
		}
	}

	if (remainingFiles.length === 0) {
		const markerPath = join(directory, MARKER_FILE);
		if (readFileSync(markerPath, "utf-8") !== removal.markerContent) {
			throw new BlueprintScaffoldError(
				`The blueprint marker in ${directory} changed during removal. Review it and try again.`,
			);
		}
		unlinkSync(markerPath);
		removedFiles.push(MARKER_FILE);
	} else {
		remainingFiles.push(MARKER_FILE);
	}

	const parentDirectories = new Set<string>();
	for (const relativePath of current.marker.files) {
		let parent = dirname(join(directory, ...relativePath.split("/")));
		while (parent !== directory) {
			parentDirectories.add(parent);
			const next = dirname(parent);
			if (next === parent) break;
			parent = next;
		}
	}
	for (const parent of [...parentDirectories].sort(
		(left, right) => right.length - left.length,
	)) {
		if (
			hasSafeDirectoryChain(directory, parent) &&
			readdirSync(parent).length === 0
		) {
			rmdirSync(parent);
		}
	}

	const finalRootInfo = lstatSync(directory, { throwIfNoEntry: false });
	if (
		resolve(directory) !== resolve(process.cwd()) &&
		finalRootInfo?.isDirectory() &&
		!finalRootInfo.isSymbolicLink() &&
		readdirSync(directory).length === 0
	) {
		rmdirSync(directory);
	}

	return {
		removedFiles,
		remainingFiles,
		directoryExists: existsSync(directory),
	};
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

function writeFiles(
	directory: string,
	files: readonly DownloadedFile[],
	blueprint: SetupBlueprint,
): void {
	mkdirSync(directory, { recursive: true });
	for (const file of files) {
		const destination = destinationPath(directory, file.relativePath);
		mkdirSync(dirname(destination), { recursive: true });
		writeFileSync(destination, file.contents, { flag: "wx" });
	}
	// The marker goes last: its presence proves the scaffold completed.
	const marker: BlueprintMarker = {
		id: blueprint.id,
		files: files.map((file) => file.relativePath),
	};
	writeFileSync(
		join(directory, MARKER_FILE),
		`${JSON.stringify(marker, null, 2)}\n`,
		{ flag: "wx" },
	);
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
	const blueprint = setupBlueprintById(id);
	const directory = resolve(cwd, destinationDir ?? blueprint.id);

	// Idempotent rerun: a directory marked with this blueprint is reused
	// as-is — no suffixed copies, no network, no overwrite.
	const marker = readMarker(directory);
	if (marker) {
		if (marker.id === blueprint.id) {
			// A marker alone is not proof of a complete project: a file may
			// have been deleted since. Refuse to reuse a partial scaffold —
			// deploying it would fail later with a less obvious error.
			const missing = marker.files.filter(
				(file) => !existsSync(destinationPath(directory, file)),
			);
			if (missing.length > 0) {
				throw new BlueprintScaffoldError(
					`Blueprint project ${directory} is incomplete: ${missing.join(", ")} missing.`,
					{
						hint: "Remove the directory and re-run to scaffold the blueprint fresh; existing files are never overwritten.",
					},
				);
			}
			onProgress?.({
				phase: "complete",
				message: `${blueprint.name} is already set up in ${directory}.`,
				totalFiles: marker.files.length,
			});
			return { blueprint, directory, files: marker.files };
		}
		throw new BlueprintScaffoldError(
			`Blueprint destination ${directory} already contains the "${marker.id}" blueprint.`,
			{
				hint: `Remove the directory to start over, or keep it and pick the "${marker.id}" blueprint in the setup wizard.`,
			},
		);
	}
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
	writeFiles(directory, downloaded, blueprint);
	onProgress?.({
		phase: "complete",
		message: `${blueprint.name} is ready in ${directory}.`,
		totalFiles: files.length,
	});

	return { blueprint, directory, files };
}
