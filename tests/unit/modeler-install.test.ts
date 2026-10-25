import assert from "node:assert";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, test } from "node:test";
import {
	latestStableModelerVersion,
	modelerMacArchiveName,
} from "../../src/utils/command-local/modeler-helpers.ts";
import { c8, c8WithOptions } from "../utils/cli.ts";

const MODELER_BUNDLE = "Camunda Modeler.app";

function modelerInstallPreload(): string[] {
	return [
		'import childProcess from "node:child_process";',
		'import fs from "node:fs";',
		'import { syncBuiltinESMExports } from "node:module";',
		"const installRoot = process.env.DITTO_INSTALL_ROOT;",
		"const originalExistsSync = fs.existsSync;",
		"const originalMkdtempSync = fs.mkdtempSync;",
		"const originalRenameSync = fs.renameSync;",
		"const originalSpawnSync = childProcess.spawnSync;",
		'const lsregisterPath = "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";',
		"const remapPath = (value) => {",
		"  const path = String(value);",
		"  if (!installRoot) return value;",
		'  if (path === "/Applications") return installRoot;',
		'  if (path.startsWith("/Applications/")) return installRoot + path.slice("/Applications".length);',
		"  return value;",
		"};",
		"fs.existsSync = (value) => {",
		'  if (!installRoot && String(value) === "/Applications/Camunda Modeler.app") return false;',
		"  return originalExistsSync(remapPath(value));",
		"};",
		"fs.mkdtempSync = (prefix, options) => originalMkdtempSync(remapPath(prefix), options);",
		"fs.renameSync = (from, to) => originalRenameSync(remapPath(from), remapPath(to));",
		"childProcess.spawnSync = (command, args, options) => {",
		"  if (String(command) === lsregisterPath) {",
		'    fs.appendFileSync(process.env.LSREGISTER_LOG, JSON.stringify(args) + "\\n");',
		"    return { error: undefined, status: 0 };",
		"  }",
		"  return originalSpawnSync(command, args, options);",
		"};",
		"syncBuiltinESMExports();",
	];
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

	test("prints manual download instructions on non-macOS", {
		skip: process.platform === "darwin",
	}, async () => {
		const result = await c8("modeler", "install");

		assert.strictEqual(result.status, 1);
		assert.ok(
			(result.stdout + result.stderr).includes("currently supports macOS only"),
		);
		assert.ok(
			(result.stdout + result.stderr).includes(
				"Download Modeler manually from",
			),
		);
	});

	test("skips when a Modeler app bundle is already installed", {
		skip: process.platform !== "darwin",
	}, async () => {
		const home = mkdtempSync(join(tmpdir(), "c8ctl-modeler-test-"));
		const preloadPath = join(home, "hide-system-modeler.mjs");
		writeFileSync(preloadPath, modelerInstallPreload().join("\n"));
		mkdirSync(join(home, "Applications", MODELER_BUNDLE), {
			recursive: true,
		});

		try {
			const result = await c8WithOptions(
				{
					nodeArgs: ["--import", preloadPath],
					env: {
						HOME: home,
						C8CTL_DATA_DIR: join(home, "data"),
						C8CTL_OUTPUT_MODE: "text",
					},
				},
				"modeler",
				"install",
			);

			assert.strictEqual(result.status, 0, result.stderr);
			assert.ok((result.stdout + result.stderr).includes("already installed"));
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("uses Homebrew to install and skips an installed cask", {
		skip: process.platform !== "darwin",
	}, async () => {
		const home = mkdtempSync(join(tmpdir(), "c8ctl-modeler-test-"));
		const binDir = join(home, "bin");
		const brewPath = join(binDir, "brew");
		const brewLog = join(home, "brew.log");
		const preloadPath = join(home, "hide-system-modeler.mjs");
		mkdirSync(binDir);
		writeFileSync(preloadPath, modelerInstallPreload().join("\n"));
		writeFileSync(
			brewPath,
			[
				"#!/bin/sh",
				'printf "%s\\n" "$*" >> "$BREW_LOG"',
				'if [ "$1" = "--version" ]; then exit 0; fi',
				'if [ "$1" = "list" ]; then exit "$BREW_INSTALLED"; fi',
				'if [ "$1" = "install" ]; then exit 0; fi',
				"exit 1",
			].join("\n"),
		);
		chmodSync(brewPath, 0o755);

		const env = {
			PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
			HOME: home,
			BREW_LOG: brewLog,
			BREW_INSTALLED: "1",
			C8CTL_DATA_DIR: join(home, "data"),
			C8CTL_OUTPUT_MODE: "text",
		};

		try {
			const installed = await c8WithOptions(
				{ nodeArgs: ["--import", preloadPath], env },
				"modeler",
				"install",
			);
			assert.strictEqual(installed.status, 0, installed.stderr);
			assert.ok(
				(installed.stdout + installed.stderr).includes("Homebrew"),
				`stdout: ${installed.stdout}\nstderr: ${installed.stderr}`,
			);
			assert.deepStrictEqual(
				readFileSync(brewLog, "utf-8").trim().split("\n"),
				[
					"--version",
					"list --cask --versions camunda-modeler",
					"install --cask camunda-modeler",
				],
			);

			writeFileSync(brewLog, "");
			const alreadyInstalled = await c8WithOptions(
				{
					nodeArgs: ["--import", preloadPath],
					env: { ...env, BREW_INSTALLED: "0" },
				},
				"modeler",
				"install",
			);
			assert.strictEqual(alreadyInstalled.status, 0, alreadyInstalled.stderr);
			assert.ok(
				(alreadyInstalled.stdout + alreadyInstalled.stderr).includes(
					"already installed",
				),
			);
			assert.deepStrictEqual(
				readFileSync(brewLog, "utf-8").trim().split("\n"),
				["--version", "list --cask --versions camunda-modeler"],
			);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("installs the latest stable app bundle when Homebrew is absent", {
		skip: process.platform !== "darwin",
	}, async () => {
		const home = mkdtempSync(join(tmpdir(), "c8ctl-modeler-test-"));
		const binDir = join(home, "bin");
		const dittoPath = join(binDir, "ditto");
		const dittoLog = join(home, "ditto.log");
		const launchServicesLog = join(home, "launch-services.log");
		const preloadPath = join(home, "mock-downloads.mjs");
		const installRoot = join(home, "install-root");
		const archiveName = modelerMacArchiveName("5.52.0", process.arch);
		const releaseUrl =
			"https://downloads.camunda.cloud/release/camunda-modeler/";
		const archiveUrl = `${releaseUrl}5.52.0/${archiveName}`;
		mkdirSync(binDir);
		symlinkSync(process.execPath, join(binDir, "node"));
		writeFileSync(
			dittoPath,
			[
				"#!/usr/bin/env node",
				'const { appendFileSync, cpSync, mkdirSync, writeFileSync } = require("node:fs");',
				'const { dirname, join } = require("node:path");',
				"const args = process.argv.slice(2);",
				'appendFileSync(process.env.DITTO_LOG, JSON.stringify(args) + "\\n");',
				'if (args[0] === "-x" && args[1] === "-k") {',
				'  const appPath = join(args[3], "Camunda Modeler.app");',
				'  mkdirSync(join(appPath, "Contents"), { recursive: true });',
				'  writeFileSync(join(appPath, "Contents", "Info.plist"), "CFBundleDocumentTypes .bpmn");',
				"} else {",
				'  const destination = args[1].startsWith("/Applications/") ? join(process.env.DITTO_INSTALL_ROOT, args[1].slice("/Applications/".length)) : args[1];',
				"  mkdirSync(dirname(destination), { recursive: true });",
				'  if (process.env.DITTO_FAIL_INSTALL === "1") {',
				"    mkdirSync(destination, { recursive: true });",
				'    writeFileSync(join(destination, "partial"), "partial");',
				"    process.exitCode = 1;",
				"  } else {",
				"    cpSync(args[0], destination, { recursive: true });",
				"  }",
				"}",
			].join("\n"),
		);
		chmodSync(dittoPath, 0o755);
		writeFileSync(
			preloadPath,
			[
				...modelerInstallPreload(),
				"Object.defineProperty(process.stderr, 'isTTY', { value: true });",
				`const releaseUrl = ${JSON.stringify(releaseUrl)};`,
				`const archiveUrl = ${JSON.stringify(archiveUrl)};`,
				"const originalFetch = globalThis.fetch;",
				"globalThis.fetch = async (input, options) => {",
				"  const url = String(input);",
				'  if (url === releaseUrl) return new Response(\'<a href="5.52.0/">5.52.0/</a><a href="nightly/">nightly/</a>\');',
				'  if (url === archiveUrl) return new Response("test-archive", { headers: { "content-length": "12" } });',
				"  return originalFetch(input, options);",
				"};",
			].join("\n"),
		);

		const appPath = join(installRoot, MODELER_BUNDLE);
		try {
			mkdirSync(installRoot);
			const installEnv = {
				PATH: binDir,
				HOME: home,
				DITTO_LOG: dittoLog,
				DITTO_INSTALL_ROOT: installRoot,
				LSREGISTER_LOG: launchServicesLog,
				C8CTL_DATA_DIR: join(home, "data"),
				C8CTL_OUTPUT_MODE: "text",
			};
			const failedCopy = await c8WithOptions(
				{
					nodeArgs: ["--import", preloadPath],
					env: { ...installEnv, DITTO_FAIL_INSTALL: "1" },
				},
				"modeler",
				"install",
			);

			assert.strictEqual(failedCopy.status, 1);
			assert.ok(
				(failedCopy.stdout + failedCopy.stderr).includes(
					"Could not copy Camunda Modeler",
				),
			);
			assert.ok(!existsSync(appPath));
			assert.deepStrictEqual(readdirSync(installRoot), []);

			writeFileSync(dittoLog, "");
			const result = await c8WithOptions(
				{ nodeArgs: ["--import", preloadPath], env: installEnv },
				"modeler",
				"install",
			);
			assert.strictEqual(result.status, 0, result.stderr);
			assert.ok(
				(result.stdout + result.stderr).includes("5.52.0"),
				`stdout: ${result.stdout}\nstderr: ${result.stderr}`,
			);
			assert.match(result.stderr, /\[[#-]+\] 100%/);
			assert.ok(existsSync(appPath));
			assert.ok(
				readFileSync(join(appPath, "Contents", "Info.plist"), "utf-8").includes(
					"CFBundleDocumentTypes .bpmn",
				),
			);
			assert.ok(readFileSync(dittoLog, "utf-8").includes(archiveName));
			assert.deepStrictEqual(
				JSON.parse(readFileSync(launchServicesLog, "utf-8").trim()),
				["-f", "/Applications/Camunda Modeler.app"],
			);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
