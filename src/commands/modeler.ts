import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Logger } from "../core/index.ts";
import { defineCommand } from "../framework/index.ts";
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function manualDownloadError(message: string): Error {
	return new Error(`${message}. Download manually from ${MANUAL_DOWNLOAD_URL}`);
}

function runCommand(
	command: string,
	args: string[],
	{ failureMessage, quiet }: { failureMessage: string; quiet: boolean },
): void {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		stdio: quiet
			? ["inherit", "pipe", "pipe"]
			: ["inherit", process.stderr.fd, process.stderr.fd],
	});
	const diagnostics = quiet
		? `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
		: "";
	const details = diagnostics ? `\n${diagnostics}` : "";
	if (result.error) {
		throw new Error(`${failureMessage}: ${result.error.message}${details}`);
	}
	if (result.status !== 0) {
		throw new Error(
			`${failureMessage} (exit code ${String(result.status)}).${details}`,
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

function isHomebrewAvailable(): boolean {
	const result = spawnSync("brew", ["--version"], { stdio: "ignore" });
	if (result.error) {
		if ("code" in result.error && result.error.code === "ENOENT") return false;
		throw new Error(`Could not check Homebrew: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(
			`Homebrew is available but \`brew --version\` failed (exit code ${String(result.status)}).`,
		);
	}
	return true;
}

function isModelerInstalledWithHomebrew(): boolean {
	const result = spawnSync(
		"brew",
		["list", "--cask", "--versions", "camunda-modeler"],
		{ stdio: "ignore" },
	);
	if (result.error) {
		throw new Error(
			`Could not check the Homebrew Modeler cask: ${result.error.message}`,
		);
	}
	if (result.status === 0) return true;
	if (result.status === 1) return false;
	throw new Error(
		`Could not check the Homebrew Modeler cask (exit code ${String(result.status)}).`,
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

function resolveHomebrewModelerPath(): string {
	const failureMessage =
		"Could not locate the Camunda Modeler app installed by Homebrew";
	const result = spawnSync("brew", ["list", "--cask", "camunda-modeler"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", process.stderr.fd],
	});
	if (result.error) {
		throw new Error(`${failureMessage}: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`${failureMessage} (exit code ${String(result.status)}).`);
	}
	const appPath = result.stdout
		.split(/\r?\n/)
		.find((path) => path.endsWith(`/${APP_BUNDLE_NAME}`));
	if (!appPath) {
		throw new Error(
			`${failureMessage}. Run \`brew list --cask camunda-modeler\` to check the installation.`,
		);
	}
	// Homebrew keeps a Caskroom symlink to the configured app directory.
	return realpathSync(appPath);
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
	quiet,
	signal: interruptionSignal,
}: {
	url: string;
	destination: string;
	logger: Logger;
	quiet: boolean;
	signal: AbortSignal;
}): Promise<void> {
	// Only time out on stalls, so slow connections can still finish.
	const controller = new AbortController();
	const signal = AbortSignal.any([interruptionSignal, controller.signal]);
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
		!quiet &&
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
			signal,
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
				{ signal },
			);
		} catch (error) {
			const reason = signal.aborted ? signal.reason : error;
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

async function installFromOfficialDownload({
	applicationsDir,
	logger,
	quiet,
}: {
	applicationsDir: string;
	logger: Logger;
	quiet: boolean;
}): Promise<{ version: string; destination: string }> {
	const version = latestStableModelerVersion(await fetchReleaseIndex());
	const archiveName = modelerMacArchiveName(version, process.arch);
	const archiveUrl = new URL(
		`${version}/${archiveName}`,
		MODELER_RELEASE_URL,
	).toString();
	const destination = join(applicationsDir, APP_BUNDLE_NAME);
	const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-modeler-"));
	const controller = new AbortController();
	let interruptedSignal: NodeJS.Signals | undefined;
	const interrupt = (signal: NodeJS.Signals): void => {
		interruptedSignal ??= signal;
		controller.abort(new Error(`Installation interrupted by ${signal}`));
	};
	const onSigint = (): void => interrupt("SIGINT");
	const onSigterm = (): void => interrupt("SIGTERM");
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);

	try {
		const archivePath = join(tempDir, archiveName);
		logger.info(`Downloading Camunda Modeler ${version} for macOS...`);
		await downloadArchive({
			url: archiveUrl,
			destination: archivePath,
			logger,
			quiet,
			signal: controller.signal,
		});

		if (applicationsDir !== SYSTEM_APPLICATIONS_DIR) {
			mkdirSync(applicationsDir, { recursive: true });
		}
		// Extract next to the destination: publishing is then an atomic rename,
		// and a failed or rejected extraction never leaves a partial bundle.
		const stagingDir = mkdtempSync(join(applicationsDir, ".c8ctl-modeler-"));
		try {
			logger.info(`Installing Camunda Modeler to ${destination}...`);
			runCommand("ditto", ["-x", "-k", archivePath, stagingDir], {
				failureMessage: "Could not extract Camunda Modeler",
				quiet,
			});
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
				{
					failureMessage:
						"The downloaded Camunda Modeler is not signed by Camunda; refusing to install it",
					quiet,
				},
			);
			renameSync(stagedApp, destination);
		} finally {
			rmSync(stagingDir, { recursive: true, force: true });
		}

		registerWithLaunchServices(destination, logger);
		return { version, destination };
	} finally {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
		rmSync(tempDir, { recursive: true, force: true });
		// Re-raise after cleanup so the shell still sees the original signal.
		if (interruptedSignal) process.kill(process.pid, interruptedSignal);
	}
}

export const modelerInstallCommand = defineCommand(
	"modeler",
	"install",
	async (ctx) => {
		if (process.platform !== "darwin") {
			throw new Error(
				`c8ctl modeler install currently supports macOS only. Download Modeler manually from ${MANUAL_DOWNLOAD_URL}`,
			);
		}

		const installedPath = findInstalledModeler();
		if (installedPath) {
			return {
				kind: "info",
				message: `Camunda Modeler is already installed at ${installedPath}; skipping installation.`,
			};
		}

		if (isHomebrewAvailable()) {
			if (isModelerInstalledWithHomebrew()) {
				return {
					kind: "info",
					message:
						"Camunda Modeler is already installed with Homebrew; skipping installation.",
				};
			}
			if (ctx.isDryRun) {
				return {
					kind: "dryRun",
					info: {
						dryRun: true,
						command: "modeler install",
						message:
							"Dry run: would install Camunda Modeler with `brew install --cask camunda-modeler`.",
					},
				};
			}

			ctx.logger.info("Installing Camunda Modeler with Homebrew...");
			runCommand("brew", ["install", "--cask", "camunda-modeler"], {
				failureMessage: "Homebrew could not install Camunda Modeler",
				quiet: ctx.quiet,
			});
			// Homebrew does not register new apps with Launch Services.
			const brewInstalledPath =
				findInstalledModeler() ?? resolveHomebrewModelerPath();
			registerWithLaunchServices(brewInstalledPath, ctx.logger);
			return {
				kind: "success",
				message: "Installed Camunda Modeler with Homebrew.",
			};
		}

		const applicationsDir = installApplicationsDir();
		if (ctx.isDryRun) {
			return {
				kind: "dryRun",
				info: {
					dryRun: true,
					command: "modeler install",
					message: `Dry run: would download the latest stable Camunda Modeler and install it to ${join(applicationsDir, APP_BUNDLE_NAME)}.`,
				},
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
			quiet: ctx.quiet,
		});
		return {
			kind: "success",
			message: `Installed Camunda Modeler ${version} to ${destination}.`,
		};
	},
);
