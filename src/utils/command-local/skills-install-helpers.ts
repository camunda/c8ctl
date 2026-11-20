import { spawn } from "node:child_process";
import {
	existsSync,
	lstatSync,
	realpathSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	posix,
	relative,
	resolve,
	sep,
	win32,
} from "node:path";
import { isRecord } from "../../core/index.ts";

type Env = Readonly<Record<string, string | undefined>>;

interface HarnessDetector {
	id: string;
	executable: string;
}

const HARNESS_DETECTORS = [
	{ id: "claude-code", executable: "claude" },
	{ id: "github-copilot", executable: "copilot" },
] as const satisfies readonly HarnessDetector[];

const HARNESS_ALIASES: Readonly<Record<string, string>> = {
	claude: "claude-code",
	copilot: "github-copilot",
};

export const CAMUNDA_SKILLS_REPOSITORY = "camunda/skills";

const CAMUNDA_SKILLS_URL = `https://github.com/${CAMUNDA_SKILLS_REPOSITORY}`;

export function normalizeSkillHarness(value: string): string {
	const normalized = value.trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9.-]*$/.test(normalized)) {
		throw new Error(
			"Invalid harness ID. Use a non-empty GitHub CLI skill agent ID, such as claude-code, github-copilot, or cursor.",
		);
	}
	return Object.hasOwn(HARNESS_ALIASES, normalized)
		? HARNESS_ALIASES[normalized]
		: normalized;
}

export function buildSkillInstallArgs(harness: string): string[] {
	return [
		"skill",
		"install",
		CAMUNDA_SKILLS_REPOSITORY,
		"--all",
		"--agent",
		harness,
		"--scope",
		"user",
	];
}

function buildSkillListArgs(harness: string): string[] {
	return [
		"skill",
		"list",
		"--agent",
		harness,
		"--scope",
		"user",
		"--json",
		"skillName,sourceURL,path",
	];
}

function buildSkillDiscoveryArgs(): string[] {
	return ["skill", "install", CAMUNDA_SKILLS_REPOSITORY];
}

function buildSkillInstallSpecificArgs({
	harness,
	skill,
}: {
	harness: string;
	skill: string;
}): string[] {
	return [
		"skill",
		"install",
		CAMUNDA_SKILLS_REPOSITORY,
		skill,
		"--agent",
		harness,
		"--scope",
		"user",
	];
}

function buildSkillUpdateArgs(skills: string[], directory: string): string[] {
	return ["skill", "update", "--all", "--dir", directory, ...skills];
}

interface InstalledCamundaSkill {
	readonly name: string;
	readonly directory: string;
	readonly path: string;
}

export interface CamundaSkillInstallation extends InstalledCamundaSkill {
	readonly harness: string;
}

function installedCamundaSkills(stdout: string): InstalledCamundaSkill[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error("GitHub CLI returned invalid JSON while listing skills.");
	}
	if (!Array.isArray(parsed)) {
		throw new Error("GitHub CLI returned an invalid installed-skills list.");
	}

	const skills: InstalledCamundaSkill[] = [];
	for (const entry of parsed) {
		if (!isRecord(entry) || typeof entry.sourceURL !== "string") continue;
		if (
			entry.sourceURL.replace(/\/+$/, "").toLowerCase() !== CAMUNDA_SKILLS_URL
		)
			continue;
		if (
			typeof entry.skillName !== "string" ||
			entry.skillName.length === 0 ||
			typeof entry.path !== "string" ||
			entry.path.length === 0
		) {
			throw new Error("GitHub CLI returned incomplete Camunda skill metadata.");
		}
		skills.push({
			name: entry.skillName,
			directory: dirname(entry.path),
			path: entry.path,
		});
	}
	return skills;
}

function availableCamundaSkills(stdout: string): string[] {
	const names = stdout
		.split(/\r?\n/)
		.filter((line) => line.includes("\t"))
		.map((line) => line.split("\t", 1)[0].trim())
		.filter((name) => name.length > 0);
	if (names.length === 0) {
		throw new Error("GitHub CLI returned no available Camunda skills.");
	}
	if (names.some((name) => !/^[a-z0-9][a-z0-9._/-]*$/i.test(name))) {
		throw new Error(
			"GitHub CLI returned an invalid available Camunda skills list.",
		);
	}
	return [...new Set(names)];
}

function joinForPlatform(platform: string, ...paths: string[]): string {
	return platform === "win32" ? win32.join(...paths) : posix.join(...paths);
}

function harnessConfigDirectories({
	harness,
	env,
	home,
	platform,
}: {
	harness: string;
	env: Env;
	home: string;
	platform: string;
}): string[] {
	if (harness === "claude-code") {
		return [
			...(env.CLAUDE_CONFIG_DIR ? [env.CLAUDE_CONFIG_DIR] : []),
			joinForPlatform(platform, home, ".claude"),
		];
	}
	if (harness === "github-copilot") {
		return [joinForPlatform(platform, home, ".copilot")];
	}
	return [];
}

export function executableIsOnPath({
	name,
	env,
	platform,
}: {
	name: string;
	env: Env;
	platform: string;
}): boolean {
	const pathSeparator = platform === "win32" ? ";" : ":";
	const directories = (env.PATH ?? "")
		.split(pathSeparator)
		.filter((directory) => directory.length > 0);
	const extensions =
		platform === "win32"
			? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
					.split(";")
					.filter((extension) => extension.length > 0)
			: [""];
	return directories.some((directory) =>
		extensions.some((extension) =>
			existsSync(joinForPlatform(platform, directory, `${name}${extension}`)),
		),
	);
}

export function detectInstalledHarnesses({
	env = process.env,
	home,
	platform = process.platform,
}: {
	env?: Env;
	home?: string;
	platform?: string;
} = {}): string[] {
	const userHome =
		home ??
		(platform === "win32"
			? env.USERPROFILE || env.HOME || homedir()
			: env.HOME || homedir());

	return HARNESS_DETECTORS.filter(
		({ id, executable }) =>
			harnessConfigDirectories({
				harness: id,
				env,
				home: userHome,
				platform,
			}).some((directory) => existsSync(directory)) ||
			executableIsOnPath({ name: executable, env, platform }),
	).map(({ id }) => id);
}

export interface SkillInstallRunResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly error?: Error;
}

export type SkillInstallRunner = (
	command: string,
	args: string[],
) => Promise<SkillInstallRunResult>;

/**
 * Async spawn, not spawnSync: a sync call would block the event loop
 * for the whole download, freezing the setup step's spinner mid-run.
 */
function runCommand(
	command: string,
	args: string[],
): Promise<SkillInstallRunResult> {
	return new Promise((resolveRun) => {
		const child = spawn(command, args);
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		// ENOENT reports "error" and then "close" — settle once, on the
		// first signal.
		let settled = false;
		const done = (result: SkillInstallRunResult) => {
			if (settled) return;
			settled = true;
			resolveRun(result);
		};
		child.on("error", (error) => done({ status: null, stdout, stderr, error }));
		child.on("close", (status) => done({ status, stdout, stderr }));
	});
}

export async function listCamundaSkills(
	harness: string,
	runner: SkillInstallRunner = runCommand,
): Promise<CamundaSkillInstallation[]> {
	const listed = await runner("gh", buildSkillListArgs(harness));
	requireSuccessfulSkillCommand(listed, "check for installed");
	return installedCamundaSkills(listed.stdout).map((skill) => ({
		...skill,
		harness,
	}));
}

function isWithinPath(root: string, candidate: string): boolean {
	const relativePath = relative(root, candidate);
	return (
		relativePath === "" ||
		(relativePath !== ".." &&
			!relativePath.startsWith(`..${sep}`) &&
			!isAbsolute(relativePath))
	);
}

function harnessSkillDirectories({
	harness,
	env,
	home,
	platform,
}: {
	harness: string;
	env: Env;
	home: string;
	platform: string;
}): string[] {
	return harnessConfigDirectories({ harness, env, home, platform }).map(
		(directory) => resolve(joinForPlatform(platform, directory, "skills")),
	);
}

interface SkillRemovalOptions {
	env?: Env;
	home?: string;
	platform?: string;
}

export function hasCamundaUserSkillsDirectory(
	harness: string,
	{
		env = process.env,
		home,
		platform = process.platform,
	}: SkillRemovalOptions = {},
): boolean {
	const userHome =
		home ??
		(platform === "win32"
			? env.USERPROFILE || env.HOME || homedir()
			: env.HOME || homedir());
	return harnessSkillDirectories({
		harness,
		env,
		home: userHome,
		platform,
	}).some(
		(directory) =>
			statSync(directory, { throwIfNoEntry: false })?.isDirectory() === true,
	);
}

function skillRemovalLocation(
	skill: CamundaSkillInstallation,
	{ env = process.env, home, platform = process.platform }: SkillRemovalOptions,
): { directory: string; root: string } {
	const userHome =
		home ??
		(platform === "win32"
			? env.USERPROFILE || env.HOME || homedir()
			: env.HOME || homedir());
	if (!isAbsolute(skill.path)) {
		throw new Error(
			`Cannot safely remove Camunda skill "${skill.name}": GitHub CLI returned a non-absolute path.`,
		);
	}

	const directory = resolve(skill.path);
	const skillName = skill.name.split(/[\\/]/).at(-1);
	if (!skillName || basename(directory) !== skillName) {
		throw new Error(
			`Cannot safely remove Camunda skill "${skill.name}": its listed path does not match the skill name.`,
		);
	}

	const roots = harnessSkillDirectories({
		harness: skill.harness,
		env,
		home: userHome,
		platform,
	});
	const configuredRoot = roots.find(
		(candidate) =>
			candidate !== directory && isWithinPath(candidate, directory),
	);
	const reportedRoot = dirname(directory);
	// GitHub CLI supports agent IDs with host-specific roots unknown to c8ctl.
	// Accept its reported root for those agents only when it stays under the
	// user's home and is a skills directory.
	const userSkillsRoot =
		basename(reportedRoot) === "skills" &&
		isWithinPath(resolve(userHome), reportedRoot)
			? reportedRoot
			: undefined;
	const root = configuredRoot ?? userSkillsRoot;
	if (!root) {
		throw new Error(
			`Cannot safely remove Camunda skill "${skill.name}" from ${skill.path}: the path is outside the ${skill.harness} user skills directory.`,
		);
	}
	return { directory, root };
}

export function camundaSkillRemovalPath(
	skill: CamundaSkillInstallation,
	options: SkillRemovalOptions = {},
): string {
	return skillRemovalLocation(skill, options).directory;
}

/**
 * Remove a listed Camunda skill directory without following a skill or parent
 * symlink outside the harness's user-scope skills directory.
 */
export function removeCamundaSkill(
	skill: CamundaSkillInstallation,
	options: SkillRemovalOptions = {},
): void {
	const { directory, root } = skillRemovalLocation(skill, options);
	const directoryInfo = lstatSync(directory, { throwIfNoEntry: false });
	if (!directoryInfo) return;
	if (directoryInfo.isSymbolicLink()) {
		const rootInfo = statSync(root, { throwIfNoEntry: false });
		if (!rootInfo?.isDirectory()) {
			throw new Error(
				`Cannot safely remove Camunda skill "${skill.name}": its user skills directory is unavailable.`,
			);
		}
		const rootRealPath = realpathSync(root);
		const parentRealPath = realpathSync(dirname(directory));
		if (!isWithinPath(rootRealPath, parentRealPath)) {
			throw new Error(
				`Cannot safely remove Camunda skill "${skill.name}": its parent directory resolves outside the user skills directory.`,
			);
		}
		unlinkSync(directory);
		return;
	}
	if (!directoryInfo.isDirectory()) {
		throw new Error(
			`Cannot safely remove Camunda skill "${skill.name}": its listed path is not a directory.`,
		);
	}

	const rootInfo = statSync(root, { throwIfNoEntry: false });
	if (!rootInfo?.isDirectory()) {
		throw new Error(
			`Cannot safely remove Camunda skill "${skill.name}": its user skills directory is unavailable.`,
		);
	}
	const rootRealPath = realpathSync(root);
	const directoryRealPath = realpathSync(directory);
	if (
		!isWithinPath(rootRealPath, directoryRealPath) ||
		directoryRealPath === rootRealPath
	) {
		throw new Error(
			`Cannot safely remove Camunda skill "${skill.name}": its directory resolves outside the user skills directory.`,
		);
	}
	rmSync(directory, { recursive: true });
}

export async function runSkillInstall(
	harness: string,
	runner: SkillInstallRunner = runCommand,
): Promise<void> {
	const installed = await listCamundaSkills(harness, runner);
	if (installed.length === 0) {
		requireSuccessfulSkillCommand(
			await runner("gh", buildSkillInstallArgs(harness)),
			"install",
		);
		return;
	}

	const availableResult = await runner("gh", buildSkillDiscoveryArgs());
	requireSuccessfulSkillCommand(availableResult, "list available");
	const available = availableCamundaSkills(availableResult.stdout);
	const installedNames = new Set(installed.map(({ name }) => name));
	const missing = available.filter((skill) => !installedNames.has(skill));

	const byDirectory = new Map<string, string[]>();
	for (const skill of installed) {
		const skills = byDirectory.get(skill.directory) ?? [];
		if (!skills.includes(skill.name)) skills.push(skill.name);
		byDirectory.set(skill.directory, skills);
	}
	for (const [directory, skills] of byDirectory) {
		requireSuccessfulSkillCommand(
			await runner("gh", buildSkillUpdateArgs(skills, directory)),
			"update",
		);
	}
	for (const skill of missing) {
		requireSuccessfulSkillCommand(
			await runner("gh", buildSkillInstallSpecificArgs({ harness, skill })),
			"install",
		);
	}
}

function requireSuccessfulSkillCommand(
	result: SkillInstallRunResult,
	action: string,
): void {
	if (result.error) {
		const errorCode =
			"code" in result.error && typeof result.error.code === "string"
				? result.error.code
				: undefined;
		if (errorCode === "ENOENT") {
			throw new Error(
				"GitHub CLI was not found. Install GitHub CLI 2.90 or later from https://cli.github.com/.",
			);
		}
		throw new Error(`Could not run GitHub CLI: ${result.error.message}`);
	}

	if (result.status === 0) return;

	const details = [result.stderr.trim(), result.stdout.trim()]
		.filter((output) => output.length > 0)
		.join("\n");
	if (/unknown command\s+["']?skill\b/i.test(details)) {
		throw new Error(
			"`gh skill` requires GitHub CLI 2.90 or later. Upgrade GitHub CLI from https://cli.github.com/.",
		);
	}
	throw new Error(
		`GitHub CLI failed to ${action} Camunda skills${result.status === null ? "" : ` (exit code ${result.status})`}: ${details || "No details were reported."}`,
	);
}
