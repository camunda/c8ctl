import { spawnSync } from "node:child_process";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { defineCommand } from "../framework/index.ts";
import {
	latestStableModelerVersion,
	MODELER_RELEASE_URL,
	modelerMacArchiveName,
} from "../utils/index.ts";

const APP_BUNDLE_NAME = "Camunda Modeler.app";
const MANUAL_DOWNLOAD_URL = MODELER_RELEASE_URL;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function manualDownloadError(message: string): Error {
	return new Error(`${message}. Download manually from ${MANUAL_DOWNLOAD_URL}`);
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
		throw new Error(`${failureMessage} (exit code ${String(result.status)}).`);
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

function findInstalledModeler(): string | undefined {
	const locations = [
		join("/Applications", APP_BUNDLE_NAME),
		join(homedir(), "Applications", APP_BUNDLE_NAME),
	];
	return locations.find((location) => existsSync(location));
}

async function fetchResponse(
	url: string,
	description: string,
	timeoutMs: number,
): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
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
		30_000,
	);
	try {
		return await response.text();
	} catch (error) {
		throw manualDownloadError(
			`Could not read Camunda Modeler releases: ${errorMessage(error)}`,
		);
	}
}

function formatMegabytes(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function writeDownloadProgress(
	downloadedBytes: number,
	totalBytes: number,
	percent: number | undefined,
): void {
	if (!process.stderr.isTTY) return;

	const width = 28;
	const filled =
		percent === undefined ? undefined : Math.round((percent / 100) * width);
	let bar: string;
	if (filled === undefined) {
		const movingWidth = 5;
		const distance = width - movingWidth;
		const phase = Math.floor(downloadedBytes / 131_072) % (distance * 2);
		const position = phase <= distance ? phase : distance * 2 - phase;
		bar =
			" ".repeat(position) +
			"#".repeat(movingWidth) +
			" ".repeat(width - position - movingWidth);
	} else {
		bar = "#".repeat(filled) + "-".repeat(width - filled);
	}

	const styledBar =
		process.env.NO_COLOR === undefined && process.env.TERM !== "dumb"
			? `\u001b[36m${bar}\u001b[0m`
			: bar;
	const detail =
		percent === undefined
			? `${formatMegabytes(downloadedBytes)} downloaded`
			: `${percent}%  ${formatMegabytes(downloadedBytes)} / ${formatMegabytes(totalBytes)}`;
	process.stderr.write(
		`\r\u001b[2KDownloading Camunda Modeler [${styledBar}] ${detail}`,
	);
}

async function downloadArchive(
	url: string,
	destination: string,
): Promise<void> {
	const response = await fetchResponse(
		url,
		"Could not download Camunda Modeler",
		15 * 60_000,
	);
	if (!response.body) {
		throw manualDownloadError("The Modeler download returned no file");
	}

	const contentLength = Number(response.headers.get("content-length"));
	let downloadedBytes = 0;
	let lastProgressUpdate = 0;
	const progress = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			downloadedBytes += chunk.byteLength;
			const now = Date.now();
			if (now - lastProgressUpdate >= 100) {
				const percent =
					Number.isFinite(contentLength) && contentLength > 0
						? Math.min(100, Math.floor((downloadedBytes / contentLength) * 100))
						: undefined;
				writeDownloadProgress(downloadedBytes, contentLength, percent);
				lastProgressUpdate = now;
			}
			callback(null, chunk);
		},
	});
	let completed = false;

	try {
		await pipeline(
			Readable.fromWeb(response.body),
			progress,
			createWriteStream(destination),
		);
		completed = true;
	} catch (error) {
		throw manualDownloadError(
			`Could not download Camunda Modeler: ${errorMessage(error)}`,
		);
	} finally {
		if (process.stderr.isTTY) {
			const knownSize = Number.isFinite(contentLength) && contentLength > 0;
			if (completed) {
				writeDownloadProgress(
					downloadedBytes,
					contentLength,
					knownSize ? 100 : undefined,
				);
			}
			process.stderr.write("\n");
		} else if (completed) {
			process.stderr.write(
				`Downloaded Camunda Modeler (${formatMegabytes(downloadedBytes)}).\n`,
			);
		}
	}
}

async function installFromOfficialDownload(logger: {
	info: (message: string) => void;
}): Promise<{ version: string; destination: string }> {
	const version = latestStableModelerVersion(await fetchReleaseIndex());
	const archiveName = modelerMacArchiveName(version, process.arch);
	const archiveUrl = new URL(
		`${version}/${archiveName}`,
		MODELER_RELEASE_URL,
	).toString();
	const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-modeler-"));

	try {
		const archivePath = join(tempDir, archiveName);
		const extractDir = join(tempDir, "extracted");
		mkdirSync(extractDir);

		logger.info(`Downloading Camunda Modeler ${version} for macOS...`);
		await downloadArchive(archiveUrl, archivePath);

		logger.info("Extracting Camunda Modeler...");
		runCommand(
			"ditto",
			["-x", "-k", archivePath, extractDir],
			"Could not extract Camunda Modeler",
		);

		const sourceApp = join(extractDir, APP_BUNDLE_NAME);
		if (!existsSync(sourceApp)) {
			throw manualDownloadError(
				`The Camunda Modeler ${version} archive did not contain ${APP_BUNDLE_NAME}`,
			);
		}

		const applicationsDir = "/Applications";
		const destination = join(applicationsDir, APP_BUNDLE_NAME);
		if (existsSync(destination)) {
			throw new Error(
				`Camunda Modeler is already installed at ${destination}; skipping installation.`,
			);
		}

		logger.info(`Installing Camunda Modeler to ${destination}...`);
		runCommand(
			"ditto",
			[sourceApp, destination],
			"Could not install Camunda Modeler to /Applications; administrator permissions may be required",
		);

		return { version, destination };
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
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

		if (ctx.isDryRun) {
			return {
				kind: "info",
				message:
					"Dry run: would install the latest stable Camunda Desktop Modeler.",
			};
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

			ctx.logger.info("Installing Camunda Modeler with Homebrew...");
			runCommand(
				"brew",
				["install", "--cask", "camunda-modeler"],
				"Homebrew could not install Camunda Modeler",
			);
			return {
				kind: "success",
				message: "Installed Camunda Modeler with Homebrew.",
			};
		}

		ctx.logger.info(
			"Checking for the latest stable Camunda Modeler release...",
		);
		const { version, destination } = await installFromOfficialDownload(
			ctx.logger,
		);
		return {
			kind: "success",
			message: `Installed Camunda Modeler ${version} to ${destination}.`,
		};
	},
);
