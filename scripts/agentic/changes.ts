import { Buffer } from "node:buffer";
import { isCommitSha } from "./contracts.ts";

export interface ChangeReport {
	readonly schema_version: 1;
	readonly status: "complete" | "blocked";
	readonly title: string;
	readonly summary: string;
	readonly evidence: string;
	readonly blockers: readonly string[];
	readonly files: readonly {
		readonly path: string;
		readonly content: string | null;
	}[];
}

export interface ExistingFile {
	readonly path: string;
	readonly mode: string;
	readonly type: string;
	/** Required for modified existing blobs, not for deletions or tree entries. */
	readonly content?: string;
}

export interface CommitOptions {
	readonly repository: string;
	readonly branch: string;
	readonly expectedHeadOid: string;
	readonly report: ChangeReport;
	readonly reimplementation: boolean;
	/** Complete trusted tree at expectedHeadOid, including ancestor entries. */
	readonly existingFiles: readonly ExistingFile[];
}

export interface CreateCommitInput {
	branch: { repositoryNameWithOwner: string; branchName: string };
	expectedHeadOid: string;
	message: { headline: string; body: string };
	fileChanges: {
		additions: { path: string; contents: string }[];
		deletions: { path: string }[];
	};
}

const writableRoots = new Set(["src", "tests", "docs", "default-plugins"]);
const writableRootFiles = new Set([
	"README.md",
	"EXAMPLES.md",
	"PLUGIN-HELP.md",
]);
const dependencyFiles = new Set([
	"package.json",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"deno.json",
	"deno.jsonc",
	"composer.json",
	"cargo.toml",
	"pyproject.toml",
	"pipfile",
	"gemfile",
	"go.mod",
	"go.sum",
	"packages.lock.json",
	"packages.config",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
]);

function invalid(reason: string): never {
	throw new TypeError(reason);
}

function hasControls(value: string): boolean {
	return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function portablePath(path: string): string {
	return path.normalize("NFC").toLowerCase();
}

function safePath(path: string): boolean {
	return (
		typeof path === "string" &&
		path.length > 0 &&
		path.length <= 4096 &&
		!hasControls(path) &&
		!/[\\:<>"|?*]/.test(path) &&
		!path.includes("..") &&
		Buffer.from(path, "utf8").toString("utf8") === path &&
		path
			.split("/")
			.every(
				(part) =>
					part.length > 0 &&
					!part.startsWith(".") &&
					!/[. ]$/.test(part) &&
					!/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$|clock\$) *(?:\.|$)/i.test(
						part,
					),
			)
	);
}

function dependencyFile(basename: string): boolean {
	return (
		dependencyFiles.has(basename) ||
		/\.lock(?:b|file)?$/.test(basename) ||
		/^requirements(?:[.-][^.]+)?\.txt$/.test(basename)
	);
}

function instructionFile(basename: string): boolean {
	return (
		/^(?:agents?|claude|gemini|codex|copilot|cursor|windsurf|cline|aider|opencode|roo|roocode|qwen|kiro|goose|warp|droid|amp|crush)(?:[._-]|$)/.test(
			basename,
		) ||
		/^(?:skills?|instructions?|rules|context|conventions)\.md$/.test(
			basename,
		) ||
		/\.(?:instructions|prompt)\.md$/.test(basename)
	);
}

function toolingFile(basename: string): boolean {
	return (
		/^(?:ts|js)config(?:\.[^.]+)*\.json$/.test(basename) ||
		/^biome\.jsonc?$/.test(basename) ||
		/^(?:eslint|prettier|babel|webpack|vite|vitest|jest|rollup|release)\.config\.[a-z]+$/.test(
			basename,
		)
	);
}

/** Lexical policy only; trusted tree modes and existing content are checked later. */
export function isWritablePath(path: string): boolean {
	if (!safePath(path)) return false;
	const parts = path.split("/");
	const root = parts[0];
	const basename = parts.at(-1)?.toLowerCase();
	if (!root || !basename) return false;
	if (
		dependencyFile(basename) ||
		instructionFile(basename) ||
		toolingFile(basename) ||
		basename === "codeowners" ||
		basename === "security.md"
	) {
		return false;
	}
	if (parts.length === 1) return writableRootFiles.has(path);
	return (
		writableRoots.has(root) &&
		!(root === "src" && parts[1]?.toLowerCase() === "templates")
	);
}

/** Apply to every original PR path, not just to the worker's proposed edits. */
export function manualMergeReasons(paths: readonly string[]): string[] {
	const reasons = new Set<string>();
	for (const path of paths) {
		const lower = path.toLowerCase();
		const basename = lower.split("/").at(-1) ?? "";
		const add = (reason: string) => reasons.add(`${path}: ${reason}`);
		if (dependencyFile(basename)) add("dependency manifest or lockfile");
		if (instructionFile(basename) || basename === "codeowners") {
			add("protected automation instructions or ownership");
		}
		if (/(?:^|\/)(?:\.github|workflows?|pipelines?)(?:\/|$)/.test(lower)) {
			add("workflow or CI configuration");
		}
		if (
			/(?:^|\/)scripts?(?:\/|$)/.test(lower) ||
			/\.(?:sh|bash|zsh|fish|ps1|psm1|cmd|bat)$/.test(basename)
		) {
			add("automation script");
		}
		if (lower.includes("auth")) add("authentication or authorization surface");
		if (lower.includes("security")) add("security-sensitive surface");
		if (lower.includes("migrat")) add("migration surface");
		if (/release|publish/.test(lower))
			add("release or publishing configuration");
		if (toolingFile(basename)) add("tooling configuration");
		if (!isWritablePath(path))
			add("protected path outside the write allowlist");
	}
	return [...reasons];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null)
	);
}

function record(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	if (
		!isRecord(value) ||
		Reflect.ownKeys(value).length !== keys.length ||
		!keys.every((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor !== undefined && Object.hasOwn(descriptor, "value");
		})
	) {
		return invalid(`Expected only report fields: ${keys.join(", ")}`);
	}
	return value;
}

function text(value: unknown, field: string, max: number): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > max ||
		value.includes("\0")
	) {
		return invalid(`Invalid ${field}`);
	}
	return value;
}

function isUnknownArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
}

function list<T>(
	value: unknown,
	field: string,
	parse: (value: unknown) => T,
): T[] {
	if (!isUnknownArray(value) || value.length > 20) {
		return invalid(`Invalid ${field}; maximum 20 entries`);
	}
	return Array.from(value, parse);
}

function parseFile(value: unknown): ChangeReport["files"][number] {
	const input = record(value, ["path", "content"]);
	if (typeof input.path !== "string" || !isWritablePath(input.path)) {
		return invalid("File path is outside the write allowlist or is unsafe");
	}
	const content = input.content;
	if (content === null) {
		if (input.path.startsWith("tests/")) {
			return invalid("Deleting test files is not permitted");
		}
	} else if (
		typeof content !== "string" ||
		Buffer.byteLength(content, "utf8") > 200000 ||
		content.includes("\0") ||
		Buffer.from(content, "utf8").toString("utf8") !== content
	) {
		return invalid("File content must be UTF-8 text of at most 200000 bytes");
	}
	return Object.freeze({ path: input.path, content });
}

/** Validate decoded untrusted JSON and return a detached, deeply frozen report. */
export function parseChangeReport(value: unknown): ChangeReport {
	const input = record(value, [
		"schema_version",
		"status",
		"title",
		"summary",
		"evidence",
		"blockers",
		"files",
	]);
	if (input.schema_version !== 1) return invalid("Invalid schema_version");
	if (input.status !== "complete" && input.status !== "blocked") {
		return invalid("Invalid report status");
	}
	const title = text(input.title, "title", 200);
	if (hasControls(title))
		return invalid("Title must be a single line without controls");
	const summary = text(input.summary, "summary", 12000);
	const evidence = text(input.evidence, "evidence", 12000);
	const blockers = list(input.blockers, "blockers", (item) =>
		text(item, "blocker", 2000),
	);
	const files = list(input.files, "files", parseFile);
	if (
		input.status === "complete"
			? files.length === 0 || blockers.length !== 0
			: files.length !== 0 || blockers.length === 0
	) {
		return invalid(
			"Complete reports require changes and no blockers; blocked reports require only blockers",
		);
	}
	const paths = new Set<string>();
	for (const file of files) {
		const path = portablePath(file.path);
		if (
			paths.has(path) ||
			[...paths].some(
				(other) => path.startsWith(`${other}/`) || other.startsWith(`${path}/`),
			)
		) {
			return invalid("Duplicate, aliased or conflicting report paths");
		}
		paths.add(path);
	}
	const report: ChangeReport = {
		schema_version: 1,
		status: input.status,
		title,
		summary,
		evidence,
		blockers: Object.freeze(blockers),
		files: Object.freeze(files),
	};
	if (Buffer.byteLength(JSON.stringify(report), "utf8") > 750000) {
		return invalid("Serialized change report exceeds 750000 bytes");
	}
	return Object.freeze(report);
}

function validateRepository(repository: string): void {
	if (
		typeof repository !== "string" ||
		!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}(?![\s\S])/.test(
			repository,
		)
	) {
		invalid("Invalid repository; expected owner/name");
	}
	const [owner, name] = repository.split("/");
	if (owner?.includes("--") || name === "." || name === "..") {
		invalid("Invalid repository; expected owner/name");
	}
}

function validateBranch(branch: string): void {
	if (
		typeof branch !== "string" ||
		branch.length === 0 ||
		branch.length > 255 ||
		hasControls(branch) ||
		/[\s~^:?*[\]\\]/.test(branch) ||
		branch.includes("..") ||
		branch.includes("@{") ||
		branch.startsWith("-") ||
		branch.startsWith("refs/") ||
		branch === "@" ||
		/^(?:head|main|master|releases?)(?:$|[/-])/i.test(branch) ||
		branch
			.split("/")
			.some(
				(part) =>
					part.length === 0 ||
					part.startsWith(".") ||
					part.endsWith(".") ||
					/\.lock$/i.test(part),
			)
	) {
		invalid(
			"Invalid or protected branch; use an authorized nondefault branch name",
		);
	}
}

function commitMessage(
	report: ChangeReport,
	reimplementation: boolean,
): CreateCommitInput["message"] {
	const headline = reimplementation
		? "chore(gh-aw): address review feedback"
		: report.title;
	if (
		!/^(?:fix|feat|chore)(?:\([a-z0-9][a-z0-9._/-]*\))?: \S/.test(headline) ||
		headline.includes("!") ||
		/BREAKING[ -]CHANGE/i.test(headline) ||
		/BREAKING[ -]CHANGE/i.test(report.summary) ||
		/(?:^|\r?\n)\s*Co-authored-by:/i.test(report.summary)
	) {
		return invalid(
			"Commit message must use fix, feat or chore without breaking-change markers or model attribution",
		);
	}
	return {
		headline,
		body: `${report.summary}\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`,
	};
}

function indexTree(
	entries: readonly ExistingFile[],
): Map<string, ExistingFile> {
	const tree = new Map<string, ExistingFile>();
	for (const entry of entries) {
		const key = portablePath(entry.path);
		if (tree.has(key))
			return invalid("Duplicate or case-aliased existing tree entries");
		tree.set(key, entry);
	}
	return tree;
}

function validateTarget(
	path: string,
	tree: ReadonlyMap<string, ExistingFile>,
): ExistingFile | undefined {
	const parts = path.split("/");
	for (let length = 1; length < parts.length; length++) {
		const parent = parts.slice(0, length).join("/");
		const entry = tree.get(portablePath(parent));
		if (
			entry &&
			(entry.path !== parent ||
				entry.mode !== "040000" ||
				entry.type !== "tree")
		) {
			return invalid(
				`Unsafe ancestor of ${path}; only exact ordinary tree entries are allowed`,
			);
		}
	}
	const key = portablePath(path);
	const entry = tree.get(key);
	if (
		entry &&
		(entry.path !== path || entry.mode !== "100644" || entry.type !== "blob")
	) {
		return invalid(
			`Unsafe target ${path}; only nonexecutable ordinary blobs can be changed`,
		);
	}
	for (const existingPath of tree.keys()) {
		if (existingPath.startsWith(`${key}/`)) {
			return invalid(`Cannot replace directory ${path}`);
		}
	}
	return entry;
}

/**
 * Construct a GraphQL createCommitOnBranch input without I/O or git execution.
 * The adapter authenticates the branch and tree, and GitHub enforces expectedHeadOid.
 */
export function createCommitInput(options: CommitOptions): CreateCommitInput {
	validateRepository(options.repository);
	validateBranch(options.branch);
	if (!isCommitSha(options.expectedHeadOid))
		return invalid("Invalid expectedHeadOid");
	if (typeof options.reimplementation !== "boolean")
		return invalid("Invalid reimplementation flag");
	const report = parseChangeReport(options.report);
	if (report.status !== "complete")
		return invalid("Cannot commit a blocked report");
	const message = commitMessage(report, options.reimplementation);
	const tree = indexTree(options.existingFiles);
	const additions: CreateCommitInput["fileChanges"]["additions"] = [];
	const deletions: CreateCommitInput["fileChanges"]["deletions"] = [];
	for (const file of report.files) {
		const existing = validateTarget(file.path, tree);
		if (file.content === null) {
			if (!existing)
				return invalid(`Cannot delete nonexistent file ${file.path}`);
			deletions.push({ path: file.path });
		} else {
			if (existing) {
				if (typeof existing.content !== "string") {
					return invalid(`Missing trusted comparison content for ${file.path}`);
				}
				if (existing.content === file.content) continue;
			}
			additions.push({
				path: file.path,
				contents: Buffer.from(file.content, "utf8").toString("base64"),
			});
		}
	}
	if (additions.length === 0 && deletions.length === 0) {
		return invalid("Report makes no progress; no effective file changes");
	}
	return {
		branch: {
			repositoryNameWithOwner: options.repository,
			branchName: options.branch,
		},
		expectedHeadOid: options.expectedHeadOid,
		message,
		fileChanges: { additions, deletions },
	};
}
