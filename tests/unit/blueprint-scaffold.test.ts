import assert from "node:assert";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
	type BlueprintFetch,
	type BlueprintProgress,
	type BlueprintResponse,
	BlueprintScaffoldError,
	SETUP_BLUEPRINTS,
	scaffoldSetupBlueprint,
} from "../../src/utils/index.ts";

function jsonResponse(value: unknown): BlueprintResponse {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => value,
		arrayBuffer: async () => new ArrayBuffer(0),
	};
}

function fileResponse(contents: string): BlueprintResponse {
	const bytes = new TextEncoder().encode(contents);
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => ({}),
		arrayBuffer: async () =>
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
	};
}

function errorResponse(status: number, statusText: string): BlueprintResponse {
	return {
		ok: false,
		status,
		statusText,
		json: async () => ({}),
		arrayBuffer: async () => new ArrayBuffer(0),
	};
}

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("SETUP_BLUEPRINTS", () => {
	test("contains exactly the three setup projects and their guides", () => {
		assert.deepStrictEqual(
			SETUP_BLUEPRINTS.map((blueprint) => blueprint.id),
			["rocket-launch", "service-worker", "ai-agent"],
		);
		assert.deepStrictEqual(
			SETUP_BLUEPRINTS.map((blueprint) => blueprint.guideUrl),
			[
				"https://docs.camunda.io/docs/guides/getting-started-hello-world/",
				"https://docs.camunda.io/docs/guides/getting-started-example/",
				"https://docs.camunda.io/docs/guides/getting-started-agentic-orchestration/",
			],
		);
		assert.deepStrictEqual(
			SETUP_BLUEPRINTS.map((blueprint) => blueprint.source.path),
			[
				"1-rocket-launch",
				"2-order-process-with-service-workers",
				"solutions/ai-agent-chat-with-tools",
			],
		);
	});
});

describe("scaffoldSetupBlueprint()", () => {
	test("downloads every file in the selected GitHub project tree", async () => {
		const root = tempDir("c8ctl-blueprint-test-");
		const destination = join(root, "rocket");
		const requestedUrls: string[] = [];
		const progress: BlueprintProgress[] = [];
		const fetch: BlueprintFetch = async (url) => {
			requestedUrls.push(url);
			if (url.includes("/git/trees/main")) {
				return jsonResponse({
					truncated: false,
					tree: [
						{
							path: "1-rocket-launch/README.md",
							type: "blob",
						},
						{
							path: "1-rocket-launch/assets",
							type: "tree",
						},
						{
							path: "1-rocket-launch/assets/diagram.bpmn",
							type: "blob",
						},
						{
							path: "2-order-process-with-service-workers/README.md",
							type: "blob",
						},
					],
				});
			}
			if (url.endsWith("/1-rocket-launch/README.md")) {
				return fileResponse("# Rocket Launch\n");
			}
			if (url.endsWith("/1-rocket-launch/assets/diagram.bpmn")) {
				return fileResponse("<definitions />\n");
			}
			return errorResponse(404, "Not Found");
		};

		try {
			const result = await scaffoldSetupBlueprint({
				id: "rocket-launch",
				destinationDir: destination,
				fetch,
				onProgress: (event) => progress.push(event),
			});

			assert.strictEqual(result.directory, destination);
			assert.deepStrictEqual(result.files, [
				"README.md",
				"assets/diagram.bpmn",
			]);
			assert.strictEqual(
				readFileSync(join(destination, "README.md"), "utf-8"),
				"# Rocket Launch\n",
			);
			assert.strictEqual(
				readFileSync(join(destination, "assets", "diagram.bpmn"), "utf-8"),
				"<definitions />\n",
			);
			assert.ok(
				requestedUrls.some((url) =>
					url.startsWith(
						"https://api.github.com/repos/camunda/camunda-8-get-started/git/trees/main",
					),
				),
			);
			assert.ok(
				requestedUrls.some((url) =>
					url.startsWith(
						"https://raw.githubusercontent.com/camunda/camunda-8-get-started/main/1-rocket-launch/",
					),
				),
			);
			assert.deepStrictEqual(
				progress.map((event) => event.phase),
				["listing", "downloading", "writing", "complete"],
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("uses the blueprint id below the current directory by default", async () => {
		const root = tempDir("c8ctl-blueprint-default-");
		const fetch: BlueprintFetch = async (url) => {
			if (url.includes("/git/trees/main")) {
				return jsonResponse({
					truncated: false,
					tree: [{ path: "1-rocket-launch/README.md", type: "blob" }],
				});
			}
			return fileResponse("# Rocket Launch\n");
		};

		try {
			const result = await scaffoldSetupBlueprint({
				id: "rocket-launch",
				cwd: root,
				fetch,
			});
			assert.strictEqual(result.directory, join(root, "rocket-launch"));
			assert.ok(existsSync(join(root, "rocket-launch", "README.md")));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("accepts an existing empty directory", async () => {
		const root = tempDir("c8ctl-blueprint-empty-");
		const destination = join(root, "project");
		mkdirSync(destination);
		const fetch: BlueprintFetch = async (url) => {
			if (url.includes("/git/trees/main")) {
				return jsonResponse({
					truncated: false,
					tree: [{ path: "1-rocket-launch/README.md", type: "blob" }],
				});
			}
			return fileResponse("# Rocket Launch\n");
		};

		try {
			await scaffoldSetupBlueprint({
				id: "rocket-launch",
				destinationDir: destination,
				fetch,
			});
			assert.strictEqual(
				readFileSync(join(destination, "README.md"), "utf-8"),
				"# Rocket Launch\n",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects an unknown id and lists the supported ids", async () => {
		await assert.rejects(
			scaffoldSetupBlueprint({ id: "unknown" }),
			(error: unknown) => {
				assert.ok(error instanceof BlueprintScaffoldError);
				assert.match(error.message, /Unknown blueprint "unknown"/);
				assert.match(error.message, /rocket-launch, service-worker, ai-agent/);
				return true;
			},
		);
	});

	test("rejects a non-empty destination before fetching", async () => {
		const root = tempDir("c8ctl-blueprint-existing-");
		const destination = join(root, "project");
		mkdirSync(destination, { recursive: true });
		writeFileSync(join(destination, "keep.txt"), "do not overwrite");
		let fetchCount = 0;
		const fetch: BlueprintFetch = async () => {
			fetchCount += 1;
			return jsonResponse({ truncated: false, tree: [] });
		};

		try {
			await assert.rejects(
				scaffoldSetupBlueprint({
					id: "rocket-launch",
					destinationDir: destination,
					fetch,
				}),
				(error: unknown) => {
					assert.ok(error instanceof BlueprintScaffoldError);
					assert.match(error.message, /already exists and is not empty/);
					return true;
				},
			);
			assert.strictEqual(fetchCount, 0);
			assert.strictEqual(
				readFileSync(join(destination, "keep.txt"), "utf-8"),
				"do not overwrite",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("reports an unreachable GitHub host with an actionable hint", async () => {
		const root = tempDir("c8ctl-blueprint-offline-");
		const cause = Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
		const fetch: BlueprintFetch = async () => {
			throw new TypeError("fetch failed", { cause });
		};

		try {
			await assert.rejects(
				scaffoldSetupBlueprint({
					id: "rocket-launch",
					destinationDir: join(root, "project"),
					fetch,
				}),
				(error: unknown) => {
					assert.ok(error instanceof BlueprintScaffoldError);
					assert.match(
						error.message,
						/Could not fetch the blueprint file list/,
					);
					assert.match(error.hint ?? "", /Check your network connection/);
					return true;
				},
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("reports GitHub HTTP failures with status and URL", async () => {
		const root = tempDir("c8ctl-blueprint-http-");
		const fetch: BlueprintFetch = async () => errorResponse(503, "Unavailable");

		try {
			await assert.rejects(
				scaffoldSetupBlueprint({
					id: "rocket-launch",
					destinationDir: join(root, "project"),
					fetch,
				}),
				(error: unknown) => {
					assert.ok(error instanceof BlueprintScaffoldError);
					assert.match(error.message, /HTTP 503 Unavailable/);
					assert.match(error.message, /api\.github\.com/);
					return true;
				},
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("keeps a stalled response body inside the request timeout", async () => {
		const root = tempDir("c8ctl-blueprint-stalled-body-");
		const fetch: BlueprintFetch = async (_url, { signal }) => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: () =>
				new Promise((_, reject) => {
					// Safety net only: the assertion still fails if the request timeout
					// does not abort the body read.
					const fallback = setTimeout(
						() => reject(new Error("body read without timeout")),
						200,
					);
					signal.addEventListener(
						"abort",
						() => {
							clearTimeout(fallback);
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				}),
			arrayBuffer: async () => new ArrayBuffer(0),
		});

		try {
			await assert.rejects(
				scaffoldSetupBlueprint({
					id: "rocket-launch",
					destinationDir: join(root, "project"),
					fetch,
					timeoutMs: 10,
				}),
				(error: unknown) => {
					assert.ok(error instanceof BlueprintScaffoldError);
					assert.match(error.message, /after 0\.01s/);
					assert.match(error.hint ?? "", /Check your network connection/);
					return true;
				},
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("wraps response body read failures in an actionable error", async () => {
		const root = tempDir("c8ctl-blueprint-body-error-");
		const fetch: BlueprintFetch = async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => {
				throw new Error("invalid JSON body");
			},
			arrayBuffer: async () => new ArrayBuffer(0),
		});

		try {
			await assert.rejects(
				scaffoldSetupBlueprint({
					id: "rocket-launch",
					destinationDir: join(root, "project"),
					fetch,
				}),
				(error: unknown) => {
					assert.ok(error instanceof BlueprintScaffoldError);
					assert.match(
						error.message,
						/Could not fetch the blueprint file list from GitHub/,
					);
					assert.match(error.hint ?? "", /Check your network connection/);
					return true;
				},
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rechecks the destination before writing downloaded files", async () => {
		const root = tempDir("c8ctl-blueprint-race-");
		const destination = join(root, "project");
		const fetch: BlueprintFetch = async (url) => {
			if (url.includes("/git/trees/main")) {
				return jsonResponse({
					truncated: false,
					tree: [{ path: "1-rocket-launch/README.md", type: "blob" }],
				});
			}
			mkdirSync(destination, { recursive: true });
			writeFileSync(join(destination, "other.txt"), "created during download");
			return fileResponse("# Rocket Launch\n");
		};

		try {
			await assert.rejects(
				scaffoldSetupBlueprint({
					id: "rocket-launch",
					destinationDir: destination,
					fetch,
				}),
				/already exists and is not empty/,
			);
			assert.strictEqual(
				readFileSync(join(destination, "other.txt"), "utf-8"),
				"created during download",
			);
			assert.strictEqual(existsSync(join(destination, "README.md")), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects a truncated GitHub tree instead of writing a partial project", async () => {
		const root = tempDir("c8ctl-blueprint-truncated-");
		const fetch: BlueprintFetch = async () =>
			jsonResponse({
				truncated: true,
				tree: [{ path: "1-rocket-launch/README.md", type: "blob" }],
			});

		try {
			await assert.rejects(
				scaffoldSetupBlueprint({
					id: "rocket-launch",
					destinationDir: join(root, "project"),
					fetch,
				}),
				/truncated/,
			);
			assert.strictEqual(existsSync(join(root, "project")), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects unsafe paths from the GitHub tree", async () => {
		const root = tempDir("c8ctl-blueprint-path-");
		const fetch: BlueprintFetch = async () =>
			jsonResponse({
				truncated: false,
				tree: [{ path: "1-rocket-launch/../outside.txt", type: "blob" }],
			});

		try {
			await assert.rejects(
				scaffoldSetupBlueprint({
					id: "rocket-launch",
					destinationDir: join(root, "project"),
					fetch,
				}),
				/unsafe path/,
			);
			assert.strictEqual(existsSync(join(root, "outside.txt")), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
