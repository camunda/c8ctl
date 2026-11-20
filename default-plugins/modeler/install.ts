import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	accessSync,
	constants,
	createWriteStream,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isRecord, type Logger } from "../../src/core/index.ts";
import {
	isNewerModelerVersion,
	latestStableModelerVersion,
	MODELER_RELEASE_URL,
	modelerMacArchiveName,
	renderDownloadProgress,
} from "./helpers.ts";

/**
 * The slice of the plugin host context the installer needs.
 */
export interface ModelerInstallContext {
	isDryRun: boolean;
	logger: Logger;
	quiet: boolean;
}

/**
 * What an install attempt produced. The plugin handler renders it the same
 * way the command framework renders the matching CommandResult kinds.
 */
export type ModelerInstallResult =
	| { kind: "info"; message: string }
	| { kind: "success"; message: string }
	| { kind: "dryRun"; info: Record<string, unknown> };

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
const UNREGISTER_WINDOWS_SCRIPT =
	"$ErrorActionPreference='Stop'; $base=[Microsoft.Win32.Registry]::CurrentUser; " +
	"foreach ($type in @('bpmn','dmn','form','rpa')) { " +
	"$prog='CamundaModeler.'+$type.ToUpper(); " +
	"$path='Software\\Classes\\'+$prog+'\\shell\\open\\command'; " +
	"$key=$base.OpenSubKey($path); " +
	"if ($key -and $key.GetValue('') -ieq ('\"'+$env:C8CTL_TARGET+'\" \"%1\"')) { " +
	"$key.Close(); $ext=$base.OpenSubKey('Software\\Classes\\.'+$type,$true); " +
	"if ($ext) { if ($ext.GetValue('') -ieq $prog) { $ext.DeleteValue('', $false) }; $ext.Close() }; " +
	"Remove-Item -LiteralPath ('Registry::HKEY_CURRENT_USER\\Software\\Classes\\'+$prog) -Recurse -Force " +
	"} elseif ($key) { $key.Close() } }; " +
	"$shortcut=(New-Object -ComObject WScript.Shell).CreateShortcut($env:C8CTL_SHORTCUT); " +
	"if ((Test-Path -LiteralPath $env:C8CTL_SHORTCUT) -and $shortcut.TargetPath -ieq $env:C8CTL_TARGET) { " +
	"Remove-Item -LiteralPath $env:C8CTL_SHORTCUT -Force }";
// Both paths arrive through the environment, so they need no quoting.
const CREATE_SHORTCUT_SCRIPT =
	"$ErrorActionPreference = 'Stop'; $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($env:C8CTL_SHORTCUT); $shortcut.TargetPath = $env:C8CTL_TARGET; $shortcut.Save()";
// Camunda's Linux installation docs extract the release into /usr/bin as root
// and link its launcher there.
const LINUX_INSTALL_ROOT = "/usr/bin";
const LINUX_EXECUTABLE = "camunda-modeler";
// The Linux lifecycle lock lives at a fixed system-wide path: every
// invocation modifies the same /usr/bin launcher and release directories,
// so a TMPDIR-dependent location would let two runs with different
// environments lock different files and still race.
const LINUX_LIFECYCLE_LOCK = "/tmp/c8ctl-modeler-lifecycle.lock";
const LINUX_LIFECYCLE_RECLAIM_LOCK = `${LINUX_LIFECYCLE_LOCK}.reclaim`;
// The reclamation critical section is a handful of syscalls, so a live
// reclaimer never holds its meta-lock anywhere near this long; past it,
// the meta-lock belongs to a killed reclaimer even if its pid was reused.
const RECLAIM_LOCK_STALE_AFTER_MS = 10_000;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Read `error.code` without an `as NodeJS.ErrnoException` cast. */
function errorCode(error: unknown): string | undefined {
	if (error instanceof Error && "code" in error) {
		const { code } = error;
		if (typeof code === "string") return code;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Linux lifecycle lock — concurrent install/update/remove runs share the
// release directories and the launcher in /usr/bin, so without serialisation
// a losing run would delete the winning run's files mid-flight.
//
// The lock file holds `{pid, token}` JSON and is created atomically with
// "wx". A lock is reclaimed only when its owner process is dead (or the
// file is unreadable) — never because it is old, since a continuously
// progressing download has no total time limit. Reclamation itself runs
// under a meta-lock so two runs that both found the main lock stale cannot
// delete each other's freshly acquired lock, and a run only ever unlinks a
// lock carrying its own token.
// ---------------------------------------------------------------------------

type LifecycleLockPayload = { pid: number; token: string };

// Identifies the locks this invocation created, so release and reclamation
// never touch another run's lock.
const lifecycleToken = randomUUID();

function readLifecycleLock(path: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		// Signal 0 only tests existence. EPERM means the process exists but
		// belongs to someone else — still alive.
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

function isStaleLock(path: string, maxAgeMs?: number): boolean {
	const pid = readLifecycleLock(path)?.pid;
	if (typeof pid !== "number" || !Number.isInteger(pid)) return true;
	if (!isProcessAlive(pid)) return true;
	if (maxAgeMs !== undefined) {
		try {
			return Date.now() - statSync(path).mtimeMs > maxAgeMs;
		} catch {
			return true;
		}
	}
	return false;
}

function tryCreateLifecycleLock(path: string): boolean {
	const payload: LifecycleLockPayload = {
		pid: process.pid,
		token: lifecycleToken,
	};
	// Publish a fully written owner record atomically: a "wx" create on the
	// lock itself would expose an empty file that another run could reclaim
	// as stale while its owner is alive. The staging file is unique to this
	// invocation, and the hard link fails with EEXIST if the lock exists.
	const staging = `${path}.${process.pid}.${lifecycleToken}`;
	writeFileSync(staging, JSON.stringify(payload), { flag: "wx", mode: 0o644 });
	try {
		linkSync(staging, path);
		return true;
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	} finally {
		try {
			unlinkSync(staging);
		} catch {
			// Best effort — the staging file is unique and inert.
		}
	}
}

/** Unlink only the lock this invocation created — never another run's. */
function releaseOwnLifecycleLock(path: string): void {
	if (readLifecycleLock(path)?.token !== lifecycleToken) return;
	try {
		unlinkSync(path);
	} catch {
		// Already gone — a signal handler may have raced the normal finally.
	}
}

function lifecycleLockBusy(): Error {
	return new Error(
		`Another c8ctl Modeler operation is in progress. Wait for it to finish, or remove ${LINUX_LIFECYCLE_LOCK} if you are sure none is running.`,
	);
}

/**
 * Reclaim a dead owner's main lock under the reclamation meta-lock, then
 * create our own. Returns true when the main lock was acquired this way.
 */
function reclaimStaleLifecycleLock(logger: Logger): boolean {
	if (!tryCreateLifecycleLock(LINUX_LIFECYCLE_RECLAIM_LOCK)) {
		// A crashed reclaimer's meta-lock expires quickly: the critical
		// section is a few syscalls, far below the staleness window.
		if (
			isStaleLock(LINUX_LIFECYCLE_RECLAIM_LOCK, RECLAIM_LOCK_STALE_AFTER_MS)
		) {
			unlinkStaleReclaimLock();
		}
		if (!tryCreateLifecycleLock(LINUX_LIFECYCLE_RECLAIM_LOCK)) {
			throw new Error(
				"Another c8ctl Modeler operation is recovering an interrupted run's lock; try again in a moment.",
			);
		}
	}
	try {
		// Re-verify under the meta-lock: the stale main lock may already be
		// gone or have been replaced by a live owner.
		if (
			!pathExists(LINUX_LIFECYCLE_LOCK) ||
			!isStaleLock(LINUX_LIFECYCLE_LOCK)
		) {
			return false;
		}
		logger.warn(
			`Reclaiming a stale Camunda Modeler lifecycle lock at ${LINUX_LIFECYCLE_LOCK} from a previous run.`,
		);
		try {
			unlinkSync(LINUX_LIFECYCLE_LOCK);
		} catch (error) {
			throw new Error(
				`Could not reclaim the stale Modeler lifecycle lock at ${LINUX_LIFECYCLE_LOCK} (${errorMessage(error)}). Remove it manually if no other c8ctl modeler command is running.`,
			);
		}
		return tryCreateLifecycleLock(LINUX_LIFECYCLE_LOCK);
	} finally {
		releaseOwnLifecycleLock(LINUX_LIFECYCLE_RECLAIM_LOCK);
	}
}

function unlinkStaleReclaimLock(): void {
	try {
		unlinkSync(LINUX_LIFECYCLE_RECLAIM_LOCK);
	} catch {
		// Another reclaimer may have beaten us to it — the create decides.
	}
}

/**
 * Acquire the Linux lifecycle lock or throw with a user-actionable message.
 * A live owner's lock is never reclaimed, no matter its age.
 */
function acquireLinuxLifecycleLock(logger: Logger): void {
	if (tryCreateLifecycleLock(LINUX_LIFECYCLE_LOCK)) return;
	if (isStaleLock(LINUX_LIFECYCLE_LOCK) && reclaimStaleLifecycleLock(logger)) {
		return;
	}
	throw lifecycleLockBusy();
}

function releaseLinuxLifecycleLock(): void {
	releaseOwnLifecycleLock(LINUX_LIFECYCLE_LOCK);
}

/**
 * Run `body` while the Linux lifecycle lock is held. Signal handlers
 * release the lock because the download interrupt handlers re-raise the
 * signal against the process itself, so this function's `finally` never
 * runs on the interrupt path. The once-listeners are consumed by the
 * first signal, so the re-raise still kills the process by default.
 */
async function withLinuxLifecycleLock(
	ctx: ModelerInstallContext,
	body: () => ModelerInstallResult | Promise<ModelerInstallResult>,
): Promise<ModelerInstallResult> {
	acquireLinuxLifecycleLock(ctx.logger);
	const onSignal = (): void => releaseLinuxLifecycleLock();
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		return await body();
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		releaseLinuxLifecycleLock();
	}
}

/**
 * Progress chatter that `quiet` suppresses (download and install
 * announcements); warnings and failure diagnostics still surface.
 */
function reportProgress(
	{ logger, quiet }: Pick<ModelerInstallContext, "logger" | "quiet">,
	message: string,
): void {
	if (!quiet) logger.info(message);
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
	{
		failureMessage,
		quiet,
		stdin = "inherit",
		env,
	}: {
		failureMessage: string;
		quiet: boolean;
		stdin?: "inherit" | "ignore";
		env?: NodeJS.ProcessEnv;
	},
): void {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		stdio: quiet
			? [stdin, "pipe", "pipe"]
			: [stdin, process.stderr.fd, process.stderr.fd],
		env,
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
			`${failureMessage} (exit code ${formatExitCode(result.status)}).${details}`,
		);
	}
}

function runCommandCapture(
	command: string,
	args: string[],
	failureMessage: string,
): string {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const diagnostics = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	const details = diagnostics ? `\n${diagnostics}` : "";
	if (result.error) {
		throw new Error(`${failureMessage}: ${result.error.message}${details}`);
	}
	if (result.status !== 0) {
		throw new Error(
			`${failureMessage} (exit code ${formatExitCode(result.status)}).${details}`,
		);
	}
	return result.stdout ?? "";
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

function unregisterWithLaunchServices(appPath: string, logger: Logger): void {
	const result = spawnSync(LAUNCH_SERVICES_REGISTER, ["-u", "-f", appPath], {
		stdio: "ignore",
	});
	if (result.error || result.status !== 0) {
		logger.warn(
			`Could not unregister ${appPath} from macOS Launch Services. Remove its file associations manually if they remain.`,
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

async function fetchReleaseIndex(signal: AbortSignal): Promise<string> {
	const response = await fetchResponse(
		MODELER_RELEASE_URL,
		"Could not check Camunda Modeler releases",
		AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
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

	if (!live && !quiet) {
		logger.info(`Downloaded ${(received / 1_048_576).toFixed(1)} MB.`);
	}
}

/** Downloads the latest stable release into `dir`, with progress. */
async function downloadLatestRelease({
	dir,
	platform,
	archiveName,
	logger,
	quiet,
	signal,
}: {
	dir: string;
	platform: string;
	archiveName: (version: string) => string;
	logger: Logger;
	quiet: boolean;
	signal: AbortSignal;
}): Promise<{ version: string; archivePath: string }> {
	const version = latestStableModelerVersion(await fetchReleaseIndex(signal));
	const name = archiveName(version);
	const archivePath = join(dir, name);
	reportProgress(
		{ logger, quiet },
		`Downloading Camunda Modeler ${version} for ${platform}...`,
	);
	await downloadArchive({
		url: new URL(`${version}/${name}`, MODELER_RELEASE_URL).toString(),
		destination: archivePath,
		logger,
		quiet,
		signal,
	});
	return { version, archivePath };
}

async function downloadReleaseVersion({
	dir,
	version,
	platform,
	archiveName,
	logger,
	quiet,
	signal,
}: {
	dir: string;
	version: string;
	platform: string;
	archiveName: (version: string) => string;
	logger: Logger;
	quiet: boolean;
	signal: AbortSignal;
}): Promise<{ version: string; archivePath: string }> {
	const name = archiveName(version);
	const archivePath = join(dir, name);
	reportProgress(
		{ logger, quiet },
		`Downloading Camunda Modeler ${version} for ${platform}...`,
	);
	await downloadArchive({
		url: new URL(`${version}/${name}`, MODELER_RELEASE_URL).toString(),
		destination: archivePath,
		logger,
		quiet,
		signal,
	});
	return { version, archivePath };
}

function registerDownloadInterrupts(operation: string): {
	signal: AbortSignal;
	cleanup: () => void;
} {
	const controller = new AbortController();
	let interruptedSignal: NodeJS.Signals | undefined;
	const interrupt = (signal: NodeJS.Signals): void => {
		interruptedSignal ??= signal;
		controller.abort(new Error(`${operation} interrupted by ${signal}`));
	};
	const onSigint = (): void => interrupt("SIGINT");
	const onSigterm = (): void => interrupt("SIGTERM");
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);

	return {
		signal: controller.signal,
		cleanup: () => {
			process.off("SIGINT", onSigint);
			process.off("SIGTERM", onSigterm);
			if (interruptedSignal) process.kill(process.pid, interruptedSignal);
		},
	};
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
		const { version, archivePath } = await downloadLatestRelease({
			dir: tempDir,
			platform: "macOS",
			archiveName: (version) => modelerMacArchiveName(version, process.arch),
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
			reportProgress(
				{ logger, quiet },
				`Installing Camunda Modeler to ${destination}...`,
			);
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
	quiet,
}: ModelerInstallContext): ModelerInstallResult {
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
				kind: "dryRun",
				info: {
					dryRun: true,
					command: "modeler install",
					message: `Dry run: would install Camunda Modeler to ${installDir} with \`winget install --id ${WINGET_PACKAGE_ID}\`.`,
				},
			};
		}

		reportProgress(
			{ logger, quiet },
			"Installing Camunda Modeler with winget...",
		);
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
			{
				failureMessage: "winget could not install Camunda Modeler",
				quiet,
			},
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
function runAsRoot(
	args: string[],
	failureMessage: string,
	quiet: boolean,
	includeManualDownload = true,
): void {
	const [command, ...rest] =
		process.getuid?.() === 0 ? args : ["sudo", ...args];
	try {
		runCommand(command, rest, { failureMessage, quiet });
	} catch (error) {
		const message = errorMessage(error);
		throw includeManualDownload
			? manualDownloadError(message)
			: new Error(message);
	}
}

/** Modeler's own script installs its desktop entry, icons, and MIME types for the current user. */
function registerWithDesktop({
	installDir,
	logger,
	quiet,
}: {
	installDir: string;
	logger: Logger;
	quiet: boolean;
}): void {
	const script = join(installDir, "support", "xdg_register.sh");
	// The script reports success even when the xdg-utils it calls are missing.
	if (!findOnPath("xdg-mime")) {
		logger.warn(
			`Could not register Camunda Modeler for .bpmn, .dmn, .form, and .rpa files because xdg-utils is not installed. Install xdg-utils, then run ${script}.`,
		);
		return;
	}
	// Keep the interpreter fixed; the script path is versioned release data.
	try {
		runCommand("/bin/bash", [script], {
			failureMessage: `Could not register Camunda Modeler for .bpmn, .dmn, .form, and .rpa files. Run ${script} to retry.`,
			quiet,
			stdin: "ignore",
		});
	} catch (error) {
		logger.warn(errorMessage(error));
	}
}

function unregisterWithDesktop({
	installDir,
	logger,
	quiet,
}: {
	installDir: string;
	logger: Logger;
	quiet: boolean;
}): void {
	const script = join(installDir, "support", "xdg_unregister.sh");
	if (!existsSync(script)) {
		logger.warn(
			`Could not unregister Camunda Modeler file types because ${script} is missing.`,
		);
		return;
	}
	const missingTools = [
		"xdg-mime",
		"xdg-desktop-menu",
		"xdg-icon-resource",
	].filter((tool) => !findOnPath(tool));
	if (missingTools.length > 0) {
		logger.warn(
			`Could not unregister Camunda Modeler file types because these xdg-utils are not installed: ${missingTools.join(", ")}.`,
		);
		return;
	}
	try {
		runCommand("/bin/bash", [script], {
			failureMessage: `Could not unregister Camunda Modeler file types using ${script}`,
			quiet,
			stdin: "ignore",
		});
	} catch (error) {
		logger.warn(`${errorMessage(error)} File registrations may remain.`);
	}
}

async function installOnLinux({
	isDryRun,
	logger,
	quiet,
}: ModelerInstallContext): Promise<ModelerInstallResult> {
	const installedPath = findOnPath(LINUX_EXECUTABLE);
	if (installedPath) {
		return {
			kind: "info",
			message: `Camunda Modeler is already installed at ${installedPath}; skipping installation.`,
		};
	}
	if (process.arch !== "x64") {
		throw manualDownloadError(
			`Unsupported Linux architecture "${process.arch}"`,
		);
	}
	if (isDryRun) {
		return {
			kind: "dryRun",
			info: {
				dryRun: true,
				command: "modeler install",
				message: `Dry run: would download the latest stable Camunda Modeler and install it to ${LINUX_INSTALL_ROOT} as root.`,
			},
		};
	}

	if (process.getuid?.() !== 0) {
		reportProgress(
			{ logger, quiet },
			`Installing to ${LINUX_INSTALL_ROOT} needs root privileges; sudo may ask for your password.`,
		);
	}
	runAsRoot(["true"], "Could not get root privileges", quiet);

	reportProgress(
		{ logger, quiet },
		"Checking for the latest stable Camunda Modeler release...",
	);
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
		const { version, archivePath } = await downloadLatestRelease({
			dir: tempDir,
			platform: "Linux",
			archiveName: (version) => `camunda-modeler-${version}-linux-x64.tar.gz`,
			logger,
			quiet,
			signal: controller.signal,
		});
		const releaseDir = `camunda-modeler-${version}-linux-x64`;
		const installDir = join(LINUX_INSTALL_ROOT, releaseDir);
		const launcher = join(LINUX_INSTALL_ROOT, LINUX_EXECUTABLE);
		reportProgress(
			{ logger, quiet },
			`Installing Camunda Modeler to ${installDir}...`,
		);
		// Remove stale links before extraction and recreate the launcher last.
		runAsRoot(["rm", "-f", launcher], `Could not remove ${launcher}`, quiet);
		runAsRoot(
			["tar", "--no-same-owner", "-xzf", archivePath, "-C", LINUX_INSTALL_ROOT],
			"Could not extract Camunda Modeler",
			quiet,
		);
		runAsRoot(
			["chmod", "4755", join(installDir, "chrome-sandbox")],
			"Could not set up the Camunda Modeler sandbox",
			quiet,
		);
		runAsRoot(
			["ln", "-sfn", join(releaseDir, LINUX_EXECUTABLE), launcher],
			`Could not link ${launcher}`,
			quiet,
		);
		registerWithDesktop({ installDir, logger, quiet });
		return {
			kind: "success",
			message: `Installed Camunda Modeler ${version} to ${installDir}.`,
		};
	} finally {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
		rmSync(tempDir, { recursive: true, force: true });
		if (interruptedSignal) process.kill(process.pid, interruptedSignal);
	}
}

/**
 * Install the latest Desktop Modeler for this OS, skipping when already
 * installed. Kept free of command-dispatch concerns so the plugin handler
 * owns rendering and error mapping.
 */
export async function installDesktopModeler(
	ctx: ModelerInstallContext,
): Promise<ModelerInstallResult> {
	if (process.platform === "win32") return installOnWindows(ctx);
	if (process.platform === "linux") {
		return withLinuxLifecycleLock(ctx, () => installOnLinux(ctx));
	}
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
				kind: "dryRun",
				info: {
					dryRun: true,
					command: "modeler install",
					message:
						"Dry run: would install Camunda Modeler with `brew install --cask camunda-modeler`.",
				},
			};
		}

		reportProgress(ctx, "Installing Camunda Modeler with Homebrew...");
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
		reportProgress(
			ctx,
			`${SYSTEM_APPLICATIONS_DIR} is not writable; installing to ${applicationsDir} instead.`,
		);
	}

	reportProgress(
		ctx,
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
}

function noModelerInstalled(): ModelerInstallResult {
	return {
		kind: "info",
		message:
			"Camunda Modeler is not installed; run `c8ctl modeler install` first.",
	};
}

function dryRunResult(
	command: "modeler update" | "modeler remove",
	message: string,
): ModelerInstallResult {
	return {
		kind: "dryRun",
		info: { dryRun: true, command, message },
	};
}

function homebrewModelerInstalled(): boolean {
	return isInstalledWith({
		command: "brew",
		args: ["list", "--cask", "--versions", "camunda-modeler"],
		notInstalledStatus: 1,
		description: "the Homebrew Modeler cask",
	});
}

function updateHomebrewModeler(
	ctx: ModelerInstallContext,
): ModelerInstallResult {
	const outdated = runCommandCapture(
		"brew",
		["outdated", "--cask", "--quiet", "camunda-modeler"],
		"Could not check Homebrew for Camunda Modeler updates",
	).trim();
	if (!outdated) {
		return {
			kind: "info",
			message: "Camunda Modeler is already up to date with Homebrew.",
		};
	}
	if (ctx.isDryRun) {
		return dryRunResult(
			"modeler update",
			"Dry run: would update Camunda Modeler with `brew upgrade --cask camunda-modeler`.",
		);
	}

	reportProgress(ctx, "Updating Camunda Modeler with Homebrew...");
	runCommand("brew", ["upgrade", "--cask", "camunda-modeler"], {
		failureMessage: "Homebrew could not update Camunda Modeler",
		quiet: ctx.quiet,
	});
	return {
		kind: "success",
		message: "Updated Camunda Modeler with Homebrew.",
	};
}

function isHomebrewCaskPath(appPath: string): boolean {
	return /\/Caskroom\/camunda-modeler\//i.test(realpathSync(appPath));
}

function verifyMacModelerBundle(
	appPath: string,
	action: "update" | "remove",
	quiet: boolean,
): void {
	runCommand(
		"codesign",
		[
			"--verify",
			"--deep",
			"--strict",
			`-R=${MODELER_CODE_REQUIREMENT}`,
			appPath,
		],
		{
			failureMessage: `Camunda Modeler at ${appPath} is not signed by Camunda; refusing to ${action} it`,
			quiet,
		},
	);
}

function readMacModelerVersion(appPath: string): string {
	const plistPath = join(appPath, "Contents", "Info.plist");
	const plist = readFileSync(plistPath, "utf8");
	const version =
		/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/
			.exec(plist)?.[1]
			?.trim();
	if (!version) {
		throw new Error(
			`Could not read the installed Camunda Modeler version from ${plistPath}; reinstall it with c8ctl before updating.`,
		);
	}
	return version;
}

async function updateDirectMacModeler(
	ctx: ModelerInstallContext,
	appPath: string,
): Promise<ModelerInstallResult> {
	if (isHomebrewCaskPath(appPath)) {
		throw new Error(
			"Camunda Modeler appears to be Homebrew-managed, but its cask was not found; refusing to update the app bundle directly.",
		);
	}
	verifyMacModelerBundle(appPath, "update", ctx.quiet);
	const currentVersion = readMacModelerVersion(appPath);
	const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-modeler-"));
	const interruption = registerDownloadInterrupts("Modeler update");
	try {
		reportProgress(
			ctx,
			"Checking for the latest stable Camunda Modeler release...",
		);
		const latestVersion = latestStableModelerVersion(
			await fetchReleaseIndex(interruption.signal),
		);
		if (!isNewerModelerVersion(latestVersion, currentVersion)) {
			return {
				kind: "info",
				message: `Camunda Modeler is already up to date (installed ${currentVersion}; latest stable ${latestVersion}).`,
			};
		}
		if (ctx.isDryRun) {
			return dryRunResult(
				"modeler update",
				`Dry run: would update Camunda Modeler from ${currentVersion} to ${latestVersion} at ${appPath}.`,
			);
		}

		const { archivePath } = await downloadReleaseVersion({
			dir: tempDir,
			version: latestVersion,
			platform: "macOS",
			archiveName: (version) => modelerMacArchiveName(version, process.arch),
			logger: ctx.logger,
			quiet: ctx.quiet,
			signal: interruption.signal,
		});
		const stagingDir = mkdtempSync(
			join(dirname(appPath), ".c8ctl-modeler-update-"),
		);
		const stagedApp = join(stagingDir, APP_BUNDLE_NAME);
		const backupApp = join(stagingDir, "previous.app");
		try {
			reportProgress(ctx, `Updating Camunda Modeler to ${latestVersion}...`);
			runCommand("ditto", ["-x", "-k", archivePath, stagingDir], {
				failureMessage: "Could not extract Camunda Modeler",
				quiet: ctx.quiet,
			});
			if (!existsSync(stagedApp)) {
				throw manualDownloadError(
					`The Camunda Modeler ${latestVersion} archive did not contain ${APP_BUNDLE_NAME}`,
				);
			}
			verifyMacModelerBundle(stagedApp, "update", ctx.quiet);

			renameSync(appPath, backupApp);
			try {
				renameSync(stagedApp, appPath);
			} catch (error) {
				try {
					renameSync(backupApp, appPath);
				} catch (restoreError) {
					throw new Error(
						`Could not install the new Camunda Modeler bundle; the previous bundle remains at ${backupApp}: ${errorMessage(restoreError)}`,
					);
				}
				throw new Error(
					`Could not replace the Camunda Modeler bundle: ${errorMessage(error)}`,
				);
			}
			try {
				rmSync(backupApp, { recursive: true, force: true });
			} catch (error) {
				ctx.logger.warn(
					`Could not remove the previous Camunda Modeler bundle at ${backupApp}: ${errorMessage(error)}`,
				);
			}
		} finally {
			// A failed restore leaves the previous bundle in the staging
			// directory as the only recoverable copy — keep it.
			if (!existsSync(backupApp)) {
				try {
					rmSync(stagingDir, { recursive: true, force: true });
				} catch (error) {
					ctx.logger.warn(
						`Could not clean up the Modeler update directory ${stagingDir}: ${errorMessage(error)}`,
					);
				}
			}
		}

		registerWithLaunchServices(appPath, ctx.logger);
		return {
			kind: "success",
			message: `Updated Camunda Modeler to ${latestVersion} at ${appPath}.`,
		};
	} finally {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} finally {
			interruption.cleanup();
		}
	}
}

async function updateMacModeler(
	ctx: ModelerInstallContext,
): Promise<ModelerInstallResult> {
	if (hasPackageManager("brew", "Homebrew") && homebrewModelerInstalled()) {
		return updateHomebrewModeler(ctx);
	}
	const appPath = findInstalledModeler();
	if (!appPath) return noModelerInstalled();
	return updateDirectMacModeler(ctx, appPath);
}

function wingetUpgradeAvailable(): boolean {
	const result = spawnSync(
		"winget",
		["list", "--upgrade-available", ...WINGET_PACKAGE],
		{
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	if (result.error) {
		throw new Error(
			`Could not check for Camunda Modeler updates with winget: ${result.error.message}`,
		);
	}
	if (result.status === WINGET_NO_APPLICATIONS_FOUND) return false;
	if (result.status !== 0) {
		throw new Error(
			`Could not check for Camunda Modeler updates with winget (exit code ${formatExitCode(result.status)})`,
		);
	}
	return `${result.stdout ?? ""}\n${result.stderr ?? ""}`
		.split(/\r?\n/)
		.some((line) => line.includes(WINGET_PACKAGE_ID));
}

function wingetModelerPaths(): { installDir: string; executable: string } {
	const localAppData =
		process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
	const installDir = join(localAppData, "Programs", "Camunda Modeler");
	return { installDir, executable: join(installDir, WINDOWS_EXECUTABLE) };
}

function updateWindowsModeler(
	ctx: ModelerInstallContext,
): ModelerInstallResult {
	const { executable, installDir } = wingetModelerPaths();
	if (!hasPackageManager("winget", "winget")) {
		if (existsSync(executable)) {
			throw new Error(
				`winget is not available, so c8ctl cannot safely update the Modeler installation at ${installDir}.`,
			);
		}
		return noModelerInstalled();
	}
	if (
		!isInstalledWith({
			command: "winget",
			args: ["list", ...WINGET_PACKAGE],
			notInstalledStatus: WINGET_NO_APPLICATIONS_FOUND,
			description: "the winget Modeler package",
		})
	) {
		if (existsSync(executable)) {
			throw new Error(
				`Camunda Modeler at ${installDir} is not installed with winget; refusing to update it.`,
			);
		}
		return noModelerInstalled();
	}
	if (!wingetUpgradeAvailable()) {
		return {
			kind: "info",
			message: "Camunda Modeler is already up to date with winget.",
		};
	}
	if (ctx.isDryRun) {
		return dryRunResult(
			"modeler update",
			"Dry run: would update Camunda Modeler with `winget upgrade --id Camunda.Modeler --exact --source winget`.",
		);
	}

	reportProgress(ctx, "Updating Camunda Modeler with winget...");
	runCommand("winget", ["upgrade", ...WINGET_PACKAGE], {
		failureMessage: "winget could not update Camunda Modeler",
		quiet: ctx.quiet,
	});
	return { kind: "success", message: "Updated Camunda Modeler with winget." };
}

function unregisterWindowsModeler(
	ctx: ModelerInstallContext,
	executable: string,
): void {
	const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
	const shortcut = join(
		appData,
		"Microsoft",
		"Windows",
		"Start Menu",
		"Programs",
		"Camunda Modeler.lnk",
	);
	try {
		runCommand(
			"powershell",
			["-NoProfile", "-NonInteractive", "-Command", UNREGISTER_WINDOWS_SCRIPT],
			{
				failureMessage: "Could not unregister Camunda Modeler file types",
				quiet: ctx.quiet,
				stdin: "ignore",
				env: {
					...process.env,
					C8CTL_SHORTCUT: shortcut,
					C8CTL_TARGET: executable,
				},
			},
		);
	} catch (error) {
		ctx.logger.warn(
			`${errorMessage(error)} File associations or the Start Menu shortcut may remain.`,
		);
	}
}

function removeWindowsModeler(
	ctx: ModelerInstallContext,
): ModelerInstallResult {
	const { executable, installDir } = wingetModelerPaths();
	if (!hasPackageManager("winget", "winget")) {
		if (existsSync(executable)) {
			throw new Error(
				`winget is not available, so c8ctl cannot safely remove the Modeler installation at ${installDir}.`,
			);
		}
		return noModelerInstalled();
	}
	if (
		!isInstalledWith({
			command: "winget",
			args: ["list", ...WINGET_PACKAGE],
			notInstalledStatus: WINGET_NO_APPLICATIONS_FOUND,
			description: "the winget Modeler package",
		})
	) {
		if (existsSync(executable)) {
			throw new Error(
				`Camunda Modeler at ${installDir} is not installed with winget; refusing to remove it.`,
			);
		}
		return noModelerInstalled();
	}
	if (ctx.isDryRun) {
		return dryRunResult(
			"modeler remove",
			"Dry run: would remove Camunda Modeler with `winget uninstall --id Camunda.Modeler --exact --source winget`.",
		);
	}

	reportProgress(ctx, "Removing Camunda Modeler with winget...");
	runCommand("winget", ["uninstall", ...WINGET_PACKAGE], {
		failureMessage: "winget could not remove Camunda Modeler",
		quiet: ctx.quiet,
	});
	unregisterWindowsModeler(ctx, executable);
	return {
		kind: "success",
		message: "Removed Camunda Modeler with winget.",
	};
}

interface LinuxModelerInstallation {
	version: string;
	target: string;
	installDir: string;
	launcher: string;
}

/** Like existsSync, but also sees a dangling symlink (existsSync follows links). */
function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function findManagedLinuxModeler(): LinuxModelerInstallation | undefined {
	const launcher = join(LINUX_INSTALL_ROOT, LINUX_EXECUTABLE);
	// readlinkSync throws for a missing launcher or a non-symlink — both
	// mean "not a managed installation".
	let target: string;
	try {
		target = readlinkSync(launcher);
	} catch {
		return undefined;
	}
	const version =
		/^camunda-modeler-(\d+\.\d+\.\d+)-linux-x64\/camunda-modeler$/.exec(
			target,
		)?.[1];
	if (!version) return undefined;
	const installDir = join(
		LINUX_INSTALL_ROOT,
		`camunda-modeler-${version}-linux-x64`,
	);
	// A dangling link still identifies a managed install: a partial removal
	// may have deleted the release before the launcher, and a retry needs
	// the identity to finish the cleanup.
	return { version, target, installDir, launcher };
}

function linuxModelerForAction(
	action: "update" | "remove",
): LinuxModelerInstallation | undefined {
	const installation = findManagedLinuxModeler();
	if (installation) return installation;
	const launcher = join(LINUX_INSTALL_ROOT, LINUX_EXECUTABLE);
	const installedPath = findOnPath(LINUX_EXECUTABLE);
	if (installedPath || pathExists(launcher)) {
		throw new Error(
			`Camunda Modeler at ${installedPath ?? launcher} is not installed by c8ctl; refusing to ${action} it.`,
		);
	}
	return undefined;
}

async function updateLinuxModeler(
	ctx: ModelerInstallContext,
): Promise<ModelerInstallResult> {
	if (process.arch !== "x64") {
		throw manualDownloadError(
			`Unsupported Linux architecture "${process.arch}"`,
		);
	}
	const installation = linuxModelerForAction("update");
	if (!installation) return noModelerInstalled();
	// A dangling launcher identifies a partially removed installation; it
	// must not pass the up-to-date check below as if it were working.
	if (!existsSync(join(installation.installDir, LINUX_EXECUTABLE))) {
		throw new Error(
			`Camunda Modeler ${installation.version} is only partially installed: ${join(installation.installDir, LINUX_EXECUTABLE)} is missing. Run \`c8ctl modeler remove\` to clean up, then \`c8ctl modeler install\` to install it again.`,
		);
	}

	const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-modeler-"));
	const interruption = registerDownloadInterrupts("Modeler update");
	try {
		reportProgress(
			ctx,
			"Checking for the latest stable Camunda Modeler release...",
		);
		const latestVersion = latestStableModelerVersion(
			await fetchReleaseIndex(interruption.signal),
		);
		if (!isNewerModelerVersion(latestVersion, installation.version)) {
			return {
				kind: "info",
				message: `Camunda Modeler is already up to date (installed ${installation.version}; latest stable ${latestVersion}).`,
			};
		}
		const newReleaseName = `camunda-modeler-${latestVersion}-linux-x64`;
		const newInstallDir = join(LINUX_INSTALL_ROOT, newReleaseName);
		if (ctx.isDryRun) {
			return dryRunResult(
				"modeler update",
				`Dry run: would update Camunda Modeler from ${installation.version} to ${latestVersion} in ${newInstallDir}.`,
			);
		}
		if (existsSync(newInstallDir)) {
			throw new Error(
				`A release directory already exists at ${newInstallDir}; refusing to overwrite it.`,
			);
		}

		if (process.getuid?.() !== 0) {
			reportProgress(
				ctx,
				`Updating in ${LINUX_INSTALL_ROOT} needs root privileges; sudo may ask for your password.`,
			);
		}
		runAsRoot(["true"], "Could not get root privileges", ctx.quiet);
		const { archivePath } = await downloadReleaseVersion({
			dir: tempDir,
			version: latestVersion,
			platform: "Linux",
			archiveName: (version) => `camunda-modeler-${version}-linux-x64.tar.gz`,
			logger: ctx.logger,
			quiet: ctx.quiet,
			signal: interruption.signal,
		});

		const temporaryLauncher = join(
			LINUX_INSTALL_ROOT,
			".c8ctl-camunda-modeler-update",
		);
		let launcherUpdated = false;
		try {
			reportProgress(
				ctx,
				`Installing Camunda Modeler ${latestVersion} to ${newInstallDir}...`,
			);
			runAsRoot(
				[
					"tar",
					"--no-same-owner",
					"-xzf",
					archivePath,
					"-C",
					LINUX_INSTALL_ROOT,
				],
				"Could not extract Camunda Modeler",
				ctx.quiet,
			);
			if (!existsSync(join(newInstallDir, LINUX_EXECUTABLE))) {
				throw manualDownloadError(
					`The Camunda Modeler ${latestVersion} archive did not contain ${newReleaseName}/${LINUX_EXECUTABLE}`,
				);
			}
			runAsRoot(
				["chmod", "4755", join(newInstallDir, "chrome-sandbox")],
				"Could not set up the Camunda Modeler sandbox",
				ctx.quiet,
			);
			runAsRoot(
				[
					"ln",
					"-sfn",
					join(newReleaseName, LINUX_EXECUTABLE),
					temporaryLauncher,
				],
				`Could not prepare ${LINUX_EXECUTABLE}`,
				ctx.quiet,
			);
			runAsRoot(
				["mv", "-f", temporaryLauncher, installation.launcher],
				`Could not switch ${LINUX_EXECUTABLE} to the updated release`,
				ctx.quiet,
			);
			launcherUpdated = true;
		} catch (error) {
			if (!launcherUpdated) {
				try {
					runAsRoot(
						["rm", "-f", temporaryLauncher],
						`Could not remove ${temporaryLauncher}`,
						ctx.quiet,
						false,
					);
				} catch (cleanupError) {
					ctx.logger.warn(errorMessage(cleanupError));
				}
				if (existsSync(newInstallDir)) {
					try {
						runAsRoot(
							["rm", "-rf", newInstallDir],
							`Could not remove incomplete release ${newInstallDir}`,
							ctx.quiet,
							false,
						);
					} catch (cleanupError) {
						ctx.logger.warn(errorMessage(cleanupError));
					}
				}
			}
			throw error;
		}

		unregisterWithDesktop({
			installDir: installation.installDir,
			logger: ctx.logger,
			quiet: ctx.quiet,
		});
		registerWithDesktop({
			installDir: newInstallDir,
			logger: ctx.logger,
			quiet: ctx.quiet,
		});
		try {
			runAsRoot(
				["rm", "-rf", installation.installDir],
				`Could not remove previous Modeler release ${installation.installDir}`,
				ctx.quiet,
				false,
			);
		} catch (error) {
			ctx.logger.warn(
				`Updated Camunda Modeler, but could not remove the previous release at ${installation.installDir}: ${errorMessage(error)}`,
			);
		}
		return {
			kind: "success",
			message: `Updated Camunda Modeler to ${latestVersion} in ${newInstallDir}.`,
		};
	} finally {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} finally {
			interruption.cleanup();
		}
	}
}

function removeLinuxModeler(ctx: ModelerInstallContext): ModelerInstallResult {
	const installation = linuxModelerForAction("remove");
	if (!installation) return noModelerInstalled();
	if (ctx.isDryRun) {
		return dryRunResult(
			"modeler remove",
			`Dry run: would remove Camunda Modeler ${installation.version} from ${installation.installDir} and unregister its file types.`,
		);
	}

	if (process.getuid?.() !== 0) {
		reportProgress(
			ctx,
			`Removing from ${LINUX_INSTALL_ROOT} needs root privileges; sudo may ask for your password.`,
		);
	}
	runAsRoot(["true"], "Could not get root privileges", ctx.quiet, false);
	unregisterWithDesktop({
		installDir: installation.installDir,
		logger: ctx.logger,
		quiet: ctx.quiet,
	});
	// Remove the release before the launcher: while the launcher still
	// points at it, a failed removal stays detectable and a retry can
	// finish the cleanup.
	runAsRoot(
		["rm", "-rf", installation.installDir],
		`Could not remove ${installation.installDir}`,
		ctx.quiet,
		false,
	);
	runAsRoot(
		["rm", "-f", installation.launcher],
		`Could not remove ${installation.launcher}`,
		ctx.quiet,
		false,
	);
	return {
		kind: "success",
		message: `Removed Camunda Modeler ${installation.version} from ${installation.installDir}.`,
	};
}

async function removeMacModeler(
	ctx: ModelerInstallContext,
): Promise<ModelerInstallResult> {
	if (hasPackageManager("brew", "Homebrew") && homebrewModelerInstalled()) {
		if (ctx.isDryRun) {
			return dryRunResult(
				"modeler remove",
				"Dry run: would remove Camunda Modeler with `brew uninstall --cask camunda-modeler`.",
			);
		}

		let appPath: string | undefined;
		try {
			appPath = resolveHomebrewModelerPath();
		} catch (error) {
			ctx.logger.warn(
				`Could not locate the Homebrew Modeler bundle before uninstalling it: ${errorMessage(error)}`,
			);
		}
		reportProgress(ctx, "Removing Camunda Modeler with Homebrew...");
		runCommand("brew", ["uninstall", "--cask", "camunda-modeler"], {
			failureMessage: "Homebrew could not remove Camunda Modeler",
			quiet: ctx.quiet,
		});
		if (appPath) unregisterWithLaunchServices(appPath, ctx.logger);
		return {
			kind: "success",
			message: "Removed Camunda Modeler with Homebrew.",
		};
	}

	const appPath = findInstalledModeler();
	if (!appPath) return noModelerInstalled();
	if (isHomebrewCaskPath(appPath)) {
		throw new Error(
			"Camunda Modeler appears to be Homebrew-managed, but its cask was not found; refusing to remove the app bundle directly.",
		);
	}
	verifyMacModelerBundle(appPath, "remove", ctx.quiet);
	if (ctx.isDryRun) {
		return dryRunResult(
			"modeler remove",
			`Dry run: would remove the Camunda Modeler app bundle at ${appPath}.`,
		);
	}
	reportProgress(ctx, `Removing Camunda Modeler from ${appPath}...`);
	unregisterWithLaunchServices(appPath, ctx.logger);
	rmSync(appPath, { recursive: true });
	return {
		kind: "success",
		message: `Removed Camunda Modeler from ${appPath}.`,
	};
}

export async function updateDesktopModeler(
	ctx: ModelerInstallContext,
): Promise<ModelerInstallResult> {
	if (process.platform === "win32") return updateWindowsModeler(ctx);
	if (process.platform === "linux") {
		return withLinuxLifecycleLock(ctx, () => updateLinuxModeler(ctx));
	}
	if (process.platform === "darwin") return updateMacModeler(ctx);
	throw new Error(
		`c8ctl modeler update currently supports macOS, Windows, and Linux only. Download Modeler manually from ${MANUAL_DOWNLOAD_URL}`,
	);
}

export async function removeDesktopModeler(
	ctx: ModelerInstallContext,
): Promise<ModelerInstallResult> {
	if (process.platform === "win32") return removeWindowsModeler(ctx);
	if (process.platform === "linux") {
		return withLinuxLifecycleLock(ctx, () => removeLinuxModeler(ctx));
	}
	if (process.platform === "darwin") return removeMacModeler(ctx);
	throw new Error(
		`c8ctl modeler remove currently supports macOS, Windows, and Linux only. Download Modeler manually from ${MANUAL_DOWNLOAD_URL}`,
	);
}
