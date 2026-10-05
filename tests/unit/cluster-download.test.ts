/**
 * Unit tests for the cluster plugin's resilient c8run download
 * (`downloadWithRetry`): retry, HTTP Range resume, stall detection, cleanup,
 * user-facing messages and `--verbose` diagnostics.
 *
 * A real local HTTP server drops or stalls connections, so the failures are
 * the ones undici actually produces (e.g. `TypeError: terminated` caused by
 * `UND_ERR_SOCKET`), not hand-written fetch mocks. Backoff and stall timeout
 * are injected so the suite stays fast.
 */

import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

// @ts-expect-error — JS plugin has no declaration file; typed via runtime shape assertions below
const plugin = await import("../../default-plugins/cluster/c8ctl-plugin.js");

const ETAG = '"c8run-test-1"';

/** Deterministic 3 MB payload, large enough to span many body chunks. */
const PAYLOAD = Buffer.alloc(3 * 1024 * 1024);
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = i % 251;
const HALF = Math.floor(PAYLOAD.length / 2);

type RecordedRequest = { range?: string; ifRange?: string };
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
		});
		handler(req, res, requests.length);
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	const port = await new Promise<number>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("Expected a TCP address"));
				return;
			}
			resolve((address satisfies AddressInfo).port);
		});
	});
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

/** Announce the full payload, send half of it, then kill the socket. */
function serveHalfThenDrop(res: ServerResponse): void {
	res.writeHead(200, { "content-length": PAYLOAD.length, etag: ETAG });
	res.write(PAYLOAD.subarray(0, HALF), () => {
		setTimeout(() => res.socket?.destroy(), 20);
	});
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
		// Progress continues across the resume instead of restarting at 10%.
		const progress = log
			.messages("info")
			.filter((m) => m.startsWith("Progress:"))
			.map((m) => Number(/Progress: (\d+)%/.exec(m)?.[1]));
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
			res.writeHead(200, { "content-length": PAYLOAD.length });
			if (n === 1) {
				res.write(PAYLOAD.subarray(0, HALF), () =>
					setTimeout(() => res.socket?.destroy(), 20),
				);
			} else {
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

	test("gives up after 1 initial attempt + 3 retries, removes the partial file, and explains why", async () => {
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

	test("does not retry a 404 and leaves no file behind", async () => {
		server = await startServer((_req, res) => {
			res.writeHead(404);
			res.end("Not Found");
		});
		const log = recordingLogger();

		const error = await rejectionOf(
			plugin.downloadWithRetry({
				url: server.url,
				targetFile,
				logger: log.logger,
				...fast,
			}),
		);

		assert.strictEqual(server.requests.length, 1);
		assert.strictEqual(prop(error, "status"), 404);
		assert.strictEqual(existsSync(targetFile), false);
		assert.deepStrictEqual(log.messages("warn"), []);
	});

	test("4xx responses are never retried; 5xx and 429 are (class-scoped)", async () => {
		for (const status of [400, 401, 403, 404, 410]) {
			const s = await startServer((_req, res) => {
				res.writeHead(status);
				res.end();
			});
			try {
				const error = await rejectionOf(
					plugin.downloadWithRetry({
						url: s.url,
						targetFile,
						logger: recordingLogger().logger,
						...fast,
					}),
				);
				assert.strictEqual(s.requests.length, 1, `HTTP ${status} retried`);
				assert.strictEqual(prop(error, "status"), status);
			} finally {
				await s.close();
			}
		}
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

	test("reports an unreachable server as such after all retries", async () => {
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

	test("verbose output appears only when verbose is enabled", async () => {
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
		has(/^\[verbose\] Request headers: \(none beyond the Node\.js defaults\)$/);
		has(
			/^\[verbose\] Request headers: Range: bytes=\d+-, If-Range: "c8run-test-1"$/,
		);
		has(/^\[verbose\] Response: HTTP 200 OK from /);
		has(/^\[verbose\] Response: HTTP 206 Partial Content from /);
		has(
			/^\[verbose\] Response headers: content-length: \d+, content-range: bytes \d+-\d+\/\d+, etag: "c8run-test-1", last-modified: \(none\), accept-ranges: \(none\)$/,
		);
		has(
			/^\[verbose\] Attempt 1\/4 failed after \S+: [\d.]+ MB received in this attempt/,
		);
		has(/^\[verbose\] Error details: Error: /);
		has(/^\[verbose\] {3}caused by: TypeError: terminated$/);
		has(
			/^\[verbose\] Attempt 2\/4 completed after \S+: [\d.]+ MB received \(([\d.]+ MB\/s|n\/a)\)/,
		);
		has(/^\[verbose\] Progress: \d+% \([\d.]+ MB \/ 3\.0 MB\) at /);
		// Finer-grained than the regular 10% steps.
		const verboseProgress = diagnostics.filter((m) => m.includes("Progress:"));
		const regularProgress = loud.log
			.messages("info")
			.filter((m) => m.startsWith("Progress:"));
		assert.ok(
			verboseProgress.length > regularProgress.length,
			`verbose progress (${verboseProgress.length}) should be finer than regular (${regularProgress.length})`,
		);
	});

	test("verbose output never prints proxy credentials", async () => {
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
