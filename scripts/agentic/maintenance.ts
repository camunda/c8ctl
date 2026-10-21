import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { GitHubClient } from "./github.ts";

export const VERSION_PATH = ".github/gh-aw-version";
export const WORKER_NAMES = [
	"agentic-fitness",
	"agentic-implement",
	"agentic-review-copilot",
	"agentic-review-claude",
	"agentic-reimplement",
] as const;
export const GENERATED_PATHS: readonly string[] = [
	...WORKER_NAMES.map((name) => `.github/workflows/${name}.lock.yml`),
	".github/aw/actions-lock.json",
];
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = Math.ceil((MAX_BYTES * 4) / 3) + 16384;
const SHA_PATTERN = /^[a-f0-9]{40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new TypeError("Expected an object");
	return value;
}

function array(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new TypeError("Expected an array");
	return value;
}

function text(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("Expected a string");
	return value;
}

function positiveInteger(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
		throw new TypeError("Expected a positive integer");
	return value;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
	if (
		Object.keys(value).length !== keys.length ||
		!keys.every((key) => Object.hasOwn(value, key))
	)
		throw new Error("Unexpected or missing artifact properties");
}

export function parseCompilerVersion(value: unknown): string {
	const version = text(value);
	if (
		version.length > 64 ||
		!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\n?$/.test(version)
	)
		throw new Error(
			"Compiler version must be one exact vMAJOR.MINOR.PATCH release",
		);
	return version.trimEnd();
}

export function assertCompilerIdentity(
	version: string,
	result: {
		status: number | null;
		stdout: string;
		stderr: string;
		error?: Error;
	},
): void {
	if (result.error) throw result.error;
	if (
		result.status !== 0 ||
		`${result.stdout}${result.stderr}`.trim() !==
			`gh aw version ${parseCompilerVersion(version)}`
	)
		throw new Error(
			"Installed gh-aw compiler does not match the declared version",
		);
}

export function assertPublishedRelease(
	value: unknown,
	version: string,
	current: string,
): void {
	const release = object(value);
	parseCompilerVersion(version);
	parseCompilerVersion(current);
	if (
		release.tag_name !== version ||
		release.prerelease !== false ||
		release.draft !== false ||
		typeof release.published_at !== "string" ||
		!Number.isFinite(Date.parse(release.published_at))
	)
		throw new Error(
			"Candidate must be the published latest non-prerelease gh-aw release",
		);
	const candidateParts = version.slice(1).split(".").map(BigInt);
	const currentParts = current.slice(1).split(".").map(BigInt);
	const different = candidateParts.findIndex(
		(part, index) => part !== currentParts[index],
	);
	const candidatePart = candidateParts[different];
	const currentPart = currentParts[different];
	if (
		candidatePart === undefined ||
		currentPart === undefined ||
		candidatePart <= currentPart
	)
		throw new Error(
			"Compiler update must be newer than the trusted default-branch version",
		);
}

export interface Candidate {
	number: number;
	headSha: string;
	branch: string;
	changedFiles: number;
}

export function validatePullRequest(
	value: unknown,
	repository: string,
): Candidate {
	const pr = object(value);
	const user = object(pr.user);
	const head = object(pr.head);
	const base = object(pr.base);
	const branch = text(head.ref);
	if (
		user.login !== "renovate[bot]" ||
		user.type !== "Bot" ||
		pr.state !== "open" ||
		pr.draft !== false ||
		object(head.repo).full_name !== repository ||
		object(base.repo).full_name !== repository ||
		base.ref !== "main" ||
		/^(main|master|release(?:[/.-]|$)|refs\/)/i.test(branch) ||
		!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
		branch.includes("..") ||
		branch.includes("//") ||
		branch.endsWith("/") ||
		branch.endsWith(".") ||
		branch.endsWith(".lock") ||
		branch.split("/").some((part) => part.startsWith(".")) ||
		!SHA_PATTERN.test(text(head.sha)) ||
		array(pr.labels).some((label) => object(label).name === "agentic:hold")
	)
		throw new Error(
			"Compiler maintenance requires an open, unheld same-repository Renovate PR targeting main",
		);
	return {
		number: positiveInteger(pr.number),
		headSha: text(head.sha),
		branch,
		changedFiles: positiveInteger(pr.changed_files),
	};
}

export function validateChangedFiles(
	value: unknown,
	expectedCount: number,
): void {
	const files = array(value).map(object);
	if (
		files.length !== expectedCount ||
		files.length > GENERATED_PATHS.length + 1 ||
		!files.some((file) => file.filename === VERSION_PATH)
	)
		throw new Error("Incomplete or unexpected compiler PR diff");
	const names = new Set<string>();
	for (const file of files) {
		const name = text(file.filename);
		if (
			names.has(name) ||
			(name !== VERSION_PATH && !GENERATED_PATHS.includes(name)) ||
			(file.status !== "added" && file.status !== "modified") ||
			Object.hasOwn(file, "previous_filename")
		)
			throw new Error(
				"Compiler PR may change only the version declaration and generated files",
			);
		names.add(name);
	}
}

export interface RegenerationIdentity {
	repository: string;
	pull_request: number;
	expected_head_sha: string;
	version: string;
	source_sha: string;
}
export interface GeneratedFile {
	path: string;
	content: string;
}
export interface Regeneration extends RegenerationIdentity {
	schema_version: 1;
	files: GeneratedFile[];
}

export function assertArtifactEntries(entries: string[]): void {
	if (entries.length !== 1 || entries[0] !== "regeneration.json")
		throw new Error("Artifact must contain only regeneration.json");
}

function decodeBase64(value: unknown): Buffer {
	const content = text(value);
	if (content.length > MAX_ARTIFACT_BYTES)
		throw new Error("Generated content exceeds size bound");
	const bytes = Buffer.from(content, "base64");
	if (bytes.toString("base64") !== content)
		throw new Error("Generated content must use canonical base64");
	return bytes;
}

export function parseRegeneration(
	value: unknown,
	expected: RegenerationIdentity,
): Regeneration {
	const data = object(value);
	exactKeys(data, [
		"schema_version",
		"repository",
		"pull_request",
		"expected_head_sha",
		"version",
		"source_sha",
		"files",
	]);
	if (
		data.schema_version !== 1 ||
		!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expected.repository) ||
		!SHA_PATTERN.test(expected.expected_head_sha) ||
		!SHA_PATTERN.test(expected.source_sha)
	)
		throw new Error("Invalid regeneration identity");
	positiveInteger(expected.pull_request);
	parseCompilerVersion(expected.version);
	for (const key of [
		"repository",
		"pull_request",
		"expected_head_sha",
		"version",
		"source_sha",
	] as const) {
		if (data[key] !== expected[key])
			throw new Error("Regeneration artifact provenance mismatch");
	}
	const files: GeneratedFile[] = [];
	const paths = new Set<string>();
	let bytes = 0;
	for (const entry of array(data.files)) {
		const file = object(entry);
		exactKeys(file, ["path", "content"]);
		const path = text(file.path);
		if (!GENERATED_PATHS.includes(path) || paths.has(path))
			throw new Error("Unexpected or duplicate generated file");
		bytes += decodeBase64(file.content).byteLength;
		if (bytes > MAX_BYTES)
			throw new Error("Regeneration exceeds the 4 MiB total size bound");
		paths.add(path);
		files.push({ path, content: text(file.content) });
	}
	return { schema_version: 1, ...expected, files };
}

export function assertGeneratedTree(value: unknown): Map<string, string> {
	const tree = object(value);
	if (tree.truncated !== false)
		throw new Error("Cannot validate a truncated Git tree");
	const blobs = new Map<string, string>();
	for (const item of array(tree.tree)) {
		const entry = object(item);
		const path = text(entry.path);
		if (
			[VERSION_PATH, ...GENERATED_PATHS].some((generated) =>
				generated.startsWith(`${path}/`),
			) &&
			(entry.mode !== "040000" || entry.type !== "tree")
		)
			throw new Error("Generated output parents must be regular Git trees");
		if (path !== VERSION_PATH && !GENERATED_PATHS.includes(path)) continue;
		if (
			entry.mode !== "100644" ||
			entry.type !== "blob" ||
			!SHA_PATTERN.test(text(entry.sha)) ||
			blobs.has(path)
		)
			throw new Error(
				"Version and generated files must be regular mode-100644 blobs",
			);
		blobs.set(path, text(entry.sha));
	}
	if (!blobs.has(VERSION_PATH))
		throw new Error("PR is missing the compiler version declaration");
	return blobs;
}

export function assertNoGeneratedDrift(input: {
	tracked: readonly string[];
	existing: readonly string[];
	changed: readonly (string | undefined)[];
	untracked: readonly (string | undefined)[];
}): void {
	const missing = GENERATED_PATHS.filter(
		(path) => !input.tracked.includes(path) || !input.existing.includes(path),
	);
	if (missing.length || input.changed.length || input.untracked.length)
		throw new Error(
			"Generated gh-aw files drifted, are missing, or are untracked; regenerate with the declared compiler",
		);
}

export function assertCompileResult(stdout: string, stderr: string): void {
	const lines = stripVTControlCharacters(`${stdout}\n${stderr}`)
		.split(/\r?\n/)
		.map((line) => line.trim());
	const summaryPattern =
		/^(?:✓ )?Compiled (\d+) workflows?: (\d+) succeeded, (\d+) warnings?(?:, (\d+) errors?)?$/;
	const summaries = lines.flatMap((line) => {
		const summary = summaryPattern.exec(line);
		return summary ? [summary] : [];
	});
	const summary = summaries[0];
	if (
		summaries.length !== 1 ||
		Number(summary?.[1]) !== WORKER_NAMES.length ||
		Number(summary?.[2]) !== WORKER_NAMES.length ||
		Number(summary?.[3]) !== 0 ||
		Number(summary?.[4] ?? 0) !== 0 ||
		lines.some(
			(line) =>
				!summaryPattern.test(line) && /\b(?:warning|error)s?\b|⚠/i.test(line),
		)
	)
		throw new Error(
			"Strict compilation must produce five successful results with no warnings or errors",
		);
}

export type MaintenanceGitHub = Pick<
	GitHubClient,
	"request" | "list" | "graphql"
>;

export async function prepareMaintenance(input: {
	github: MaintenanceGitHub;
	repository: string;
	number: number;
	currentVersion: string;
}): Promise<Candidate & { version: string; blobs: Map<string, string> }> {
	const { github, repository, number, currentVersion } = input;
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
		throw new Error("Invalid repository");
	positiveInteger(number);
	const prefix = `/repos/${repository}`;
	const candidate = validatePullRequest(
		await github.request("GET", `${prefix}/pulls/${number}`),
		repository,
	);
	if (candidate.number !== number) throw new Error("PR number mismatch");
	validateChangedFiles(
		await github.list(`${prefix}/pulls/${number}/files`),
		candidate.changedFiles,
	);
	const blobs = assertGeneratedTree(
		await github.request(
			"GET",
			`${prefix}/git/trees/${candidate.headSha}?recursive=1`,
		),
	);
	const declaration = object(
		await github.request(
			"GET",
			`${prefix}/contents/${VERSION_PATH}?ref=${candidate.headSha}`,
		),
	);
	if (
		declaration.type !== "file" ||
		declaration.encoding !== "base64" ||
		declaration.sha !== blobs.get(VERSION_PATH)
	)
		throw new Error("Invalid compiler version declaration");
	const encoded = text(declaration.content);
	if (encoded.length > 256) throw new Error("Oversized compiler declaration");
	const version = parseCompilerVersion(
		decodeBase64(encoded.replace(/\s/g, "")).toString("utf8"),
	);
	assertPublishedRelease(
		await github.request("GET", "/repos/github/gh-aw/releases/latest"),
		version,
		currentVersion,
	);
	return { ...candidate, version, blobs };
}

async function assertLiveGates(
	github: MaintenanceGitHub,
	repository: string,
): Promise<void> {
	for (const name of [
		"C8CTL_AUTOMATION_ENABLED",
		"C8CTL_DEPENDENCY_MAINTENANCE_ENABLED",
	]) {
		const variable = object(
			await github.request(
				"GET",
				`/repos/${repository}/actions/variables/${name}`,
			),
		);
		if (variable.value !== "true")
			throw new Error(`Maintenance blocked: ${name} is not enabled`);
	}
}

function assertExpectedCandidate(
	candidate: Candidate & { version: string },
	expected: RegenerationIdentity,
): void {
	if (
		candidate.number !== expected.pull_request ||
		candidate.headSha !== expected.expected_head_sha ||
		candidate.version !== expected.version
	)
		throw new Error(
			"Maintenance blocked: PR head or version changed since preparation",
		);
}

export async function applyRegeneration(input: {
	github: MaintenanceGitHub;
	value: unknown;
	expected: RegenerationIdentity;
	currentVersion: string;
}): Promise<"applied" | "noop"> {
	const { github, value, expected, currentVersion } = input;
	const regeneration = parseRegeneration(value, expected);
	const inspect = () =>
		prepareMaintenance({
			github,
			repository: expected.repository,
			number: expected.pull_request,
			currentVersion,
		});
	const candidate = await inspect();
	assertExpectedCandidate(candidate, expected);
	const additions = regeneration.files
		.filter((file) => {
			const bytes = decodeBase64(file.content);
			const hash = createHash("sha1")
				.update(`blob ${bytes.length}\0`)
				.update(bytes)
				.digest("hex");
			return candidate.blobs.get(file.path) !== hash;
		})
		.map((file) => ({ path: file.path, contents: file.content }));

	// The artifact is data only. The branch and controls come from fresh authenticated API reads.
	const fresh = await inspect();
	assertExpectedCandidate(fresh, expected);
	if (fresh.branch !== candidate.branch)
		throw new Error("Maintenance blocked: PR branch changed");
	await assertLiveGates(github, expected.repository);
	if (!additions.length) return "noop";
	try {
		const result = object(
			await github.graphql(
				"mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }",
				{
					input: {
						branch: {
							repositoryNameWithOwner: expected.repository,
							branchName: fresh.branch,
						},
						expectedHeadOid: expected.expected_head_sha,
						message: {
							headline: `chore(agentic): regenerate workflows for ${expected.version}`,
							body: "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>",
						},
						fileChanges: { additions },
					},
				},
			),
		);
		if (
			!SHA_PATTERN.test(
				text(object(object(result.createCommitOnBranch).commit).oid),
			)
		)
			throw new Error("GitHub did not confirm the generated-file commit");
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"status" in error &&
			error.status === 409
		)
			throw new Error(
				"Maintenance blocked: compare-and-swap conflict; PR head changed",
			);
		throw error;
	}
	return "applied";
}

function run(command: string, args: string[]): string {
	return execFileSync(command, args, {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
}

function compilerVersion(): string {
	return parseCompilerVersion(
		process.env.MAINTENANCE_VERSION ?? readFileSync(VERSION_PATH, "utf8"),
	);
}

function verifyInstalledCompiler(version: string): void {
	assertCompilerIdentity(
		version,
		spawnSync("gh", ["aw", "version"], {
			encoding: "utf8",
			maxBuffer: 64 * 1024,
		}),
	);
}

export function compilerArguments({
	refreshPins = false,
}: {
	refreshPins?: boolean;
} = {}): string[] {
	return [
		"aw",
		"compile",
		...WORKER_NAMES.map((name) => `.github/workflows/${name}.md`),
		"--strict",
		"--no-check-update",
		// gh-aw's JSON mode omits safe-update and schedule warnings.
		...(refreshPins ? ["--force-refresh-action-pins"] : []),
	];
}

function compile({
	version,
	refreshPins = false,
}: {
	version: string;
	refreshPins?: boolean;
}): void {
	verifyInstalledCompiler(version);
	const result = spawnSync("gh", compilerArguments({ refreshPins }), {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(
			`Strict gh-aw compilation failed:\n${result.stderr}\n${result.stdout}`,
		);
	try {
		assertCompileResult(result.stdout, result.stderr);
	} catch (error) {
		throw new Error(
			`Invalid or non-clean compiler result:\n${result.stdout}\n${result.stderr}`,
			{ cause: error },
		);
	}
}

function gitPaths(args: string[]): string[] {
	return run("git", args).split("\0").filter(Boolean);
}

function changedGeneratedPaths(): string[] {
	return gitPaths([
		"diff",
		"--name-only",
		"-z",
		"HEAD",
		"--",
		...GENERATED_PATHS,
	]);
}

function untrackedGeneratedPaths(): string[] {
	return gitPaths([
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
		"--",
		...GENERATED_PATHS,
	]);
}

function readGenerated(path: string): Buffer {
	const segments = path.split("/");
	for (let index = 1; index < segments.length; index++) {
		const parent = segments.slice(0, index).join("/");
		if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink())
			throw new Error("Generated output parent must be a real directory");
	}
	const info = lstatSync(path);
	if (
		!info.isFile() ||
		info.isSymbolicLink() ||
		(info.mode & 0o777) !== 0o644 ||
		info.size > MAX_BYTES
	)
		throw new Error(
			"Generated output must be a bounded regular mode-100644 file",
		);
	return readFileSync(path);
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing ${name}`);
	return value;
}

function expectedIdentity(): RegenerationIdentity {
	const expected = {
		repository: required("GITHUB_REPOSITORY"),
		pull_request: positiveInteger(Number(required("MAINTENANCE_PR"))),
		expected_head_sha: required("MAINTENANCE_HEAD_SHA"),
		version: parseCompilerVersion(required("MAINTENANCE_VERSION")),
		source_sha: required("GITHUB_SHA"),
	};
	parseRegeneration({ schema_version: 1, ...expected, files: [] }, expected);
	return expected;
}

async function main(): Promise<void> {
	const command = process.argv[2];
	if (command === "install") {
		const version = compilerVersion();
		run("gh", ["extension", "install", "github/gh-aw", "--pin", version]);
		verifyInstalledCompiler(version);
		return;
	}
	if (command === "check") {
		compile({ version: compilerVersion() });
		for (const path of GENERATED_PATHS) readGenerated(path);
		assertNoGeneratedDrift({
			tracked: gitPaths(["ls-files", "-z", "--", ...GENERATED_PATHS]),
			existing: GENERATED_PATHS.filter((path) => existsSync(path)),
			changed: changedGeneratedPaths(),
			untracked: untrackedGeneratedPaths(),
		});
		console.log(
			"Strict compilation passed; all generated files are tracked and current.",
		);
		return;
	}
	if (command === "collect") {
		const expected = expectedIdentity();
		compile({ version: expected.version, refreshPins: true });
		// Include every expected output, including newly generated files absent from git diff.
		// This also makes a synchronize caused by our own commit an explicit no-op.
		const paths = new Set([
			...changedGeneratedPaths(),
			...untrackedGeneratedPaths(),
			...GENERATED_PATHS,
		]);
		const files = [...paths].map((path) => ({
			path,
			content: readGenerated(path).toString("base64"),
		}));
		const regeneration = parseRegeneration(
			{ schema_version: 1, ...expected, files },
			expected,
		);
		writeFileSync("regeneration.json", `${JSON.stringify(regeneration)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
		console.log(`Collected ${files.length} allowlisted generated files.`);
		return;
	}
	if (command !== "prepare" && command !== "apply")
		throw new Error(
			"Usage: maintenance.ts install|check|prepare|collect|apply",
		);
	if (required("GITHUB_REF") !== "refs/heads/main")
		throw new Error("Maintenance must run from trusted main");
	if (run("git", ["rev-parse", "HEAD"]).trim() !== required("GITHUB_SHA"))
		throw new Error(
			"Maintenance checkout does not match the trusted workflow SHA",
		);
	const { GitHub } = await import("./github.ts");
	const github = new GitHub({
		token: required("GH_TOKEN"),
		apiUrl: process.env.GITHUB_API_URL,
	});
	const currentVersion = parseCompilerVersion(
		readFileSync(VERSION_PATH, "utf8"),
	);
	if (command === "prepare") {
		const prepared = await prepareMaintenance({
			github,
			repository: required("GITHUB_REPOSITORY"),
			number: positiveInteger(Number(required("MAINTENANCE_PR"))),
			currentVersion,
		});
		appendFileSync(
			required("GITHUB_OUTPUT"),
			`pull_request=${prepared.number}\nhead_sha=${prepared.headSha}\nversion=${prepared.version}\n`,
		);
		console.log(
			"Authenticated same-repository Renovate compiler update and latest stable release.",
		);
		return;
	}
	const path = "regeneration-input/regeneration.json";
	const directory = lstatSync("regeneration-input");
	if (!directory.isDirectory() || directory.isSymbolicLink())
		throw new Error("Artifact input must be a regular directory");
	assertArtifactEntries(readdirSync("regeneration-input"));
	const info = lstatSync(path);
	if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ARTIFACT_BYTES)
		throw new Error("Invalid or oversized regeneration artifact");
	const status = await applyRegeneration({
		github,
		value: JSON.parse(readFileSync(path, "utf8")),
		expected: expectedIdentity(),
		currentVersion,
	});
	console.log(
		status === "noop"
			? "No-op: generated files already match the PR head."
			: "Generated files committed using expected-head compare-and-swap.",
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	main().catch((error: unknown) => {
		console.error(
			error instanceof Error ? error.message : "Compiler maintenance failed",
		);
		process.exitCode = 1;
	});
}
