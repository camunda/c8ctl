import assert from "node:assert";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import {
	latestStableModelerVersion,
	modelerMacArchiveName,
	renderDownloadProgress,
} from "../../src/utils/command-local/modeler-helpers.ts";
import { c8WithOptions } from "../utils/cli.ts";

const MODELER_BUNDLE = "Camunda Modeler.app";
const MODELER_EXECUTABLE = "Camunda Modeler.exe";
const MB = 1_048_576;
const PROGRESS_COLUMNS = 60;
const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";
const isLinux = process.platform === "linux";

/**
 * Loaded into the CLI subprocess: maps /Applications to APPLICATIONS_ROOT
 * (optionally read-only), records Launch Services registrations in TOOL_LOG,
 * renders progress as if on a TTY, and serves a fake release index and archive.
 */
const PRELOAD = `
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const remap = (path) =>
	String(path) === "/Applications" || String(path).startsWith("/Applications/")
		? process.env.APPLICATIONS_ROOT + String(path).slice("/Applications".length)
		: path;
const { accessSync, existsSync, mkdtempSync, renameSync } = fs;
fs.existsSync = (path) => existsSync(remap(path));
fs.mkdtempSync = (prefix, options) => mkdtempSync(remap(prefix), options);
fs.renameSync = (from, to) => renameSync(remap(from), remap(to));
fs.accessSync = (path, mode) => {
	if (process.env.APPLICATIONS_READONLY === "1" && String(path) === "/Applications") {
		throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
	}
	return accessSync(remap(path), mode);
};
const { spawnSync } = childProcess;
childProcess.spawnSync = (command, args, options) => {
	if (String(command).endsWith("/lsregister")) {
		fs.appendFileSync(process.env.TOOL_LOG, "lsregister " + args.join(" ") + "\\n");
		return { status: 0 };
	}
	return spawnSync(command, args, options);
};
syncBuiltinESMExports();

Object.defineProperty(process.stderr, "isTTY", { value: true });
Object.defineProperty(process.stderr, "columns", { value: ${PROGRESS_COLUMNS} });
const releaseUrl = "https://downloads.camunda.cloud/release/camunda-modeler/";
const { fetch } = globalThis;
globalThis.fetch = async (input, init) => {
	const url = String(input);
	if (url === releaseUrl) {
		return new Response('<a href="5.52.0/">5.52.0/</a><a href="nightly/">nightly/</a>');
	}
	if (url.startsWith(releaseUrl + "5.52.0/")) {
		return new Response("archive", { headers: { "content-length": "7" } });
	}
	return fetch(input, init);
};
`;

/**
 * Loaded into the CLI subprocess on Windows: stands in for winget, reg and
 * PowerShell and records their calls in TOOL_LOG. WINGET=missing|installed|
 * failing selects the winget state; an install creates the executable under
 * --location, and the shortcut script writes its target into the shortcut.
 */
const WINDOWS_PRELOAD = `
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const { spawnSync } = childProcess;
childProcess.spawnSync = (command, args, options) => {
	if (!["winget", "reg", "powershell"].includes(command)) {
		return spawnSync(command, args, options);
	}
	fs.appendFileSync(process.env.TOOL_LOG, [command, ...args].join(" ") + "\\n");
	const winget = process.env.WINGET;
	if (command === "winget" && winget === "missing") {
		return { error: Object.assign(new Error("spawnSync winget ENOENT"), { code: "ENOENT" }) };
	}
	if (command === "winget" && args[0] === "list") {
		return { status: winget === "installed" ? 0 : 0x8a150014 };
	}
	if (command === "winget" && args[0] === "install") {
		if (winget === "failing") return { status: 0x8a150010 };
		const location = args[args.indexOf("--location") + 1];
		fs.mkdirSync(location, { recursive: true });
		fs.writeFileSync(join(location, "Camunda Modeler.exe"), "");
	}
	if (command === "powershell") {
		fs.writeFileSync(options.env.C8CTL_SHORTCUT, options.env.C8CTL_TARGET);
	}
	return { status: 0 };
};
syncBuiltinESMExports();
`;

/**
 * Loaded into the CLI subprocess on Linux: maps /usr/bin to USR_BIN_ROOT, runs
 * root commands without sudo and records them in TOOL_LOG (FAIL_AT=<tool>
 * makes that tool fail), fakes the user id and architecture, and serves
 * ARCHIVE as the 5.52.0 release.
 */
const LINUX_PRELOAD = `
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const remap = (path) =>
	String(path) === "/usr/bin" || String(path).startsWith("/usr/bin/")
		? process.env.USR_BIN_ROOT + String(path).slice("/usr/bin".length)
		: path;
const { accessSync, existsSync, statSync } = fs;
fs.accessSync = (path, mode) => accessSync(remap(path), mode);
fs.existsSync = (path) => existsSync(remap(path));
fs.statSync = (path, options) => statSync(remap(path), options);
const { spawnSync } = childProcess;
childProcess.spawnSync = (command, args, options) => {
	const desktopRegistration =
	command === "/bin/bash" && String(args[0]).startsWith("/usr/bin/");
	if (
		!["sudo", "true", "rm", "tar", "chmod", "ln"].includes(command) &&
		!command.startsWith("/usr/bin/") &&
		!desktopRegistration
	) {
		return spawnSync(command, args, options);
	}
	fs.appendFileSync(process.env.TOOL_LOG, [command, ...args].join(" ") + "\\n");
	const [real, ...rest] = (command === "sudo" ? args : [command, ...args]).map(remap);
	return real === process.env.FAIL_AT ? { status: 1 } : spawnSync(real, rest, options);
};
syncBuiltinESMExports();

Object.defineProperty(process, "platform", { value: "linux" });
process.getuid = () => Number(process.env.FAKE_UID);
Object.defineProperty(process, "arch", { value: process.env.FAKE_ARCH });
if (process.env.UNSET_PATH === "1") delete process.env.PATH;
const releaseUrl = "https://downloads.camunda.cloud/release/camunda-modeler/";
globalThis.fetch = async (input) => {
	const url = String(input);
	if (url === releaseUrl) {
		return new Response('<a href="5.52.0/">5.52.0/</a>');
	}
	return url === releaseUrl + "5.52.0/camunda-modeler-5.52.0-linux-x64.tar.gz"
		? new Response(fs.readFileSync(process.env.ARCHIVE))
		: new Response("not found", { status: 404 });
};
`;

function readToolLog(toolLog: string): string[] {
	return existsSync(toolLog)
		? readFileSync(toolLog, "utf-8").trim().split("\n")
		: [];
}

function createSandbox() {
	const home = mkdtempSync(join(tmpdir(), "c8ctl-modeler-test-"));
	const binDir = join(home, "bin");
	const applicationsRoot = join(home, "applications-root");
	const toolLog = join(home, "tools.log");
	const preload = join(home, "preload.mjs");
	mkdirSync(binDir);
	mkdirSync(applicationsRoot);
	// PATH below hides Homebrew, but the CLI subprocess still needs node.
	symlinkSync(process.execPath, join(binDir, "node"));
	writeFileSync(preload, PRELOAD);

	return {
		home,
		applicationsRoot,
		/** Put a fake command on PATH that records its arguments, then runs `body`. */
		fakeTool(name: string, body: string): void {
			const path = join(binDir, name);
			writeFileSync(
				path,
				`#!/bin/sh\nprintf '${name} %s\\n' "$*" >> "$TOOL_LOG"\n${body}\n`,
			);
			chmodSync(path, 0o755);
		},
		toolCalls(): string[] {
			return readToolLog(toolLog);
		},
		resetToolCalls(): void {
			rmSync(toolLog, { force: true });
		},
		install(env: Record<string, string> = {}, ...args: string[]) {
			return c8WithOptions(
				{
					nodeArgs: ["--import", preload],
					env: {
						PATH: [binDir, "/usr/bin", "/bin"].join(delimiter),
						HOME: home,
						APPLICATIONS_ROOT: applicationsRoot,
						TOOL_LOG: toolLog,
						C8CTL_DATA_DIR: join(home, "data"),
						C8CTL_OUTPUT_MODE: "text",
						...env,
					},
				},
				"modeler",
				"install",
				...args,
			);
		},
		cleanup(): void {
			rmSync(home, { recursive: true, force: true });
		},
	};
}

/** Fake `ditto` and `codesign`; FAIL_AT=extract|verify makes that step fail. */
function fakeReleaseTools(sandbox: ReturnType<typeof createSandbox>): void {
	sandbox.fakeTool(
		"ditto",
		[
			'app="$4/Camunda Modeler.app"',
			'/bin/mkdir -p "$app/Contents"',
			'if [ "$FAIL_AT" = extract ]; then exit 1; fi',
			`printf 'CFBundleDocumentTypes bpmn' > "$app/Contents/Info.plist"`,
		].join("\n"),
	);
	sandbox.fakeTool("codesign", 'if [ "$FAIL_AT" = verify ]; then exit 3; fi');
}

/** Points %LOCALAPPDATA% and %APPDATA% into a temp dir with faked Windows tools. */
function createWindowsSandbox() {
	const home = mkdtempSync(join(tmpdir(), "c8ctl-modeler-test-"));
	const localAppData = join(home, "AppData", "Local");
	const appData = join(home, "AppData", "Roaming");
	const startMenu = join(appData, "Microsoft", "Windows", "Start Menu");
	const toolLog = join(home, "tools.log");
	const preload = join(home, "preload.mjs");
	mkdirSync(join(startMenu, "Programs"), { recursive: true });
	writeFileSync(preload, WINDOWS_PRELOAD);

	return {
		installDir: join(localAppData, "Programs", "Camunda Modeler"),
		shortcut: join(startMenu, "Programs", "Camunda Modeler.lnk"),
		toolCalls: (): string[] => readToolLog(toolLog),
		resetToolCalls: (): void => rmSync(toolLog, { force: true }),
		install: (env: Record<string, string> = {}, ...args: string[]) =>
			c8WithOptions(
				{
					nodeArgs: ["--import", pathToFileURL(preload).href],
					env: {
						LOCALAPPDATA: localAppData,
						APPDATA: appData,
						TOOL_LOG: toolLog,
						C8CTL_DATA_DIR: join(home, "data"),
						C8CTL_OUTPUT_MODE: "text",
						...env,
					},
				},
				"modeler",
				"install",
				...args,
			),
		cleanup: (): void => rmSync(home, { recursive: true, force: true }),
	};
}

/** Maps /usr/bin into a temp dir, and builds a 5.52.0 release archive of stub files. */
function createLinuxSandbox() {
	const home = mkdtempSync(join(tmpdir(), "c8ctl-modeler-test-"));
	const binDir = join(home, "bin");
	const usrBin = join(home, "usr-bin");
	const release = join(home, "release", "camunda-modeler-5.52.0-linux-x64");
	const archive = join(home, "release.tar.gz");
	const toolLog = join(home, "tools.log");
	const preload = join(home, "preload.mjs");
	mkdirSync(binDir);
	mkdirSync(usrBin);
	mkdirSync(join(release, "support"), { recursive: true });
	// The isolated PATH exposes system tools; this symlink supplies Node.
	symlinkSync(process.execPath, join(binDir, "node"));
	for (const file of [
		"camunda-modeler",
		"chrome-sandbox",
		"support/xdg_register.sh",
	]) {
		const script =
			file === "support/xdg_register.sh" ? "#!/bin/bash\n" : "#!/bin/sh\n";
		writeFileSync(join(release, file), script, { mode: 0o755 });
	}
	execFileSync("tar", [
		"-czf",
		archive,
		"-C",
		dirname(release),
		basename(release),
	]);
	writeFileSync(preload, LINUX_PRELOAD);

	const runInstall = ({
		cwd,
		env = {},
		args,
	}: {
		cwd?: string;
		env?: Record<string, string | undefined>;
		args: string[];
	}) =>
		c8WithOptions(
			{
				nodeArgs: ["--import", preload],
				env: {
					PATH: [binDir, "/usr/bin", "/bin"].join(delimiter),
					USR_BIN_ROOT: usrBin,
					TOOL_LOG: toolLog,
					ARCHIVE: archive,
					FAKE_UID: "1000",
					FAKE_ARCH: "x64",
					C8CTL_DATA_DIR: join(home, "data"),
					C8CTL_OUTPUT_MODE: "text",
					...env,
				},
				...(cwd === undefined ? {} : { cwd }),
			},
			"modeler",
			"install",
			...args,
		);

	return {
		home,
		binDir,
		usrBin,
		/** Put a stub command on PATH. */
		fakeTool: (name: string): void =>
			writeFileSync(join(binDir, name), "#!/bin/sh\n", { mode: 0o755 }),
		toolCalls: (): string[] => readToolLog(toolLog),
		resetToolCalls: (): void => rmSync(toolLog, { force: true }),
		install: (env: Record<string, string> = {}, ...args: string[]) =>
			runInstall({ env, args }),
		installFrom: (
			cwd: string,
			env: Record<string, string | undefined> = {},
			...args: string[]
		) => runInstall({ cwd, env, args }),
		cleanup: (): void => rmSync(home, { recursive: true, force: true }),
	};
}

describe("Modeler installer helpers", () => {
	test("selects the latest stable release and architecture-specific archive", () => {
		const index = [
			'<a href="5.9.0/">5.9.0/</a>',
			'<a href="5.52.0/">5.52.0/</a>',
			'<a href="5.53.0-rc.1/">5.53.0-rc.1/</a>',
			'<a href="nightly/">nightly/</a>',
		].join("\n");

		assert.strictEqual(latestStableModelerVersion(index), "5.52.0");
		assert.strictEqual(
			modelerMacArchiveName("5.52.0", "arm64"),
			"camunda-modeler-5.52.0-mac-arm64.zip",
		);
		assert.strictEqual(
			modelerMacArchiveName("5.52.0", "x64"),
			"camunda-modeler-5.52.0-mac-x64.zip",
		);
		assert.throws(
			() => modelerMacArchiveName("5.52.0", "ia32"),
			/Unsupported macOS architecture/,
		);
	});

	test("renders download progress that never wraps the terminal line", () => {
		for (const columns of [40, 60, 80, 120]) {
			const frame = renderDownloadProgress({
				received: 64 * MB,
				total: 148 * MB,
				elapsedMs: 4_000,
				columns,
				color: false,
			});
			assert.ok(frame.length < columns, `${columns} columns: "${frame}"`);
			if (columns >= 60) {
				assert.ok(
					frame.endsWith(" 43%  64.0/148.0 MB  16.0 MB/s  eta 0:06"),
					frame,
				);
			}
		}
		assert.strictEqual(
			renderDownloadProgress({
				received: 148 * MB,
				total: 148 * MB,
				elapsedMs: 2_000,
				columns: 80,
				color: false,
			}),
			`${"█".repeat(34)} 100%  148.0/148.0 MB  74.0 MB/s`,
		);
		// Too early for a meaningful rate: no speed or ETA, same bar width.
		assert.match(
			renderDownloadProgress({
				received: MB,
				total: 148 * MB,
				elapsedMs: 50,
				columns: 80,
				color: false,
			}),
			/^░{34} {3}0% {2}1\.0\/148\.0 MB$/,
		);
		assert.match(
			renderDownloadProgress({
				received: 2 * MB,
				total: 0,
				elapsedMs: 1_000,
				columns: 80,
				color: false,
			}),
			/^\S 2\.0 MB {2}2\.0 MB\/s$/,
		);
	});
});

describe("CLI behavioural: modeler install", () => {
	test("shows install help without a force option", async () => {
		const result = await c8WithOptions(
			{ env: { C8CTL_OUTPUT_MODE: "text" } },
			"modeler",
			"install",
			"--help",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(result.stdout.includes("c8ctl modeler install"));
		assert.ok(result.stdout.includes("Camunda Desktop Modeler"));
		assert.ok(!result.stdout.includes("--force"));
	});

	test("prints manual download instructions on unsupported platforms", async () => {
		const result = await c8WithOptions(
			{
				// Loading node:os first keeps the host's temp and home directories.
				nodeArgs: [
					"--import",
					'data:text/javascript,import "node:os"; Object.defineProperty(process, "platform", { value: "freebsd" });',
				],
			},
			"modeler",
			"install",
		);

		assert.strictEqual(result.status, 1);
		assert.ok(
			(result.stdout + result.stderr).includes(
				"currently supports macOS, Windows, and Linux only",
			),
		);
		assert.ok(
			(result.stdout + result.stderr).includes(
				"Download Modeler manually from",
			),
		);
	});

	test("skips an existing installation", { skip: !isMac }, async () => {
		const sandbox = createSandbox();
		try {
			mkdirSync(join(sandbox.home, "Applications", MODELER_BUNDLE), {
				recursive: true,
			});

			const result = await sandbox.install();

			assert.strictEqual(result.status, 0, result.stderr);
			assert.match(result.stdout, /already installed at .*; skipping/);
			assert.deepStrictEqual(sandbox.toolCalls(), []);
		} finally {
			sandbox.cleanup();
		}
	});

	test("installs with Homebrew when available and registers the app", {
		skip: !isMac,
	}, async () => {
		const sandbox = createSandbox();
		sandbox.fakeTool(
			"brew",
			[
				'case "$1" in',
				"  --version) exit 0 ;;",
				'  list) exit "$BREW_INSTALLED" ;;',
				'  install) /bin/mkdir -p "$APPLICATIONS_ROOT/Camunda Modeler.app" ;;',
				"  *) exit 1 ;;",
				"esac",
			].join("\n"),
		);
		const brewChecks = [
			"brew --version",
			"brew list --cask --versions camunda-modeler",
		];
		try {
			const dryRun = await sandbox.install(
				{ BREW_INSTALLED: "1" },
				"--dry-run",
			);
			assert.strictEqual(dryRun.status, 0, dryRun.stderr);
			assert.match(dryRun.stdout, /would install .*brew install --cask/);
			assert.deepStrictEqual(sandbox.toolCalls(), brewChecks);

			sandbox.resetToolCalls();
			const installed = await sandbox.install({ BREW_INSTALLED: "1" });
			assert.strictEqual(installed.status, 0, installed.stderr);
			assert.match(installed.stdout, /Installed Camunda Modeler with Homebrew/);
			assert.deepStrictEqual(sandbox.toolCalls(), [
				...brewChecks,
				"brew install --cask camunda-modeler",
				"lsregister -f /Applications/Camunda Modeler.app",
			]);

			// A cask installed outside the default app folders is found via Homebrew.
			rmSync(join(sandbox.applicationsRoot, MODELER_BUNDLE), {
				recursive: true,
			});
			sandbox.resetToolCalls();
			const alreadyInstalled = await sandbox.install({ BREW_INSTALLED: "0" });
			assert.strictEqual(alreadyInstalled.status, 0, alreadyInstalled.stderr);
			assert.match(alreadyInstalled.stdout, /already installed with Homebrew/);
			assert.deepStrictEqual(sandbox.toolCalls(), brewChecks);
		} finally {
			sandbox.cleanup();
		}
	});

	test("installs the Camunda-signed release into /Applications without Homebrew", {
		skip: !isMac,
	}, async () => {
		const sandbox = createSandbox();
		fakeReleaseTools(sandbox);
		try {
			const dryRun = await sandbox.install({}, "--dry-run");
			assert.strictEqual(dryRun.status, 0, dryRun.stderr);
			assert.match(
				dryRun.stdout,
				/would download .* to \/Applications\/Camunda Modeler\.app/,
			);
			assert.deepStrictEqual(sandbox.toolCalls(), []);

			const failures = {
				extract: /Could not extract Camunda Modeler/,
				verify: /not signed by Camunda/,
			};
			for (const [failAt, message] of Object.entries(failures)) {
				const failed = await sandbox.install({ FAIL_AT: failAt });
				assert.strictEqual(failed.status, 1, `${failAt}: ${failed.stdout}`);
				assert.match(failed.stdout + failed.stderr, message);
				// Nothing is published or left behind, so a retry starts clean.
				assert.deepStrictEqual(readdirSync(sandbox.applicationsRoot), []);
			}

			sandbox.resetToolCalls();
			const result = await sandbox.install();
			assert.strictEqual(result.status, 0, result.stderr);
			assert.match(
				result.stdout,
				/Installed Camunda Modeler 5\.52\.0 to \/Applications\/Camunda Modeler\.app/,
			);
			assert.deepStrictEqual(readdirSync(sandbox.applicationsRoot), [
				MODELER_BUNDLE,
			]);
			const [extract, verify, register] = sandbox.toolCalls();
			assert.match(
				extract,
				/^ditto -x -k \S+\/camunda-modeler-5\.52\.0-mac-(arm64|x64)\.zip /,
			);
			assert.match(
				verify,
				/^codesign --verify --deep --strict -R=.*leaf\[subject\.OU\] = "3JVGD57JQZ"/,
			);
			assert.strictEqual(
				register,
				"lsregister -f /Applications/Camunda Modeler.app",
			);

			const frames = result.stderr
				.split("\r\u001b[2K")
				.slice(1)
				.map((frame) => frame.trimEnd());
			assert.match(frames.at(-1) ?? "", / 100% /, result.stderr);
			for (const frame of frames) {
				assert.ok(frame.length < PROGRESS_COLUMNS, `wraps: "${frame}"`);
			}
		} finally {
			sandbox.cleanup();
		}
	});

	test("installs to ~/Applications when /Applications is not writable", {
		skip: !isMac,
	}, async () => {
		const sandbox = createSandbox();
		fakeReleaseTools(sandbox);
		try {
			const result = await sandbox.install({ APPLICATIONS_READONLY: "1" });

			const userApp = join(sandbox.home, "Applications", MODELER_BUNDLE);
			assert.strictEqual(result.status, 0, result.stderr);
			assert.match(result.stdout, /\/Applications is not writable/);
			assert.ok(existsSync(join(userApp, "Contents", "Info.plist")));
			assert.deepStrictEqual(readdirSync(sandbox.applicationsRoot), []);
			assert.strictEqual(
				sandbox.toolCalls().at(-1),
				`lsregister -f ${userApp}`,
			);
		} finally {
			sandbox.cleanup();
		}
	});

	test("skips an existing Windows installation", {
		skip: !isWindows,
	}, async () => {
		const sandbox = createWindowsSandbox();
		try {
			mkdirSync(sandbox.installDir, { recursive: true });
			writeFileSync(join(sandbox.installDir, MODELER_EXECUTABLE), "");

			const result = await sandbox.install();

			assert.strictEqual(result.status, 0, result.stderr);
			assert.match(result.stdout, /already installed at .*; skipping/);
			assert.deepStrictEqual(sandbox.toolCalls(), []);
		} finally {
			sandbox.cleanup();
		}
	});

	test("installs with winget, then registers file types and a Start Menu shortcut", {
		skip: !isWindows,
	}, async () => {
		const sandbox = createWindowsSandbox();
		const executable = join(sandbox.installDir, MODELER_EXECUTABLE);
		const wingetChecks = [
			"winget --version",
			"winget list --id Camunda.Modeler --exact --source winget",
		];
		try {
			const dryRun = await sandbox.install({}, "--dry-run");
			assert.strictEqual(dryRun.status, 0, dryRun.stderr);
			assert.match(dryRun.stdout, /would install .* with `winget install/);
			assert.deepStrictEqual(sandbox.toolCalls(), wingetChecks);

			sandbox.resetToolCalls();
			const installed = await sandbox.install();
			assert.strictEqual(installed.status, 0, installed.stderr);
			assert.ok(
				installed.stdout.includes(
					`Installed Camunda Modeler with winget to ${sandbox.installDir}`,
				),
				installed.stdout,
			);
			const calls = sandbox.toolCalls();
			assert.deepStrictEqual(calls.slice(0, 3), [
				...wingetChecks,
				`winget install --id Camunda.Modeler --exact --source winget --scope user --location ${sandbox.installDir}`,
			]);
			for (const type of ["bpmn", "dmn", "form", "rpa"]) {
				const progId = `CamundaModeler.${type.toUpperCase()}`;
				for (const [key, value] of [
					[`.${type}`, progId],
					[`${progId}\\shell\\open\\command`, `"${executable}" "%1"`],
				]) {
					const call = `reg add HKCU\\Software\\Classes\\${key} /ve /d ${value} /f`;
					assert.ok(calls.includes(call), `missing: ${call}`);
				}
			}
			assert.strictEqual(readFileSync(sandbox.shortcut, "utf-8"), executable);

			// A package installed with winget elsewhere is found via winget.
			rmSync(sandbox.installDir, { recursive: true });
			sandbox.resetToolCalls();
			const alreadyInstalled = await sandbox.install({ WINGET: "installed" });
			assert.strictEqual(alreadyInstalled.status, 0, alreadyInstalled.stderr);
			assert.match(alreadyInstalled.stdout, /already installed with winget/);
			assert.deepStrictEqual(sandbox.toolCalls(), wingetChecks);
		} finally {
			sandbox.cleanup();
		}
	});

	test("prints manual download instructions when winget is missing or fails", {
		skip: !isWindows,
	}, async () => {
		const sandbox = createWindowsSandbox();
		const failures = {
			missing: /winget is not available/,
			failing:
				/winget could not install Camunda Modeler \(exit code 0x8A150010\)/,
		};
		try {
			for (const [winget, message] of Object.entries(failures)) {
				const result = await sandbox.install({ WINGET: winget });
				const output = result.stdout + result.stderr;
				assert.strictEqual(result.status, 1, `${winget}: ${output}`);
				assert.match(output, message);
				assert.match(output, /Download manually from /);
				assert.ok(!existsSync(sandbox.shortcut));
			}
		} finally {
			sandbox.cleanup();
		}
	});

	test("skips only an executable Modeler on PATH on Linux", {
		skip: !isLinux,
	}, async () => {
		const sandbox = createLinuxSandbox();
		const onPath = join(sandbox.binDir, "camunda-modeler");
		try {
			// Neither a directory nor a non-executable file can run Modeler.
			for (const create of [
				() => mkdirSync(onPath),
				() => writeFileSync(onPath, "", { mode: 0o644 }),
			]) {
				create();
				const dryRun = await sandbox.install({}, "--dry-run");
				assert.match(dryRun.stdout, /Dry run: would download/, dryRun.stderr);
				rmSync(onPath, { recursive: true });
			}
			sandbox.fakeTool("camunda-modeler");

			const result = await sandbox.install();

			assert.strictEqual(result.status, 0, result.stderr);
			assert.match(
				result.stdout,
				/already installed at \S+\/bin\/camunda-modeler; skipping/,
			);
			assert.deepStrictEqual(sandbox.toolCalls(), []);
		} finally {
			sandbox.cleanup();
		}
	});

	test("finds Modeler in empty PATH components on Linux", {
		skip: !isLinux,
	}, async () => {
		const sandbox = createLinuxSandbox();
		const modeler = join(sandbox.home, "camunda-modeler");
		writeFileSync(modeler, "#!/bin/sh\n", { mode: 0o755 });
		const paths = [
			["", sandbox.binDir],
			[sandbox.binDir, ""],
			[sandbox.binDir, "", sandbox.binDir],
		];
		try {
			for (const entries of paths) {
				const result = await sandbox.installFrom(
					sandbox.home,
					{ PATH: entries.join(delimiter) },
					"--dry-run",
				);
				assert.strictEqual(result.status, 0, result.stderr);
				assert.match(
					result.stdout,
					/already installed at camunda-modeler; skipping/,
					result.stdout,
				);
				assert.deepStrictEqual(sandbox.toolCalls(), []);
			}
		} finally {
			sandbox.cleanup();
		}
	});

	test("does not search the current directory when PATH is unset on Linux", {
		skip: !isLinux,
	}, async () => {
		const sandbox = createLinuxSandbox();
		writeFileSync(join(sandbox.home, "camunda-modeler"), "#!/bin/sh\n", {
			mode: 0o755,
		});
		try {
			const result = await sandbox.installFrom(
				sandbox.home,
				{ UNSET_PATH: "1" },
				"--dry-run",
			);
			assert.strictEqual(result.status, 0, result.stderr);
			assert.match(result.stdout, /Dry run: would download/);
			assert.deepStrictEqual(sandbox.toolCalls(), []);
		} finally {
			sandbox.cleanup();
		}
	});

	test("finds xdg-utils in an empty PATH component on Linux", {
		skip: !isLinux,
	}, async () => {
		const sandbox = createLinuxSandbox();
		writeFileSync(join(sandbox.home, "xdg-mime"), "#!/bin/sh\n", {
			mode: 0o755,
		});
		try {
			const result = await sandbox.installFrom(sandbox.home, {
				PATH: ["", sandbox.binDir, "/usr/bin", "/bin"].join(delimiter),
			});
			const output = result.stdout + result.stderr;
			assert.strictEqual(result.status, 0, output);
			assert.ok(!output.includes("xdg-utils is not installed"), output);
			assert.ok(
				sandbox
					.toolCalls()
					.includes(
						"/bin/bash /usr/bin/camunda-modeler-5.52.0-linux-x64/support/xdg_register.sh",
					),
				sandbox.toolCalls().join("\n"),
			);
		} finally {
			sandbox.cleanup();
		}
	});

	test("installs the release into /usr/bin with sudo as documented, then registers file types", {
		skip: !isLinux,
	}, async () => {
		const sandbox = createLinuxSandbox();
		const releaseDir = "/usr/bin/camunda-modeler-5.52.0-linux-x64";
		sandbox.fakeTool("xdg-mime");
		try {
			const dryRun = await sandbox.install({}, "--dry-run");
			assert.strictEqual(dryRun.status, 0, dryRun.stderr);
			assert.match(dryRun.stdout, /would download .* to \/usr\/bin as root/);
			assert.deepStrictEqual(sandbox.toolCalls(), []);

			const result = await sandbox.install();
			assert.strictEqual(result.status, 0, result.stderr);
			assert.ok(
				result.stdout.includes(
					`Installed Camunda Modeler 5.52.0 to ${releaseDir}.`,
				),
				result.stdout,
			);
			const [authenticate, removeLauncher, extract, ...rest] =
				sandbox.toolCalls();
			assert.strictEqual(authenticate, "sudo true");
			assert.strictEqual(removeLauncher, "sudo rm -f /usr/bin/camunda-modeler");
			assert.match(
				extract,
				/^sudo tar --no-same-owner -xzf \S+\/camunda-modeler-5\.52\.0-linux-x64\.tar\.gz -C \/usr\/bin$/,
			);
			assert.deepStrictEqual(rest, [
				`sudo chmod 4755 ${releaseDir}/chrome-sandbox`,
				"sudo ln -sfn camunda-modeler-5.52.0-linux-x64/camunda-modeler /usr/bin/camunda-modeler",
				`/bin/bash ${releaseDir}/support/xdg_register.sh`,
			]);
			const installed = join(sandbox.usrBin, basename(releaseDir));
			assert.strictEqual(
				statSync(join(installed, "chrome-sandbox")).mode & 0o7777,
				0o4755,
			);
			assert.strictEqual(
				readlinkSync(join(sandbox.usrBin, "camunda-modeler")),
				"camunda-modeler-5.52.0-linux-x64/camunda-modeler",
			);

			// The launcher link is on PATH now, so a second run skips.
			sandbox.resetToolCalls();
			const again = await sandbox.install();
			assert.strictEqual(again.status, 0, again.stderr);
			assert.match(
				again.stdout,
				/already installed at \/usr\/bin\/camunda-modeler; skipping/,
			);
			assert.deepStrictEqual(sandbox.toolCalls(), []);
		} finally {
			sandbox.cleanup();
		}
	});

	test("installs as root without sudo, and explains how to register file types without xdg-utils", {
		skip: !isLinux,
	}, async () => {
		const sandbox = createLinuxSandbox();
		try {
			const result = await sandbox.install({ FAKE_UID: "0" });

			const output = result.stdout + result.stderr;
			assert.strictEqual(result.status, 0, output);
			const calls = sandbox.toolCalls();
			assert.deepStrictEqual(
				calls.map((call) => call.split(" ")[0]),
				["true", "rm", "tar", "chmod", "ln"],
			);
			assert.ok(
				output.includes(
					"xdg-utils is not installed. Install xdg-utils, then run /usr/bin/camunda-modeler-5.52.0-linux-x64/support/xdg_register.sh.",
				),
				output,
			);
		} finally {
			sandbox.cleanup();
		}
	});

	test("prints manual download instructions for other architectures or without sudo", {
		skip: !isLinux,
	}, async () => {
		const sandbox = createLinuxSandbox();
		const failures: Array<[Record<string, string>, RegExp, string[]]> = [
			[{ FAKE_ARCH: "arm64" }, /Unsupported Linux architecture "arm64"/, []],
			[
				{ FAIL_AT: "true" },
				/Could not get root privileges \(exit code 1\)/,
				["sudo true"],
			],
		];
		try {
			for (const [env, message, calls] of failures) {
				sandbox.resetToolCalls();
				const result = await sandbox.install(env);
				const output = result.stdout + result.stderr;
				assert.strictEqual(result.status, 1, output);
				assert.match(output, message);
				assert.match(output, /Download manually from /);
				assert.deepStrictEqual(sandbox.toolCalls(), calls);
				assert.deepStrictEqual(readdirSync(sandbox.usrBin), []);
			}
		} finally {
			sandbox.cleanup();
		}
	});

	test("removes a stale launcher first, so an unfinished install is retried", {
		skip: !isLinux,
	}, async () => {
		const sandbox = createLinuxSandbox();
		const launcher = join(sandbox.usrBin, "camunda-modeler");
		try {
			// Extraction would make this dangling link valid.
			symlinkSync("camunda-modeler-5.52.0-linux-x64/camunda-modeler", launcher);

			const failed = await sandbox.install({ FAIL_AT: "chmod" });

			const output = failed.stdout + failed.stderr;
			assert.strictEqual(failed.status, 1, output);
			assert.match(output, /Could not set up the Camunda Modeler sandbox/);
			assert.ok(!readdirSync(sandbox.usrBin).includes("camunda-modeler"));
			const retry = await sandbox.install({}, "--dry-run");
			assert.match(retry.stdout, /Dry run: would download/, retry.stderr);
		} finally {
			sandbox.cleanup();
		}
	});
});
