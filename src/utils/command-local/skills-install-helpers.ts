import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

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
		"--force",
	];
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

function executableIsOnPath({
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
	const result = runner("gh", buildSkillInstallArgs(harness));
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
		`GitHub CLI failed to install Camunda skills${result.status === null ? "" : ` (exit code ${result.status})`}: ${details || "No details were reported."}`,
	);
}
