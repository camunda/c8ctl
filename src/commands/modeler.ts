import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Logger } from "../core/index.ts";
import {
	type CommandContext,
	type CommandResult,
	defineCommand,
} from "../framework/index.ts";
import {
	latestStableModelerVersion,
	MODELER_RELEASE_URL,
	modelerMacArchiveName,
	renderDownloadProgress,
} from "../utils/index.ts";

const APP_BUNDLE_NAME = "Camunda Modeler.app";
const SYSTEM_APPLICATIONS_DIR = "/Applications";
const MANUAL_DOWNLOAD_URL = MODELER_RELEASE_URL;
const DOWNLOAD_STALL_TIMEOUT_MS = 60_000;
const LAUNCH_SERVICES_REGISTER =
	"/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";
// Downloads made outside a browser are not quarantined, so Gatekeeper never
// checks them; require Camunda's Developer ID signature before installing.
const MODELER_CODE_REQUIREMENT =
	'identifier "com.camunda.CamundaModeler" and anchor apple generic and certificate leaf[subject.OU] = "3JVGD57JQZ"';
const WINGET_PACKAGE_ID = "Camunda.Modeler";
const WINGET_PACKAGE = [
	"--id",
	WINGET_PACKAGE_ID,
	"--exact",
	"--source",
	"winget",
];
const WINGET_INSTALL_URL =
	"https://learn.microsoft.com/windows/package-manager/winget/";
// APPINSTALLER_CLI_ERROR_NO_APPLICATIONS_FOUND: `winget list` matched nothing.
const WINGET_NO_APPLICATIONS_FOUND = 0x8a150014;
const WINDOWS_EXECUTABLE = "Camunda Modeler.exe";
const MODELER_FILE_TYPES = ["bpmn", "dmn", "form", "rpa"];
// Both paths arrive through the environment, so they need no quoting.
const CREATE_SHORTCUT_SCRIPT =
	"$ErrorActionPreference = 'Stop'; $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($env:C8CTL_SHORTCUT); $shortcut.TargetPath = $env:C8CTL_TARGET; $shortcut.Save()";
// Camunda's Linux installation docs extract the release into /usr/bin as root
// and link its launcher there.
const LINUX_INSTALL_ROOT = "/usr/bin";
const LINUX_EXECUTABLE = "camunda-modeler";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function manualDownloadError(message: string): Error {
	return new Error(`${message}. Download manually from ${MANUAL_DOWNLOAD_URL}`);
}

/** winget exits with HRESULTs, which its documentation lists in hex. */
function formatExitCode(status: number | null): string {
	return status !== null && status > 0xffff
		? `0x${status.toString(16).toUpperCase()}`
		: String(status);
}

function runCommand(
	command: string,
	args: string[],
	failureMessage: string,
): void {
	const result = spawnSync(command, args, {
		stdio: ["inherit", process.stderr.fd, process.stderr.fd],
	});
	if (result.error) {
		throw new Error(`${failureMessage}: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(
			`${failureMessage} (exit code ${formatExitCode(result.status)})`,
		);
	}
}

function registerWithLaunchServices(appPath: string, logger: Logger): void {
	const result = spawnSync(LAUNCH_SERVICES_REGISTER, ["-f", appPath], {
		stdio: "ignore",
	});
	if (result.error || result.status !== 0) {
		logger.warn(
			`Could not register ${appPath} with macOS Launch Services. Open Camunda Modeler once so macOS picks up its file associations.`,
		);
	}
}

/** Whether a package manager is on PATH; one that is present but broken is an error. */
function hasPackageManager(command: string, name: string): boolean {
	const result = spawnSync(command, ["--version"], { stdio: "ignore" });
	if (result.error) {
		if ("code" in result.error && result.error.code === "ENOENT") return false;
		throw new Error(`Could not check ${name}: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(
			`${name} is available but \`${command} --version\` failed (exit code ${formatExitCode(result.status)})`,
		);
	}
	return true;
}

/** Runs a package query that exits with 0 when Modeler is installed and `notInstalledStatus` when it is not. */
function isInstalledWith({
	command,
	args,
	notInstalledStatus,
	description,
}: {
	command: string;
	args: string[];
	notInstalledStatus: number;
	description: string;
}): boolean {
	const result = spawnSync(command, args, { stdio: "ignore" });
	if (result.error) {
		throw new Error(`Could not check ${description}: ${result.error.message}`);
	}
	if (result.status === 0) return true;
	if (result.status === notInstalledStatus) return false;
	throw new Error(
		`Could not check ${description} (exit code ${formatExitCode(result.status)})`,
	);
}

function userApplicationsDir(): string {
	return join(homedir(), "Applications");
}

function findInstalledModeler(): string | undefined {
	return [SYSTEM_APPLICATIONS_DIR, userApplicationsDir()]
		.map((dir) => join(dir, APP_BUNDLE_NAME))
		.find((location) => existsSync(location));
}

/** Standard (non-admin) users cannot write to /Applications. */
function installApplicationsDir(): string {
	try {
		accessSync(SYSTEM_APPLICATIONS_DIR, constants.W_OK);
		return SYSTEM_APPLICATIONS_DIR;
	} catch {
		return userApplicationsDir();
	}
}

async function fetchResponse(
	url: string,
	description: string,
	signal: AbortSignal,
): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(url, { signal });
	} catch (error) {
		throw manualDownloadError(`${description}: ${errorMessage(error)}`);
	}
	if (!response.ok) {
		throw manualDownloadError(
			`${description} returned HTTP ${response.status}`,
		);
	}
	return response;
}

async function fetchReleaseIndex(): Promise<string> {
	const response = await fetchResponse(
		MODELER_RELEASE_URL,
		"Could not check Camunda Modeler releases",
		AbortSignal.timeout(30_000),
	);
	try {
		return await response.text();
	} catch (error) {
		throw manualDownloadError(
			`Could not read Camunda Modeler releases: ${errorMessage(error)}`,
		);
	}
}

async function downloadArchive({
	url,
	destination,
	logger,
}: {
	url: string;
	destination: string;
	logger: Logger;
}): Promise<void> {
	// Abort only when the transfer stalls, so slow connections can still finish.
	const controller = new AbortController();
	const stallTimer = setTimeout(
		() =>
			controller.abort(
				new Error(
					`no data received for ${DOWNLOAD_STALL_TIMEOUT_MS / 1000} seconds`,
				),
			),
		DOWNLOAD_STALL_TIMEOUT_MS,
	);
	const live =
		Boolean(process.stderr.isTTY) &&
		process.env.TERM !== "dumb" &&
		logger.mode === "text";
	const startedAt = Date.now();
	let received = 0;
	let total = 0;
	let renderedAt = 0;
	const render = (): void => {
		const frame = renderDownloadProgress({
			received,
			total,
			elapsedMs: Date.now() - startedAt,
			columns: process.stderr.columns || 80,
			color: process.env.NO_COLOR === undefined,
		});
		process.stderr.write(`\r\u001b[2K${frame}`);
		renderedAt = Date.now();
	};

	try {
		const response = await fetchResponse(
			url,
			"Could not download Camunda Modeler",
			controller.signal,
		);
		if (!response.body) {
			throw manualDownloadError("The Modeler download returned no file");
		}
		total = Number(response.headers.get("content-length")) || 0;

		try {
			await pipeline(
				Readable.fromWeb(response.body),
				new Transform({
					transform(chunk: Uint8Array, _encoding, callback) {
						stallTimer.refresh();
						received += chunk.byteLength;
						if (live && Date.now() - renderedAt >= 100) render();
						callback(null, chunk);
					},
				}),
				createWriteStream(destination),
			);
		} catch (error) {
			const reason = controller.signal.aborted
				? controller.signal.reason
				: error;
			throw manualDownloadError(
				`Could not download Camunda Modeler: ${errorMessage(reason)}`,
			);
		} finally {
			if (live) {
				render();
				process.stderr.write("\n");
			}
		}
	} finally {
		clearTimeout(stallTimer);
	}

	if (!live) {
		logger.info(`Downloaded ${(received / 1_048_576).toFixed(1)} MB.`);
	}
}

/** Downloads the latest stable release into `dir`, with progress. */
async function downloadLatestRelease({
	dir,
	platform,
	archiveName,
	logger,
}: {
	dir: string;
	platform: string;
	archiveName: (version: string) => string;
	logger: Logger;
}): Promise<{ version: string; archivePath: string }> {
	const version = latestStableModelerVersion(await fetchReleaseIndex());
	const name = archiveName(version);
	const archivePath = join(dir, name);
	logger.info(`Downloading Camunda Modeler ${version} for ${platform}...`);
	await downloadArchive({
		url: new URL(`${version}/${name}`, MODELER_RELEASE_URL).toString(),
		destination: archivePath,
		logger,
	});
	return { version, archivePath };
}

async function installFromOfficialDownload({
	applicationsDir,
	logger,
}: {
	applicationsDir: string;
	logger: Logger;
}): Promise<{ version: string; destination: string }> {
	const destination = join(applicationsDir, APP_BUNDLE_NAME);
	const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-modeler-"));

	try {
		const { version, archivePath } = await downloadLatestRelease({
			dir: tempDir,
			platform: "macOS",
			archiveName: (version) => modelerMacArchiveName(version, process.arch),
			logger,
		});

		if (applicationsDir !== SYSTEM_APPLICATIONS_DIR) {
			mkdirSync(applicationsDir, { recursive: true });
		}
		// Extract next to the destination: publishing is then an atomic rename,
		// and a failed or rejected extraction never leaves a partial bundle.
		const stagingDir = mkdtempSync(join(applicationsDir, ".c8ctl-modeler-"));
		try {
			logger.info(`Installing Camunda Modeler to ${destination}...`);
			runCommand(
				"ditto",
				["-x", "-k", archivePath, stagingDir],
				"Could not extract Camunda Modeler",
			);
			const stagedApp = join(stagingDir, APP_BUNDLE_NAME);
			if (!existsSync(stagedApp)) {
				throw manualDownloadError(
					`The Camunda Modeler ${version} archive did not contain ${APP_BUNDLE_NAME}`,
				);
			}
			runCommand(
				"codesign",
				[
					"--verify",
					"--deep",
					"--strict",
					`-R=${MODELER_CODE_REQUIREMENT}`,
					stagedApp,
				],
				"The downloaded Camunda Modeler is not signed by Camunda; refusing to install it",
			);
			renameSync(stagedApp, destination);
		} finally {
			rmSync(stagingDir, { recursive: true, force: true });
		}

		registerWithLaunchServices(destination, logger);
		return { version, destination };
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

/** winget's portable installs set up neither file associations nor a Start Menu entry. */
function registerWithWindows(executable: string, logger: Logger): void {
	// The per-user keys of Modeler's support/fileassoc.reg; its register script
	// breaks on paths with spaces and leaves the command unquoted.
	const registered = MODELER_FILE_TYPES.flatMap(
		(type): Array<[key: string, value: string]> => {
			const progId = `CamundaModeler.${type.toUpperCase()}`;
			const progIdKey = `HKCU\\Software\\Classes\\${progId}`;
			return [
				[`HKCU\\Software\\Classes\\.${type}`, progId],
				[progIdKey, `${type.toUpperCase()} file`],
				[`${progIdKey}\\DefaultIcon`, `${executable},0`],
				[`${progIdKey}\\shell\\open\\command`, `"${executable}" "%1"`],
			];
		},
	).every(([key, value]) => {
		const result = spawnSync("reg", ["add", key, "/ve", "/d", value, "/f"], {
			stdio: "ignore",
		});
		return !result.error && result.status === 0;
	});
	if (!registered) {
		logger.warn(
			'Could not register Camunda Modeler for .bpmn, .dmn, .form, and .rpa files. Choose it with "Open with" instead.',
		);
	}

	const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
	const shortcut = join(
		appData,
		"Microsoft",
		"Windows",
		"Start Menu",
		"Programs",
		"Camunda Modeler.lnk",
	);
	const result = spawnSync(
		"powershell",
		["-NoProfile", "-NonInteractive", "-Command", CREATE_SHORTCUT_SCRIPT],
		{
			stdio: "ignore",
			env: {
				...process.env,
				C8CTL_SHORTCUT: shortcut,
				C8CTL_TARGET: executable,
			},
		},
	);
	if (result.error || result.status !== 0) {
		logger.warn(
			`Could not add Camunda Modeler to the Start Menu. Start it from ${executable}.`,
		);
	}
}

function installOnWindows({
	isDryRun,
	logger,
}: Pick<CommandContext, "isDryRun" | "logger">): CommandResult {
	const localAppData =
		process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
	const installDir = join(localAppData, "Programs", "Camunda Modeler");
	const executable = join(installDir, WINDOWS_EXECUTABLE);
	if (existsSync(executable)) {
		return {
			kind: "info",
			message: `Camunda Modeler is already installed at ${installDir}; skipping installation.`,
		};
	}

	// Any winget failure, such as a source blocked by policy or no build for
	// this machine, ends with the manual download link.
	try {
		if (!hasPackageManager("winget", "winget")) {
			throw new Error(
				`winget is not available (install it from ${WINGET_INSTALL_URL})`,
			);
		}
		if (
			isInstalledWith({
				command: "winget",
				args: ["list", ...WINGET_PACKAGE],
				notInstalledStatus: WINGET_NO_APPLICATIONS_FOUND,
				description: "the winget Modeler package",
			})
		) {
			return {
				kind: "info",
				message:
					"Camunda Modeler is already installed with winget; skipping installation.",
			};
		}
		if (isDryRun) {
			return {
				kind: "info",
				message: `Dry run: would install Camunda Modeler to ${installDir} with \`winget install --id ${WINGET_PACKAGE_ID}\`.`,
			};
		}

		logger.info("Installing Camunda Modeler with winget...");
		// winget picks the build for this machine, verifies its checksum, and
		// lists it under Installed apps, so `winget upgrade` can update it.
		// User scope needs no administrator rights, whatever winget's settings prefer.
		runCommand(
			"winget",
			[
				"install",
				...WINGET_PACKAGE,
				"--scope",
				"user",
				"--location",
				installDir,
			],
			"winget could not install Camunda Modeler",
		);
	} catch (error) {
		throw manualDownloadError(errorMessage(error));
	}
	registerWithWindows(executable, logger);
	return {
		kind: "success",
		message: `Installed Camunda Modeler with winget to ${installDir}.`,
	};
}

/** Like a shell's command lookup: the first executable regular file on PATH. */
function findOnPath(command: string): string | undefined {
	const path = process.env.PATH;
	if (path === undefined) return undefined;
	return path
		.split(delimiter)
		.map((dir) => join(dir || ".", command))
		.find((path) => {
			try {
				accessSync(path, constants.X_OK);
				return statSync(path).isFile();
			} catch {
				return false;
			}
		});
}

/** Runs `args` as root: directly when c8ctl runs as root, otherwise with sudo. */
function runAsRoot(args: string[], failureMessage: string): void {
	const [command, ...rest] =
		process.getuid?.() === 0 ? args : ["sudo", ...args];
	try {
		runCommand(command, rest, failureMessage);
	} catch (error) {
		throw manualDownloadError(errorMessage(error));
	}
}

/** Modeler's own script installs its desktop entry, icons, and MIME types for the current user. */
function registerWithDesktop(installDir: string, logger: Logger): void {
	const script = join(installDir, "support", "xdg_register.sh");
	// The script reports success even when the xdg-utils it calls are missing.
	if (!findOnPath("xdg-mime")) {
		logger.warn(
			`Could not register Camunda Modeler for .bpmn, .dmn, .form, and .rpa files because xdg-utils is not installed. Install xdg-utils, then run ${script}.`,
		);
		return;
	}
	// Keep the interpreter fixed; the script path is versioned release data.
	const result = spawnSync("/bin/bash", [script], {
		stdio: ["ignore", process.stderr.fd, process.stderr.fd],
	});
	if (result.error || result.status !== 0) {
		logger.warn(
			`Could not register Camunda Modeler for .bpmn, .dmn, .form, and .rpa files. Run ${script} to retry.`,
		);
	}
}

async function installOnLinux({
	isDryRun,
	logger,
}: Pick<CommandContext, "isDryRun" | "logger">): Promise<CommandResult> {
	const installedPath = findOnPath(LINUX_EXECUTABLE);
	if (installedPath) {
		return {
			kind: "info",
			message: `Camunda Modeler is already installed at ${installedPath}; skipping installation.`,
		};
	}
	// Camunda publishes Linux builds for x64 only.
	if (process.arch !== "x64") {
		throw manualDownloadError(
			`Unsupported Linux architecture "${process.arch}"`,
		);
	}
	if (isDryRun) {
		return {
			kind: "info",
			message: `Dry run: would download the latest stable Camunda Modeler and install it to ${LINUX_INSTALL_ROOT} as root.`,
		};
	}

	if (process.getuid?.() !== 0) {
		logger.info(
			`Installing to ${LINUX_INSTALL_ROOT} needs root privileges; sudo may ask for your password.`,
		);
	}
	// Authenticate before the long download, so that missing sudo rights fail fast.
	runAsRoot(["true"], "Could not get root privileges");

	logger.info("Checking for the latest stable Camunda Modeler release...");
	const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-modeler-"));
	try {
		const { version, archivePath } = await downloadLatestRelease({
			dir: tempDir,
			platform: "Linux",
			archiveName: (version) => `camunda-modeler-${version}-linux-x64.tar.gz`,
			logger,
		});
		const releaseDir = `camunda-modeler-${version}-linux-x64`;
		const installDir = join(LINUX_INSTALL_ROOT, releaseDir);
		const launcher = join(LINUX_INSTALL_ROOT, LINUX_EXECUTABLE);
		logger.info(`Installing Camunda Modeler to ${installDir}...`);
		// The launcher marks Modeler as installed, so it goes first and comes back
		// last: a stale link that extraction would revive cannot make an
		// unfinished installation look complete, and a retry starts over.
		runAsRoot(["rm", "-f", launcher], `Could not remove ${launcher}`);
		runAsRoot(
			["tar", "--no-same-owner", "-xzf", archivePath, "-C", LINUX_INSTALL_ROOT],
			"Could not extract Camunda Modeler",
		);
		// Electron's sandbox needs a root-owned setuid helper where unprivileged
		// user namespaces are restricted.
		runAsRoot(
			["chmod", "4755", join(installDir, "chrome-sandbox")],
			"Could not set up the Camunda Modeler sandbox",
		);
		runAsRoot(
			["ln", "-sfn", join(releaseDir, LINUX_EXECUTABLE), launcher],
			`Could not link ${launcher}`,
		);
		registerWithDesktop(installDir, logger);
		return {
			kind: "success",
			message: `Installed Camunda Modeler ${version} to ${installDir}.`,
		};
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

export const modelerInstallCommand = defineCommand(
	"modeler",
	"install",
	async (ctx) => {
		if (process.platform === "win32") return installOnWindows(ctx);
		if (process.platform === "linux") return installOnLinux(ctx);
		if (process.platform !== "darwin") {
			throw new Error(
				`c8ctl modeler install currently supports macOS, Windows, and Linux only. Download Modeler manually from ${MANUAL_DOWNLOAD_URL}`,
			);
		}

		const installedPath = findInstalledModeler();
		if (installedPath) {
			return {
				kind: "info",
				message: `Camunda Modeler is already installed at ${installedPath}; skipping installation.`,
			};
		}

		if (hasPackageManager("brew", "Homebrew")) {
			if (
				isInstalledWith({
					command: "brew",
					args: ["list", "--cask", "--versions", "camunda-modeler"],
					notInstalledStatus: 1,
					description: "the Homebrew Modeler cask",
				})
			) {
				return {
					kind: "info",
					message:
						"Camunda Modeler is already installed with Homebrew; skipping installation.",
				};
			}
			if (ctx.isDryRun) {
				return {
					kind: "info",
					message:
						"Dry run: would install Camunda Modeler with `brew install --cask camunda-modeler`.",
				};
			}

			ctx.logger.info("Installing Camunda Modeler with Homebrew...");
			runCommand(
				"brew",
				["install", "--cask", "camunda-modeler"],
				"Homebrew could not install Camunda Modeler",
			);
			// Homebrew does not register new apps with Launch Services.
			const brewInstalledPath = findInstalledModeler();
			if (brewInstalledPath) {
				registerWithLaunchServices(brewInstalledPath, ctx.logger);
			}
			return {
				kind: "success",
				message: "Installed Camunda Modeler with Homebrew.",
			};
		}

		const applicationsDir = installApplicationsDir();
		if (ctx.isDryRun) {
			return {
				kind: "info",
				message: `Dry run: would download the latest stable Camunda Modeler and install it to ${join(applicationsDir, APP_BUNDLE_NAME)}.`,
			};
		}
		if (applicationsDir !== SYSTEM_APPLICATIONS_DIR) {
			ctx.logger.info(
				`${SYSTEM_APPLICATIONS_DIR} is not writable; installing to ${applicationsDir} instead.`,
			);
		}

		ctx.logger.info(
			"Checking for the latest stable Camunda Modeler release...",
		);
		const { version, destination } = await installFromOfficialDownload({
			applicationsDir,
			logger: ctx.logger,
		});
		return {
			kind: "success",
			message: `Installed Camunda Modeler ${version} to ${destination}.`,
		};
	},
);
