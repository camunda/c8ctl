import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, posix, win32 } from "node:path";
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

function buildSkillUpdateArgs(skills: string[], directory: string): string[] {
	return ["skill", "update", "--all", "--dir", directory, ...skills];
}

interface InstalledCamundaSkill {
	readonly name: string;
	readonly directory: string;
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
		skills.push({ name: entry.skillName, directory: dirname(entry.path) });
	}
	return skills;
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
) => SkillInstallRunResult;

function runCommand(command: string, args: string[]): SkillInstallRunResult {
	const result = spawnSync(command, args, { encoding: "utf8" });
	return {
		status: result.status,
		stdout: typeof result.stdout === "string" ? result.stdout : "",
		stderr: typeof result.stderr === "string" ? result.stderr : "",
		...(result.error ? { error: result.error } : {}),
	};
}

export function runSkillInstall(
	harness: string,
	runner: SkillInstallRunner = runCommand,
): void {
	const listed = runner("gh", buildSkillListArgs(harness));
	requireSuccessfulSkillCommand(listed, "check for installed");
	const installed = installedCamundaSkills(listed.stdout);
	if (installed.length === 0) {
		requireSuccessfulSkillCommand(
			runner("gh", buildSkillInstallArgs(harness)),
			"install",
		);
		return;
	}

	const byDirectory = new Map<string, string[]>();
	for (const skill of installed) {
		const skills = byDirectory.get(skill.directory) ?? [];
		if (!skills.includes(skill.name)) skills.push(skill.name);
		byDirectory.set(skill.directory, skills);
	}
	for (const [directory, skills] of byDirectory) {
		requireSuccessfulSkillCommand(
			runner("gh", buildSkillUpdateArgs(skills, directory)),
			"update",
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
