/**
 * Behaviour tests for the global --quiet / -q flag.
 *
 * Quiet hides status chatter (informational and success messages) but
 * never a command's answer, its data, warnings or errors.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { c8WithEnv } from "../utils/cli.ts";
import { listenOnLoopback } from "../utils/http-server.ts";

let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "c8ctl-quiet-"));
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

const run = (mode: "text" | "json", ...args: string[]) =>
	c8WithEnv({ C8CTL_DATA_DIR: dataDir, C8CTL_OUTPUT_MODE: mode }, ...args);

const addProfile = (mode: "text" | "json", ...flags: string[]) =>
	run(
		mode,
		...flags,
		"add",
		"profile",
		"quiet-test",
		"--baseUrl",
		"http://localhost:8080",
	);

describe("--quiet", () => {
	test("without it, a mutating command reports success", async () => {
		const result = await addProfile("text");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /Profile 'quiet-test' added/);
	});

	for (const flag of ["--quiet", "-q"]) {
		test(`${flag} hides the success message`, async () => {
			const result = await addProfile("text", flag);
			assert.strictEqual(result.status, 0, result.stderr);
			assert.strictEqual(result.stdout, "");
			assert.strictEqual(result.stderr, "");
		});
	}

	test("works after the verb too", async () => {
		const result = await run(
			"text",
			"add",
			"profile",
			"quiet-test",
			"--baseUrl",
			"http://localhost:8080",
			"--quiet",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.strictEqual(result.stdout, "");
	});

	test("the command still takes effect", async () => {
		await addProfile("text", "--quiet");
		const result = await run("json", "list", "profiles");
		assert.match(result.stdout, /quiet-test/);
	});

	test("in JSON mode, hides the success status record", async () => {
		const result = await addProfile("json", "--quiet");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.strictEqual(result.stdout, "");
		assert.strictEqual(result.stderr, "");
	});

	test("keeps a command's answer", async () => {
		const result = await run("text", "which", "profile", "--quiet");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.notStrictEqual(result.stdout.trim(), "");
	});

	test("keeps the version", async () => {
		const result = await run("text", "--version", "--quiet");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /^c8ctl v/);
	});

	test("keeps data output", async () => {
		await addProfile("text");
		const result = await run("json", "list", "profiles", "--quiet");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /quiet-test/);
	});

	test("keeps warnings", async () => {
		const result = await run(
			"text",
			"which",
			"profile",
			"--no-such-flag",
			"--quiet",
		);
		assert.match(result.stderr, /no-such-flag/);
	});

	test("keeps errors", async () => {
		const result = await run("text", "use", "profile", "missing", "--quiet");
		assert.notStrictEqual(result.status, 0);
		assert.match(result.stderr, /missing/);
	});
});

describe("--quiet in help", () => {
	test("is listed as a global flag", async () => {
		const result = await run("text", "help");
		assert.match(result.stdout, /^\s+--quiet, -q\s+\S/m);
	});
});

const INSTANCE_KEY = "2251799813685249";

/** A stub cluster: creates process instances and has user tasks with no form. */
async function withStubCluster(
	fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
	const server = createServer((req, res) => {
		if (req.method === "POST" && req.url?.endsWith("/process-instances")) {
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					processDefinitionKey: "2251799813685248",
					processDefinitionId: "quiet-process",
					processDefinitionVersion: 1,
					processInstanceKey: INSTANCE_KEY,
					tenantId: "<default>",
					variables: {},
					tags: [],
				}),
			);
			return;
		}
		if (req.url?.includes("/user-tasks/") && req.url.endsWith("/form")) {
			res.statusCode = 204;
			res.end();
			return;
		}
		res.statusCode = 404;
		res.end();
	});
	const port = await listenOnLoopback(server);
	try {
		await fn(`http://127.0.0.1:${port}/v2`);
	} finally {
		await new Promise<void>((done) => server.close(() => done()));
	}
}

const runAgainst = (
	baseUrl: string,
	mode: "text" | "json",
	...args: string[]
) =>
	c8WithEnv(
		{
			C8CTL_DATA_DIR: dataDir,
			C8CTL_OUTPUT_MODE: mode,
			CAMUNDA_BASE_URL: baseUrl,
		},
		...args,
	);

describe("--quiet keeps keys and answers", () => {
	test("create process-instance prints only the new key in text mode", async () => {
		await withStubCluster(async (baseUrl) => {
			const result = await runAgainst(
				baseUrl,
				"text",
				"create",
				"pi",
				"--id",
				"quiet-process",
				"--quiet",
			);
			assert.strictEqual(result.status, 0, result.stderr);
			assert.strictEqual(result.stdout.trim(), INSTANCE_KEY);
		});
	});

	test("create process-instance keeps the key record in JSON mode", async () => {
		await withStubCluster(async (baseUrl) => {
			const result = await runAgainst(
				baseUrl,
				"json",
				"create",
				"pi",
				"--id",
				"quiet-process",
				"--quiet",
			);
			assert.strictEqual(result.status, 0, result.stderr);
			assert.match(
				`${result.stdout}${result.stderr}`,
				new RegExp(`"key":"${INSTANCE_KEY}"`),
			);
		});
	});

	test("an info result is the answer and is kept", async () => {
		await withStubCluster(async (baseUrl) => {
			const result = await runAgainst(
				baseUrl,
				"text",
				"get",
				"form",
				"2251799813685250",
				"--userTask",
				"--quiet",
			);
			assert.strictEqual(result.status, 0, result.stderr);
			assert.match(result.stdout, /has no associated form/);
		});
	});

	test("open --dry-run keeps the URL it would open", async () => {
		const result = await runAgainst(
			"http://127.0.0.1:1/v2",
			"text",
			"open",
			"operate",
			"--dry-run",
			"--quiet",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /http:\/\/127\.0\.0\.1:1\/operate/);
	});

	test("open without --dry-run still hides the status line", async () => {
		const result = await runAgainst(
			"http://127.0.0.1:1/v2",
			"text",
			"open",
			"operate",
			"--quiet",
		);
		assert.doesNotMatch(result.stdout, /Opening operate/);
	});
});
