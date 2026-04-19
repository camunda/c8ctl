/**
 * Behavioural regression guard for SIGINT during an in-flight deploy.
 *
 * The defect class: a long-running handler whose worker is mid-HTTP must
 * shut down promptly when the user hits Ctrl+C, without:
 *   - blocking on the in-flight network round-trip,
 *   - emitting a "Failed to deploy" line that masquerades as a real error,
 *   - or relying on `process.exit()` inside the handler.
 *
 * To make the in-flight window deterministic, we stand up a mock REST
 * server that accepts the `POST /v2/deployments` request but never sends
 * a response. The watcher will sit on `await client.createDeployment(...)`
 * indefinitely until SIGINT triggers `AbortController.abort()`, which the
 * SDK's `CancelablePromise` translates into an underlying fetch abort.
 *
 * A passing test proves the cancellation pipeline (deploy.signal →
 * CancelablePromise.cancel → fetch abort) is wired end-to-end.
 */

import assert from "node:assert";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	after,
	afterEach,
	before,
	beforeEach,
	describe,
	test,
} from "node:test";
import { pollUntil } from "../utils/polling.ts";
import { startWatchProcess } from "../utils/watch-process.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const VALID_BPMN = join(
	PROJECT_ROOT,
	"tests",
	"fixtures",
	"simple-user-task.bpmn",
);

const POLL_INTERVAL_MS = 50;
const STARTUP_TIMEOUT_MS = 5_000;
// Cancellation budget: from SIGINT to process exit. If the request weren't
// being aborted we'd be waiting forever (mock never responds), so even a
// generous budget here would still catch the regression.
const SHUTDOWN_BUDGET_MS = 3_000;

describe("watch command cancels in-flight deploys on SIGINT", () => {
	let dataDir: string;
	let mockServer: Server;
	let mockServerUrl: string;
	let signalReceived: () => void;
	let deployRequestReceived: Promise<void>;

	before(() => {
		dataDir = mkdtempSync(join(tmpdir(), "c8ctl-watch-cancel-"));
	});

	after(() => {
		rmSync(dataDir, { recursive: true, force: true });
	});

	beforeEach(async () => {
		// Fresh promise + resolver per test so we can await the moment the
		// mock server has fully consumed the request body (i.e. the deploy
		// is genuinely "in flight").
		deployRequestReceived = new Promise<void>((r) => {
			signalReceived = r;
		});

		mockServer = createServer((req, res) => {
			if (req.method === "POST" && req.url?.includes("/deployments")) {
				// Drain the request body so the client knows the request was
				// transmitted, then deliberately never call res.end(). The
				// SDK call will sit on `await fetch(...)` until aborted.
				req.on("data", () => {});
				req.on("end", () => signalReceived());
				return;
			}
			// Unrelated probes (e.g. token endpoints) get a benign 200.
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end("{}");
		});

		await new Promise<void>((r) => {
			// Port 0 → kernel-assigned free port. Avoids races between
			// parallel test runs grabbing the same hardcoded port.
			mockServer.listen(0, "127.0.0.1", () => r());
		});
		const addr = mockServer.address();
		if (!addr || typeof addr === "string") {
			throw new Error("mock server did not bind to an inet address");
		}
		mockServerUrl = `http://127.0.0.1:${addr.port}/v2`;
	});

	afterEach(async () => {
		await new Promise<void>((r) => {
			mockServer.close(() => r());
		});
	});

	test("SIGINT mid-deploy aborts the HTTP request and exits 0 within the shutdown budget", async () => {
		const watchDir = mkdtempSync(join(tmpdir(), "c8ctl-watch-cancel-dir-"));
		const watch = startWatchProcess({
			watchDir,
			dataDir,
			env: { CAMUNDA_BASE_URL: mockServerUrl },
		});

		try {
			// 1. Wait for the watcher to be ready.
			const ready = await pollUntil(
				async () => watch.getOutput().includes("Watching for changes"),
				STARTUP_TIMEOUT_MS,
				POLL_INTERVAL_MS,
			);
			assert.ok(
				ready,
				`watch did not start within ${STARTUP_TIMEOUT_MS}ms. Output:\n${watch.getOutput()}`,
			);

			// 2. Trigger a deploy by dropping a BPMN into the watched dir.
			//    The watcher debounces by 500ms, so the deploy actually
			//    starts shortly after the copy.
			const droppedFile = join(watchDir, "simple-user-task.bpmn");
			copyFileSync(VALID_BPMN, droppedFile);

			// 3. Wait for the mock server to confirm the POST body landed.
			//    From this point on, the SDK call is genuinely in-flight.
			await Promise.race([
				deployRequestReceived,
				new Promise<never>((_r, reject) =>
					setTimeout(
						() =>
							reject(
								new Error(
									`mock server did not receive POST /deployments within startup budget. Output:\n${watch.getOutput()}`,
								),
							),
						STARTUP_TIMEOUT_MS,
					),
				),
			]);

			// 4. Send SIGINT and time how long shutdown takes. Without
			//    cancellation wiring, we'd block forever on the hung
			//    fetch and the SIGKILL fallback would fire instead.
			const sigintAt = Date.now();
			watch.child.kill("SIGINT");
			const exitCode = await watch.waitForExit(SHUTDOWN_BUDGET_MS);
			const elapsedMs = Date.now() - sigintAt;
			const output = watch.getOutput();

			assert.strictEqual(
				exitCode,
				0,
				`watch should exit 0 on SIGINT mid-deploy. Got: ${exitCode} after ${elapsedMs}ms. Output:\n${output}`,
			);
			assert.ok(
				elapsedMs < SHUTDOWN_BUDGET_MS,
				`watch should shut down within ${SHUTDOWN_BUDGET_MS}ms (took ${elapsedMs}ms). Output:\n${output}`,
			);
			assert.ok(
				output.includes("bottoms up"),
				`Expected the SIGINT goodbye message. Output:\n${output}`,
			);
			assert.ok(
				!output.includes("Failed to deploy"),
				`A user-cancelled deploy must not surface as "Failed to deploy". Output:\n${output}`,
			);
		} finally {
			await watch.cleanup(SHUTDOWN_BUDGET_MS);
			rmSync(watchDir, { recursive: true, force: true });
		}
	});
});
