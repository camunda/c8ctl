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
	realpathSync,
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
	isNewerModelerVersion,
	latestStableModelerVersion,
	modelerMacArchiveName,
	renderDownloadProgress,
} from "../../default-plugins/modeler/helpers.ts";
import { c8WithOptions, parseJson } from "../utils/cli.ts";
import { pollUntilValue } from "../utils/polling.ts";

const MODELER_BUNDLE = "Camunda Modeler.app";
const MODELER_EXECUTABLE = "Camunda Modeler.exe";
const MB = 1_048_576;
const PROGRESS_COLUMNS = 60;
const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";
const isLinux = process.platform === "linux";

const STALLED_RELEASE_INDEX = `
		if (process.env.STALL_RELEASE_INDEX === "1") {
			return new Response(new ReadableStream({
				start(controller) {
					const keepAlive = setInterval(() => {}, 1000);
					const stop = () => {
						clearInterval(keepAlive);
						controller.error(new Error("Stalled release-index fixture stopped"));
					};
					init.signal.addEventListener("abort", stop, { once: true });
					// Observe cancellation after the installer handler, then release even a broken request.
					for (const signal of ["SIGINT", "SIGTERM"]) {
						process.once(signal, () => {
							fs.writeFileSync(process.env.INDEX_ABORT_FILE, String(init.signal.aborted));
							if (!init.signal.aborted) stop();
						});
					}
					fs.writeFileSync(process.env.DOWNLOAD_PID_FILE + ".tmp", String(process.pid));
					fs.renameSync(process.env.DOWNLOAD_PID_FILE + ".tmp", process.env.DOWNLOAD_PID_FILE);
				},
			}));
		}
`;

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
const {
	accessSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
} = fs;
fs.existsSync = (path) => existsSync(remap(path));
fs.mkdtempSync = (prefix, options) => mkdtempSync(remap(prefix), options);
fs.readFileSync = (path, ...args) => readFileSync(remap(path), ...args);
fs.realpathSync = (path, ...args) => realpathSync(remap(path), ...args);
fs.renameSync = (from, to) => renameSync(remap(from), remap(to));
fs.rmSync = (path, options) => rmSync(remap(path), options);
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
const releaseVersion = process.env.MODELER_RELEASE_VERSION || "5.52.0";
globalThis.fetch = async (input, init) => {
	const url = String(input);
	if (url === releaseUrl) {
${STALLED_RELEASE_INDEX}
		return new Response('<a href="' + releaseVersion + '/">' + releaseVersion + '/</a><a href="nightly/">nightly/</a>');
	}
	if (url.startsWith(releaseUrl + releaseVersion + "/")) {
		if (process.env.STALL_DOWNLOAD === "1") {
			fs.writeFileSync(process.env.DOWNLOAD_PID_FILE, String(process.pid));
			return new Response(new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("partial archive"));
				},
			}));
		}
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
		if (args.includes("--upgrade-available")) {
			const upgradeAvailable =
				winget === "installed" && process.env.WINGET_UPGRADE === "available";
			return {
				status: upgradeAvailable || winget === "installed" ? 0 : 0x8a150014,
				stdout: upgradeAvailable
					? "Camunda Modeler Camunda.Modeler 5.51.0 5.52.0\\n"
					: "",
			};
		}
		return { status: winget === "installed" ? 0 : 0x8a150014 };
	}
	if (command === "winget" && args[0] === "upgrade") {
		return { status: 0 };
	}
	if (command === "winget" && args[0] === "uninstall") {
		fs.rmSync(
			join(process.env.LOCALAPPDATA, "Programs", "Camunda Modeler"),
			{ recursive: true, force: true },
		);
		return { status: 0 };
	}
	if (command === "winget" && args[0] === "install") {
		const chatter = process.env.TOOL_CHATTER === "1";
		const stdout = chatter ? "winget routine stdout\\n" : "";
		const stderr = chatter ? "winget routine stderr\\n" : "";
		if (stdout && options.stdio[1] !== "pipe") process.stderr.write(stdout);
		if (stderr && options.stdio[2] !== "pipe") process.stderr.write(stderr);
		if (winget === "failing") return { status: 0x8a150010, stdout, stderr };
		const location = args[args.indexOf("--location") + 1];
		fs.mkdirSync(location, { recursive: true });
		fs.writeFileSync(join(location, "Camunda Modeler.exe"), "");
		return { status: 0, stdout, stderr };
	}
	if (command === "powershell") {
		const script = String(args[args.length - 1] ?? "");
		if (script.includes("Remove-Item")) {
			fs.rmSync(options.env.C8CTL_SHORTCUT, { force: true });
		} else if (script.includes("CreateShortcut")) {
			fs.writeFileSync(options.env.C8CTL_SHORTCUT, options.env.C8CTL_TARGET);
		}
	}
	return { status: 0 };
};
Object.defineProperty(process, "platform", { value: "win32" });
syncBuiltinESMExports();
`;

/**
 * Loaded into the CLI subprocess on Linux: maps /usr/bin and /bin filesystem
 * lookups into temp roots, runs root commands without sudo and records them in
 * TOOL_LOG (FAIL_AT=<tool> makes that tool fail), fakes the user id and
 * architecture, and serves ARCHIVE as the 5.52.0 release.
 */
const LINUX_PRELOAD = `
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const remapUsrBin = (path) =>
	String(path) === "/usr/bin" || String(path).startsWith("/usr/bin/")
		? process.env.USR_BIN_ROOT + String(path).slice("/usr/bin".length)
		: path;
const remapFilesystemPath = (path) =>
	String(path) === "/bin" || String(path).startsWith("/bin/")
		? process.env.BIN_ROOT + String(path).slice("/bin".length)
		: remapUsrBin(path);
const { accessSync, existsSync, readlinkSync, statSync } = fs;
fs.accessSync = (path, mode) => accessSync(remapFilesystemPath(path), mode);
fs.existsSync = (path) => existsSync(remapFilesystemPath(path));
fs.readlinkSync = (path, ...args) =>
	readlinkSync(remapFilesystemPath(path), ...args);
fs.statSync = (path, options) => statSync(remapFilesystemPath(path), options);
const { spawnSync } = childProcess;
childProcess.spawnSync = (command, args, options) => {
	const desktopRegistration =
		command === "/bin/bash" && String(args[0]).startsWith("/usr/bin/");
	if (
		!["sudo", "true", "rm", "tar", "chmod", "ln", "mv"].includes(command) &&
		!command.startsWith("/usr/bin/") &&
		!desktopRegistration
	) {
		return spawnSync(command, args, options);
	}
	fs.appendFileSync(process.env.TOOL_LOG, [command, ...args].join(" ") + "\\n");
	const [real, ...rest] = (command === "sudo" ? args : [command, ...args]).map(
		remapUsrBin,
	);
	if (process.env.TOOL_CHATTER === "1" && !desktopRegistration && options.stdio[1] !== "pipe") {
		process.stderr.write("root tool chatter\\n");
	}
	return real === process.env.FAIL_AT ? { status: 1 } : spawnSync(real, rest, options);
};
syncBuiltinESMExports();

Object.defineProperty(process, "platform", { value: "linux" });
process.getuid = () => Number(process.env.FAKE_UID);
Object.defineProperty(process, "arch", { value: process.env.FAKE_ARCH });
if (process.env.UNSET_PATH === "1") delete process.env.PATH;
const releaseUrl = "https://downloads.camunda.cloud/release/camunda-modeler/";
const releaseVersion = process.env.MODELER_RELEASE_VERSION || "5.52.0";
globalThis.fetch = async (input, init) => {
	const url = String(input);
	if (url === releaseUrl) {
${STALLED_RELEASE_INDEX}
		return new Response('<a href="' + releaseVersion + '/">' + releaseVersion + '/</a>');
	}
	return url === releaseUrl + releaseVersion + "/camunda-modeler-" + releaseVersion + "-linux-x64.tar.gz"
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

	const runModeler = (
		action: string,
		env: Record<string, string> = {},
		...args: string[]
	) =>
		c8WithOptions(
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
			action,
			...args,
		);

	return {
		home,
		applicationsRoot,
		/** Put a fake command on PATH that records its arguments, then runs `body`. */
		fakeTool(name: string, body: string): void {
			const path = join(binDir, name);
			writeFileSync(
				path,
				`#!/bin/sh
printf '${name} %s\\n' "$*" >> "$TOOL_LOG"
if [ "$TOOL_CHATTER" = "1" ]; then
  printf '${name} routine stdout\\n'
  printf '${name} routine stderr\\n' >&2
fi
${body}
`,
			);
			chmodSync(path, 0o755);
		},
		toolCalls(): string[] {
			return readToolLog(toolLog);
		},
		resetToolCalls(): void {
			rmSync(toolLog, { force: true });
		},
		install: (env: Record<string, string> = {}, ...args: string[]) =>
			runModeler("install", env, ...args),
		update: (env: Record<string, string> = {}, ...args: string[]) =>
			runModeler("update", env, ...args),
		remove: (env: Record<string, string> = {}, ...args: string[]) =>
			runModeler("remove", env, ...args),
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
			`printf 'CFBundleDocumentTypes bpmn\\n<plist><dict><key>CFBundleShortVersionString</key><string>%s</string></dict></plist>' "\${MODEL_VERSION:-5.52.0}" > "$app/Contents/Info.plist"`,
		].join("\n"),
	);
	sandbox.fakeTool("codesign", 'if [ "$FAIL_AT" = verify ]; then exit 3; fi');
}

function writeMacApp(appPath: string, version: string): void {
	mkdirSync(join(appPath, "Contents"), { recursive: true });
	writeFileSync(
		join(appPath, "Contents", "Info.plist"),
		`<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
	);
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

	const runModeler = (
		action: string,
		env: Record<string, string> = {},
		...args: string[]
	) =>
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
			action,
			...args,
		);

	return {
		installDir: join(localAppData, "Programs", "Camunda Modeler"),
		shortcut: join(startMenu, "Programs", "Camunda Modeler.lnk"),
		toolCalls: (): string[] => readToolLog(toolLog),
		resetToolCalls: (): void => rmSync(toolLog, { force: true }),
		install: (env: Record<string, string> = {}, ...args: string[]) =>
			runModeler("install", env, ...args),
		update: (env: Record<string, string> = {}, ...args: string[]) =>
			runModeler("update", env, ...args),
		remove: (env: Record<string, string> = {}, ...args: string[]) =>
			runModeler("remove", env, ...args),
		cleanup: (): void => rmSync(home, { recursive: true, force: true }),
	};
}

/** Maps /usr/bin and /bin into temp dirs, and builds a stub 5.52.0 archive. */
function createLinuxSandbox() {
	const home = mkdtempSync(join(tmpdir(), "c8ctl-modeler-test-"));
	const binDir = join(home, "bin");
	const binRoot = join(home, "bin-root");
	const usrBin = join(home, "usr-bin");
	const release = join(home, "release", "camunda-modeler-5.52.0-linux-x64");
	const archive = join(home, "release.tar.gz");
	const toolLog = join(home, "tools.log");
	const preload = join(home, "preload.mjs");
	mkdirSync(binDir);
	mkdirSync(binRoot);
	mkdirSync(usrBin);
	mkdirSync(join(release, "support"), { recursive: true });
	symlinkSync(process.execPath, join(binDir, "node"));
	for (const command of ["chmod", "ln", "mv", "rm"]) {
		symlinkSync(`/bin/${command}`, join(binDir, command));
	}
	for (const file of [
		"camunda-modeler",
		"chrome-sandbox",
		"support/xdg_register.sh",
		"support/xdg_unregister.sh",
	]) {
		const script =
			file === "support/xdg_register.sh"
				? `#!/bin/bash
if [ "$TOOL_CHATTER" = "1" ]; then
	echo "registration routine stdout"
	echo "registration routine stderr" >&2
fi
if [ "$FAIL_AT" = "register" ]; then exit 1; fi
exit 0
`
				: file === "support/xdg_unregister.sh"
					? `#!/bin/bash
if [ "$FAIL_AT" = "unregister" ]; then exit 1; fi
exit 0
`
					: "#!/bin/sh\n";
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

	const runModeler = ({
		cwd,
		env = {},
		action,
		args,
	}: {
		cwd?: string;
		env?: Record<string, string | undefined>;
		action: string;
		args: string[];
	}) =>
		c8WithOptions(
			{
				nodeArgs: ["--import", preload],
				env: {
					PATH: [binDir, "/usr/bin", "/bin"].join(delimiter),
					BIN_ROOT: binRoot,
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
			action,
			...args,
		);

	return {
		home,
		binDir,
		binRoot,
		usrBin,
		fakeTool: (name: string): void =>
			writeFileSync(join(binDir, name), "#!/bin/sh\n", { mode: 0o755 }),
		toolCalls: (): string[] => readToolLog(toolLog),
		resetToolCalls: (): void => rmSync(toolLog, { force: true }),
		install: (env: Record<string, string> = {}, ...args: string[]) =>
			runModeler({ action: "install", env, args }),
		update: (env: Record<string, string> = {}, ...args: string[]) =>
			runModeler({ action: "update", env, args }),
		remove: (env: Record<string, string> = {}, ...args: string[]) =>
			runModeler({ action: "remove", env, args }),
		installFrom: (
			cwd: string,
			env: Record<string, string | undefined> = {},
			...args: string[]
		) => runModeler({ action: "install", cwd, env, args }),
		cleanup: (): void => rmSync(home, { recursive: true, force: true }),
	};
}

function addLinuxInstall(
	sandbox: ReturnType<typeof createLinuxSandbox>,
	version: string,
): { installDir: string; launcher: string } {
	const releaseName = `camunda-modeler-${version}-linux-x64`;
	const installDir = join(sandbox.usrBin, releaseName);
	const launcher = join(sandbox.usrBin, "camunda-modeler");
	mkdirSync(join(installDir, "support"), { recursive: true });
	for (const file of [
		"camunda-modeler",
		"chrome-sandbox",
		"support/xdg_register.sh",
		"support/xdg_unregister.sh",
	]) {
		writeFileSync(join(installDir, file), "#!/bin/sh\n", { mode: 0o755 });
	}
	symlinkSync(join(releaseName, "camunda-modeler"), launcher);
	return { installDir, launcher };
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

	test("compares stable Modeler versions without proposing a downgrade", () => {
		assert.ok(isNewerModelerVersion("5.53.0", "5.52.0"));
		assert.ok(!isNewerModelerVersion("5.52.0", "5.52.0"));
		assert.ok(!isNewerModelerVersion("5.51.0", "5.52.0"));
		assert.throws(
			() => isNewerModelerVersion("nightly", "5.52.0"),
			/Invalid Camunda Modeler version/,
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

	test("shows help for the update and remove lifecycle commands", async () => {
		for (const action of ["update", "remove"]) {
			const result = await c8WithOptions(
				{ env: { C8CTL_OUTPUT_MODE: "text" } },
				"modeler",
				action,
				"--help",
			);

			assert.strictEqual(result.status, 0, `${action}: ${result.stderr}`);
			assert.ok(result.stdout.includes(`c8ctl modeler ${action}`));
		}
	});

	test("prints manual download instructions on unsupported platforms", async () => {
		const result = await c8WithOptions(
			{
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

	test("updates Homebrew installations only when an upgrade is available", {
		skip: !isMac,
	}, async () => {
		const sandbox = createSandbox();
		sandbox.fakeTool(
			"brew",
			[
				'case "$*" in',
				'  "--version") exit 0 ;;',
				'  "list --cask --versions camunda-modeler") exit 0 ;;',
				'  "outdated --cask --quiet camunda-modeler")',
				'    if [ "$BREW_OUTDATED" = "1" ]; then printf "camunda-modeler\\n"; fi ;;',
				'  "upgrade --cask camunda-modeler") exit 0 ;;',
				"  *) exit 1 ;;",
				"esac",
			].join("\n"),
		);
		const checks = [
			"brew --version",
			"brew list --cask --versions camunda-modeler",
			"brew outdated --cask --quiet camunda-modeler",
		];

		try {
			const dryRun = await sandbox.update(
				{ BREW_OUTDATED: "1" },
				"--dry-run",
				"--json",
			);
			assert.strictEqual(dryRun.status, 0, dryRun.stderr);
			const preview = parseJson(dryRun);
			assert.strictEqual(preview.command, "modeler update");
			assert.match(String(preview.message), /brew upgrade --cask/);
			assert.deepStrictEqual(sandbox.toolCalls(), checks);

			sandbox.resetToolCalls();
			const current = await sandbox.update({ BREW_OUTDATED: "0" });
			assert.strictEqual(current.status, 0, current.stderr);
			assert.match(current.stdout, /already up to date/);
			assert.deepStrictEqual(sandbox.toolCalls(), checks);

			sandbox.resetToolCalls();
			const updated = await sandbox.update({ BREW_OUTDATED: "1" });
			assert.strictEqual(updated.status, 0, updated.stderr);
			assert.match(updated.stdout, /Updated Camunda Modeler with Homebrew/);
			assert.deepStrictEqual(sandbox.toolCalls(), [
				...checks,
				"brew upgrade --cask camunda-modeler",
			]);
		} finally {
			sandbox.cleanup();
		}
	});

	test("updates a signed direct macOS installation and leaves newer releases untouched", {
		skip: !isMac,
	}, async () => {
		const sandbox = createSandbox();
		fakeReleaseTools(sandbox);
		const appPath = join(sandbox.applicationsRoot, MODELER_BUNDLE);
		writeMacApp(appPath, "5.51.0");
		const release = {
			MODELER_RELEASE_VERSION: "5.52.0",
			MODEL_VERSION: "5.52.0",
		};

		try {
			const dryRun = await sandbox.update(release, "--dry-run", "--json");
			assert.strictEqual(dryRun.status, 0, dryRun.stderr);
			const preview = parseJson(dryRun);
			assert.strictEqual(preview.dryRun, true);
			assert.strictEqual(preview.command, "modeler update");
			assert.match(String(preview.message), /5\.51\.0.*5\.52\.0/);
			assert.ok(!sandbox.toolCalls().some((call) => call.startsWith("ditto ")));

			sandbox.resetToolCalls();
			const updated = await sandbox.update(release);
			assert.strictEqual(updated.status, 0, updated.stderr);
			assert.match(updated.stdout, /Updated Camunda Modeler to 5\.52\.0/);
			assert.match(
				readFileSync(join(appPath, "Contents", "Info.plist"), "utf8"),
				/<string>5\.52\.0<\/string>/,
			);
			assert.ok(sandbox.toolCalls().some((call) => call.startsWith("ditto ")));
			assert.ok(
				sandbox
					.toolCalls()
					.some(
						(call) =>
							call === "lsregister -f /Applications/Camunda Modeler.app",
					),
			);

			sandbox.resetToolCalls();
			const current = await sandbox.update({
				MODELER_RELEASE_VERSION: "5.51.0",
			});
			assert.strictEqual(current.status, 0, current.stderr);
			assert.match(current.stdout, /already up to date/);
			assert.ok(!sandbox.toolCalls().some((call) => call.startsWith("ditto ")));
		} finally {
			sandbox.cleanup();
		}
	});

	test("dry-runs and removes a signed direct macOS installation", {
		skip: !isMac,
	}, async () => {
		const sandbox = createSandbox();
		fakeReleaseTools(sandbox);
		const appPath = join(sandbox.applicationsRoot, MODELER_BUNDLE);
		writeMacApp(appPath, "5.52.0");

		try {
			const dryRun = await sandbox.remove({}, "--dry-run", "--json");
			assert.strictEqual(dryRun.status, 0, dryRun.stderr);
			assert.strictEqual(parseJson(dryRun).command, "modeler remove");
			assert.match(String(parseJson(dryRun).message), /would remove/);
			assert.ok(existsSync(appPath));

			sandbox.resetToolCalls();
			const removed = await sandbox.remove();
			assert.strictEqual(removed.status, 0, removed.stderr);
			assert.match(removed.stdout, /Removed Camunda Modeler/);
			assert.ok(!existsSync(appPath));
			assert.ok(
				sandbox
					.toolCalls()
					.some(
						(call) =>
							call === "lsregister -u -f /Applications/Camunda Modeler.app",
					),
			);
		} finally {
			sandbox.cleanup();
		}
	});

	test("refuses to update or remove a direct macOS app not signed by Camunda", {
		skip: !isMac,
	}, async () => {
		const sandbox = createSandbox();
		fakeReleaseTools(sandbox);
		const appPath = join(sandbox.applicationsRoot, MODELER_BUNDLE);
		writeMacApp(appPath, "5.52.0");

		try {
			for (const result of [
				await sandbox.update({ FAIL_AT: "verify" }),
				await sandbox.remove({ FAIL_AT: "verify" }),
			]) {
				assert.strictEqual(result.status, 1);
				assert.match(result.stdout + result.stderr, /not signed by Camunda/);
				assert.ok(existsSync(appPath));
			}
		} finally {
			sandbox.cleanup();
		}
	});

	test("removes Homebrew installations with brew uninstall", {
		skip: !isMac,
	}, async () => {
		const sandbox = createSandbox();
		const appPath = join(sandbox.applicationsRoot, MODELER_BUNDLE);
		mkdirSync(appPath);
		sandbox.fakeTool(
			"brew",
			[
				'case "$*" in',
				'  "--version") exit 0 ;;',
				'  "list --cask --versions camunda-modeler") exit 0 ;;',
				'  "list --cask camunda-modeler") printf "%s\\n" "$BREW_APP_PATH"; exit 0 ;;',
				'  "uninstall --cask camunda-modeler") exit 0 ;;',
				"  *) exit 1 ;;",
				"esac",
			].join("\n"),
		);

		try {
			const dryRun = await sandbox.remove({}, "--dry-run", "--json");
			assert.strictEqual(dryRun.status, 0, dryRun.stderr);
			assert.match(String(parseJson(dryRun).message), /brew uninstall --cask/);
			assert.ok(
				!sandbox
					.toolCalls()
					.some((call) => call === "brew uninstall --cask camunda-modeler"),
			);

			sandbox.resetToolCalls();
			const removed = await sandbox.remove({ BREW_APP_PATH: appPath });
			assert.strictEqual(removed.status, 0, removed.stderr);
			assert.match(removed.stdout, /Removed Camunda Modeler with Homebrew/);
			assert.deepStrictEqual(sandbox.toolCalls(), [
				"brew --version",
				"brew list --cask --versions camunda-modeler",
				"brew list --cask camunda-modeler",
				"brew uninstall --cask camunda-modeler",
				`lsregister -u -f ${realpathSync(appPath)}`,
			]);
		} finally {
			sandbox.cleanup();
		}
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

	for (const homebrew of [true, false]) {
		test(`emits a JSON dry-run preview for ${homebrew ? "Homebrew" : "direct download"}`, {
			skip: !isMac,
		}, async () => {
			const sandbox = createSandbox();
			try {
				if (homebrew) {
					sandbox.fakeTool(
						"brew",
						'if [ "$1" = --version ]; then exit 0; fi\nexit 1',
					);
				}

				const result = await sandbox.install(
					{},
					"--dry-run",
					"--json",
					"--profile=not-configured",
				);

				assert.strictEqual(result.status, 0, result.stderr);
				const preview = parseJson(result);
				assert.strictEqual(preview.dryRun, true);
				assert.strictEqual(preview.command, "modeler install");
				assert.ok(typeof preview.message === "string");
				assert.match(
					preview.message,
					homebrew ? /brew install --cask/ : /would download .*Camunda Modeler/,
				);
				assert.strictEqual(result.stderr, "");
				assert.deepStrictEqual(
					sandbox.toolCalls(),
					homebrew
						? ["brew --version", "brew list --cask --versions camunda-modeler"]
						: [],
				);
				assert.deepStrictEqual(readdirSync(sandbox.applicationsRoot), []);
			} finally {
				sandbox.cleanup();
			}
		});
	}

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

	for (const mode of ["text", "json"]) {
		test(`quiet Homebrew installs hide chatter but keep failure details in ${mode} mode`, {
			skip: !isMac,
		}, async () => {
			const sandbox = createSandbox();
			try {
				sandbox.fakeTool(
					"brew",
					[
						'case "$1" in',
						"  --version) exit 0 ;;",
						"  list) exit 1 ;;",
						"  install)",
						'    if [ "$FAIL_AT" = brew ]; then printf "brew failure detail\\n" >&2; exit 2; fi',
						'    /bin/mkdir -p "$APPLICATIONS_ROOT/Camunda Modeler.app" ;;',
						"  *) exit 1 ;;",
						"esac",
					].join("\n"),
				);
				const env = { TOOL_CHATTER: "1", C8CTL_OUTPUT_MODE: mode };
				const failed = await sandbox.install(
					{ ...env, FAIL_AT: "brew" },
					"--quiet",
				);
				assert.strictEqual(failed.status, 1, failed.stderr);
				assert.doesNotMatch(failed.stdout, /brew routine stdout/);
				assert.match(failed.stderr, /brew failure detail/);

				const result = await sandbox.install(env, "--quiet");
				assert.strictEqual(result.status, 0, result.stderr);
				assert.strictEqual(result.stdout, "");
				assert.strictEqual(result.stderr, "");
				assert.ok(existsSync(join(sandbox.applicationsRoot, MODELER_BUNDLE)));
			} finally {
				sandbox.cleanup();
			}
		});
	}

	test("registers the Homebrew bundle in a custom application directory", {
		skip: !isMac,
	}, async () => {
		const sandbox = createSandbox();
		const appDir = join(realpathSync(sandbox.home), "custom-apps");
		const appPath = join(appDir, MODELER_BUNDLE);
		const caskDir = join(sandbox.home, "Caskroom", "camunda-modeler", "5.52.0");
		try {
			mkdirSync(caskDir, { recursive: true });
			symlinkSync(appPath, join(caskDir, MODELER_BUNDLE));
			sandbox.fakeTool(
				"brew",
				[
					'case "$*" in',
					"  --version) exit 0 ;;",
					'  "list --cask --versions camunda-modeler") exit 1 ;;',
					`  "install --cask camunda-modeler") /bin/mkdir -p "${appPath}" ;;`,
					'  "list --cask camunda-modeler")',
					'    printf "%s\\n" "$HOME/Caskroom/camunda-modeler/5.52.0/INSTALL_RECEIPT.json" "$HOME/Caskroom/camunda-modeler/5.52.0/Camunda Modeler.app" ;;',
					"  *) exit 1 ;;",
					"esac",
				].join("\n"),
			);

			const result = await sandbox.install({
				HOMEBREW_CASK_OPTS: `--appdir=${appDir}`,
			});

			assert.strictEqual(result.status, 0, result.stderr);
			assert.match(result.stdout, /Installed Camunda Modeler with Homebrew/);
			assert.deepStrictEqual(readdirSync(sandbox.applicationsRoot), []);
			assert.deepStrictEqual(sandbox.toolCalls(), [
				"brew --version",
				"brew list --cask --versions camunda-modeler",
				"brew install --cask camunda-modeler",
				"brew list --cask camunda-modeler",
				`lsregister -f ${appPath}`,
			]);
		} finally {
			sandbox.cleanup();
		}
	});

	test("reports when Homebrew cannot locate the installed bundle", {
		skip: !isMac,
	}, async () => {
		for (const listing of [
			"exit 2",
			'printf "%s\\n" "$HOME/INSTALL_RECEIPT.json"',
		]) {
			const sandbox = createSandbox();
			try {
				sandbox.fakeTool(
					"brew",
					[
						'case "$*" in',
						'  --version|"install --cask camunda-modeler") exit 0 ;;',
						'  "list --cask --versions camunda-modeler") exit 1 ;;',
						`  "list --cask camunda-modeler") ${listing} ;;`,
						"  *) exit 1 ;;",
						"esac",
					].join("\n"),
				);

				const result = await sandbox.install();

				assert.strictEqual(result.status, 1, result.stdout);
				assert.match(
					result.stdout + result.stderr,
					/Could not locate the Camunda Modeler app installed by Homebrew/,
				);
				assert.doesNotMatch(result.stdout, /Installed Camunda Modeler/);
				assert.strictEqual(
					sandbox.toolCalls().at(-1),
					"brew list --cask camunda-modeler",
				);
			} finally {
				sandbox.cleanup();
			}
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

	test("emits a JSON dry-run preview for winget", {
		skip: !isWindows,
	}, async () => {
		const sandbox = createWindowsSandbox();
		try {
			const result = await sandbox.install(
				{ C8CTL_OUTPUT_MODE: "json" },
				"--dry-run",
			);
			assert.strictEqual(result.status, 0, result.stderr);
			const preview = parseJson(result);
			assert.strictEqual(preview.dryRun, true);
			assert.strictEqual(preview.command, "modeler install");
			assert.deepStrictEqual(sandbox.toolCalls(), [
				"winget --version",
				"winget list --id Camunda.Modeler --exact --source winget",
			]);
		} finally {
			sandbox.cleanup();
		}
	});

	for (const mode of ["text", "json"]) {
		test(`quiet winget installs hide chatter but keep failure details in ${mode} mode`, {
			skip: !isWindows,
		}, async () => {
			const sandbox = createWindowsSandbox();
			try {
				const env = { TOOL_CHATTER: "1", C8CTL_OUTPUT_MODE: mode };
				const failed = await sandbox.install(
					{ ...env, WINGET: "failing" },
					"--quiet",
				);
				assert.strictEqual(failed.status, 1, failed.stderr);
				assert.match(failed.stderr, /winget routine stdout/);
				assert.match(failed.stderr, /winget routine stderr/);

				const installed = await sandbox.install(env, "--quiet");
				assert.strictEqual(installed.status, 0, installed.stderr);
				assert.strictEqual(installed.stdout, "");
				assert.strictEqual(installed.stderr, "");
			} finally {
				sandbox.cleanup();
			}
		});
	}

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

	test("updates winget installations only when an upgrade is available", {
		skip: !isWindows,
	}, async () => {
		const sandbox = createWindowsSandbox();
		const checks = [
			"winget --version",
			"winget list --id Camunda.Modeler --exact --source winget",
			"winget list --upgrade-available --id Camunda.Modeler --exact --source winget",
		];

		try {
			const dryRun = await sandbox.update(
				{ WINGET: "installed", WINGET_UPGRADE: "available" },
				"--dry-run",
				"--json",
			);
			assert.strictEqual(dryRun.status, 0, dryRun.stderr);
			const preview = parseJson(dryRun);
			assert.strictEqual(preview.command, "modeler update");
			assert.match(String(preview.message), /winget upgrade/);
			assert.deepStrictEqual(sandbox.toolCalls(), checks);

			sandbox.resetToolCalls();
			const current = await sandbox.update({ WINGET: "installed" });
			assert.strictEqual(current.status, 0, current.stderr);
			assert.match(current.stdout, /already up to date/);
			assert.deepStrictEqual(sandbox.toolCalls(), checks);

			sandbox.resetToolCalls();
			const updated = await sandbox.update({
				WINGET: "installed",
				WINGET_UPGRADE: "available",
			});
			assert.strictEqual(updated.status, 0, updated.stderr);
			assert.match(updated.stdout, /Updated Camunda Modeler with winget/);
			assert.deepStrictEqual(sandbox.toolCalls(), [
				...checks,
				"winget upgrade --id Camunda.Modeler --exact --source winget",
			]);
		} finally {
			sandbox.cleanup();
		}
	});

	test("dry-runs and removes a winget installation and its registrations", {
		skip: !isWindows,
	}, async () => {
		const sandbox = createWindowsSandbox();
		const executable = join(sandbox.installDir, MODELER_EXECUTABLE);

		try {
			const installed = await sandbox.install();
			assert.strictEqual(installed.status, 0, installed.stderr);
			assert.ok(existsSync(executable));
			assert.ok(existsSync(sandbox.shortcut));

			sandbox.resetToolCalls();
			const dryRun = await sandbox.remove(
				{ WINGET: "installed" },
				"--dry-run",
				"--json",
			);
			assert.strictEqual(dryRun.status, 0, dryRun.stderr);
			assert.strictEqual(parseJson(dryRun).command, "modeler remove");
			assert.match(String(parseJson(dryRun).message), /winget uninstall/);
			assert.ok(existsSync(executable));
			assert.ok(existsSync(sandbox.shortcut));

			sandbox.resetToolCalls();
			const removed = await sandbox.remove({ WINGET: "installed" });
			assert.strictEqual(removed.status, 0, removed.stderr);
			assert.match(removed.stdout, /Removed Camunda Modeler with winget/);
			assert.ok(!existsSync(executable));
			assert.ok(!existsSync(sandbox.shortcut));
			assert.ok(
				sandbox
					.toolCalls()
					.some((call) => call.startsWith("winget uninstall ")),
			);
			assert.ok(
				sandbox.toolCalls().some((call) => call.startsWith("powershell ")),
			);
		} finally {
			sandbox.cleanup();
		}
	});

	test("refuses to manage an unregistered Windows installation", {
		skip: !isWindows,
	}, async () => {
		const sandbox = createWindowsSandbox();
		try {
			mkdirSync(sandbox.installDir, { recursive: true });
			writeFileSync(join(sandbox.installDir, MODELER_EXECUTABLE), "");

			const results = [
				await sandbox.update({ WINGET: "unregistered" }),
				await sandbox.remove({ WINGET: "unregistered" }),
			];

			for (const result of results) {
				assert.strictEqual(result.status, 1);
				assert.match(
					result.stdout + result.stderr,
					/not installed with winget/,
				);
			}
			assert.ok(existsSync(join(sandbox.installDir, MODELER_EXECUTABLE)));
			assert.ok(
				!sandbox
					.toolCalls()
					.some(
						(call) =>
							call.startsWith("winget upgrade ") ||
							call.startsWith("winget uninstall "),
					),
			);
		} finally {
			sandbox.cleanup();
		}
	});

	test("quiet TTY downloads hide progress and tool chatter but keep failure details", {
		skip: !isMac,
	}, async () => {
		const sandbox = createSandbox();
		fakeReleaseTools(sandbox);
		try {
			const env = { TOOL_CHATTER: "1" };
			const failed = await sandbox.install(
				{ ...env, FAIL_AT: "verify" },
				"--quiet",
			);
			assert.strictEqual(failed.status, 1, failed.stderr);
			assert.match(failed.stderr, /not signed by Camunda/);
			assert.match(failed.stderr, /codesign routine stdout/);
			assert.match(failed.stderr, /codesign routine stderr/);

			const result = await sandbox.install(env, "--quiet");
			assert.strictEqual(result.status, 0, result.stderr);
			assert.strictEqual(result.stdout, "");
			assert.strictEqual(result.stderr, "");
			assert.ok(
				existsSync(
					join(
						sandbox.applicationsRoot,
						MODELER_BUNDLE,
						"Contents",
						"Info.plist",
					),
				),
			);
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

	test("finds Modeler in a sandboxed /bin PATH entry on Linux", {
		skip: isWindows,
	}, async () => {
		const sandbox = createLinuxSandbox();
		const pathSuffix = basename(sandbox.home);
		const pathEntry = join("/bin", pathSuffix);
		const modeler = join(sandbox.binRoot, pathSuffix, "camunda-modeler");
		mkdirSync(dirname(modeler), { recursive: true });
		writeFileSync(modeler, "#!/bin/sh\n", { mode: 0o755 });
		try {
			const result = await sandbox.install(
				{
					PATH: [sandbox.binDir, "/usr/bin", pathEntry].join(delimiter),
				},
				"--dry-run",
			);

			assert.strictEqual(result.status, 0, result.stderr);
			assert.ok(
				result.stdout.includes(
					`already installed at ${pathEntry}/camunda-modeler; skipping`,
				),
				result.stdout,
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

	test("finds xdg-utils in a sandboxed /bin PATH entry on Linux", {
		skip: isWindows,
	}, async () => {
		const sandbox = createLinuxSandbox();
		const pathSuffix = basename(sandbox.home);
		const pathEntry = join("/bin", pathSuffix);
		const xdgMime = join(sandbox.binRoot, pathSuffix, "xdg-mime");
		mkdirSync(dirname(xdgMime), { recursive: true });
		writeFileSync(xdgMime, "#!/bin/sh\n", { mode: 0o755 });
		try {
			const result = await sandbox.install({
				PATH: [sandbox.binDir, "/usr/bin", pathEntry].join(delimiter),
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

	for (const mode of ["text", "json"]) {
		test(`quiet Linux installs hide tool chatter but keep registration failures in ${mode} mode`, {
			skip: !isLinux,
		}, async () => {
			for (const fails of [false, true]) {
				const sandbox = createLinuxSandbox();
				sandbox.fakeTool("xdg-mime");
				try {
					const result = await sandbox.install(
						{
							TOOL_CHATTER: "1",
							C8CTL_OUTPUT_MODE: mode,
							FAIL_AT: fails ? "register" : "",
						},
						"--quiet",
					);
					assert.strictEqual(result.status, 0, result.stderr);
					assert.strictEqual(result.stdout, "");
					if (fails) {
						assert.match(result.stderr, /Could not register Camunda Modeler/);
						assert.match(result.stderr, /registration routine stdout/);
						assert.match(result.stderr, /registration routine stderr/);
						assert.match(result.stderr, /xdg_register\.sh to retry/);
					} else {
						assert.strictEqual(result.stderr, "");
					}
				} finally {
					sandbox.cleanup();
				}
			}
		});
	}

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

	test("updates a managed Linux release and refreshes its desktop registrations", {
		skip: !isLinux,
	}, async () => {
		const sandbox = createLinuxSandbox();
		const installed = addLinuxInstall(sandbox, "5.51.0");
		for (const tool of ["xdg-mime", "xdg-desktop-menu", "xdg-icon-resource"]) {
			sandbox.fakeTool(tool);
		}

		try {
			const dryRun = await sandbox.update(
				{ FAKE_UID: "0" },
				"--dry-run",
				"--json",
			);
			assert.strictEqual(dryRun.status, 0, dryRun.stderr);
			const preview = parseJson(dryRun);
			assert.strictEqual(preview.command, "modeler update");
			assert.match(String(preview.message), /5\.51\.0.*5\.52\.0/);
			assert.deepStrictEqual(sandbox.toolCalls(), []);

			const updated = await sandbox.update({ FAKE_UID: "0" });
			assert.strictEqual(updated.status, 0, updated.stderr);
			assert.match(updated.stdout, /Updated Camunda Modeler to 5\.52\.0/);
			assert.strictEqual(
				readlinkSync(installed.launcher),
				"camunda-modeler-5.52.0-linux-x64/camunda-modeler",
			);
			assert.ok(!existsSync(installed.installDir));
			assert.ok(
				sandbox
					.toolCalls()
					.includes(
						"/bin/bash /usr/bin/camunda-modeler-5.51.0-linux-x64/support/xdg_unregister.sh",
					),
			);
			assert.ok(
				sandbox
					.toolCalls()
					.includes(
						"/bin/bash /usr/bin/camunda-modeler-5.52.0-linux-x64/support/xdg_register.sh",
					),
			);

			sandbox.resetToolCalls();
			const current = await sandbox.update({ FAKE_UID: "0" });
			assert.strictEqual(current.status, 0, current.stderr);
			assert.match(current.stdout, /already up to date/);
			assert.deepStrictEqual(sandbox.toolCalls(), []);
		} finally {
			sandbox.cleanup();
		}
	});

	test("preserves the previous Linux release when switching the launcher fails", {
		skip: !isLinux,
	}, async () => {
		const sandbox = createLinuxSandbox();
		const installed = addLinuxInstall(sandbox, "5.51.0");

		try {
			const failed = await sandbox.update({
				FAKE_UID: "0",
				FAIL_AT: "mv",
			});
			assert.strictEqual(failed.status, 1);
			assert.match(
				failed.stdout + failed.stderr,
				/Could not switch camunda-modeler to the updated release/,
			);
			assert.strictEqual(
				readlinkSync(installed.launcher),
				"camunda-modeler-5.51.0-linux-x64/camunda-modeler",
			);
			assert.ok(existsSync(installed.installDir));
			assert.ok(
				!existsSync(join(sandbox.usrBin, "camunda-modeler-5.52.0-linux-x64")),
			);
			assert.ok(
				!existsSync(join(sandbox.usrBin, ".c8ctl-camunda-modeler-update")),
			);
		} finally {
			sandbox.cleanup();
		}
	});

	test("dry-runs and removes a managed Linux release and its file registrations", {
		skip: !isLinux,
	}, async () => {
		const sandbox = createLinuxSandbox();
		const installed = addLinuxInstall(sandbox, "5.52.0");
		for (const tool of ["xdg-mime", "xdg-desktop-menu", "xdg-icon-resource"]) {
			sandbox.fakeTool(tool);
		}

		try {
			const dryRun = await sandbox.remove(
				{ FAKE_UID: "0" },
				"--dry-run",
				"--json",
			);
			assert.strictEqual(dryRun.status, 0, dryRun.stderr);
			assert.strictEqual(parseJson(dryRun).command, "modeler remove");
			assert.match(String(parseJson(dryRun).message), /would remove/);
			assert.ok(existsSync(installed.installDir));
			assert.ok(existsSync(installed.launcher));
			assert.deepStrictEqual(sandbox.toolCalls(), []);

			const removed = await sandbox.remove({ FAKE_UID: "0" });
			assert.strictEqual(removed.status, 0, removed.stderr);
			assert.match(removed.stdout, /Removed Camunda Modeler/);
			assert.ok(!existsSync(installed.installDir));
			assert.ok(!existsSync(installed.launcher));
			assert.ok(
				sandbox
					.toolCalls()
					.includes(
						"/bin/bash /usr/bin/camunda-modeler-5.52.0-linux-x64/support/xdg_unregister.sh",
					),
			);
		} finally {
			sandbox.cleanup();
		}
	});

	test("refuses to manage an unmanaged Linux executable", {
		skip: !isLinux,
	}, async () => {
		const sandbox = createLinuxSandbox();
		sandbox.fakeTool("camunda-modeler");
		try {
			const results = [await sandbox.update(), await sandbox.remove()];

			for (const result of results) {
				assert.strictEqual(result.status, 1);
				assert.match(result.stdout + result.stderr, /not installed by c8ctl/);
			}
			assert.deepStrictEqual(sandbox.toolCalls(), []);
		} finally {
			sandbox.cleanup();
		}
	});

	for (const scenario of [
		{ name: "macOS", skip: !isMac, create: createSandbox },
		{ name: "Linux", skip: !isLinux, create: createLinuxSandbox },
	]) {
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			test(`${scenario.name} release-index downloads abort on ${signal}`, {
				skip: scenario.skip,
			}, async () => {
				const sandbox = scenario.create();
				const downloadTmp = join(sandbox.home, "download-tmp");
				const pidFile = join(sandbox.home, "download.pid");
				const abortFile = join(sandbox.home, "index-aborted");
				mkdirSync(downloadTmp);
				const resultPromise = sandbox.install({
					TMPDIR: downloadTmp,
					STALL_RELEASE_INDEX: "1",
					DOWNLOAD_PID_FILE: pidFile,
					INDEX_ABORT_FILE: abortFile,
				});
				try {
					await pollUntilValue(
						async () => (existsSync(pidFile) ? pidFile : undefined),
						15_000,
						25,
						"a stalled Modeler release-index request",
					);
					const pid = Number(readFileSync(pidFile, "utf8"));
					assert.ok(Number.isInteger(pid) && pid > 0);
					process.kill(pid, signal);

					const result = await resultPromise;
					assert.strictEqual(result.timedOut, false, result.stderr);
					assert.strictEqual(result.status, null, result.stderr);
					assert.strictEqual(result.signal, signal, result.stderr);
					assert.strictEqual(readFileSync(abortFile, "utf8"), "true");
					assert.deepStrictEqual(readdirSync(downloadTmp), []);
				} finally {
					await resultPromise;
					sandbox.cleanup();
				}
			});
		}
	}

	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		test(`cleans up a partial download before exiting on ${signal}`, {
			skip: !isMac,
		}, async () => {
			const sandbox = createSandbox();
			const downloadTmp = join(sandbox.home, "download-tmp");
			const pidFile = join(sandbox.home, "download.pid");
			mkdirSync(downloadTmp);
			const resultPromise = sandbox.install({
				TMPDIR: downloadTmp,
				STALL_DOWNLOAD: "1",
				DOWNLOAD_PID_FILE: pidFile,
			});
			try {
				const archiveName = modelerMacArchiveName("5.52.0", process.arch);
				await pollUntilValue(
					async () =>
						readdirSync(downloadTmp)
							.map((dir) => join(downloadTmp, dir, archiveName))
							.find((path) => existsSync(path) && statSync(path).size > 0),
					15_000,
					25,
					"a partially written Modeler archive",
				);
				const pid = Number(readFileSync(pidFile, "utf8"));
				assert.ok(Number.isInteger(pid) && pid > 0);
				process.kill(pid, signal);

				const result = await resultPromise;
				assert.strictEqual(result.timedOut, false, result.stderr);
				assert.strictEqual(result.status, null, result.stderr);
				assert.strictEqual(result.signal, signal, result.stderr);
				assert.deepStrictEqual(readdirSync(downloadTmp), []);
				assert.deepStrictEqual(readdirSync(sandbox.applicationsRoot), []);
				assert.deepStrictEqual(sandbox.toolCalls(), []);
			} finally {
				await resultPromise;
				sandbox.cleanup();
			}
		});
	}
});
