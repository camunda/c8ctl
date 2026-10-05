/**
 * Unit tests for the cluster plugin's resilient c8run download, called
 * directly: `downloadWithRetry` (resume, restart, retry policy, stall
 * detection, cleanup, failure message, verbose diagnostics and proxy
 * redaction) and the error helpers `describeDownloadFailure` and
 * `formatErrorWithCause`.
 *
 * This file owns every download detail. What can only be observed through
 * the CLI — that `cluster start` reports the failure and exits 1, and that
 * `--verbose` reaches the download — lives in
 * `cluster-start-behaviour.test.ts`, which does not re-assert these details.
 *
 * A real local HTTP server drops or stalls connections, so the failures are
 * the ones undici actually produces (e.g. `TypeError: terminated` caused by
 * `UND_ERR_SOCKET`), not hand-written fetch mocks. Backoff and stall timeout
 * are injected so the suite stays fast.
 */

import assert from "node:assert";
import fs, {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { gzipSync } from "node:zlib";
import { listenOnLoopback, sendHalfThenDrop } from "../utils/http-server.ts";

// @ts-expect-error — JS plugin has no declaration file; typed via runtime shape assertions below
const plugin = await import("../../default-plugins/cluster/c8ctl-plugin.js");

const ETAG = '"c8run-test-1"';

/** Deterministic 3 MB payload, large enough to span many body chunks. */
const PAYLOAD = Buffer.alloc(3 * 1024 * 1024);
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = i % 251;

type RecordedRequest = {
	range?: string;
	ifRange?: string;
	acceptEncoding?: string;
};
type Handler = (
	req: IncomingMessage,
	res: ServerResponse,
	requestNumber: number,
) => void;

interface TestServer {
	url: string;
	requests: RecordedRequest[];
	close: () => Promise<void>;
}

async function startServer(handler: Handler): Promise<TestServer> {
	const requests: RecordedRequest[] = [];
	const sockets = new Set<Socket>();
	const server: Server = createServer((req, res) => {
		const ifRange = req.headers["if-range"];
		requests.push({
			range: req.headers.range,
			ifRange: typeof ifRange === "string" ? ifRange : undefined,
			acceptEncoding: req.headers["accept-encoding"],
		});
		handler(req, res, requests.length);
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	const port = await listenOnLoopback(server);
	return {
		url: `http://127.0.0.1:${port}/c8run/8.8.1/camunda8-run-8.8.1-linux-x86_64.tar.gz`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}

/** Send the full payload with a strong ETag. */
function serveFull(res: ServerResponse): void {
	res.writeHead(200, { "content-length": PAYLOAD.length, etag: ETAG });
	res.end(PAYLOAD);
}

/** Announce the full payload with a strong ETag, send half, kill the socket. */
function serveHalfThenDrop(res: ServerResponse): void {
	sendHalfThenDrop(res, PAYLOAD, { etag: ETAG });
}

/** Honour `Range: bytes=N-` with a 206 when If-Range matches; else full 200. */
function serveRange(req: IncomingMessage, res: ServerResponse): void {
	const match = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
	if (!match || req.headers["if-range"] !== ETAG) {
		serveFull(res);
		return;
	}
	const start = Number(match[1]);
	res.writeHead(206, {
		"content-length": PAYLOAD.length - start,
		"content-range": `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
		etag: ETAG,
	});
	res.end(PAYLOAD.subarray(start));
}

type LogLine = { level: "info" | "warn" | "error"; message: string };

function recordingLogger() {
	const lines: LogLine[] = [];
	return {
		lines,
		logger: {
			info: (message: string) => lines.push({ level: "info", message }),
			warn: (message: string) => lines.push({ level: "warn", message }),
			error: (message: string) => lines.push({ level: "error", message }),
			debug: () => {},
		},
		messages: (level?: LogLine["level"]) =>
			lines
				.filter((line) => level === undefined || line.level === level)
				.map((line) => line.message),
	};
}

/** Await a rejection and return the error for detailed assertions. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof Error, `expected an Error, got ${error}`);
		return error;
	}
	assert.fail("expected the download to fail");
}

/** Read a string-valued property off an unknown error without a cast. */
function prop(error: unknown, key: string): unknown {
	return typeof error === "object" && error !== null
		? Reflect.get(error, key)
		: undefined;
}

describe("Cluster Plugin – downloadWithRetry", () => {
	let tempDir: string;
	let targetFile: string;
	let server: TestServer | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "c8ctl-download-"));
		targetFile = join(tempDir, "c8run.tar.gz");
	});

	afterEach(async () => {
		await server?.close();
		server = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	const fast = { retryDelayMs: 1, stallTimeoutMs: 5_000 };

	test("resumes with Range + If-Range after a mid-body drop and appends the 206 body", async () => {
		server = await startServer((req, res, n) =>
			n === 1 ? serveHalfThenDrop(res) : serveRange(req, res),
		);
		const log = recordingLogger();

		const result = await plugin.downloadWithRetry({
			url: server.url,
			targetFile,
			logger: log.logger,
			...fast,
		});

		assert.strictEqual(server.requests.length, 2);
		assert.strictEqual(server.requests[0].range, undefined);
		const resumeFrom = /^bytes=(\d+)-$/.exec(server.requests[1].range ?? "");
		assert.ok(
			resumeFrom,
			`second request must ask for a byte range, got ${server.requests[1].range}`,
		);
		assert.ok(Number(resumeFrom[1]) > 0, "must resume after the bytes kept");
		assert.strictEqual(server.requests[1].ifRange, ETAG);

		assert.ok(
			readFileSync(targetFile).equals(PAYLOAD),
			"resumed file must equal the payload",
		);
		assert.deepStrictEqual(result, { bytes: PAYLOAD.length, etag: ETAG });

		const warnings = log.messages("warn");
		assert.strictEqual(warnings.length, 1, warnings.join("\n"));
		assert.match(
			warnings[0],
			/^Download interrupted at \d+ (KB|MB) \/ 3 MB \(the connection was (closed by the server or a proxy|closed unexpectedly)\)\. Retrying \(1\/3\) in 1ms, resuming from \d+ (KB|MB)\.\.\.$/,
		);
		// Progress continues across the resume instead of starting over.
		const progress = log
			.messages("info")
			.filter((m) => m.startsWith("//>"))
			.map((m) => Number(/^\/\/> (\d+)%/.exec(m)?.[1]));
		assert.deepStrictEqual(
			progress,
			[...progress].sort((a, b) => a - b),
			"progress must be monotonic",
		);
	});

	test("restarts from zero (truncating) when the server ignores Range and answers 200", async () => {
		server = await startServer((_req, res, n) =>
			n === 1 ? serveHalfThenDrop(res) : serveFull(res),
		);
		const log = recordingLogger();

		await plugin.downloadWithRetry({
			url: server.url,
			targetFile,
			logger: log.logger,
			...fast,
		});

		assert.strictEqual(server.requests.length, 2);
		assert.match(server.requests[1].range ?? "", /^bytes=\d+-$/);
		assert.ok(
			readFileSync(targetFile).equals(PAYLOAD),
			"a 200 answer must replace, not append to, the partial file",
		);
		assert.ok(
			log
				.messages("info")
				.includes(
					"The server did not resume the download; restarting from the beginning.",
				),
			log.messages().join("\n"),
		);
	});

	test("does not send Range without a validator (no ETag / Last-Modified) and restarts instead", async () => {
		server = await startServer((_req, res, n) => {
			if (n === 1) {
				sendHalfThenDrop(res, PAYLOAD);
			} else {
				res.writeHead(200, { "content-length": PAYLOAD.length });
				res.end(PAYLOAD);
			}
		});
		const log = recordingLogger();

		const result = await plugin.downloadWithRetry({
			url: server.url,
			targetFile,
			logger: log.logger,
			...fast,
		});

		assert.strictEqual(server.requests.length, 2);
		assert.strictEqual(server.requests[1].range, undefined);
		assert.ok(readFileSync(targetFile).equals(PAYLOAD));
		assert.strictEqual(result.etag, null);
		assert.match(log.messages("warn")[0], /restarting from the beginning/);
	});

	test("gives up after 1 initial attempt + 3 retries, removes the partial file, and reports the cause, URL and hints", async () => {
		server = await startServer((_req, res) => serveHalfThenDrop(res));
		const log = recordingLogger();

		const error = await rejectionOf(
			plugin.downloadWithRetry({
				url: server.url,
				targetFile,
				logger: log.logger,
				extraHints: ["Extra hint from the caller."],
				...fast,
			}),
		);

		assert.strictEqual(server.requests.length, 4, "exactly 1 + 3 attempts");
		assert.strictEqual(
			existsSync(targetFile),
			false,
			"partial download must be removed",
		);
		assert.deepStrictEqual(
			log.messages("warn").map((m) => /Retrying \((\d\/3)\)/.exec(m)?.[1]),
			["1/3", "2/3", "3/3"],
		);

		const message = error.message;
		assert.match(message, /^Download failed after 4 attempts: /);
		assert.match(
			message,
			/the connection was (closed by the server or a proxy|closed unexpectedly)/,
		);
		assert.match(
			message,
			/Cause: (UND_ERR_SOCKET|ECONNRESET): /,
			"the underlying cause code must be shown",
		);
		assert.ok(message.includes(`URL: ${server.url}`), message);
		assert.match(message, /Received \d+ (KB|MB) of 3 MB before giving up/);
		assert.ok(message.includes("check your network connection"), message);
		assert.ok(message.includes("NODE_USE_ENV_PROXY=1"), message);
		assert.ok(message.includes("C8CTL_C8RUN_DOWNLOAD_URL"), message);
		assert.ok(message.includes("Extra hint from the caller."), message);
		assert.strictEqual(prop(error, "attempts"), 4);
		assert.ok(error.cause, "the final error keeps the cause chain");
	});

	test("fails a 4xx response (400/401/403/404/410) on the first attempt, with its status and no file left behind", async () => {
		for (const status of [400, 401, 403, 404, 410]) {
			const s = await startServer((_req, res) => {
				res.writeHead(status);
				res.end();
			});
			try {
				const log = recordingLogger();
				const error = await rejectionOf(
					plugin.downloadWithRetry({
						url: s.url,
						targetFile,
						logger: log.logger,
						...fast,
					}),
				);
				assert.strictEqual(s.requests.length, 1, `HTTP ${status} retried`);
				assert.strictEqual(prop(error, "status"), status);
				assert.deepStrictEqual(log.messages("warn"), [], `HTTP ${status}`);
				assert.strictEqual(existsSync(targetFile), false, `HTTP ${status}`);
			} finally {
				await s.close();
			}
		}
	});

	test("retries a 429 or 5xx response (500/502/503/504) and completes the download", async () => {
		for (const status of [429, 500, 502, 503, 504]) {
			const s = await startServer((_req, res, n) => {
				if (n === 1) {
					res.writeHead(status);
					res.end();
				} else {
					serveFull(res);
				}
			});
			try {
				const log = recordingLogger();
				await plugin.downloadWithRetry({
					url: s.url,
					targetFile,
					logger: log.logger,
					...fast,
				});
				assert.strictEqual(s.requests.length, 2, `HTTP ${status} not retried`);
				assert.match(
					log.messages("warn")[0],
					new RegExp(
						`^Download failed \\(the server responded with HTTP ${status}.*\\)\\. Retrying \\(1/3\\)`,
					),
				);
				assert.ok(readFileSync(targetFile).equals(PAYLOAD));
			} finally {
				await s.close();
			}
		}
	});

	test("fails a stalled attempt after the stall timeout and resumes", async () => {
		server = await startServer((req, res, n) => {
			if (n === 1) {
				// Send some bytes, then go silent without closing the socket.
				res.writeHead(200, { "content-length": PAYLOAD.length, etag: ETAG });
				res.write(PAYLOAD.subarray(0, 64 * 1024));
				return;
			}
			serveRange(req, res);
		});
		const log = recordingLogger();

		await plugin.downloadWithRetry({
			url: server.url,
			targetFile,
			logger: log.logger,
			retryDelayMs: 1,
			stallTimeoutMs: 200,
		});

		assert.strictEqual(server.requests.length, 2);
		assert.match(log.messages("warn")[0], /\(no data received for 200ms\)/);
		assert.match(server.requests[1].range ?? "", /^bytes=\d+-$/);
		assert.ok(readFileSync(targetFile).equals(PAYLOAD));
	});

	test("fails with disk advice instead of hanging when the file stream errors while the next chunk is awaited", {
		timeout: 10_000,
	}, async (t) => {
		const targets = {
			"missing directory": () => join(tempDir, "missing", "c8run.tar.gz"),
			"file name too long": () => join(tempDir, `${"x".repeat(300)}.tar.gz`),
		};
		for (const [name, target] of Object.entries(targets)) {
			await t.test(name, async () => {
				const s = await startServer((_req, res) => {
					res.writeHead(200, { "content-length": PAYLOAD.length, etag: ETAG });
					// Send headers only, so the file open fails while the first read waits.
					res.flushHeaders();
					setTimeout(() => res.end(PAYLOAD), 100);
				});
				try {
					const error = await rejectionOf(
						plugin.downloadWithRetry({
							url: s.url,
							targetFile: target(),
							logger: recordingLogger().logger,
							...fast,
						}),
					);
					assert.strictEqual(
						s.requests.length,
						1,
						"a local failure is not retried",
					);
					assert.match(
						error.message,
						/^Could not save the download to .*: E[A-Z]+: /,
					);
					assert.match(error.message, /C8RUN_CACHE_DIR/);
					assert.doesNotMatch(error.message, /VPN|HTTPS_PROXY/);
				} finally {
					await s.close();
				}
			});
		}
	});

	test("says where the incomplete download was kept when removing it fails", async () => {
		server = await startServer((_req, res) => serveHalfThenDrop(res));
		const realRmSync = fs.rmSync;
		// The plugin's named rmSync import follows the fs object only after a sync.
		const rmMock = mock.method(
			fs,
			"rmSync",
			(...args: Parameters<typeof fs.rmSync>) => {
				if (args[0] === targetFile) {
					throw Object.assign(new Error("resource busy or locked"), {
						code: "EBUSY",
					});
				}
				return realRmSync(...args);
			},
		);
		syncBuiltinESMExports();
		try {
			const error = await rejectionOf(
				plugin.downloadWithRetry({
					url: server.url,
					targetFile,
					logger: recordingLogger().logger,
					...fast,
				}),
			);
			assert.match(
				error.message,
				/before giving up\.\nThe incomplete download could not be removed \(EBUSY\); delete it yourself: .*c8run\.tar\.gz$/m,
			);
			assert.doesNotMatch(error.message, /was removed/);
			assert.match(
				error.message,
				/Cause: (UND_ERR_SOCKET|ECONNRESET): /,
				"the download cause is kept",
			);
		} finally {
			rmMock.mock.restore();
			syncBuiltinESMExports();
		}
	});

	test("names the kept path when a file-system failure leaves something it cannot remove", async () => {
		// A directory where the archive should go: writing fails with EISDIR and
		// rmSync() without `recursive` refuses to delete it.
		mkdirSync(targetFile);
		server = await startServer((_req, res) => serveFull(res));

		const error = await rejectionOf(
			plugin.downloadWithRetry({
				url: server.url,
				targetFile,
				logger: recordingLogger().logger,
				...fast,
			}),
		);

		assert.match(error.message, /^Could not save the download to /);
		assert.match(
			error.message,
			/^The incomplete download could not be removed \(\S+\); delete it yourself: .*c8run\.tar\.gz$/m,
		);
	});

	test("rejects a URL that fetch() cannot send before making any request", async (t) => {
		const s = await startServer((_req, res) => serveFull(res));
		const port = new URL(s.url).port;
		const urls = {
			credentials: [
				`http://user:pw@127.0.0.1:${port}/c8run.tar.gz`,
				/contains credentials/,
			],
			"unsupported protocol": [
				"ftp://127.0.0.1/c8run.tar.gz",
				/unsupported protocol ftp:/,
			],
		} as const;
		try {
			for (const [name, [url, reason]] of Object.entries(urls)) {
				await t.test(name, async () => {
					const log = recordingLogger();
					const error = await rejectionOf(
						plugin.downloadWithRetry({
							url,
							targetFile,
							logger: log.logger,
							...fast,
						}),
					);
					assert.match(error.message, /^Cannot download from /);
					assert.match(error.message, reason);
					assert.doesNotMatch(error.message, /pw/);
					assert.deepStrictEqual(log.messages("warn"), [], "no retry");
				});
			}
			assert.strictEqual(s.requests.length, 0);
		} finally {
			await s.close();
		}
	});

	test("retries a body that ends before the announced size and resumes from what was saved", async () => {
		const short = 1024 * 1024;
		server = await startServer((req, res, n) => {
			if (n === 1) return serveHalfThenDrop(res);
			if (n === 2) {
				// A complete response whose body stops short of the Content-Range total.
				const start = Number(
					/^bytes=(\d+)-$/.exec(req.headers.range ?? "")?.[1],
				);
				res.writeHead(206, {
					"content-length": short,
					"content-range": `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
					etag: ETAG,
				});
				return res.end(PAYLOAD.subarray(start, start + short));
			}
			serveRange(req, res);
		});
		const log = recordingLogger();

		await plugin.downloadWithRetry({
			url: server.url,
			targetFile,
			logger: log.logger,
			...fast,
		});

		assert.strictEqual(server.requests.length, 3);
		const warnings = log.messages("warn");
		assert.match(
			warnings[1],
			/\(the download ended early \(received \d+ (KB|MB) of 3 MB\)\)/,
		);
		const [second, third] = server.requests
			.slice(1)
			.map((r) => Number(/^bytes=(\d+)-$/.exec(r.range ?? "")?.[1]));
		assert.strictEqual(third, second + short, "resumes after the short body");
		assert.ok(readFileSync(targetFile).equals(PAYLOAD));
	});

	test("asks for the identity encoding and ignores the sizes of a response encoded anyway", async () => {
		const gzipped = gzipSync(PAYLOAD);
		server = await startServer((_req, res) => {
			res.writeHead(200, {
				"content-encoding": "gzip",
				"content-length": gzipped.length,
				etag: ETAG,
			});
			res.end(gzipped);
		});
		const log = recordingLogger();

		const result = await plugin.downloadWithRetry({
			url: server.url,
			targetFile,
			logger: log.logger,
			...fast,
		});

		assert.strictEqual(server.requests.length, 1, log.messages().join("\n"));
		assert.strictEqual(server.requests[0].acceptEncoding, "identity");
		assert.ok(readFileSync(targetFile).equals(PAYLOAD));
		assert.deepStrictEqual(result, { bytes: PAYLOAD.length, etag: ETAG });
	});

	test("does not retry TLS certificate errors and adds the NODE_EXTRA_CA_CERTS hint", async (t) => {
		for (const code of [
			"CERT_NOT_YET_VALID",
			"CERT_REVOKED",
			"CERT_UNTRUSTED",
		]) {
			await t.test(code, async () => {
				const fetchMock = mock.method(globalThis, "fetch", async () => {
					throw new TypeError("fetch failed", {
						cause: Object.assign(new Error(code.toLowerCase()), { code }),
					});
				});
				try {
					const error = await rejectionOf(
						plugin.downloadWithRetry({
							url: "https://downloads.example.invalid/c8run.tar.gz",
							targetFile,
							logger: recordingLogger().logger,
							...fast,
						}),
					);
					assert.strictEqual(fetchMock.mock.callCount(), 1, `${code} retried`);
					assert.match(
						error.message,
						/the server certificate could not be verified/,
					);
					assert.match(error.message, /NODE_EXTRA_CA_CERTS/);
				} finally {
					fetchMock.mock.restore();
				}
			});
		}
	});

	const progressLines = (log: ReturnType<typeof recordingLogger>) =>
		log.messages("info").filter((m) => m.startsWith("//>"));

	/** Send `chunks` slices of the payload `delayMs` apart, then the rest. */
	function trickle(
		res: ServerResponse,
		{ chunks, delayMs }: { chunks: number; delayMs: number },
	): void {
		const slice = Math.floor(PAYLOAD.length / 100);
		let sent = 0;
		const next = () => {
			if (sent >= chunks * slice) {
				res.end(PAYLOAD.subarray(sent));
				return;
			}
			res.write(PAYLOAD.subarray(sent, sent + slice));
			sent += slice;
			setTimeout(next, delayMs);
		};
		next();
	}

	test("reports progress in 5% steps with throughput and ETA", async () => {
		// Paced 1% slices, so the line count doesn't depend on how fetch() chunks the body.
		server = await startServer((_req, res) => {
			res.writeHead(200, { "content-length": PAYLOAD.length, etag: ETAG });
			trickle(res, { chunks: 99, delayMs: 1 });
		});
		const log = recordingLogger();

		await plugin.downloadWithRetry({
			url: server.url,
			targetFile,
			logger: log.logger,
			...fast,
		});

		const lines = progressLines(log);
		for (const line of lines) {
			assert.match(
				line,
				/^\/\/> \d+% \(\d+\.\d MB \/ 3\.0 MB\) at ([\d.]+ MB\/s|n\/a)(, ETA (\d+s|\d+m \d{2}s))?$/,
			);
		}
		const percentages = lines.map((m) => Number(/(\d+)%/.exec(m)?.[1]));
		assert.ok(
			percentages.length > 10,
			`expected more than 10 progress lines, got:\n${lines.join("\n")}`,
		);
		assert.ok(
			percentages.every((p, i) => p >= (percentages[i - 1] ?? 0) + 5),
			lines.join("\n"),
		);
	});

	test("reports progress below the 5% step once the progress interval has passed", async () => {
		server = await startServer((_req, res) => {
			res.writeHead(200, { "content-length": PAYLOAD.length, etag: ETAG });
			trickle(res, { chunks: 3, delayMs: 50 });
		});
		const log = recordingLogger();

		await plugin.downloadWithRetry({
			url: server.url,
			targetFile,
			logger: log.logger,
			progressIntervalMs: 20,
			...fast,
		});

		const lines = progressLines(log);
		assert.ok(
			lines.some((m) => Number(/(\d+)%/.exec(m)?.[1]) < 5),
			`expected a progress line below 5%, got:\n${lines.join("\n")}`,
		);
	});

	test("reports received bytes and throughput when the total size is unknown", async () => {
		server = await startServer((_req, res) => {
			res.writeHead(200, { etag: ETAG });
			trickle(res, { chunks: 3, delayMs: 50 });
		});
		const log = recordingLogger();

		await plugin.downloadWithRetry({
			url: server.url,
			targetFile,
			logger: log.logger,
			progressIntervalMs: 20,
			...fast,
		});

		const lines = progressLines(log);
		assert.ok(lines.length > 0, "expected progress without a known size");
		for (const line of lines) {
			assert.match(
				line,
				/^\/\/> \d+\.\d MB \(total size unknown\) at ([\d.]+ MB\/s|n\/a)$/,
			);
		}
	});

	test("reports a refused connection as an unreachable Download Center after all retries", async () => {
		// Bind then close a server to obtain a port that refuses connections.
		const closed = await startServer(() => {});
		const url = closed.url;
		await closed.close();
		const log = recordingLogger();

		const error = await rejectionOf(
			plugin.downloadWithRetry({
				url,
				targetFile,
				logger: log.logger,
				...fast,
			}),
		);

		assert.strictEqual(log.messages("warn").length, 3);
		assert.match(
			log.messages("warn")[0],
			/^Download failed \(the connection was refused\)\. Retrying \(1\/3\) in 1ms\.\.\.$/,
		);
		assert.match(
			error.message,
			/^Cannot reach the Camunda Download Center \(4 attempts\): the connection was refused\./,
		);
		assert.match(error.message, /Cause: ECONNREFUSED: /);
	});

	test("logs [verbose] HTTP diagnostics (URL, environment, headers, per-attempt timing, cause chain) only when verbose is set, without extra progress lines", async () => {
		const run = async (verbose: boolean) => {
			const s = await startServer((req, res, n) =>
				n === 1 ? serveHalfThenDrop(res) : serveRange(req, res),
			);
			const log = recordingLogger();
			try {
				await plugin.downloadWithRetry({
					url: s.url,
					targetFile,
					logger: log.logger,
					verbose,
					...fast,
				});
			} finally {
				await s.close();
			}
			return { log, url: s.url };
		};

		const quiet = await run(false);
		assert.deepStrictEqual(
			quiet.log.messages().filter((m) => m.startsWith("[verbose]")),
			[],
			"no diagnostics without verbose",
		);

		const loud = await run(true);
		const diagnostics = loud.log
			.messages("info")
			.filter((m) => m.startsWith("[verbose]"));
		const has = (pattern: RegExp) =>
			assert.ok(
				diagnostics.some((m) => pattern.test(m)),
				`missing ${pattern} in:\n${diagnostics.join("\n")}`,
			);
		has(new RegExp(`^\\[verbose\\] Download URL: ${loud.url}$`));
		has(/^\[verbose\] Node\.js v\d+\.\d+\.\d+; NODE_USE_ENV_PROXY=/);
		has(/^\[verbose\] Proxy environment: /);
		has(/^\[verbose\] Attempt 1\/4 started$/);
		has(/^\[verbose\] Request headers: Accept-Encoding: identity$/);
		has(
			/^\[verbose\] Request headers: Accept-Encoding: identity, Range: bytes=\d+-, If-Range: "c8run-test-1"$/,
		);
		has(/^\[verbose\] Response: HTTP 200 OK from /);
		has(/^\[verbose\] Response: HTTP 206 Partial Content from /);
		has(
			/^\[verbose\] Response headers: content-length: \d+, content-range: bytes \d+-\d+\/\d+, content-encoding: \(none\), etag: "c8run-test-1", last-modified: \(none\), accept-ranges: \(none\)$/,
		);
		has(
			/^\[verbose\] Attempt 1\/4 failed after \S+: [\d.]+ MB received in this attempt/,
		);
		has(/^\[verbose\] Error details: Error: /);
		has(/^\[verbose\] {3}caused by: TypeError: terminated$/);
		has(
			/^\[verbose\] Attempt 2\/4 completed after \S+: [\d.]+ MB received \(([\d.]+ MB\/s|n\/a)\)/,
		);
		assert.deepStrictEqual(
			diagnostics.filter((m) => /\/\/>|Progress:/.test(m)),
			[],
			"verbose must not add progress lines",
		);
		assert.ok(
			loud.log.messages("info").some((m) => m.startsWith("//>")),
			"regular progress still shows with verbose",
		);
	});

	test("redacts the query of a signed redirect target in verbose output", async () => {
		server = await startServer((req, res) => {
			if (!req.url?.includes("signed")) {
				res.writeHead(302, {
					location: "/signed.tar.gz?X-Amz-Signature=s3cret",
				});
				return res.end();
			}
			serveFull(res);
		});
		const log = recordingLogger();

		await plugin.downloadWithRetry({
			url: server.url,
			targetFile,
			logger: log.logger,
			verbose: true,
			...fast,
		});

		const all = log.messages().join("\n");
		assert.ok(!all.includes("s3cret"), all);
		assert.match(
			all,
			/from http:\/\/127\.0\.0\.1:\d+\/signed\.tar\.gz\?<redacted> \(after redirect\)/,
		);
	});

	test("redacts credentials in the download and mirror URLs of the failure message", async () => {
		const saved = process.env.C8CTL_C8RUN_DOWNLOAD_URL;
		process.env.C8CTL_C8RUN_DOWNLOAD_URL =
			"https://mirror.example/c8run/?token=m1rror";
		server = await startServer((_req, res) => serveHalfThenDrop(res));
		try {
			const error = await rejectionOf(
				plugin.downloadWithRetry({
					url: `${server.url}?token=s3cret`,
					targetFile,
					logger: recordingLogger().logger,
					...fast,
				}),
			);
			assert.ok(!error.message.includes("s3cret"), error.message);
			assert.ok(!error.message.includes("m1rror"), error.message);
			assert.match(
				error.message,
				/^URL: http:\/\/127\.0\.0\.1:\d+\/\S+\.tar\.gz\?<redacted>$/m,
			);
			assert.match(
				error.message,
				/points the download at https:\/\/mirror\.example\/c8run\/\?<redacted>\./,
			);
		} finally {
			if (saved === undefined) delete process.env.C8CTL_C8RUN_DOWNLOAD_URL;
			else process.env.C8CTL_C8RUN_DOWNLOAD_URL = saved;
		}
	});

	test("redacts proxy credentials in verbose output", async () => {
		const saved = process.env.HTTPS_PROXY;
		process.env.HTTPS_PROXY = "http://alice:s3cret@proxy.example:3128";
		server = await startServer((_req, res) => serveFull(res));
		const log = recordingLogger();
		try {
			await plugin.downloadWithRetry({
				url: server.url,
				targetFile,
				logger: log.logger,
				verbose: true,
				...fast,
			});
		} finally {
			if (saved === undefined) delete process.env.HTTPS_PROXY;
			else process.env.HTTPS_PROXY = saved;
		}
		const all = log.messages().join("\n");
		assert.ok(!all.includes("s3cret"), all);
		assert.ok(!all.includes("alice"), all);
		assert.ok(all.includes("HTTPS_PROXY=http://***@proxy.example:3128/"), all);
	});
});

describe("Cluster Plugin – download failure descriptions", () => {
	test("quoteForHint quotes paths safely for copy-paste on POSIX shells and Windows", () => {
		assert.strictEqual(
			plugin.quoteForHint("/home/me/.cache/c8run-8.9", "linux"),
			"/home/me/.cache/c8run-8.9",
		);
		assert.strictEqual(
			plugin.quoteForHint("/tmp/my dir/$HOME`id`'x'", "darwin"),
			"'/tmp/my dir/$HOME`id`'\\''x'\\'''",
		);
		assert.strictEqual(plugin.quoteForHint("/tmp/a&b", "linux"), "'/tmp/a&b'");
		assert.strictEqual(
			plugin.quoteForHint("C:\\Users\\me\\c8run", "win32"),
			"C:\\Users\\me\\c8run",
		);
		assert.strictEqual(
			plugin.quoteForHint("C:\\Users\\Jane Doe\\c8run", "win32"),
			'"C:\\Users\\Jane Doe\\c8run"',
		);
	});

	const withCode = (message: string, code: string) =>
		Object.assign(new Error(message), { code });
	const terminated = (cause: Error) => new TypeError("terminated", { cause });

	test("maps undici/system error codes in the cause chain to plain words", () => {
		const cases: Array<[Error, string]> = [
			[
				terminated(withCode("other side closed", "UND_ERR_SOCKET")),
				"the connection was closed by the server or a proxy",
			],
			[
				terminated(withCode("read ECONNRESET", "ECONNRESET")),
				"the connection was closed by the server or a proxy",
			],
			[
				terminated(withCode("Body Timeout Error", "UND_ERR_BODY_TIMEOUT")),
				"the connection timed out",
			],
			[
				new TypeError("fetch failed", {
					cause: withCode("connect ENETUNREACH", "ENETUNREACH"),
				}),
				"the network is unreachable",
			],
			[
				new TypeError("fetch failed", {
					cause: withCode("getaddrinfo ENOTFOUND", "ENOTFOUND"),
				}),
				"the server name could not be resolved (DNS lookup failed)",
			],
			[
				new TypeError("fetch failed", {
					cause: withCode("connect ECONNREFUSED", "ECONNREFUSED"),
				}),
				"the connection was refused",
			],
			[new TypeError("terminated"), "the connection was closed unexpectedly"],
			...["CERT_NOT_YET_VALID", "CERT_REVOKED", "HOSTNAME_MISMATCH"].map(
				(code): [Error, string] => [
					new TypeError("fetch failed", { cause: withCode(code, code) }),
					"the server certificate could not be verified",
				],
			),
		];
		for (const [error, expected] of cases) {
			assert.strictEqual(plugin.describeDownloadFailure(error), expected);
		}
	});

	test("formatErrorWithCause surfaces the root cause that string interpolation hides", () => {
		const error = terminated(withCode("other side closed", "UND_ERR_SOCKET"));
		assert.strictEqual(`${error}`, "TypeError: terminated");
		assert.strictEqual(
			plugin.formatErrorWithCause(error),
			"TypeError: terminated (cause: UND_ERR_SOCKET: other side closed)",
		);
	});

	test("formatErrorWithCause leaves errors without a cause, or that already name it, unchanged", () => {
		assert.strictEqual(
			plugin.formatErrorWithCause(new Error("plain")),
			"Error: plain",
		);
		const described = new Error("Download failed. Cause: ECONNRESET: boom", {
			cause: withCode("boom", "ECONNRESET"),
		});
		assert.strictEqual(
			plugin.formatErrorWithCause(described),
			"Error: Download failed. Cause: ECONNRESET: boom",
		);
	});
});
