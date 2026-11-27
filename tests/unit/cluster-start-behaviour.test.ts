/**
 * CLI behavioural smoke tests for `c8ctl cluster start`.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess. They verify that error output is clear and actionable
 * when cluster startup fails, and that `--verbose` reaches the download.
 * Download behaviour itself (retry, resume, messages, diagnostics) is
 * unit-tested in `cluster-download.test.ts` and not re-asserted here.
 *
 * The download center is redirected via C8CTL_C8RUN_DOWNLOAD_URL to a local
 * endpoint so the outcome never depends on reaching downloads.camunda.cloud
 * (#598).
 */

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
	after,
	afterEach,
	before,
	beforeEach,
	describe,
	test,
} from "node:test";
import { c8SignalledWhen, c8WithEnv } from "../utils/cli.ts";
import { listenOnLoopback, sendHalfThenDrop } from "../utils/http-server.ts";

describe("CLI behavioural: cluster start failure", () => {
	let server: Server;
	let baseUrl: string;

	before(async () => {
		server = createServer((_req, res) => {
			res.writeHead(404);
			res.end("Not Found");
		});
		baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}/c8run/`;
	});

	after(() => {
		server.close();
	});

	test("start with nonexistent version exits with error and logs actionable message", async () => {
		const result = await c8WithEnv(
			{ C8CTL_C8RUN_DOWNLOAD_URL: baseUrl },
			"cluster",
			"start",
			"--c8-version",
			"0.0.0-nonexistent",
		);

		assert.notStrictEqual(result.status, 0, "Should exit with non-zero status");
		const combined = result.stdout + result.stderr;
		assert.ok(
			combined.includes("Failed to start cluster"),
			`Expected "Failed to start cluster" in output, got:\n${combined}`,
		);
		assert.ok(
			combined.includes("HTTP 404"),
			`Expected HTTP 404 path in output, got:\n${combined}`,
		);
		assert.ok(
			combined.includes("check the version exists") ||
				combined.includes("try a different version"),
			`Expected actionable hint in output, got:\n${combined}`,
		);
	});

	test("start when download center is unreachable logs a connectivity hint", async () => {
		// Bind then close a server to obtain a port that refuses connections.
		const closed = createServer();
		const port = await listenOnLoopback(closed);
		await new Promise<void>((resolve) => closed.close(() => resolve()));

		const result = await c8WithEnv(
			{
				C8CTL_C8RUN_DOWNLOAD_URL: `http://127.0.0.1:${port}/c8run/`,
				// Connection failures are retried; keep the backoff short.
				C8CTL_C8RUN_DOWNLOAD_RETRY_DELAY_MS: "1",
			},
			"cluster",
			"start",
			"--c8-version",
			"0.0.0-nonexistent",
		);

		assert.notStrictEqual(result.status, 0, "Should exit with non-zero status");
		const combined = result.stdout + result.stderr;
		assert.ok(
			combined.includes("Cannot reach the Camunda Download Center"),
			`Expected network-failure path in output, got:\n${combined}`,
		);
		assert.ok(
			combined.includes("check your network connection"),
			`Expected connectivity hint in output, got:\n${combined}`,
		);
	});

	test("start with a malformed C8CTL_C8RUN_DOWNLOAD_URL names the variable instead of throwing Invalid URL", async () => {
		const result = await c8WithEnv(
			{ C8CTL_C8RUN_DOWNLOAD_URL: "not a url/" },
			"cluster",
			"start",
			"--c8-version",
			"0.0.0-nonexistent",
		);

		const combined = result.stdout + result.stderr;
		assert.strictEqual(result.status, 1, combined);
		assert.match(
			combined,
			/Cannot download from \(invalid URL\): not a valid URL\. Check C8CTL_C8RUN_DOWNLOAD_URL\./,
		);
		assert.doesNotMatch(combined, /TypeError/);
	});
});

describe("CLI behavioural: cluster start with a dropping download", () => {
	let server: Server;
	let baseUrl: string;
	let cacheDir: string;

	before(async () => {
		// Every response sends half the archive and then kills the socket, so
		// every attempt fails like the reported "TypeError: terminated".
		const payload = Buffer.alloc(64 * 1024, 1);
		server = createServer((_req, res) =>
			sendHalfThenDrop(res, payload, { etag: '"c8run-drop"' }),
		);
		baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}/c8run/`;
		cacheDir = mkdtempSync(join(tmpdir(), "c8ctl-cluster-drop-"));
	});

	after(() => {
		server.close();
		rmSync(cacheDir, { recursive: true, force: true });
	});

	const start = (...extra: string[]) =>
		c8WithEnv(
			{
				C8CTL_C8RUN_DOWNLOAD_URL: baseUrl,
				C8CTL_C8RUN_DOWNLOAD_RETRY_DELAY_MS: "1",
				C8RUN_CACHE_DIR: cacheDir,
			},
			"cluster",
			"start",
			"--c8-version",
			"0.0.0-drop",
			...extra,
		);

	test("start exits 1 and prints the download failure with its cause and the manual-download hint", async () => {
		const result = await start();

		const combined = result.stdout + result.stderr;
		assert.strictEqual(result.status, 1, combined);
		assert.match(combined, /Failed to start cluster: Error: Download failed /);
		assert.match(combined, /Cause: (UND_ERR_SOCKET|ECONNRESET): /);
		// Supplied by the handler, not by downloadWithRetry.
		assert.match(
			combined,
			/Or download camunda8-run-0\.0\.0-drop-\S+ yourself/,
		);
		assert.ok(
			!combined.includes("[verbose]"),
			`no download diagnostics without --verbose:\n${combined}`,
		);
	});

	test("start --verbose turns on the download diagnostics", async () => {
		const result = await start("--verbose");

		const combined = result.stdout + result.stderr;
		assert.strictEqual(result.status, 1, combined);
		assert.ok(
			result.stderr.includes(`[verbose] Download URL: ${baseUrl}0.0.0-drop/`),
			`Expected the download diagnostics on stderr, got:\n${combined}`,
		);
		assert.ok(
			!result.stdout.includes("[verbose]"),
			`Expected no download diagnostics on stdout, got:\n${result.stdout}`,
		);
	});
});

// Fake c8run builds are POSIX shell scripts, so this runs on macOS and Linux only.
const ARCHIVE_EXT = process.platform === "darwin" ? "zip" : "tar.gz";

describe("CLI behavioural: stable never launches a prerelease build", {
	skip: process.platform === "win32",
}, () => {
	let cacheDir: string;
	let server: Server;
	let baseUrl: string;
	let archiveBytes: Buffer;
	let onArchiveRequest: () => void;

	/** Pack a fake c8run build dir as the mirror's rolling 8.11 archive. */
	function buildArchive(buildDir: string, label: string): Buffer {
		const src = mkdtempSync(join(tmpdir(), "c8ctl-archive-src-"));
		try {
			writeFakeC8Run(join(src, buildDir), label);
			const archive = join(src, `archive.${ARCHIVE_EXT}`);
			// The download center ships .zip for macOS and .tar.gz for Linux.
			if (ARCHIVE_EXT === "zip") {
				execFileSync("zip", ["-qr", archive, buildDir], { cwd: src });
			} else {
				execFileSync("tar", ["-czf", archive, "-C", src, buildDir]);
			}
			return readFileSync(archive);
		} finally {
			rmSync(src, { recursive: true, force: true });
		}
	}

	/** A c8run that records which build ran, then fails like a missing JAVA_HOME. */
	function writeFakeC8Run(dir: string, label: string) {
		mkdirSync(dir, { recursive: true });
		const binary = join(dir, "c8run");
		writeFileSync(
			binary,
			`#!/bin/sh\necho ${label} >> "$C8RUN_CACHE_DIR/launched.log"\necho "failed to get JAVA_HOME" >&2\nexit 7\n`,
		);
		chmodSync(binary, 0o755);
	}

	const launched = () => {
		const log = join(cacheDir, "launched.log");
		return existsSync(log) ? readFileSync(log, "utf-8").trim() : "";
	};
	const alphaBuildDir = () =>
		join(cacheDir, "c8run-8.11", "c8run-8.11.0-alpha1");

	beforeEach(async () => {
		cacheDir = mkdtempSync(join(tmpdir(), "c8ctl-stable-ga-"));
		// Installed through `alpha` while 8.11 was alpha-only: the rolling dir holds an alpha build.
		writeFakeC8Run(alphaBuildDir(), "alpha");

		// 8.11 has since gone GA; its rolling archive now holds the GA build.
		archiveBytes = buildArchive("c8run-8.11.0", "ga");
		onArchiveRequest = () => {};

		server = createServer((req, res) => {
			if (req.url?.endsWith(`.${ARCHIVE_EXT}`)) {
				onArchiveRequest();
				res.writeHead(200, {
					"content-length": archiveBytes.length,
					etag: '"current"',
				});
				res.end(archiveBytes);
				return;
			}
			res.end(
				["8.9/", "8.9.0/", "8.11/", "8.11.0-alpha1/", "8.11.0/"]
					.map((d) => `<a href="${d}">${d}</a>`)
					.join(""),
			);
		});
		baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}/c8run/`;
	});

	afterEach(() => {
		server.close();
		rmSync(cacheDir, { recursive: true, force: true });
	});

	const cluster = (downloadUrl: string, ...args: string[]) =>
		c8WithEnv(
			{
				C8RUN_CACHE_DIR: cacheDir,
				C8CTL_OUTPUT_MODE: "text",
				C8CTL_C8RUN_DOWNLOAD_URL: downloadUrl,
				C8CTL_C8RUN_DOWNLOAD_RETRY_DELAY_MS: "1",
			},
			"cluster",
			...args,
		);

	const start = (downloadUrl: string, ...args: string[]) =>
		c8WithEnv(
			{
				C8RUN_CACHE_DIR: cacheDir,
				C8CTL_OUTPUT_MODE: "text",
				C8CTL_C8RUN_DOWNLOAD_URL: downloadUrl,
				C8CTL_C8RUN_DOWNLOAD_RETRY_DELAY_MS: "1",
			},
			"cluster",
			"start",
			...args,
		);

	test("online, stable replaces the alpha build in the rolling dir with the GA build", async () => {
		for (let run = 1; run <= 2; run++) {
			const result = await start(baseUrl);
			assert.strictEqual(result.status, 7, result.stdout + result.stderr);
		}

		assert.strictEqual(launched(), "ga\nga");
		assert.strictEqual(existsSync(alphaBuildDir()), false);
	});

	test("offline, stable explains that only an alpha build is installed and keeps it", async () => {
		writeFileSync(join(cacheDir, "alias-stable.resolved"), "8.11");
		writeFileSync(join(cacheDir, "alias-alpha.resolved"), "8.11");
		// Bind then close a server to obtain a port that refuses connections.
		const closed = createServer();
		const port = await listenOnLoopback(closed);
		await new Promise<void>((resolve) => closed.close(() => resolve()));
		const offline = `http://127.0.0.1:${port}/c8run/`;

		const stable = await start(offline);
		const combined = stable.stdout + stable.stderr;
		assert.strictEqual(stable.status, 1, combined);
		assert.match(
			combined,
			/Only a prerelease build of 8\.11 is installed \(8\.11\.0-alpha1\); "stable" needs a GA build\./,
		);
		assert.strictEqual(launched(), "");
		assert.ok(
			existsSync(alphaBuildDir()),
			"the alpha build must survive a failed download",
		);

		// alpha itself still launches the installed prerelease.
		assert.strictEqual((await start(offline, "alpha")).status, 7);
		assert.strictEqual(launched(), "alpha");
	});
	const assertAlphaKept = () => {
		assert.ok(
			existsSync(join(alphaBuildDir(), "c8run")),
			"the alpha build must be kept",
		);
		assert.deepStrictEqual(
			readdirSync(cacheDir).filter((name) => name.startsWith(".")),
			[],
			"no staging or backup dirs may be left behind",
		);
	};

	test("a mirror whose GA-listed archive still holds a prerelease is rejected", async () => {
		archiveBytes = buildArchive("c8run-8.11.0-alpha2", "alpha2");

		const result = await start(baseUrl);
		const combined = result.stdout + result.stderr;

		assert.strictEqual(result.status, 1, combined);
		assert.match(
			combined,
			/downloaded c8run 8\.11 is a prerelease build \(8\.11\.0-alpha2\); "stable" needs a GA build/,
		);
		assert.strictEqual(launched(), "");
		assertAlphaKept();
	});

	test("a corrupt archive leaves the existing build usable", async () => {
		archiveBytes = Buffer.from("not an archive");

		const result = await start(baseUrl);

		assert.strictEqual(result.status, 1, result.stdout + result.stderr);
		assert.strictEqual(launched(), "");
		assertAlphaKept();
	});

	test("a build started by another c8ctl during the download is not replaced", async () => {
		// Simulate a concurrent `start alpha` that launched the alpha build mid-download.
		onArchiveRequest = () =>
			writeFileSync(
				join(alphaBuildDir(), "camunda.process"),
				String(process.pid),
			);

		const result = await start(baseUrl);
		const combined = result.stdout + result.stderr;

		assert.strictEqual(result.status, 1, combined);
		assert.match(
			combined,
			/Refusing to replace c8run 8\.11: an instance started from it is still running/,
		);
		assert.ok(
			existsSync(join(alphaBuildDir(), "camunda.process")),
			"the running build's pidfile must survive",
		);
		assertAlphaKept();
	});
	test("a used alpha build is not replaced, so its cluster data survives", async () => {
		const journal = join(
			alphaBuildDir(),
			"camunda-zeebe-8.11.0-alpha1",
			"data",
		);
		mkdirSync(journal, { recursive: true });
		writeFileSync(join(journal, "journal.log"), "deployments");
		let archiveRequests = 0;
		onArchiveRequest = () => archiveRequests++;

		const refused = await start(baseUrl);
		const combined = refused.stdout + refused.stderr;
		assert.strictEqual(refused.status, 1, combined);
		assert.match(
			combined,
			/prerelease build \(8\.11\.0-alpha1\) with cluster data/,
		);
		assert.match(combined, /c8ctl cluster purge 8\.11/);
		assert.strictEqual(archiveRequests, 0, "nothing should be downloaded");
		assert.ok(
			existsSync(join(journal, "journal.log")),
			"cluster data must survive",
		);
		assert.strictEqual(launched(), "");

		// The suggested way forward: purge the data, then stable replaces the build.
		assert.strictEqual((await cluster(baseUrl, "purge", "8.11")).status, 0);
		assert.strictEqual((await start(baseUrl)).status, 7);
		assert.strictEqual(launched(), "ga");
	});

	test("install stable keeps the existing GA build when the update archive is rejected", async () => {
		rmSync(join(cacheDir, "c8run-8.11"), { recursive: true });
		writeFakeC8Run(
			join(cacheDir, "c8run-8.11", "c8run-8.11.0"),
			"ga-installed",
		);
		// A stored ETag that differs from the mirror's, so install sees an update.
		writeFileSync(join(cacheDir, "c8run-8.11.etag"), '"previous"');
		archiveBytes = buildArchive("c8run-8.11.0-alpha2", "alpha2");

		const result = await cluster(baseUrl, "install", "stable");
		const combined = result.stdout + result.stderr;

		assert.strictEqual(result.status, 1, combined);
		assert.match(combined, /is a prerelease build \(8\.11\.0-alpha2\)/);
		assert.ok(
			existsSync(join(cacheDir, "c8run-8.11", "c8run-8.11.0", "c8run")),
			"the existing GA build must survive",
		);
	});
	test("an install that lost its launcher keeps its cluster data", async () => {
		rmSync(join(alphaBuildDir(), "c8run"));
		const data = join(alphaBuildDir(), "camunda-data");
		mkdirSync(data);
		writeFileSync(join(data, "state.db"), "deployments");
		let archiveRequests = 0;
		onArchiveRequest = () => archiveRequests++;

		const result = await start(baseUrl);
		const combined = result.stdout + result.stderr;

		assert.strictEqual(result.status, 1, combined);
		assert.match(
			combined,
			/c8run 8\.11 has cluster data but no c8run launcher/,
		);
		assert.match(combined, /c8ctl cluster purge 8\.11/);
		assert.strictEqual(archiveRequests, 0, "nothing should be downloaded");
		assert.ok(existsSync(join(data, "state.db")), "cluster data must survive");
	});

	test("cluster data created during the download is not deleted by the swap", async () => {
		// Simulate the alpha build being started and stopped by another c8ctl mid-download.
		const journal = join(
			alphaBuildDir(),
			"camunda-zeebe-8.11.0-alpha1",
			"data",
		);
		onArchiveRequest = () => {
			mkdirSync(journal, { recursive: true });
			writeFileSync(join(journal, "journal.log"), "deployments");
		};

		const result = await start(baseUrl);
		const combined = result.stdout + result.stderr;

		assert.strictEqual(result.status, 1, combined);
		assert.match(
			combined,
			/prerelease build \(8\.11\.0-alpha1\) with cluster data/,
		);
		assert.ok(
			existsSync(join(journal, "journal.log")),
			"cluster data must survive",
		);
		assert.strictEqual(launched(), "");
		assertAlphaKept();
	});
	test("purge clears data from every build in the install, so stable can then replace it", async () => {
		// A newer alpha build now launches; the older one still holds data.
		writeFakeC8Run(
			join(cacheDir, "c8run-8.11", "c8run-8.11.0-alpha2"),
			"alpha2",
		);
		const stale = join(alphaBuildDir(), "camunda-data");
		mkdirSync(stale);
		writeFileSync(join(stale, "state.db"), "deployments");

		const refused = await start(baseUrl);
		assert.strictEqual(refused.status, 1, refused.stdout + refused.stderr);
		assert.match(
			refused.stdout + refused.stderr,
			/prerelease build \(8\.11\.0-alpha2\) with cluster data/,
		);

		const purge = await cluster(baseUrl, "purge", "8.11");
		assert.strictEqual(purge.status, 0, purge.stdout + purge.stderr);
		assert.match(
			purge.stdout,
			/deleted: c8run-8\.11\.0-alpha1[\\/]camunda-data/,
		);
		assert.strictEqual(existsSync(stale), false);

		assert.strictEqual((await start(baseUrl)).status, 7);
		assert.strictEqual(launched(), "ga");
	});

	for (const [signal, exitStatus] of [
		["SIGINT", 130],
		["SIGTERM", 143],
	] as const) {
		test(`${signal} during extraction removes the staging dir and keeps the existing build`, async () => {
			// An extractor that never finishes, so the signal lands mid-extraction.
			const fakeBin = join(cacheDir, "fake-bin");
			mkdirSync(fakeBin);
			for (const name of ["tar", "unzip"]) {
				const extractor = join(fakeBin, name);
				writeFileSync(
					extractor,
					`#!/bin/sh\ntouch "${join(fakeBin, "started")}"\nexec sleep 60\n`,
				);
				chmodSync(extractor, 0o755);
			}

			const result = await c8SignalledWhen(
				{
					signal,
					when: () => existsSync(join(fakeBin, "started")),
					env: {
						C8RUN_CACHE_DIR: cacheDir,
						C8CTL_OUTPUT_MODE: "text",
						C8CTL_C8RUN_DOWNLOAD_URL: baseUrl,
						C8CTL_C8RUN_DOWNLOAD_RETRY_DELAY_MS: "1",
						PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
					},
				},
				"cluster",
				"start",
			);

			assert.strictEqual(
				result.status,
				exitStatus,
				result.stdout + result.stderr,
			);
			assert.ok(
				existsSync(join(alphaBuildDir(), "c8run")),
				"the alpha build must be kept",
			);
			assert.deepStrictEqual(
				readdirSync(cacheDir).filter((name) => name.startsWith(".")),
				[],
				"an interrupted install must not leave staging dirs behind",
			);
		});
	}

	test("delete and purge remove staging and backup dirs of dead processes only", async () => {
		const deadPid = 2147483646;
		const dead = [
			`.staging-c8run-8.11-${deadPid}`,
			`.replaced-c8run-8.11-${deadPid}`,
		];
		const live = `.staging-c8run-8.11-${process.pid}`;
		const seed = () => {
			for (const name of [...dead, live]) {
				mkdirSync(join(cacheDir, name, "c8run-8.11"), { recursive: true });
			}
		};
		const leftovers = () =>
			readdirSync(cacheDir)
				.filter((name) => name.startsWith("."))
				.sort();

		seed();
		assert.strictEqual((await cluster(baseUrl, "purge", "8.11")).status, 0);
		assert.deepStrictEqual(leftovers(), [live]);

		seed();
		assert.strictEqual((await cluster(baseUrl, "delete", "8.11")).status, 0);
		assert.deepStrictEqual(leftovers(), [live]);
	});

	test("a backup left by a dead process is restored when the install dir is missing", async () => {
		const backup = join(cacheDir, ".replaced-c8run-8.11-2147483646");
		mkdirSync(join(backup, "camunda-data"), { recursive: true });
		writeFileSync(join(backup, "camunda-data", "state.db"), "deployments");
		rmSync(join(cacheDir, "c8run-8.11"), { recursive: true });

		const result = await cluster(baseUrl, "purge", "8.11");

		assert.strictEqual(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /deleted: camunda-data/);
		assert.deepStrictEqual(
			readdirSync(cacheDir).filter((name) => name.startsWith(".")),
			[],
		);
		assert.ok(
			existsSync(join(cacheDir, "c8run-8.11")),
			"the build must be back",
		);
	});
});
