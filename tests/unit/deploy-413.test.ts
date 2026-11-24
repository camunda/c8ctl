/**
 * Behavioural guard for the HTTP 413 (Payload Too Large) deploy hint.
 *
 * When a `POST /deployments` payload exceeds the cluster ingress's
 * body-size limit the request is rejected with HTTP 413 *before* it
 * reaches the engine, so there is no RFC 9457 Problem-Detail body. The
 * deploy error handler must still produce a clear, actionable message:
 *   - a "Payload too large (HTTP 413)" title, and
 *   - 413-specific guidance (payload size / largest resource / split).
 *
 * This drives the real CLI as a subprocess against a local `node:http`
 * server that returns 413 for the deployment POST — no live cluster and
 * no internal exports required. Pins the diagnostic introduced for
 * https://github.com/camunda/c8ctl/issues/446 so it cannot regress
 * unnoticed.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { c8WithEnv } from "../utils/cli.ts";

const SIMPLE_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="proc-413" isExecutable="true">
    <bpmn:startEvent id="start"/>
  </bpmn:process>
</bpmn:definitions>`;

/** Start a stub HTTP server that answers every request with HTTP 413. */
function start413Server(): Promise<{ server: Server; baseUrl: string }> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			// Drain the request body, then reject — mirroring an ingress that
			// returns 413 with a plain-text (non Problem-Detail) body.
			// Set Connection: close to ensure the TCP connection is released
			// immediately after the response, preventing lingering keep-alive
			// handles that can trigger a libuv assertion on Windows (Node 24).
			req.resume();
			req.on("end", () => {
				res.writeHead(413, {
					"Content-Type": "text/plain",
					Connection: "close",
				});
				res.end("Payload Too Large");
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({ server, baseUrl: `http://127.0.0.1:${port}/v2` });
		});
	});
}

describe("deploy: HTTP 413 produces an actionable payload-too-large hint", () => {
	let tempDir: string;
	let server: Server | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "c8ctl-deploy-413-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		server?.close();
		server = undefined;
	});

	test("413 response: clear title + payload-size guidance, exit 1", async () => {
		const started = await start413Server();
		server = started.server;

		const bpmnPath = join(tempDir, "proc-413.bpmn");
		writeFileSync(bpmnPath, SIMPLE_BPMN);

		const result = await c8WithEnv(
			{ CAMUNDA_BASE_URL: started.baseUrl },
			"deploy",
			bpmnPath,
		);

		assert.strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("Payload too large (HTTP 413)"),
			`expected the clearer 413 title in stderr. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("exceeded the cluster's request body-size limit"),
			`expected the 413-specific payload-size hint in stderr. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("Split the resources across multiple"),
			`expected the split-deploys guidance in stderr. stderr:\n${result.stderr}`,
		);
	});
});
