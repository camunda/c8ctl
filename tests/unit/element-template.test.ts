/**
 * Behavioural tests for the element-template commands
 * (default-plugins/element-template/)
 */

import assert from "node:assert";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { isRecord } from "../../src/core/logger.ts";
import { c8, c8WithOptions } from "../utils/cli.ts";
import { asyncSpawn, asyncSpawnWithStdin } from "../utils/spawn.ts";

const FIXTURES_DIR = resolve(import.meta.dirname, "..", "fixtures");
const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = "src/index.ts";
const BPMN_FILE = join(FIXTURES_DIR, "simple.bpmn");
const TEMPLATE_FILE = join(FIXTURES_DIR, "http-json-connector.json");
const AGENT_DEFINITION_TEMPLATE_FILE = join(
	FIXTURES_DIR,
	"agent-definition-template.json",
);

async function c8text(...args: string[]) {
	const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
	writeFileSync(
		join(dataDir, "session.json"),
		JSON.stringify({ outputMode: "text" }),
	);
	try {
		return await asyncSpawn(
			"node",
			["--experimental-strip-types", CLI, ...args],
			{
				env: {
					...process.env,
					CAMUNDA_BASE_URL: "http://test-cluster/v2",
					HOME: "/tmp/c8ctl-test-nonexistent-home",
					C8CTL_DATA_DIR: dataDir,
				},
			},
		);
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// XML assertion helpers
// ---------------------------------------------------------------------------

function getInputValue(xml: string, target: string): string | null {
	const re = new RegExp(
		`<zeebe:input\\s+(?=.*target="${target}")(?=.*source="([^"]*)")`,
	);
	const match = xml.match(re);
	return match ? match[1] : null;
}

function hasInput(xml: string, target: string): boolean {
	return new RegExp(`<zeebe:input[^>]+target="${target}"`).test(xml);
}

function makeVersionedFooTemplates() {
	return [
		{
			id: "io.example.Foo",
			name: "Foo Connector",
			version: 1,
			engines: { camunda: "^8.7" },
			description: "v1 template",
			properties: [
				{
					id: "v1-only",
					label: "v1-only",
					binding: { type: "zeebe:input", name: "v1-only" },
					type: "String",
				},
			],
		},
		{
			id: "io.example.Foo",
			name: "Foo Connector",
			version: 2,
			engines: { camunda: "^8.9" },
			description: "v2 template",
			properties: [
				{
					id: "v2-only",
					label: "v2-only",
					binding: { type: "zeebe:input", name: "v2-only" },
					type: "String",
				},
			],
		},
	];
}

function getTaskDefinitionType(xml: string): string | null {
	const match = xml.match(/<zeebe:taskDefinition[^>]+type="([^"]*)"/);
	return match ? match[1] : null;
}

function getAgentDefinitionAgentType(xml: string): string | null {
	const match = xml.match(/<zeebe:agentDefinition[^>]+agentType="([^"]*)"/);
	return match ? match[1] : null;
}

function getTaskHeaderValue(xml: string, key: string): string | null {
	const re = new RegExp(
		`<zeebe:header\\s+(?=[^>]*key="${key}")(?=[^>]*value="([^"]*)")`,
	);
	const match = xml.match(re);
	return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// element-template verb
// ---------------------------------------------------------------------------

describe("CLI behavioural: element-template verb", () => {
	test("element-template with no subcommand lists available subcommands and exits 1", async () => {
		const result = await c8text("element-template");
		const output = result.stdout + result.stderr;
		assert.strictEqual(result.status, 1);
		assert.ok(output.includes("apply"), "Should list apply");
		assert.ok(output.includes("info"), "Should list info");
		assert.ok(output.includes("get-properties"), "Should list get-properties");
		// `get` should appear as its own subcommand name (not just a prefix of
		// `get-properties`). The hint format is `..., get, sync`, so look for
		// the bounded form.
		assert.ok(/\bget\b(?!-)/.test(output), "Should list get");
	});
});

// ---------------------------------------------------------------------------
// element-template apply
// ---------------------------------------------------------------------------

describe("CLI behavioural: element-template apply", () => {
	test("applies REST connector template with correct task definition", async () => {
		const result = await c8text(
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(
			getTaskDefinitionType(result.stdout),
			"io.camunda:http-json:1",
		);
		assert.strictEqual(getInputValue(result.stdout, "method"), "GET");
		assert.ok(hasInput(result.stdout, "url"), "Should have url input");
	});

	test("applies template in-place and modifies file", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
		const tempBpmn = join(tempDir, "test.bpmn");
		writeFileSync(tempBpmn, readFileSync(BPMN_FILE, "utf-8"));
		try {
			const result = await c8text(
				"element-template",
				"apply",
				"--in-place",
				TEMPLATE_FILE,
				"Activity_17s7axj",
				tempBpmn,
			);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			const modified = readFileSync(tempBpmn, "utf-8");
			assert.strictEqual(
				getTaskDefinitionType(modified),
				"io.camunda:http-json:1",
			);
			assert.strictEqual(getInputValue(modified, "method"), "GET");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("apply --in-place falls back to a direct write on EXDEV", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
		const tempBpmn = join(tempDir, "test.bpmn");
		writeFileSync(tempBpmn, readFileSync(BPMN_FILE, "utf-8"));
		const exdev = `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; const rename = fs.renameSync; fs.renameSync = (from, to) => { if (String(to).endsWith(".bpmn")) throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); return rename(from, to); }; syncBuiltinESMExports();`;
		try {
			const result = await c8WithOptions(
				{
					nodeArgs: [
						"--import",
						`data:text/javascript,${encodeURIComponent(exdev)}`,
					],
					env: { C8CTL_OUTPUT_MODE: "text" },
				},
				"element-template",
				"apply",
				"--in-place",
				TEMPLATE_FILE,
				"Activity_17s7axj",
				tempBpmn,
			);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			assert.strictEqual(
				getTaskDefinitionType(readFileSync(tempBpmn, "utf-8")),
				"io.camunda:http-json:1",
			);
			assert.deepStrictEqual(
				readdirSync(tempDir).filter((name) => name.endsWith(".tmp")),
				[],
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// Simulates another writer committing between the read and the replace.
	const concurrentWrite = `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; const write = fs.writeFileSync; fs.writeFileSync = (path, ...rest) => { if (String(path).endsWith(".tmp")) write(process.env.C8CTL_TEST_RACE_TARGET, "concurrent"); return write(path, ...rest); }; syncBuiltinESMExports();`;
	const exdev = `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; const rename = fs.renameSync; fs.renameSync = (from, to) => { if (String(to).endsWith(".bpmn")) throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); return rename(from, to); }; syncBuiltinESMExports();`;
	for (const [command, preloads] of [
		["apply", [concurrentWrite]],
		["apply", [concurrentWrite, exdev]],
		["edit", [concurrentWrite]],
	] as const) {
		test(`${command} --in-place keeps a concurrent write${preloads.length > 1 ? " on EXDEV" : ""}`, async () => {
			const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
			const tempBpmn = join(tempDir, "test.bpmn");
			writeFileSync(tempBpmn, readFileSync(BPMN_FILE, "utf-8"));
			const dataDir = join(tempDir, "data");
			mkdirSync(join(dataDir, "element-templates"), { recursive: true });
			writeFileSync(
				join(dataDir, "element-templates", "templates.json"),
				`[${readFileSync(TEMPLATE_FILE, "utf-8")}]`,
			);
			writeFileSync(
				join(dataDir, "element-templates", "fetched-at"),
				String(Date.now()),
			);
			try {
				if (command === "edit") {
					const applied = await c8WithOptions(
						{ env: { C8CTL_DATA_DIR: dataDir, C8CTL_OUTPUT_MODE: "text" } },
						"element-template",
						"apply",
						"--in-place",
						TEMPLATE_FILE,
						"Activity_17s7axj",
						tempBpmn,
					);
					assert.strictEqual(applied.status, 0, applied.stderr);
				}
				const args =
					command === "apply"
						? [
								"apply",
								"--in-place",
								TEMPLATE_FILE,
								"Activity_17s7axj",
								tempBpmn,
							]
						: [
								"edit",
								"--in-place",
								"Activity_17s7axj",
								tempBpmn,
								"--set",
								"method=PUT",
							];
				const result = await c8WithOptions(
					{
						nodeArgs: preloads.flatMap((code) => [
							"--import",
							`data:text/javascript,${encodeURIComponent(code)}`,
						]),
						env: {
							C8CTL_DATA_DIR: dataDir,
							C8CTL_OUTPUT_MODE: "text",
							C8CTL_TEST_RACE_TARGET: tempBpmn,
						},
					},
					"element-template",
					...args,
				);
				assert.strictEqual(result.status, 1, result.stderr);
				assert.match(result.stderr, /BPMN changed while this command ran/);
				assert.strictEqual(readFileSync(tempBpmn, "utf-8"), "concurrent");
				assert.deepStrictEqual(
					readdirSync(tempDir).filter((name) => name.endsWith(".tmp")),
					[],
				);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
	}

	describe("--in-place through a symlink", {
		skip:
			process.platform === "win32"
				? "creating symlinks needs elevated rights on Windows"
				: false,
	}, () => {
		// The link and its target sit in sibling directories. The data dir
		// caches the template so `edit` can resolve it by id.
		function linkedWorkspace() {
			const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
			mkdirSync(join(tempDir, "shared"));
			mkdirSync(join(tempDir, "models"));
			const target = join(tempDir, "shared", "model.bpmn");
			const link = join(tempDir, "models", "model.bpmn");
			writeFileSync(target, readFileSync(BPMN_FILE, "utf-8"));
			symlinkSync(join("..", "shared", "model.bpmn"), link);
			const dataDir = join(tempDir, "data");
			mkdirSync(join(dataDir, "element-templates"), { recursive: true });
			writeFileSync(
				join(dataDir, "element-templates", "templates.json"),
				`[${readFileSync(TEMPLATE_FILE, "utf-8")}]`,
			);
			writeFileSync(
				join(dataDir, "element-templates", "fetched-at"),
				String(Date.now()),
			);
			const run = (nodeArgs: string[], ...args: string[]) =>
				c8WithOptions(
					{
						nodeArgs,
						env: { C8CTL_DATA_DIR: dataDir, C8CTL_OUTPUT_MODE: "text" },
					},
					"element-template",
					...args,
				);
			const tmpFiles = () =>
				["shared", "models"].flatMap((sub) =>
					readdirSync(join(tempDir, sub)).filter((name) =>
						name.endsWith(".tmp"),
					),
				);
			return { tempDir, dataDir, target, link, run, tmpFiles };
		}

		const exdevPreload = [
			"--import",
			`data:text/javascript,${encodeURIComponent(exdev)}`,
		];
		for (const [label, nodeArgs] of [
			["", []],
			[" on EXDEV", exdevPreload],
		] as const) {
			test(`apply writes the target and keeps the link${label}`, async () => {
				const { tempDir, target, link, run, tmpFiles } = linkedWorkspace();
				try {
					const result = await run(
						[...nodeArgs],
						"apply",
						"--in-place",
						TEMPLATE_FILE,
						"Activity_17s7axj",
						link,
					);
					assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
					assert.ok(lstatSync(link).isSymbolicLink(), "link must survive");
					assert.strictEqual(
						getTaskDefinitionType(readFileSync(target, "utf-8")),
						"io.camunda:http-json:1",
					);
					assert.deepStrictEqual(tmpFiles(), []);
				} finally {
					rmSync(tempDir, { recursive: true, force: true });
				}
			});
		}

		test("edit writes the target and keeps the link", async () => {
			const { tempDir, target, link, run, tmpFiles } = linkedWorkspace();
			try {
				const applied = await run(
					[],
					"apply",
					"--in-place",
					TEMPLATE_FILE,
					"Activity_17s7axj",
					target,
				);
				assert.strictEqual(applied.status, 0, applied.stderr);
				const result = await run(
					[],
					"edit",
					"--in-place",
					"Activity_17s7axj",
					link,
					"--set",
					"method=PUT",
				);
				assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
				assert.ok(lstatSync(link).isSymbolicLink(), "link must survive");
				assert.strictEqual(
					getInputValue(readFileSync(target, "utf-8"), "method"),
					"PUT",
				);
				assert.deepStrictEqual(tmpFiles(), []);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		// Retargets the link right after the command reads it. Both files hold
		// the same XML, so only a path pinned before the read keeps the write
		// on the file that was read.
		const retargetAfterRead = `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; const read = fs.readFileSync; let done = false; fs.readFileSync = (path, ...rest) => { const out = read(path, ...rest); if (!done && String(path) === process.env.C8CTL_TEST_LINK) { done = true; fs.unlinkSync(process.env.C8CTL_TEST_LINK); fs.symlinkSync(process.env.C8CTL_TEST_LINK_TO, process.env.C8CTL_TEST_LINK); } return out; }; syncBuiltinESMExports();`;
		for (const command of ["apply", "edit"] as const) {
			test(`${command} writes the file it read when the link is retargeted`, async () => {
				const { tempDir, dataDir, target, link, run, tmpFiles } =
					linkedWorkspace();
				try {
					if (command === "edit") {
						const applied = await run(
							[],
							"apply",
							"--in-place",
							TEMPLATE_FILE,
							"Activity_17s7axj",
							target,
						);
						assert.strictEqual(applied.status, 0, applied.stderr);
					}
					const other = join(tempDir, "shared", "other.bpmn");
					writeFileSync(other, readFileSync(target));
					const before = readFileSync(other, "utf-8");
					const args =
						command === "apply"
							? ["apply", "--in-place", TEMPLATE_FILE, "Activity_17s7axj", link]
							: [
									"edit",
									"--in-place",
									"Activity_17s7axj",
									link,
									"--set",
									"method=PUT",
								];
					const result = await c8WithOptions(
						{
							nodeArgs: [
								"--import",
								`data:text/javascript,${encodeURIComponent(retargetAfterRead)}`,
							],
							env: {
								C8CTL_DATA_DIR: dataDir,
								C8CTL_OUTPUT_MODE: "text",
								C8CTL_TEST_LINK: link,
								C8CTL_TEST_LINK_TO: join("..", "shared", "other.bpmn"),
							},
						},
						"element-template",
						...args,
					);
					assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
					assert.strictEqual(
						realpathSync(link),
						realpathSync(other),
						"the hook must have retargeted the link",
					);
					assert.strictEqual(readFileSync(other, "utf-8"), before);
					const written = readFileSync(target, "utf-8");
					if (command === "apply")
						assert.strictEqual(
							getTaskDefinitionType(written),
							"io.camunda:http-json:1",
						);
					else assert.strictEqual(getInputValue(written, "method"), "PUT");
					assert.deepStrictEqual(tmpFiles(), []);
				} finally {
					rmSync(tempDir, { recursive: true, force: true });
				}
			});
		}

		test("apply reports a dangling link by path", async () => {
			const { tempDir, target, link, run, tmpFiles } = linkedWorkspace();
			rmSync(target);
			try {
				const result = await run(
					[],
					"apply",
					"--in-place",
					TEMPLATE_FILE,
					"Activity_17s7axj",
					link,
				);
				assert.strictEqual(result.status, 1, result.stderr);
				assert.match(result.stderr, /File not found: .*model\.bpmn/);
				assert.ok(lstatSync(link).isSymbolicLink(), "link must survive");
				assert.strictEqual(existsSync(target), false);
				assert.deepStrictEqual(tmpFiles(), []);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	test("missing template file exits 1", async () => {
		const result = await c8text(
			"element-template",
			"apply",
			"/nonexistent/template.json",
			"Activity_17s7axj",
			BPMN_FILE,
		);
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("not found") || output.includes("Failed"),
			"Should report missing template",
		);
	});

	test("nonexistent element ID exits 1", async () => {
		const result = await c8text(
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"NonExistent_Element",
			BPMN_FILE,
		);
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("not found") || output.includes("Error"),
			"Should report element not found",
		);
	});

	test("applies a Hidden property bound to zeebe:agentDefinition (bpmn-moddle/zeebe-bpmn-moddle schema regression)", async () => {
		// zeebe-bpmn-moddle@1.11.0's schema doesn't know about the
		// `zeebe:agentDefinition` extension element (added for the AI Agent
		// connector templates): bpmn-moddle silently drops any property bound
		// to it during serialization instead of erroring, so `apply` exits 0
		// but the output is missing the extension entirely.
		const result = await c8text(
			"element-template",
			"apply",
			AGENT_DEFINITION_TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(
			getAgentDefinitionAgentType(result.stdout),
			"aiAgentTask",
		);
	});
});

// ---------------------------------------------------------------------------
// element-template apply --set
// ---------------------------------------------------------------------------

describe("CLI behavioural: element-template apply --set", () => {
	test("--set method=POST sets the input mapping value", async () => {
		const result = await c8text(
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
			"--set",
			"method=POST",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(getInputValue(result.stdout, "method"), "POST");
	});

	test("multiple --set flags set multiple values", async () => {
		const result = await c8text(
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
			"--set",
			"method=POST",
			"--set",
			"url=https://example.com/api",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(getInputValue(result.stdout, "method"), "POST");
		assert.strictEqual(
			getInputValue(result.stdout, "url"),
			"https://example.com/api",
		);
	});

	test("--set with value containing = splits on first = only", async () => {
		const result = await c8text(
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
			"--set",
			"method=POST",
			"--set",
			"url=https://example.com?foo=bar",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(
			getInputValue(result.stdout, "url"),
			"https://example.com?foo=bar",
		);
	});

	test("--set rejects invalid dropdown value", async () => {
		const result = await c8text(
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
			"--set",
			"method=YOLO",
		);
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(output.includes("Invalid value"), "Should reject invalid value");
		assert.ok(output.includes("POST"), "Should list valid choices");
	});

	test("--set rejects unknown property name", async () => {
		const result = await c8text(
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
			"--set",
			"nonexistent=value",
		);
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes('Unknown property "nonexistent"'),
			"Should report unknown property",
		);
		assert.ok(output.includes("method"), "Should list available properties");
	});

	test("--set rejects malformed key=value (missing =)", async () => {
		const result = await c8text(
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
			"--set",
			"methodPOST",
		);
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("Invalid --set format"),
			"Should report format error",
		);
	});

	test("--set warns when conditional property is not applied", async () => {
		const result = await c8text(
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
			"--set",
			'body={"hello":"world"}',
		);
		assert.strictEqual(result.status, 0, "Should still succeed");
		assert.ok(
			result.stderr.includes("not applied"),
			"Should warn about unmet condition on stderr",
		);
		assert.ok(
			hasInput(result.stdout, "body") === false,
			"body should not appear in output",
		);
	});

	test("--set conditional property works when condition is satisfied", async () => {
		const result = await c8text(
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
			"--set",
			"method=POST",
			"--set",
			'body={"hello":"world"}',
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(getInputValue(result.stdout, "method"), "POST");
		assert.ok(hasInput(result.stdout, "body"), "body should appear in output");
	});

	test("--set with binding type prefix works", async () => {
		const result = await c8text(
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
			"--set",
			"input:method=POST",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(getInputValue(result.stdout, "method"), "POST");
	});

	test("--set rejects unknown binding type prefix", async () => {
		const result = await c8text(
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
			"--set",
			"bogus:method=POST",
		);
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("Unknown binding type prefix"),
			"Should reject unknown prefix",
		);
	});

	test("--set overrides existing dropdown value on re-apply", async () => {
		// bpmn-js-element-templates' applyTemplate preserves an existing
		// Dropdown value as long as it's a valid choice. CLI users expect
		// --set to win regardless — verify the post-apply override does that.
		const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
		const tempBpmn = join(tempDir, "test.bpmn");
		writeFileSync(tempBpmn, readFileSync(BPMN_FILE, "utf-8"));
		try {
			// First apply: default method (GET).
			const first = await c8text(
				"element-template",
				"apply",
				"--in-place",
				TEMPLATE_FILE,
				"Activity_17s7axj",
				tempBpmn,
			);
			assert.strictEqual(first.status, 0, `stderr: ${first.stderr}`);
			const afterFirst = readFileSync(tempBpmn, "utf-8");
			assert.strictEqual(getInputValue(afterFirst, "method"), "GET");

			// Re-apply with --set method=POST plus a method-conditional input.
			const second = await c8text(
				"element-template",
				"apply",
				"--in-place",
				TEMPLATE_FILE,
				"Activity_17s7axj",
				tempBpmn,
				"--set",
				"method=POST",
				"--set",
				'body={"hello":"world"}',
			);
			assert.strictEqual(second.status, 0, `stderr: ${second.stderr}`);
			const afterSecond = readFileSync(tempBpmn, "utf-8");
			assert.strictEqual(
				getInputValue(afterSecond, "method"),
				"POST",
				"--set should overwrite the preserved Dropdown value",
			);
			assert.ok(
				hasInput(afterSecond, "body"),
				"conditional dependent should be created after gating property changed",
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// -------------------------------------------------------------------------
	// FEEL auto-prepend (feel: required) and whitespace trim
	// -------------------------------------------------------------------------

	test("--set trims leading/trailing whitespace from value", async () => {
		// method is a Dropdown with feel: optional; trimming should produce
		// the valid choice value 'POST' so the whole apply succeeds.
		const result = await c8text(
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
			"--set",
			"method=  POST  ",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(getInputValue(result.stdout, "method"), "POST");
	});

	test("--set preserves internal whitespace in value", async () => {
		// Verify that internal whitespace is not stripped. Pass the FEEL
		// expression `a + b` (spaces around operator) without the `=` prefix;
		// after auto-prepend for feel:required the stored expression is `=a + b`,
		// which is valid FEEL and has internal whitespace.
		const result = await c8text(
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
			"--set",
			"headers=a + b",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		// = auto-prepended for feel:required; internal whitespace preserved.
		assert.strictEqual(getInputValue(result.stdout, "headers"), "=a + b");
	});

	test("--set auto-prepends = for feel: required property (no leading =)", async () => {
		// 'headers' has feel: required; supplying 'myHeaders' (no =) should
		// produce '=myHeaders' in the output BPMN.
		const result = await c8text(
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
			"--set",
			"headers=myHeaders",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(getInputValue(result.stdout, "headers"), "=myHeaders");
	});

	test("--set does not double-prepend = when value already starts with = (feel: required)", async () => {
		// When the user already wrote the FEEL marker, the auto-prepend is a no-op.
		const result = await c8text(
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
			"--set",
			"headers==myHeaders",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(getInputValue(result.stdout, "headers"), "=myHeaders");
	});

	test("--set does not auto-prepend = for feel: optional property", async () => {
		// 'url' has feel: optional — the raw value must be stored as-is.
		const result = await c8text(
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
			"--set",
			"url=https://example.com",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(
			getInputValue(result.stdout, "url"),
			"https://example.com",
		);
	});

	test("--set combined: whitespace trim + feel: required auto-prepend", async () => {
		// '  myHeaders  ' trimmed → 'myHeaders', then = prepended → '=myHeaders'
		const result = await c8text(
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
			"--set",
			"headers=  myHeaders  ",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(getInputValue(result.stdout, "headers"), "=myHeaders");
	});

	test("--set combined: trim after = + no double-prepend for feel: required", async () => {
		// '=  myHeaders  ' trimmed → '=myHeaders' (trim, then no prepend since starts with =)
		const result = await c8text(
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
			"--set",
			"headers==  myHeaders  ",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(getInputValue(result.stdout, "headers"), "=myHeaders");
	});
});

// ---------------------------------------------------------------------------
// element-template info — template metadata card only
// ---------------------------------------------------------------------------

describe("CLI behavioural: element-template info", () => {
	test("renders the template metadata as a keyed card", async () => {
		const result = await c8text("element-template", "info", TEMPLATE_FILE);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const output = result.stdout;

		// Title and every metadata row use schema field names verbatim.
		assert.ok(
			output.includes("REST Outbound Connector"),
			"Header should include template name",
		);
		assert.ok(
			/^\s+ID\s+io\.camunda\.connectors\.HttpJson\.v2/m.test(output),
			"Should render ID row",
		);
		assert.ok(/^\s+Version\s+13/m.test(output), "Should render Version row");
		assert.ok(
			/^\s+Applies to\s+bpmn:Task → bpmn:ServiceTask/m.test(output),
			"Applies to row should carry the source → target arrow",
		);
		assert.ok(
			/^\s+Engines\s+\^8\.9/m.test(output),
			"Should render Engines row",
		);
		assert.ok(
			/^\s+Description\s+Invoke REST API/m.test(output),
			"Should render Description row",
		);
		assert.ok(
			/^\s+Docs\s+https:\/\/docs\.camunda\.io/m.test(output),
			"Should render Docs row",
		);
	});

	test("does not render any property rows or group headings", async () => {
		const result = await c8text("element-template", "info", TEMPLATE_FILE);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const output = result.stdout;
		assert.ok(
			!/^\s+authentication\.token\s/m.test(output),
			"Should not render property rows",
		);
		assert.ok(
			!/^Authentication\s+\(authentication\)/m.test(output),
			"Should not render group headings",
		);
	});

	test("trailing hint points users at get-properties", async () => {
		const result = await c8text("element-template", "info", TEMPLATE_FILE);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			result.stdout.includes("For settable properties"),
			"Should print the property-listing hint",
		);
		assert.ok(
			result.stdout.includes(
				`c8ctl element-template get-properties ${TEMPLATE_FILE}`,
			),
			"Hint should reference the get-properties subcommand",
		);
	});

	test("JSON output is the metadata summary only — no properties or groups", async () => {
		const result = await c8("element-template", "info", TEMPLATE_FILE);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed: unknown = JSON.parse(result.stdout);
		assert.ok(isRecord(parsed), "JSON output should be an object");

		// Schema-aligned metadata fields — verbatim names.
		assert.strictEqual(parsed.name, "REST Outbound Connector");
		assert.strictEqual(parsed.id, "io.camunda.connectors.HttpJson.v2");
		assert.strictEqual(parsed.version, 13);
		assert.strictEqual(parsed.description, "Invoke REST API");
		assert.deepStrictEqual(parsed.appliesTo, ["bpmn:Task"]);
		assert.ok(
			isRecord(parsed.elementType) &&
				parsed.elementType.value === "bpmn:ServiceTask",
			"elementType is the schema's object form { value }",
		);
		assert.ok(
			isRecord(parsed.engines) && parsed.engines.camunda === "^8.9",
			"engines is the schema's object form { camunda }",
		);
		assert.strictEqual(
			parsed.documentationRef,
			"https://docs.camunda.io/docs/components/connectors/protocol/rest/",
		);

		// Properties / groups absent — they belong to get-properties.
		assert.ok(!("properties" in parsed), "info JSON should omit `properties`");
		assert.ok(
			!("groups" in parsed),
			"info JSON should omit `groups` (those are surfaced by get-properties)",
		);
	});

	test("rejects positional property names", async () => {
		const result = await c8text(
			"element-template",
			"info",
			TEMPLATE_FILE,
			"url",
		);
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("Unexpected argument") && output.includes("url"),
			"Error should report the unexpected argument",
		);
	});

	test("rejects --group", async () => {
		const result = await c8text(
			"element-template",
			"info",
			TEMPLATE_FILE,
			"--group",
			"endpoint",
		);
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("Unknown flag: --group"),
			"Error should report --group as an unknown flag",
		);
	});

	test("missing template file exits 1", async () => {
		const result = await c8text(
			"element-template",
			"info",
			"/nonexistent/template.json",
		);
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("not found") || output.includes("Failed"),
			"Should report missing template",
		);
	});
});

describe("CLI behavioural: element-template info --engine-version", () => {
	test("selects latest compatible version for unpinned OOTB ids", async () => {
		const result = await elementTemplateWithSeed(
			makeVersionedFooTemplates(),
			"json",
			"info",
			"io.example.Foo",
			"--engine-version",
			"8.8.0",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed: unknown = JSON.parse(result.stdout);
		assert.ok(isRecord(parsed));
		assert.strictEqual(parsed.id, "io.example.Foo");
		assert.strictEqual(
			parsed.version,
			1,
			"Should resolve to compatible version",
		);
	});

	test("pinned @<version> wins over --engine-version", async () => {
		const result = await elementTemplateWithSeed(
			makeVersionedFooTemplates(),
			"json",
			"info",
			"io.example.Foo@2",
			"--engine-version",
			"8.8.0",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed: unknown = JSON.parse(result.stdout);
		assert.ok(isRecord(parsed));
		assert.strictEqual(parsed.version, 2);
		assert.ok(
			(result.stdout + result.stderr).includes("Ignoring --engine-version"),
			"Expected warning that pinned version takes precedence",
		);
	});

	test("errors with apply-compatible message shape when no compatible version exists", async () => {
		const result = await elementTemplateWithSeed(
			makeVersionedFooTemplates(),
			"text",
			"info",
			"io.example.Foo",
			"--engine-version",
			"7.0.0",
		);
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes(
				"has no version compatible with execution platform 7.0.0. Available:",
			),
			`Unexpected error shape: ${output}`,
		);
	});
});

// ---------------------------------------------------------------------------
// element-template get — raw JSON passthrough
// ---------------------------------------------------------------------------

describe("CLI behavioural: element-template get", () => {
	test("local file: stdout is byte-identical to the source", async () => {
		const result = await c8text("element-template", "get", TEMPLATE_FILE);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const source = readFileSync(TEMPLATE_FILE, "utf-8");
		assert.strictEqual(
			result.stdout,
			source,
			"get should pass file bytes through unchanged",
		);
	});

	test("local file: stderr stays empty so redirect targets are clean", async () => {
		const result = await c8text("element-template", "get", TEMPLATE_FILE);
		assert.strictEqual(result.status, 0);
		assert.strictEqual(result.stderr, "", "stderr must be empty for piping");
	});

	test("OOTB id with no cache exits 1 and points at sync", async () => {
		// `get` deliberately does NOT auto-bootstrap: the bootstrap log
		// would corrupt redirected JSON output. Cache miss must surface
		// as an explicit error instructing the user to run `sync`.
		const result = await c8text(
			"element-template",
			"get",
			"io.camunda.connectors.HttpJson.v2",
		);
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("cache not found") &&
				result.stderr.includes("c8ctl element-template sync"),
			"Error should mention cache + the sync command",
		);
		assert.strictEqual(
			result.stdout,
			"",
			"stdout must stay empty when erroring",
		);
	});

	test("missing template argument exits 1", async () => {
		const result = await c8text("element-template", "get");
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("Missing template argument"),
			"Should report missing template",
		);
	});

	test("unexpected positional arg exits 1", async () => {
		const result = await c8text(
			"element-template",
			"get",
			TEMPLATE_FILE,
			"extra",
		);
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("Unexpected argument") && output.includes("extra"),
			"Should reject the extra positional",
		);
	});

	test("missing local file exits 1", async () => {
		const result = await c8text(
			"element-template",
			"get",
			"/nonexistent/template.json",
		);
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("not found") || output.includes("Failed"),
			"Should report missing file",
		);
	});

	test("--no-icon strips the icon field from a local file", async () => {
		// Sanity-check that the fixture actually has an icon — otherwise
		// the --no-icon assertion below could pass for the wrong reason.
		const source = readFileSync(TEMPLATE_FILE, "utf-8");
		assert.ok(
			source.includes('"icon"'),
			"fixture must include an icon field for this test to be meaningful",
		);

		const result = await c8text(
			"element-template",
			"get",
			TEMPLATE_FILE,
			"--no-icon",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed = JSON.parse(result.stdout);
		assert.ok(
			!Object.hasOwn(parsed, "icon"),
			"--no-icon must drop the icon field",
		);
		// Other fields should remain.
		assert.ok(
			Array.isArray(parsed.properties),
			"properties array must be preserved",
		);
	});
});

// ---------------------------------------------------------------------------
// element-template get-properties — detail cards (with globs)
// ---------------------------------------------------------------------------

describe("CLI behavioural: element-template get-properties", () => {
	test("default: condensed list — group + name + description", async () => {
		const result = await c8text(
			"element-template",
			"get-properties",
			TEMPLATE_FILE,
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const output = result.stdout;

		// Group headings carry the label and the (id) suffix so the
		// --group filter token is self-documenting.
		assert.ok(
			/HTTP endpoint \(endpoint\)/.test(output),
			"Should show 'HTTP endpoint (endpoint)' group heading",
		);
		assert.ok(
			/Authentication \(authentication\)/.test(output),
			"Should show 'Authentication (authentication)' group heading",
		);
		// Each row carries name + description (or label as fallback).
		// authentication.type has a description; url has only a label.
		assert.ok(
			output.includes(
				"Choose the authentication type. Select 'None' if no authentication is necessary",
			),
			"Should show authentication.type description",
		);
		assert.ok(
			/^\s+url\s+URL/m.test(output),
			"Should fall back to label when description is absent (url's label is 'URL')",
		);
		// No technical fields — that's --detailed territory.
		assert.ok(
			!/^\s+Type\s+String/m.test(output),
			"Condensed view should not include the Type row",
		);
		assert.ok(
			!output.includes("required"),
			"Condensed view should not include the required badge",
		);
	});

	test("default: trailing hint covers name filtering and --detailed", async () => {
		const result = await c8text(
			"element-template",
			"get-properties",
			TEMPLATE_FILE,
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			result.stdout.includes("Filter by name"),
			"Should hint at name filtering",
		);
		assert.ok(
			result.stdout.includes(`get-properties ${TEMPLATE_FILE} --detailed`),
			"Should hint at --detailed for full per-property fields",
		);
	});

	test("default condensed JSON: { count, total, groups, properties }", async () => {
		const result = await c8(
			"element-template",
			"get-properties",
			TEMPLATE_FILE,
			"--group",
			"endpoint",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed: unknown = JSON.parse(result.stdout);
		assert.ok(isRecord(parsed));

		// Top-level shape: count + total + groups + properties only.
		// Template metadata (name/id/version/description/...) lives on
		// `info`, not here.
		assert.deepStrictEqual(
			Object.keys(parsed).sort(),
			["count", "groups", "properties", "total"],
			"JSON keys should be exactly count, total, groups, properties",
		);
		const count = parsed.count;
		const total = parsed.total;
		assert.ok(typeof count === "number" && typeof total === "number");
		assert.ok(
			count > 0 && count < total,
			"--group filter should drop count below total",
		);

		// groups is the FULL template.groups, not just rendered ones —
		// JSON consumers can resolve any group id without re-fetching.
		assert.ok(Array.isArray(parsed.groups));
		const groupIds = parsed.groups
			.map((g: unknown) => (isRecord(g) ? g.id : null))
			.filter(Boolean);
		assert.ok(
			groupIds.includes("endpoint") &&
				groupIds.includes("authentication") &&
				groupIds.includes("output"),
			"groups should include every template group, not just rendered ones",
		);

		// Per-property: condensed shape (no detailed fields).
		assert.ok(Array.isArray(parsed.properties));
		const url = parsed.properties.find(
			(p: unknown): p is Record<string, unknown> =>
				isRecord(p) && isRecord(p.binding) && p.binding.name === "url",
		);
		assert.ok(url, "Should include url");
		assert.strictEqual(url.label, "URL");
		assert.strictEqual(url.group, "endpoint");
		// Detailed-only fields are absent.
		assert.ok(!("type" in url), "Condensed JSON should omit type");
		assert.ok(
			!("constraints" in url),
			"Condensed JSON should omit constraints",
		);
		assert.ok(!("optional" in url), "Condensed JSON should omit optional");
		// Template metadata is absent at top level.
		assert.ok(!("name" in parsed), "Should not include template name");
		assert.ok(!("id" in parsed), "Should not include template id");
		assert.ok(!("version" in parsed), "Should not include template version");
		assert.ok(
			!("documentationRef" in parsed),
			"Should not include documentationRef",
		);
	});

	test("default text shows 'Showing X of Y properties.' summary", async () => {
		// Unfiltered: count == total.
		const all = await c8text(
			"element-template",
			"get-properties",
			TEMPLATE_FILE,
		);
		assert.strictEqual(all.status, 0, `stderr: ${all.stderr}`);
		assert.ok(
			/Showing \d+ of \d+ properties\./.test(all.stdout),
			"Should include the count/total summary",
		);
		const allMatch = all.stdout.match(/Showing (\d+) of (\d+) properties\./);
		assert.ok(allMatch);
		assert.strictEqual(allMatch[1], allMatch[2], "Unfiltered: count == total");

		// Filtered: count < total.
		const filtered = await c8text(
			"element-template",
			"get-properties",
			TEMPLATE_FILE,
			"--group",
			"endpoint",
		);
		const filteredMatch = filtered.stdout.match(
			/Showing (\d+) of (\d+) properties\./,
		);
		assert.ok(filteredMatch);
		assert.ok(
			Number(filteredMatch[1]) < Number(filteredMatch[2]),
			"Filtered: count < total",
		);
		assert.strictEqual(
			filteredMatch[2],
			allMatch[2],
			"`total` should be stable regardless of filters",
		);
	});

	test("--detailed renders a full detail card per property", async () => {
		const result = await c8text(
			"element-template",
			"get-properties",
			TEMPLATE_FILE,
			"--detailed",
			"url",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const output = result.stdout;

		assert.ok(/^\s+Type\s+String/m.test(output), "Card should have Type field");
		assert.ok(
			/^\s+Required\s+yes/m.test(output),
			"Card should mark url as Required: yes",
		);
		assert.ok(
			/^\s+FEEL\s+optional/m.test(output),
			"Card should expose FEEL level",
		);
		assert.ok(
			/^\s+Binding\s+zeebe:input/m.test(output),
			"Card should show full binding type",
		);
		assert.ok(
			/^\s+Description\s+URL/m.test(output),
			"Card should include the property description",
		);
		assert.ok(
			/^\s+Pattern\s+\^/m.test(output),
			"Card should include the pattern regex",
		);
		assert.ok(
			output.includes("Must be a http(s) URL"),
			"Card should include the pattern error message",
		);
	});

	test("--detailed does NOT print the template metadata header", async () => {
		const result = await c8text(
			"element-template",
			"get-properties",
			TEMPLATE_FILE,
			"--detailed",
			"url",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			!/^\s+ID\s+io\.camunda\.connectors\.HttpJson\.v2/m.test(result.stdout),
			"Should not render template ID row",
		);
		assert.ok(
			!/^\s+Engines\s+\^8\.9/m.test(result.stdout),
			"Should not render Engines row",
		);
	});

	test("--detailed Dropdown card lists every choice value", async () => {
		const result = await c8text(
			"element-template",
			"get-properties",
			TEMPLATE_FILE,
			"--detailed",
			"authentication.type",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			/^\s+Choices\s+.*apiKey.*basic.*bearer.*noAuth.*oauth-client-credentials-flow/m.test(
				result.stdout,
			),
			"Card should list every Dropdown choice value",
		);
	});

	test("--detailed conditional card shows full Active when expression", async () => {
		const result = await c8text(
			"element-template",
			"get-properties",
			TEMPLATE_FILE,
			"--detailed",
			"body",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			/^\s+Active when\s+method ∈ \{"POST", "PUT", "PATCH"\}/m.test(
				result.stdout,
			),
			"Card should render the full condition expression",
		);
	});

	test("--detailed accepts multiple property names", async () => {
		const result = await c8text(
			"element-template",
			"get-properties",
			TEMPLATE_FILE,
			"--detailed",
			"authentication.token",
			"url",
			"body",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const output = result.stdout;

		assert.ok(
			output.includes("authentication.token"),
			"Should render token card",
		);
		assert.ok(
			/^\s+Description\s+Bearer token/m.test(output),
			"Should render token's Description",
		);
		assert.ok(
			/^\s+Pattern\s+\^/m.test(output),
			"Should render url's Pattern field",
		);
		assert.ok(
			output.includes("Active when"),
			"Should render body's Active when",
		);
	});

	test("glob expands to all matching properties", async () => {
		const result = await c8text(
			"element-template",
			"get-properties",
			TEMPLATE_FILE,
			"authentication.*",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const output = result.stdout;
		assert.ok(
			output.includes("authentication.type"),
			"Should include authentication.type",
		);
		assert.ok(
			output.includes("authentication.token"),
			"Should include authentication.token",
		);
		assert.ok(
			output.includes("authentication.oauthTokenEndpoint"),
			"Should include authentication.oauthTokenEndpoint",
		);
		// And nothing outside the glob.
		assert.ok(
			!/^\s+url\s/m.test(output),
			"Should not include non-matching properties",
		);
	});

	test("mixing literals and globs preserves request order, deduped", async () => {
		const result = await c8text(
			"element-template",
			"get-properties",
			TEMPLATE_FILE,
			"--detailed",
			"url",
			"authentication.t*",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const output = result.stdout;

		// url first (literal), then matched authentication.t* in template
		// order. authentication.token matches both .type and .token, but
		// only one card per identity.
		const urlIndex = output.indexOf("url (HTTP endpoint)");
		const typeIndex = output.indexOf("authentication.type");
		const tokenIndex = output.indexOf("authentication.token");
		assert.ok(urlIndex >= 0, "url card should be present");
		assert.ok(typeIndex > urlIndex, "url should come before authentication.t*");
		assert.ok(tokenIndex > typeIndex, "type should come before token");

		// Each unique property gets at most one card.
		const tokenCount = output.split("authentication.token (").length - 1;
		assert.strictEqual(tokenCount, 1, "Should not duplicate cards");
	});

	test("--group filters to properties in the requested groups", async () => {
		const result = await c8text(
			"element-template",
			"get-properties",
			TEMPLATE_FILE,
			"--group",
			"endpoint",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const output = result.stdout;
		assert.ok(
			/HTTP endpoint \(endpoint\)/.test(output),
			"Should render endpoint group heading",
		);
		assert.ok(/^\s+url\s/m.test(output), "Should include url row");
		assert.ok(
			!/Authentication \(authentication\)/.test(output),
			"Should not include Authentication group",
		);
	});

	test("--group is repeatable; multiple ids union", async () => {
		const result = await c8text(
			"element-template",
			"get-properties",
			TEMPLATE_FILE,
			"--group",
			"authentication",
			"--group",
			"endpoint",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const output = result.stdout;
		assert.ok(
			/^\s+authentication\.token\s/m.test(output),
			"Should include Authentication rows",
		);
		assert.ok(/^\s+url\s/m.test(output), "Should include endpoint rows");
		assert.ok(
			!/^\s+resultVariable\s/m.test(output),
			"Should not include Output mapping rows",
		);
	});

	test("--group with unknown id errors with the list of valid ids", async () => {
		const result = await c8text(
			"element-template",
			"get-properties",
			TEMPLATE_FILE,
			"--group",
			"nope",
		);
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes('Unknown group id "nope"'),
			"Should report the unknown group id",
		);
		assert.ok(
			output.includes("authentication") && output.includes("endpoint"),
			"Should list valid group ids",
		);
		assert.ok(
			output.includes("not its label"),
			"Should clarify that the user must use the id, not the label",
		);
	});

	test("rejects a positional that matches nothing — points at get-properties", async () => {
		const result = await c8text(
			"element-template",
			"get-properties",
			TEMPLATE_FILE,
			"doesNotExist",
		);
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes('"doesNotExist" not found'),
			"Should report the unknown property",
		);
		assert.ok(
			output.includes("c8ctl element-template get-properties"),
			"Should redirect to get-properties (not info) to list available properties",
		);
		assert.ok(
			!output.includes("authentication.token") ||
				output.indexOf("authentication.token") < output.indexOf("not found"),
			"Should not enumerate every property name",
		);
	});

	test("rejects a glob that matches nothing", async () => {
		const result = await c8text(
			"element-template",
			"get-properties",
			TEMPLATE_FILE,
			"xyz*",
		);
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes('"xyz*" not found'),
			"Glob misses must error too — silent zero matches would hide typos",
		);
	});

	test("rejects empty intersection of name + --group filters", async () => {
		// `url` exists (in group `endpoint`) and `authentication` is a valid
		// group, but `url` is NOT in `authentication`. Each filter is
		// individually valid; their intersection is empty. Should error
		// rather than silently print `Showing 0 of N properties`.
		const result = await c8text(
			"element-template",
			"get-properties",
			TEMPLATE_FILE,
			"url",
			"--group",
			"authentication",
		);
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("No properties match"),
			`Empty intersection should error. Got: ${output}`,
		);
		assert.ok(
			output.includes('"url"') && output.includes('"authentication"'),
			"Error should quote the offending filters",
		);
	});

	test("--detailed JSON: full per-property shape", async () => {
		const result = await c8(
			"element-template",
			"get-properties",
			TEMPLATE_FILE,
			"--detailed",
			"url",
			"authentication.type",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed: unknown = JSON.parse(result.stdout);
		assert.ok(isRecord(parsed) && Array.isArray(parsed.properties));
		const properties = parsed.properties;

		const findProp = (binding: string): Record<string, unknown> | undefined =>
			properties.find(
				(p: unknown): p is Record<string, unknown> =>
					isRecord(p) && isRecord(p.binding) && p.binding.name === binding,
			);

		// url card surfaces label + constraints (with nested pattern).
		const url = findProp("url");
		assert.ok(url, "Should include url");
		assert.strictEqual(url.label, "URL");
		assert.ok(
			isRecord(url.constraints) && isRecord(url.constraints.pattern),
			"constraints.pattern should round-trip the schema's nested shape",
		);
		assert.strictEqual(
			url.constraints.pattern.message,
			"Must be a http(s) URL",
		);
		assert.strictEqual(url.constraints.notEmpty, true);

		// authentication.type card surfaces description + choices.
		const authType = findProp("authentication.type");
		assert.ok(authType, "Should include authentication.type");
		assert.strictEqual(authType.label, "Type");
		assert.ok(
			typeof authType.description === "string" &&
				authType.description.includes("authentication type"),
			"Should round-trip description",
		);
		assert.ok(
			Array.isArray(authType.choices) &&
				authType.choices.some(
					(c) =>
						isRecord(c) && c.name === "Bearer token" && c.value === "bearer",
				),
			"choices keep the schema's { name, value } shape",
		);
	});
});

describe("CLI behavioural: element-template get-properties --engine-version", () => {
	test("selects latest compatible version for unpinned OOTB ids", async () => {
		const result = await elementTemplateWithSeed(
			makeVersionedFooTemplates(),
			"text",
			"get-properties",
			"io.example.Foo",
			"--engine-version",
			"8.8.0",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("v1-only"),
			"Expected properties from compatible v1 template",
		);
		assert.ok(
			!output.includes("v2-only"),
			"Should not include properties from incompatible v2 template",
		);
	});

	test("pinned @<version> wins over --engine-version", async () => {
		const result = await elementTemplateWithSeed(
			makeVersionedFooTemplates(),
			"text",
			"get-properties",
			"io.example.Foo@2",
			"--engine-version",
			"8.8.0",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			(result.stdout + result.stderr).includes("v2-only"),
			"Expected explicitly pinned version properties",
		);
		assert.ok(
			(result.stdout + result.stderr).includes("Ignoring --engine-version"),
			"Expected warning that pinned version takes precedence",
		);
	});
});

// ---------------------------------------------------------------------------
// element-template search — --limit (default 20)
// ---------------------------------------------------------------------------

/**
 * Run an element-template subcommand against a pre-seeded cache so we don't
 * hit the live marketplace. Each call gets a fresh tmpdir wiped on completion.
 */
async function elementTemplateWithSeed(
	templates: Array<Record<string, unknown>>,
	mode: "text" | "json",
	...args: string[]
) {
	const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
	writeFileSync(
		join(dataDir, "session.json"),
		JSON.stringify({ outputMode: mode }),
	);
	const cacheDir = join(dataDir, "element-templates");
	mkdirSync(cacheDir, { recursive: true });
	writeFileSync(
		join(cacheDir, "templates.json"),
		JSON.stringify(templates, null, 2),
	);
	writeFileSync(join(cacheDir, "fetched-at"), String(Date.now()));
	try {
		return await asyncSpawn(
			"node",
			["--experimental-strip-types", CLI, "element-template", ...args],
			{
				env: {
					...process.env,
					CAMUNDA_BASE_URL: "http://test-cluster/v2",
					HOME: "/tmp/c8ctl-test-nonexistent-home",
					C8CTL_DATA_DIR: dataDir,
				},
			},
		);
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
}

/**
 * Run search against a pre-seeded cache.
 */
async function searchWithSeed(
	templates: Array<Record<string, unknown>>,
	mode: "text" | "json",
	...args: string[]
) {
	return elementTemplateWithSeed(templates, mode, "search", ...args);
}

/** Build N matchable templates with stable shape. */
function makeTemplates(prefix: string, n: number) {
	return Array.from({ length: n }, (_, i) => ({
		id: `io.example.${prefix}.${i}`,
		name: `${prefix} connector ${i}`,
		version: 1,
		description: `${prefix} test template`,
		properties: [],
	}));
}

describe("CLI behavioural: element-template search", () => {
	test("filters by --engine-version before per-id latest reduction", async () => {
		const seeded = [
			{
				id: "io.example.Foo",
				name: "Foo",
				version: 1,
				engines: { camunda: "^8.7" },
				description: "compatible with 8.8",
				properties: [],
			},
			{
				id: "io.example.Foo",
				name: "Foo",
				version: 2,
				engines: { camunda: "^8.9" },
				description: "requires 8.9",
				properties: [],
			},
		];
		const result = await searchWithSeed(
			seeded,
			"json",
			"foo",
			"--engine-version",
			"8.8.0",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed: unknown = JSON.parse(result.stdout);
		assert.ok(isRecord(parsed));
		assert.ok(Array.isArray(parsed.matches));
		const matches = parsed.matches;
		assert.strictEqual(matches.length, 1, "Expected one compatible version");
		assert.ok(isRecord(matches[0]));
		assert.strictEqual(matches[0].id, "io.example.Foo");
		assert.strictEqual(
			matches[0].version,
			1,
			"Should pick v1, not absolute latest",
		);
	});

	test("keeps templates without engines.camunda when --engine-version is set", async () => {
		const seeded = [
			{
				id: "io.example.Legacy",
				name: "Legacy",
				version: 3,
				description: "no engines constraint",
				properties: [],
			},
		];
		const result = await searchWithSeed(
			seeded,
			"json",
			"legacy",
			"--engine-version",
			"8.8.0",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed: unknown = JSON.parse(result.stdout);
		assert.ok(isRecord(parsed));
		assert.strictEqual(parsed.count, 1);
		assert.ok(Array.isArray(parsed.matches));
		assert.ok(isRecord(parsed.matches[0]));
		assert.strictEqual(parsed.matches[0].id, "io.example.Legacy");
	});

	test("--engine-version accepts concrete semver and x.y shorthand", async () => {
		const seeded = makeTemplates("aws", 1);
		for (const value of ["8.8.0", "8.8", "8.8.0-alpha1"]) {
			const result = await searchWithSeed(
				seeded,
				"text",
				"aws",
				"--engine-version",
				value,
			);
			assert.strictEqual(
				result.status,
				0,
				`--engine-version ${value} should be accepted. stderr: ${result.stderr}`,
			);
		}
	});

	test("--engine-version rejects ranges, bare majors, and missing values", async () => {
		const seeded = makeTemplates("aws", 1);
		const invalid = ["^8.8", "~8.8", ">=8.8", "8.8 || 8.9", "8"];
		for (const value of invalid) {
			const result = await searchWithSeed(
				seeded,
				"text",
				"aws",
				"--engine-version",
				value,
			);
			assert.strictEqual(result.status, 1);
			assert.ok(
				(result.stdout + result.stderr).includes("--engine-version"),
				`Error should mention --engine-version for value ${value}`,
			);
		}

		const missing = await searchWithSeed(
			seeded,
			"text",
			"aws",
			"--engine-version",
		);
		assert.strictEqual(missing.status, 1);
		assert.ok(
			(missing.stdout + missing.stderr).includes(
				"--engine-version requires a value",
			),
		);
	});

	test("default limit (20): all results show, no 'Showing X of Y' truncation header", async () => {
		const result = await searchWithSeed(makeTemplates("aws", 5), "text", "aws");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			/^5 matches for 'aws'/.test(result.stdout),
			`expected '5 matches' header. Got: ${result.stdout.slice(0, 300)}`,
		);
		assert.ok(
			!result.stdout.includes("Showing"),
			"no truncation header expected when total <= limit",
		);
		assert.ok(
			!result.stdout.includes("Refine the query"),
			"no refinement hint expected when nothing was elided",
		);
	});

	test("--limit caps text output and shows refinement hint", async () => {
		const result = await searchWithSeed(
			makeTemplates("aws", 25),
			"text",
			"aws",
			"--limit",
			"5",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			/Showing 5 of 25 matches for 'aws'/.test(result.stdout),
			`expected truncation header. Got: ${result.stdout.slice(0, 300)}`,
		);
		assert.ok(
			result.stdout.includes("Refine the query"),
			"truncated output should include the refinement hint",
		);
		assert.ok(
			result.stdout.includes("--limit 25"),
			"hint should suggest the exact total as a --limit value",
		);
	});

	test("--limit reports count + total in JSON mode", async () => {
		const result = await searchWithSeed(
			makeTemplates("aws", 25),
			"json",
			"aws",
			"--limit",
			"5",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed = JSON.parse(result.stdout);
		assert.strictEqual(parsed.count, 5, "post-limit count");
		assert.strictEqual(parsed.total, 25, "pre-limit total");
		assert.ok(Array.isArray(parsed.matches));
		assert.strictEqual(parsed.matches.length, 5);
	});

	test("--limit must be a positive integer", async () => {
		const cases = ["0", "-1", "abc", "1.5"];
		for (const value of cases) {
			const result = await searchWithSeed(
				makeTemplates("aws", 3),
				"text",
				"aws",
				"--limit",
				value,
			);
			assert.strictEqual(
				result.status,
				1,
				`--limit ${value} should be rejected. stdout: ${result.stdout}`,
			);
			assert.ok(
				(result.stdout + result.stderr).includes("--limit"),
				`error should reference --limit. Got: ${result.stdout + result.stderr}`,
			);
		}
	});
});

// ---------------------------------------------------------------------------
// element-template help
// ---------------------------------------------------------------------------

describe("CLI behavioural: element-template help", () => {
	test("help element-template shows apply, info, and get-properties", async () => {
		const result = await c8text("help", "element-template");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const output = result.stdout + result.stderr;
		assert.ok(output.includes("apply"), "Should mention apply");
		assert.ok(output.includes("info"), "Should mention info");
		assert.ok(
			output.includes("get-properties"),
			"Should mention get-properties",
		);
	});

	test("help element-template shows --engine-version scope", async () => {
		const result = await c8text("help", "element-template");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			result.stdout.includes("--engine-version"),
			"Help should include --engine-version flag",
		);
		assert.ok(
			result.stdout.includes("[search|info|get-properties]"),
			"Help should scope --engine-version to discovery commands",
		);
	});
});

// ---------------------------------------------------------------------------
// element-template apply — headless BPMN import (no DOM warnings)
// ---------------------------------------------------------------------------

describe("CLI behavioural: element-template apply headless import", () => {
	test("imports a diagram with named events without 'document is not defined' noise", async () => {
		// simple.bpmn has named StartEvent and EndEvent; bpmn-js's importer
		// would call TextRenderer.getExternalLabelBounds for those, which
		// requires `document` and throws in Node unless the textRenderer
		// module is overridden by the plugin.
		const result = await c8text(
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			!result.stderr.includes("document is not defined"),
			`stderr should not contain DOM errors. Got: ${result.stderr.slice(0, 500)}`,
		);
		assert.ok(
			!result.stderr.includes("failed to import"),
			"stderr should not contain bpmn-js importer warnings",
		);
	});
});

// ---------------------------------------------------------------------------
// element-template apply — piped stdin
// ---------------------------------------------------------------------------

describe("CLI behavioural: element-template apply stdin", () => {
	test("reads piped BPMN from a fast stdin writer and prints to stdout", async () => {
		const xml = readFileSync(BPMN_FILE, "utf-8");
		const result = await asyncSpawnWithStdin(
			"node",
			[
				"--experimental-strip-types",
				CLI,
				"element-template",
				"apply",
				TEMPLATE_FILE,
				"Activity_17s7axj",
			],
			(stdin) => {
				stdin.write(xml);
			},
			{ cwd: REPO_ROOT, env: process.env },
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			result.stdout.includes("zeebe:modelerTemplate="),
			"stdout should contain the applied template binding",
		);
	});

	test("waits for a slow stdin writer (regression: EAGAIN race)", async () => {
		const xml = readFileSync(BPMN_FILE, "utf-8");
		const result = await asyncSpawnWithStdin(
			"node",
			[
				"--experimental-strip-types",
				CLI,
				"element-template",
				"apply",
				TEMPLATE_FILE,
				"Activity_17s7axj",
			],
			async (stdin) => {
				await new Promise((r) => setTimeout(r, 200));
				stdin.write(xml);
			},
			{ cwd: REPO_ROOT, env: process.env },
		);
		assert.strictEqual(
			result.status,
			0,
			`Expected apply to wait for slow producer. stderr: ${result.stderr}`,
		);
		assert.ok(
			!result.stderr.includes("No BPMN input provided"),
			"Should not bail with 'No BPMN input' when writer is slow",
		);
		assert.ok(
			result.stdout.includes("zeebe:modelerTemplate="),
			"stdout should contain the applied template binding",
		);
	});
});

// ---------------------------------------------------------------------------
// element-template apply -- --dry-run
// ---------------------------------------------------------------------------

describe("CLI behavioural: element-template apply --dry-run", () => {
	test("text mode: prints dry-run summary without touching the BPMN file", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
		const tempBpmn = join(tempDir, "test.bpmn");
		const original = readFileSync(BPMN_FILE, "utf-8");
		writeFileSync(tempBpmn, original);
		try {
			const result = await c8text(
				"--dry-run",
				"element-template",
				"apply",
				"--in-place",
				TEMPLATE_FILE,
				"Activity_17s7axj",
				tempBpmn,
			);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			assert.ok(
				result.stdout.includes("Dry run"),
				"stdout should contain 'Dry run' summary line",
			);
			// The file must not have been modified
			assert.strictEqual(
				readFileSync(tempBpmn, "utf-8"),
				original,
				"--dry-run must not modify the BPMN file",
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("text mode: reports template name, element id, and in-place mode", async () => {
		const result = await c8text(
			"--dry-run",
			"element-template",
			"apply",
			"--in-place",
			TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			result.stdout.includes("Activity_17s7axj"),
			"stdout should include the element id",
		);
		assert.ok(
			result.stdout.toLowerCase().includes("in-place"),
			"stdout should describe in-place mode",
		);
	});

	test("text mode: reports stdout mode when --in-place is absent", async () => {
		const result = await c8text(
			"--dry-run",
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			result.stdout.includes("stdout"),
			"stdout should describe stdout (non-in-place) mode",
		);
	});

	test("text mode: --set overrides are reflected in the dry-run summary", async () => {
		const result = await c8text(
			"--dry-run",
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"Activity_17s7axj",
			BPMN_FILE,
			"--set",
			"method=POST",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			result.stdout.includes("method=POST"),
			"dry-run summary should list --set overrides",
		);
	});

	test("JSON mode: emits structured { dryRun: true, command, template, elementId } object", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
		writeFileSync(
			join(dataDir, "session.json"),
			JSON.stringify({ outputMode: "json" }),
		);
		try {
			const result = await asyncSpawn(
				"node",
				[
					"--experimental-strip-types",
					CLI,
					"--dry-run",
					"element-template",
					"apply",
					TEMPLATE_FILE,
					"Activity_17s7axj",
					BPMN_FILE,
				],
				{
					env: {
						...process.env,
						CAMUNDA_BASE_URL: "http://test-cluster/v2",
						HOME: "/tmp/c8ctl-test-nonexistent-home",
						C8CTL_DATA_DIR: dataDir,
					},
				},
			);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			const out = JSON.parse(result.stdout);
			assert.ok(isRecord(out), "JSON output should be a record");
			assert.strictEqual(out.dryRun, true, "dryRun must be true");
			assert.strictEqual(out.command, "element-template apply");
			assert.strictEqual(out.elementId, "Activity_17s7axj");
			assert.ok(
				out.template !== null && typeof out.template === "object",
				"template must be an object",
			);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	test("JSON mode: setOverrides array reflects --set values", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
		writeFileSync(
			join(dataDir, "session.json"),
			JSON.stringify({ outputMode: "json" }),
		);
		try {
			const result = await asyncSpawn(
				"node",
				[
					"--experimental-strip-types",
					CLI,
					"--dry-run",
					"element-template",
					"apply",
					TEMPLATE_FILE,
					"Activity_17s7axj",
					BPMN_FILE,
					"--set",
					"method=POST",
					"--set",
					"url=https://example.com",
				],
				{
					env: {
						...process.env,
						CAMUNDA_BASE_URL: "http://test-cluster/v2",
						HOME: "/tmp/c8ctl-test-nonexistent-home",
						C8CTL_DATA_DIR: dataDir,
					},
				},
			);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			const out = JSON.parse(result.stdout);
			assert.ok(isRecord(out), "JSON output should be a record");
			assert.ok(
				Array.isArray(out.setOverrides),
				"setOverrides must be an array",
			);
			const overrides: string[] = Array.isArray(out.setOverrides)
				? out.setOverrides.map(String)
				: [];
			assert.ok(
				overrides.includes("method=POST"),
				"setOverrides should contain method=POST",
			);
			assert.ok(
				overrides.includes("url=https://example.com"),
				"setOverrides should contain the url override",
			);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	test("exits non-zero when elementId does not exist in the BPMN", async () => {
		const result = await c8text(
			"--dry-run",
			"element-template",
			"apply",
			TEMPLATE_FILE,
			"MissingElement_xyz",
			BPMN_FILE,
		);
		assert.notStrictEqual(
			result.status,
			0,
			"Should exit non-zero for missing element",
		);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("MissingElement_xyz") && output.includes("not found"),
			`Should report the missing element id. Got: ${output.slice(0, 300)}`,
		);
	});
});

// ---------------------------------------------------------------------------
// element-template edit
// ---------------------------------------------------------------------------

/**
 * Run a sequence of CLI invocations against a single persistent, pre-seeded
 * OOTB cache directory. `edit` resolves its target template from the local
 * cache by the id/version recorded on the element (zeebe:modelerTemplate/
 * -Version), so tests that apply a template and then edit it need the same
 * cache available across both invocations.
 */
async function withSeededElementTemplateCache(
	templates: Array<Record<string, unknown>>,
	fn: (
		run: (...args: string[]) => ReturnType<typeof asyncSpawn>,
	) => Promise<void>,
): Promise<void> {
	const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
	writeFileSync(
		join(dataDir, "session.json"),
		JSON.stringify({ outputMode: "text" }),
	);
	const cacheDir = join(dataDir, "element-templates");
	mkdirSync(cacheDir, { recursive: true });
	writeFileSync(
		join(cacheDir, "templates.json"),
		JSON.stringify(templates, null, 2),
	);
	writeFileSync(join(cacheDir, "fetched-at"), String(Date.now()));
	const run = (...args: string[]) =>
		asyncSpawn("node", ["--experimental-strip-types", CLI, ...args], {
			env: {
				...process.env,
				CAMUNDA_BASE_URL: "http://test-cluster/v2",
				HOME: "/tmp/c8ctl-test-nonexistent-home",
				C8CTL_DATA_DIR: dataDir,
			},
		});
	try {
		await fn(run);
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
}

describe("CLI behavioural: element-template edit", () => {
	test("--set updates an already-materialized value and preserves hand-authored content the template doesn't own", async () => {
		const httpJsonTemplate = JSON.parse(readFileSync(TEMPLATE_FILE, "utf-8"));
		await withSeededElementTemplateCache([httpJsonTemplate], async (run) => {
			const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
			const tempBpmn = join(tempDir, "test.bpmn");
			writeFileSync(tempBpmn, readFileSync(BPMN_FILE, "utf-8"));
			try {
				const applied = await run(
					"element-template",
					"apply",
					"-i",
					TEMPLATE_FILE,
					"Activity_17s7axj",
					tempBpmn,
					"--set",
					"method=POST",
				);
				assert.strictEqual(applied.status, 0, `stderr: ${applied.stderr}`);

				// Simulate a hand-authored customization layered into an
				// existing templated field — the way a Modeler user extends
				// beyond what the template itself declares (c8ctl#466).
				const beforeEdit = readFileSync(tempBpmn, "utf-8");
				assert.ok(
					beforeEdit.includes('key="resultExpression"'),
					"fixture should already carry a resultExpression header to customize",
				);
				const customized = beforeEdit.replace(
					/(key="resultExpression" value="=\{)/,
					"$1&#10;  customHandAuthoredField: 1,",
				);
				assert.notStrictEqual(
					customized,
					beforeEdit,
					"the resultExpression replace should have matched",
				);
				writeFileSync(tempBpmn, customized);

				const edited = await run(
					"element-template",
					"edit",
					"Activity_17s7axj",
					tempBpmn,
					"--set",
					"method=PUT",
				);
				assert.strictEqual(edited.status, 0, `stderr: ${edited.stderr}`);
				assert.strictEqual(getInputValue(edited.stdout, "method"), "PUT");
				assert.ok(
					edited.stdout.includes("customHandAuthoredField"),
					"hand-authored content outside the template's own schema should survive edit",
				);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	test("--set never resets a Hidden-typed property, even one hand-modified after apply", async () => {
		// This is the actual c8ctl#466 regression: bpmn-js-element-templates'
		// applyTemplate() unconditionally force-overwrites Hidden-typed
		// properties back to their template default on every call
		// (ChangeElementTemplateHandler#shouldKeepValue). `edit` never calls
		// applyTemplate, so a Hidden binding's value — however it got there —
		// must survive untouched across an unrelated --set.
		const httpJsonTemplate = JSON.parse(readFileSync(TEMPLATE_FILE, "utf-8"));
		const hiddenTaskDefType = httpJsonTemplate.properties.find(
			(p: { binding?: { type?: string; property?: string }; type?: string }) =>
				p.type === "Hidden" &&
				p.binding?.type === "zeebe:taskDefinition" &&
				p.binding?.property === "type",
		);
		assert.ok(
			hiddenTaskDefType,
			"fixture template should declare a Hidden zeebe:taskDefinition/type property",
		);
		await withSeededElementTemplateCache([httpJsonTemplate], async (run) => {
			const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
			const tempBpmn = join(tempDir, "test.bpmn");
			writeFileSync(tempBpmn, readFileSync(BPMN_FILE, "utf-8"));
			try {
				const applied = await run(
					"element-template",
					"apply",
					"-i",
					TEMPLATE_FILE,
					"Activity_17s7axj",
					tempBpmn,
					"--set",
					"method=POST",
				);
				assert.strictEqual(applied.status, 0, `stderr: ${applied.stderr}`);
				assert.strictEqual(
					getTaskDefinitionType(readFileSync(tempBpmn, "utf-8")),
					hiddenTaskDefType.value,
					"apply should have set the Hidden property to the template default",
				);

				// Hand-modify the Hidden field itself to a value the template
				// doesn't own/generate — apply --set would silently stomp this
				// back to the template default on any re-apply; edit must not.
				const marker = "custom-hand-authored-task-type:1";
				const beforeEdit = readFileSync(tempBpmn, "utf-8");
				const customized = beforeEdit.replace(
					`type="${hiddenTaskDefType.value}"`,
					`type="${marker}"`,
				);
				assert.notStrictEqual(
					customized,
					beforeEdit,
					"the taskDefinition type replace should have matched",
				);
				writeFileSync(tempBpmn, customized);

				// POST -> GET deactivates `body`/`ignoreNullValues`. A write
				// that changes the active property set is what makes the
				// library re-run template application once the template is
				// registered, so this edit would expose that regression.
				const edited = await run(
					"element-template",
					"edit",
					"Activity_17s7axj",
					tempBpmn,
					"--set",
					"method=GET",
				);
				assert.strictEqual(edited.status, 0, `stderr: ${edited.stderr}`);
				assert.strictEqual(
					getInputValue(edited.stdout, "method"),
					"GET",
					"the requested property should still be updated",
				);
				assert.strictEqual(
					getTaskDefinitionType(edited.stdout),
					marker,
					"edit must not reset the Hidden zeebe:taskDefinition/type property " +
						"to its template default",
				);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	test("--set updates a zeebe:taskHeader value (and prepends FEEL) without touching other bindings", async () => {
		// zeebe:taskHeader is asymmetric to zeebe:input (keyed by
		// binding.key, writing the header's `value` property).
		// `resultExpression` is a Text/FEEL header the fixture materializes
		// with a default on apply, so editing it also proves FEEL casting
		// runs on the edit path (feel: "required" => a bare value gets an
		// "=" prefix).
		const httpJsonTemplate = JSON.parse(readFileSync(TEMPLATE_FILE, "utf-8"));
		await withSeededElementTemplateCache([httpJsonTemplate], async (run) => {
			const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
			const tempBpmn = join(tempDir, "test.bpmn");
			writeFileSync(tempBpmn, readFileSync(BPMN_FILE, "utf-8"));
			try {
				const applied = await run(
					"element-template",
					"apply",
					"-i",
					TEMPLATE_FILE,
					"Activity_17s7axj",
					tempBpmn,
					"--set",
					"method=POST",
				);
				assert.strictEqual(applied.status, 0, `stderr: ${applied.stderr}`);
				assert.ok(
					getTaskHeaderValue(
						readFileSync(tempBpmn, "utf-8"),
						"resultExpression",
					)?.startsWith("="),
					"apply should have materialized the resultExpression header with its FEEL default",
				);

				const edited = await run(
					"element-template",
					"edit",
					"Activity_17s7axj",
					tempBpmn,
					"--set",
					"resultExpression=response.body",
				);
				assert.strictEqual(edited.status, 0, `stderr: ${edited.stderr}`);
				assert.strictEqual(
					getTaskHeaderValue(edited.stdout, "resultExpression"),
					"=response.body",
					"edit must update the taskHeader's value and prepend '=' for a feel:required header",
				);
				assert.strictEqual(
					getInputValue(edited.stdout, "method"),
					"POST",
					"editing the taskHeader must not disturb the unrelated zeebe:input value",
				);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	test("errors clearly when the element has no template applied", async () => {
		await withSeededElementTemplateCache([], async (run) => {
			const result = await run(
				"element-template",
				"edit",
				"Activity_17s7axj",
				BPMN_FILE,
				"--set",
				"method=PUT",
			);
			assert.strictEqual(result.status, 1);
			const output = result.stdout + result.stderr;
			assert.ok(
				output.includes("no element template applied"),
				`Should report the missing template. Got: ${output.slice(0, 300)}`,
			);
		});
	});

	test("later --set wins when two --set args target the same property", async () => {
		// Distinct from the conditional-duplicate dedup: two *different* --set
		// args resolving to the same moddle target must behave like `apply`
		// ("--set wins", last one specified), not silently keep the first.
		const httpJsonTemplate = JSON.parse(readFileSync(TEMPLATE_FILE, "utf-8"));
		await withSeededElementTemplateCache([httpJsonTemplate], async (run) => {
			const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
			const tempBpmn = join(tempDir, "test.bpmn");
			writeFileSync(tempBpmn, readFileSync(BPMN_FILE, "utf-8"));
			try {
				const applied = await run(
					"element-template",
					"apply",
					"-i",
					TEMPLATE_FILE,
					"Activity_17s7axj",
					tempBpmn,
					"--set",
					"method=POST",
				);
				assert.strictEqual(applied.status, 0, `stderr: ${applied.stderr}`);

				const edited = await run(
					"element-template",
					"edit",
					"Activity_17s7axj",
					tempBpmn,
					"--set",
					"method=PUT",
					"--set",
					"method=DELETE",
				);
				assert.strictEqual(edited.status, 0, `stderr: ${edited.stderr}`);
				assert.strictEqual(
					getInputValue(edited.stdout, "method"),
					"DELETE",
					"the later --set method=DELETE should win over the earlier --set method=PUT",
				);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	test("errors clearly when the property's condition is not met", async () => {
		const httpJsonTemplate = JSON.parse(readFileSync(TEMPLATE_FILE, "utf-8"));
		await withSeededElementTemplateCache([httpJsonTemplate], async (run) => {
			const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
			const tempBpmn = join(tempDir, "test.bpmn");
			writeFileSync(tempBpmn, readFileSync(BPMN_FILE, "utf-8"));
			try {
				// Apply without setting `method`, so the `body` property's
				// gating condition (method=POST) is never met and no
				// zeebe:input target="body" entry is ever materialized.
				const applied = await run(
					"element-template",
					"apply",
					"-i",
					TEMPLATE_FILE,
					"Activity_17s7axj",
					tempBpmn,
				);
				assert.strictEqual(applied.status, 0, `stderr: ${applied.stderr}`);

				const result = await run(
					"element-template",
					"edit",
					"Activity_17s7axj",
					tempBpmn,
					"--set",
					'body={"hello":"world"}',
				);
				assert.strictEqual(result.status, 1);
				const output = result.stdout + result.stderr;
				assert.ok(
					output.includes("its condition is not met"),
					`Should report the unmet condition. Got: ${output.slice(0, 300)}`,
				);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	test("materializes a conditional property when an earlier --set meets its condition", async () => {
		const httpJsonTemplate = JSON.parse(readFileSync(TEMPLATE_FILE, "utf-8"));
		await withSeededElementTemplateCache([httpJsonTemplate], async (run) => {
			const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
			const tempBpmn = join(tempDir, "test.bpmn");
			writeFileSync(tempBpmn, readFileSync(BPMN_FILE, "utf-8"));
			try {
				const applied = await run(
					"element-template",
					"apply",
					"-i",
					TEMPLATE_FILE,
					"Activity_17s7axj",
					tempBpmn,
				);
				assert.strictEqual(applied.status, 0, `stderr: ${applied.stderr}`);

				const edited = await run(
					"element-template",
					"edit",
					"Activity_17s7axj",
					tempBpmn,
					"--set",
					"method=POST",
					"--set",
					'body={"hello":"world"}',
				);
				assert.strictEqual(edited.status, 0, `stderr: ${edited.stderr}`);
				assert.strictEqual(getInputValue(edited.stdout, "method"), "POST");
				assert.ok(
					edited.stdout.includes("hello"),
					"body input should be created once method=POST meets its condition",
				);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	test("rejects unknown property name", async () => {
		const httpJsonTemplate = JSON.parse(readFileSync(TEMPLATE_FILE, "utf-8"));
		await withSeededElementTemplateCache([httpJsonTemplate], async (run) => {
			const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
			const tempBpmn = join(tempDir, "test.bpmn");
			writeFileSync(tempBpmn, readFileSync(BPMN_FILE, "utf-8"));
			try {
				const applied = await run(
					"element-template",
					"apply",
					"-i",
					TEMPLATE_FILE,
					"Activity_17s7axj",
					tempBpmn,
				);
				assert.strictEqual(applied.status, 0, `stderr: ${applied.stderr}`);

				const result = await run(
					"element-template",
					"edit",
					"Activity_17s7axj",
					tempBpmn,
					"--set",
					"nonexistent=value",
				);
				assert.strictEqual(result.status, 1);
				const output = result.stdout + result.stderr;
				assert.ok(
					output.includes('Unknown property "nonexistent"'),
					"Should report unknown property",
				);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	test("requires at least one --set", async () => {
		await withSeededElementTemplateCache([], async (run) => {
			const result = await run(
				"element-template",
				"edit",
				"Activity_17s7axj",
				BPMN_FILE,
			);
			assert.strictEqual(result.status, 1);
			const output = result.stdout + result.stderr;
			assert.ok(
				output.includes("at least one --set"),
				`Should require --set. Got: ${output.slice(0, 300)}`,
			);
		});
	});

	test("requires an element-id argument", async () => {
		await withSeededElementTemplateCache([], async (run) => {
			const result = await run("element-template", "edit");
			assert.strictEqual(result.status, 1);
			const output = result.stdout + result.stderr;
			assert.ok(
				output.includes("Missing element-id argument"),
				`Should require element-id. Got: ${output.slice(0, 300)}`,
			);
		});
	});

	test("rejects unexpected extra positional argument", async () => {
		await withSeededElementTemplateCache([], async (run) => {
			const result = await run(
				"element-template",
				"edit",
				"Activity_17s7axj",
				BPMN_FILE,
				"extra-arg",
				"--set",
				"method=PUT",
			);
			assert.strictEqual(result.status, 1);
			const output = result.stdout + result.stderr;
			assert.ok(
				output.includes("Unexpected argument") && output.includes("extra-arg"),
				`Should report the unexpected argument. Got: ${output.slice(0, 300)}`,
			);
		});
	});

	test("--dry-run reports without mutating the file", async () => {
		const httpJsonTemplate = JSON.parse(readFileSync(TEMPLATE_FILE, "utf-8"));
		await withSeededElementTemplateCache([httpJsonTemplate], async (run) => {
			const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
			const tempBpmn = join(tempDir, "test.bpmn");
			writeFileSync(tempBpmn, readFileSync(BPMN_FILE, "utf-8"));
			try {
				const applied = await run(
					"element-template",
					"apply",
					"-i",
					TEMPLATE_FILE,
					"Activity_17s7axj",
					tempBpmn,
					"--set",
					"method=POST",
				);
				assert.strictEqual(applied.status, 0, `stderr: ${applied.stderr}`);
				const beforeDryRun = readFileSync(tempBpmn, "utf-8");

				const result = await run(
					"--dry-run",
					"element-template",
					"edit",
					"--in-place",
					"Activity_17s7axj",
					tempBpmn,
					"--set",
					"method=PUT",
				);
				assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
				assert.ok(
					result.stdout.includes("Dry run"),
					"stdout should contain 'Dry run' summary line",
				);
				assert.ok(
					result.stdout.toLowerCase().includes("in-place"),
					"stdout should describe in-place mode",
				);
				assert.strictEqual(
					readFileSync(tempBpmn, "utf-8"),
					beforeDryRun,
					"--dry-run must not modify the BPMN file",
				);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	test("keeps the order of existing inputs when editing one", async () => {
		const httpJsonTemplate = JSON.parse(readFileSync(TEMPLATE_FILE, "utf-8"));
		await withSeededElementTemplateCache([httpJsonTemplate], async (run) => {
			const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
			const tempBpmn = join(tempDir, "test.bpmn");
			writeFileSync(tempBpmn, readFileSync(BPMN_FILE, "utf-8"));
			const targets = () =>
				[
					...readFileSync(tempBpmn, "utf-8").matchAll(
						/<zeebe:input[^>]+target="([^"]*)"/g,
					),
				].map((m) => m[1]);
			try {
				const applied = await run(
					"element-template",
					"apply",
					"-i",
					TEMPLATE_FILE,
					"Activity_17s7axj",
					tempBpmn,
					"--set",
					"method=POST",
				);
				assert.strictEqual(applied.status, 0, `stderr: ${applied.stderr}`);
				const before = targets();
				assert.ok(before.length > 2, "fixture should have several inputs");

				const edited = await run(
					"element-template",
					"edit",
					"-i",
					"Activity_17s7axj",
					tempBpmn,
					"--set",
					"method=PUT",
				);
				assert.strictEqual(edited.status, 0, `stderr: ${edited.stderr}`);
				assert.deepStrictEqual(
					targets(),
					before,
					"editing one input must not reorder the others",
				);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	test("rejects constraint violations without touching the file, with and without --dry-run", async () => {
		const httpJsonTemplate = JSON.parse(readFileSync(TEMPLATE_FILE, "utf-8"));
		await withSeededElementTemplateCache([httpJsonTemplate], async (run) => {
			const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
			const tempBpmn = join(tempDir, "test.bpmn");
			writeFileSync(tempBpmn, readFileSync(BPMN_FILE, "utf-8"));
			try {
				const applied = await run(
					"element-template",
					"apply",
					"-i",
					TEMPLATE_FILE,
					"Activity_17s7axj",
					tempBpmn,
					"--set",
					"url=https://example.com",
				);
				assert.strictEqual(applied.status, 0, `stderr: ${applied.stderr}`);
				const before = readFileSync(tempBpmn, "utf-8");

				// `url` carries a notEmpty + http(s) pattern constraint: one
				// pattern failure and one notEmpty failure, each in normal and
				// dry-run mode.
				for (const value of ["ftp://example.com", ""]) {
					for (const dryRun of [[], ["--dry-run"]]) {
						const result = await run(
							...dryRun,
							"element-template",
							"edit",
							"-i",
							"Activity_17s7axj",
							tempBpmn,
							"--set",
							`url=${value}`,
						);
						const label = `url=${JSON.stringify(value)} ${dryRun.join(" ")}`;
						assert.strictEqual(result.status, 1, label);
						assert.ok(
							(result.stdout + result.stderr).includes(
								'Invalid value for "url"',
							),
							`${label}: should report the constraint violation. Got: ${(result.stdout + result.stderr).slice(0, 300)}`,
						);
						assert.strictEqual(
							readFileSync(tempBpmn, "utf-8"),
							before,
							`${label}: file must be byte-for-byte unchanged`,
						);
					}
				}

				// A valid value is accepted and written.
				const valid = await run(
					"element-template",
					"edit",
					"-i",
					"Activity_17s7axj",
					tempBpmn,
					"--set",
					"url=https://example.org/new",
				);
				assert.strictEqual(valid.status, 0, `stderr: ${valid.stderr}`);
				assert.strictEqual(
					getInputValue(readFileSync(tempBpmn, "utf-8"), "url"),
					"https://example.org/new",
				);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	test("writes Boolean values and a plain-property binding through apply, re-apply and edit", async () => {
		const template = {
			id: "io.example.writer",
			name: "Writer coverage",
			version: 1,
			appliesTo: ["bpmn:Task"],
			elementType: { value: "bpmn:ServiceTask" },
			engines: { camunda: "^8.10" },
			properties: [
				{
					type: "Hidden",
					value: "writer-job",
					binding: { type: "zeebe:taskDefinition:type" },
				},
				{
					type: "Boolean",
					label: "Flag",
					value: false,
					binding: { type: "zeebe:input", name: "flag" },
				},
				{
					type: "String",
					label: "Display name",
					value: "initial",
					binding: { type: "property", name: "name" },
				},
			],
		};
		await withSeededElementTemplateCache([template], async (run) => {
			const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
			const tempBpmn = join(tempDir, "test.bpmn");
			const templateFile = join(tempDir, "writer.json");
			writeFileSync(tempBpmn, readFileSync(BPMN_FILE, "utf-8"));
			writeFileSync(templateFile, JSON.stringify(template));
			const xml = () => readFileSync(tempBpmn, "utf-8");
			const nameAttr = () =>
				xml().match(/<bpmn:serviceTask[^>]*\bname="([^"]*)"/)?.[1];
			try {
				const steps: Array<{
					cmd: "apply" | "edit";
					set: string[];
					flag: string;
					name: string;
				}> = [
					{
						cmd: "apply",
						set: ["flag=true", "name=First"],
						flag: "=true",
						name: "First",
					},
					{
						cmd: "apply",
						set: ["flag=false", "name=Second"],
						flag: "=false",
						name: "Second",
					},
					{
						cmd: "edit",
						set: ["flag=true", "name=Third"],
						flag: "=true",
						name: "Third",
					},
					{ cmd: "edit", set: ["flag=false"], flag: "=false", name: "Third" },
				];
				for (const step of steps) {
					const args =
						step.cmd === "apply"
							? ["apply", "-i", templateFile, "Activity_17s7axj", tempBpmn]
							: ["edit", "-i", "Activity_17s7axj", tempBpmn];
					const result = await run(
						"element-template",
						...args,
						...step.set.flatMap((s) => ["--set", s]),
					);
					const label = `${step.cmd} ${step.set.join(" ")}`;
					assert.strictEqual(result.status, 0, `${label}: ${result.stderr}`);
					assert.strictEqual(getInputValue(xml(), "flag"), step.flag, label);
					assert.strictEqual(nameAttr(), step.name, label);
				}
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	test("--in-place writes atomically and leaves no .tmp file", async () => {
		const httpJsonTemplate = JSON.parse(readFileSync(TEMPLATE_FILE, "utf-8"));
		await withSeededElementTemplateCache([httpJsonTemplate], async (run) => {
			const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
			const tempBpmn = join(tempDir, "test.bpmn");
			writeFileSync(tempBpmn, readFileSync(BPMN_FILE, "utf-8"));
			try {
				const applied = await run(
					"element-template",
					"apply",
					"-i",
					TEMPLATE_FILE,
					"Activity_17s7axj",
					tempBpmn,
					"--set",
					"method=POST",
				);
				assert.strictEqual(applied.status, 0, `stderr: ${applied.stderr}`);

				const result = await run(
					"element-template",
					"edit",
					"-i",
					"Activity_17s7axj",
					tempBpmn,
					"--set",
					"method=PUT",
				);
				assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
				const leftovers = readdirSync(tempDir).filter((name) =>
					name.endsWith(".tmp"),
				);
				assert.deepStrictEqual(
					leftovers,
					[],
					`No .tmp file should survive a clean edit. Found: ${leftovers.join(", ")}`,
				);
				const updated = readFileSync(tempBpmn, "utf-8");
				assert.strictEqual(getInputValue(updated, "method"), "PUT");
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	test("cold cache: exits 1 with a 'run sync first' hint", async () => {
		const httpJsonTemplate = JSON.parse(readFileSync(TEMPLATE_FILE, "utf-8"));
		const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
		const tempBpmn = join(tempDir, "test.bpmn");
		writeFileSync(tempBpmn, readFileSync(BPMN_FILE, "utf-8"));
		try {
			// Produce a templated fixture under a seeded cache...
			await withSeededElementTemplateCache([httpJsonTemplate], async (run) => {
				const applied = await run(
					"element-template",
					"apply",
					"-i",
					TEMPLATE_FILE,
					"Activity_17s7axj",
					tempBpmn,
				);
				assert.strictEqual(applied.status, 0, `stderr: ${applied.stderr}`);
			});

			// ...then edit it against a cold (empty) cache.
			const result = await spawnAgainstEmptyCache(
				"edit",
				"Activity_17s7axj",
				tempBpmn,
				"--set",
				"method=PUT",
			);
			assert.strictEqual(result.status, 1);
			const output = result.stdout + result.stderr;
			assert.ok(
				output.includes("element-template sync"),
				`Should point at 'sync'. Got: ${output.slice(0, 300)}`,
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
	/**
	 * Apply a custom (non-OOTB) copy of the HTTP JSON fixture to a fresh BPMN
	 * copy, then hand the caller the BPMN path and the custom template path.
	 * Nothing about the custom template is in the OOTB cache.
	 */
	async function withCustomTemplatedBpmn(
		fn: (ctx: {
			tempDir: string;
			tempBpmn: string;
			customTemplate: Record<string, unknown>;
			customTemplateFile: string;
		}) => Promise<void>,
		{ bpmnSubdir = "" }: { bpmnSubdir?: string } = {},
	): Promise<void> {
		const customTemplate = {
			...JSON.parse(readFileSync(TEMPLATE_FILE, "utf-8")),
			id: "io.example.custom.Http.v1",
			version: 3,
		};
		const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-et-test-"));
		const bpmnDir = join(tempDir, bpmnSubdir);
		mkdirSync(bpmnDir, { recursive: true });
		const tempBpmn = join(bpmnDir, "test.bpmn");
		writeFileSync(tempBpmn, readFileSync(BPMN_FILE, "utf-8"));
		const customTemplateFile = join(tempDir, "custom-template.json");
		writeFileSync(customTemplateFile, JSON.stringify(customTemplate));
		try {
			const applied = await spawnAgainstEmptyCache(
				"apply",
				"-i",
				customTemplateFile,
				"Activity_17s7axj",
				tempBpmn,
				"--set",
				"method=POST",
			);
			assert.strictEqual(applied.status, 0, `stderr: ${applied.stderr}`);
			await fn({ tempDir, tempBpmn, customTemplate, customTemplateFile });
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	}

	test("resolves a custom template from .camunda/element-templates/ in an ancestor of the BPMN file", async () => {
		await withCustomTemplatedBpmn(
			async ({ tempDir, tempBpmn, customTemplate }) => {
				const localDir = join(tempDir, ".camunda", "element-templates");
				mkdirSync(localDir, { recursive: true });
				// Template files may hold a single template or an array.
				writeFileSync(
					join(localDir, "custom.json"),
					JSON.stringify([customTemplate]),
				);
				await withSeededElementTemplateCache([], async (run) => {
					const edited = await run(
						"element-template",
						"edit",
						"Activity_17s7axj",
						tempBpmn,
						"--set",
						"method=PUT",
					);
					assert.strictEqual(edited.status, 0, `stderr: ${edited.stderr}`);
					assert.strictEqual(getInputValue(edited.stdout, "method"), "PUT");
				});
			},
			{ bpmnSubdir: "processes" },
		);
	});

	test("cold cache: resolves a local .camunda/element-templates/ template without the OOTB cache", async () => {
		await withCustomTemplatedBpmn(async ({ tempDir, tempBpmn }) => {
			const localDir = join(tempDir, ".camunda", "element-templates");
			mkdirSync(localDir, { recursive: true });
			writeFileSync(
				join(localDir, "custom.json"),
				readFileSync(join(tempDir, "custom-template.json"), "utf-8"),
			);
			const edited = await spawnAgainstEmptyCache(
				"edit",
				"Activity_17s7axj",
				tempBpmn,
				"--set",
				"method=PUT",
			);
			assert.strictEqual(edited.status, 0, `stderr: ${edited.stderr}`);
			assert.strictEqual(getInputValue(edited.stdout, "method"), "PUT");
		});
	});

	test("--template <path> resolves an explicitly given custom template", async () => {
		await withCustomTemplatedBpmn(async ({ tempBpmn, customTemplateFile }) => {
			const edited = await spawnAgainstEmptyCache(
				"edit",
				"Activity_17s7axj",
				tempBpmn,
				"--template",
				customTemplateFile,
				"--set",
				"method=PUT",
			);
			assert.strictEqual(edited.status, 0, `stderr: ${edited.stderr}`);
			assert.strictEqual(getInputValue(edited.stdout, "method"), "PUT");
		});
	});

	test("--template rejects a template that doesn't match the element's recorded id/version", async () => {
		await withCustomTemplatedBpmn(async ({ tempBpmn }) => {
			const result = await spawnAgainstEmptyCache(
				"edit",
				"Activity_17s7axj",
				tempBpmn,
				"--template",
				TEMPLATE_FILE,
				"--set",
				"method=PUT",
			);
			assert.strictEqual(result.status, 1);
			const output = result.stdout + result.stderr;
			assert.ok(
				output.includes("does not match") &&
					output.includes("io.example.custom.Http.v1"),
				`Should report the id/version mismatch. Got: ${output.slice(0, 400)}`,
			);
		});
	});

	test("unresolvable template: error points at --template and .camunda/element-templates/", async () => {
		await withCustomTemplatedBpmn(async ({ tempBpmn }) => {
			await withSeededElementTemplateCache([], async (run) => {
				const result = await run(
					"element-template",
					"edit",
					"Activity_17s7axj",
					tempBpmn,
					"--set",
					"method=PUT",
				);
				assert.strictEqual(result.status, 1);
				const output = result.stdout + result.stderr;
				assert.ok(
					output.includes("--template") &&
						output.includes(".camunda/element-templates/"),
					`Should mention the escape hatches. Got: ${output.slice(0, 400)}`,
				);
			});
		});
	});
});

// ---------------------------------------------------------------------------
// element-template — cold-cache failures (no auto-bootstrap)
// ---------------------------------------------------------------------------

/**
 * Spawn the CLI against a fresh, empty `C8CTL_DATA_DIR`. The cache
 * is intentionally absent so we exercise the missing-cache path.
 * The temp dir is created and removed inside this helper — callers
 * just consume the spawn result.
 */
async function spawnAgainstEmptyCache(...args: string[]) {
	const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-et-cold-"));
	try {
		return await asyncSpawn(
			"node",
			["--experimental-strip-types", CLI, "element-template", ...args],
			{
				env: {
					...process.env,
					CAMUNDA_BASE_URL: "http://test-cluster/v2",
					HOME: "/tmp/c8ctl-test-nonexistent-home",
					C8CTL_DATA_DIR: dataDir,
				},
			},
		);
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
}

describe("CLI behavioural: element-template cold-cache failures", () => {
	const COLD_CASES: Array<{ label: string; args: string[] }> = [
		{ label: "search", args: ["search", "anything"] },
		{ label: "info", args: ["info", "io.camunda.connectors.HttpJson.v2"] },
		{
			label: "get-properties",
			args: ["get-properties", "io.camunda.connectors.HttpJson.v2"],
		},
		{
			label: "apply",
			args: [
				"apply",
				"io.camunda.connectors.HttpJson.v2",
				"Activity_17s7axj",
				BPMN_FILE,
			],
		},
		{ label: "get", args: ["get", "io.camunda.connectors.HttpJson.v2"] },
	];

	for (const { label, args } of COLD_CASES) {
		test(`${label}: exits 1 with 'run sync first' hint and no stdout contamination`, async () => {
			const result = await spawnAgainstEmptyCache(...args);
			assert.strictEqual(
				result.status,
				1,
				`${label} should exit 1 on cold cache. stderr: ${result.stderr}`,
			);
			const combined = result.stdout + result.stderr;
			assert.ok(
				combined.includes("element-template sync"),
				`${label} error should point at 'sync'. Got: ${combined.slice(0, 300)}`,
			);
			// Critical pipeline-safety guarantee: a cold-cache failure must
			// not write any payload (BPMN XML, template JSON, search rows)
			// to stdout. The error itself goes to stderr via logger.error.
			assert.strictEqual(
				result.stdout.trim(),
				"",
				`${label} must not write to stdout when the cache is missing. ` +
					`Got stdout: ${result.stdout.slice(0, 300)}`,
			);
		});
	}
});

// ---------------------------------------------------------------------------
// element-template — `<id>` resolves .camunda/element-templates/ before the cache
// ---------------------------------------------------------------------------

const LOCAL_TEMPLATE_ID = "io.example.local.Http.v1";

/**
 * A copy of the HTTP JSON fixture under a custom id, with a
 * `marker-v<version>` property so `get-properties` output reveals which
 * version was resolved.
 */
function localTemplateVersion(
	version: number,
	engines?: string,
): Record<string, unknown> {
	const base = JSON.parse(readFileSync(TEMPLATE_FILE, "utf-8"));
	return {
		...base,
		id: LOCAL_TEMPLATE_ID,
		version,
		engines: engines ? { camunda: engines } : undefined,
		properties: [
			...base.properties,
			{
				id: `marker-v${version}`,
				label: "marker",
				type: "String",
				value: "x",
				binding: { type: "zeebe:input", name: `marker-v${version}` },
			},
		],
	};
}

/**
 * A project dir whose `.camunda/element-templates/` holds v2 (^8.7) and v3
 * (^8.9) of a custom template, with the BPMN (executionPlatformVersion
 * 8.8.0) in a `processes/` subdirectory. `run` spawns the CLI in JSON mode
 * from `cwd`, against a data dir whose OOTB cache is absent unless `cache`
 * is given, and an empty Desktop Modeler user-data dir (`modelerDir`).
 */
async function withLocalTemplateProject(
	{ cache }: { cache?: Array<Record<string, unknown>> },
	fn: (ctx: {
		projectDir: string;
		modelerDir: string;
		bpmn: string;
		run: (cwd: string, ...args: string[]) => ReturnType<typeof asyncSpawn>;
	}) => Promise<void>,
): Promise<void> {
	const projectDir = mkdtempSync(join(tmpdir(), "c8ctl-et-project-"));
	const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-et-cold-"));
	const modelerDir = mkdtempSync(join(tmpdir(), "c8ctl-et-modeler-"));
	writeFileSync(
		join(dataDir, "session.json"),
		JSON.stringify({ outputMode: "json" }),
	);
	if (cache) {
		const cacheDir = join(dataDir, "element-templates");
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(join(cacheDir, "templates.json"), JSON.stringify(cache));
		writeFileSync(join(cacheDir, "fetched-at"), String(Date.now()));
	}
	const localDir = join(projectDir, ".camunda", "element-templates");
	mkdirSync(localDir, { recursive: true });
	writeFileSync(
		join(localDir, "custom.json"),
		JSON.stringify([
			localTemplateVersion(2, "^8.7"),
			localTemplateVersion(3, "^8.9"),
		]),
	);
	mkdirSync(join(projectDir, "processes"));
	const bpmn = join(projectDir, "processes", "test.bpmn");
	writeFileSync(bpmn, readFileSync(BPMN_FILE, "utf-8"));
	const run = (cwd: string, ...args: string[]) =>
		asyncSpawn(
			"node",
			["--experimental-strip-types", join(REPO_ROOT, CLI), ...args],
			{
				cwd,
				env: {
					...process.env,
					CAMUNDA_BASE_URL: "http://test-cluster/v2",
					HOME: "/tmp/c8ctl-test-nonexistent-home",
					C8CTL_DATA_DIR: dataDir,
					C8CTL_MODELER_DIR: modelerDir,
				},
			},
		);
	try {
		await fn({ projectDir, modelerDir, bpmn, run });
	} finally {
		rmSync(projectDir, { recursive: true, force: true });
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(modelerDir, { recursive: true, force: true });
	}
}

describe("CLI behavioural: element-template <id> resolves .camunda/element-templates/ first", () => {
	type Case = {
		label: string;
		args: (ref: string, bpmn: string) => string[];
		/** `apply` searches from the BPMN's directory; the rest from cwd. */
		cwd: (projectDir: string) => string;
		resolvedVersion: (stdout: string) => number | undefined;
		/** Unpinned: highest local version compatible with the engine. */
		unpinned: number;
		pinned: number;
	};
	const CASES: Case[] = [
		{
			label: "apply",
			args: (ref, bpmn) => ["apply", ref, "Activity_17s7axj", bpmn],
			cwd: () => tmpdir(),
			resolvedVersion: (stdout) =>
				Number(stdout.match(/zeebe:modelerTemplateVersion="(\d+)"/)?.[1]),
			// The BPMN targets 8.8.0, so v3 (^8.9) is skipped.
			unpinned: 2,
			pinned: 3,
		},
		{
			label: "info",
			args: (ref) => ["info", ref],
			cwd: (projectDir) => join(projectDir, "processes"),
			resolvedVersion: (stdout) => JSON.parse(stdout).version,
			unpinned: 3,
			pinned: 2,
		},
		{
			label: "get-properties",
			args: (ref) => ["get-properties", ref, "marker-*"],
			cwd: (projectDir) => join(projectDir, "processes"),
			resolvedVersion: (stdout) =>
				Number(
					JSON.parse(stdout).properties[0]?.binding.name.slice(
						"marker-v".length,
					),
				),
			unpinned: 3,
			pinned: 2,
		},
		{
			label: "get",
			args: (ref) => ["get", ref],
			cwd: (projectDir) => projectDir,
			resolvedVersion: (stdout) => JSON.parse(stdout).version,
			unpinned: 3,
			pinned: 2,
		},
	];

	for (const c of CASES) {
		test(`${c.label}: cold cache resolves the highest compatible local version`, async () => {
			await withLocalTemplateProject({}, async ({ projectDir, bpmn, run }) => {
				const result = await run(
					c.cwd(projectDir),
					"element-template",
					...c.args(LOCAL_TEMPLATE_ID, bpmn),
				);
				assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
				assert.strictEqual(c.resolvedVersion(result.stdout), c.unpinned);
			});
		});

		test(`${c.label}: cold cache resolves a pinned local version exactly`, async () => {
			await withLocalTemplateProject({}, async ({ projectDir, bpmn, run }) => {
				const result = await run(
					c.cwd(projectDir),
					"element-template",
					...c.args(`${LOCAL_TEMPLATE_ID}@${c.pinned}`, bpmn),
				);
				assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
				assert.strictEqual(c.resolvedVersion(result.stdout), c.pinned);
			});
		});

		test(`${c.label}: a version missing locally falls back to the OOTB cache`, async () => {
			await withLocalTemplateProject(
				{ cache: [localTemplateVersion(5)] },
				async ({ projectDir, bpmn, run }) => {
					const result = await run(
						c.cwd(projectDir),
						"element-template",
						...c.args(`${LOCAL_TEMPLATE_ID}@5`, bpmn),
					);
					assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
					assert.strictEqual(c.resolvedVersion(result.stdout), 5);
				},
			);
		});
	}

	test("info: no engine-compatible local version falls back to the OOTB cache", async () => {
		await withLocalTemplateProject(
			{ cache: [localTemplateVersion(5)] },
			async ({ projectDir, run }) => {
				const result = await run(
					projectDir,
					"element-template",
					"info",
					LOCAL_TEMPLATE_ID,
					"--engine-version",
					"8.6.0",
				);
				assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
				assert.strictEqual(JSON.parse(result.stdout).version, 5);
			},
		);
	});
});

describe("CLI behavioural: element-template local lookup matches Desktop Modeler", () => {
	/** Write `templates` to `<dir>/.camunda/element-templates/<name>`. */
	function writeLocal(dir: string, name: string, templates: unknown): void {
		const localDir = join(dir, ".camunda", "element-templates");
		mkdirSync(localDir, { recursive: true });
		writeFileSync(join(localDir, name), JSON.stringify(templates));
	}

	test("picks the version over all ancestors, not the nearest directory with a match", async () => {
		await withLocalTemplateProject({}, async ({ projectDir, run }) => {
			// The project root holds v2 and v3; the nearer dir only v1.
			const processes = join(projectDir, "processes");
			writeLocal(processes, "v1.json", localTemplateVersion(1));
			const result = await run(
				processes,
				"element-template",
				"get",
				LOCAL_TEMPLATE_ID,
			);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			assert.strictEqual(JSON.parse(result.stdout).version, 3);
		});
	});

	test("duplicate id+version: the nearest wins and the duplicate is reported", async () => {
		await withLocalTemplateProject({}, async ({ projectDir, run }) => {
			const processes = join(projectDir, "processes");
			writeLocal(processes, "v3.json", {
				...localTemplateVersion(3, "^8.9"),
				name: "nearest",
			});
			const result = await run(
				processes,
				"element-template",
				"get",
				`${LOCAL_TEMPLATE_ID}@3`,
			);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			assert.strictEqual(JSON.parse(result.stdout).name, "nearest");
			assert.ok(
				result.stderr.includes("already used"),
				`Should report the shadowed duplicate. Got: ${result.stderr}`,
			);
		});
	});

	test("a malformed template file is an error, not skipped", async () => {
		await withLocalTemplateProject({}, async ({ projectDir, run }) => {
			writeFileSync(
				join(projectDir, ".camunda", "element-templates", "broken.json"),
				"{ not json",
			);
			const result = await run(
				join(projectDir, "processes"),
				"element-template",
				"get",
				LOCAL_TEMPLATE_ID,
			);
			assert.strictEqual(result.status, 1);
			const output = result.stdout + result.stderr;
			assert.match(
				output,
				/template \S*broken\.json parse error/,
				"Should name the malformed file",
			);
		});
	});

	test("an invalid local template is reported and skipped", async () => {
		const otherId = `${LOCAL_TEMPLATE_ID}.other`;
		await withLocalTemplateProject(
			{ cache: [{ ...localTemplateVersion(5), id: otherId }] },
			async ({ projectDir, run }) => {
				// The only local candidate lacks `$schema`, so the cache answers.
				const { $schema: _, ...invalid } = localTemplateVersion(9);
				writeLocal(join(projectDir, "processes"), "invalid.json", {
					...invalid,
					id: otherId,
				});
				const result = await run(
					join(projectDir, "processes"),
					"element-template",
					"get",
					otherId,
				);
				assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
				assert.strictEqual(JSON.parse(result.stdout).version, 5);
				assert.ok(
					result.stderr.includes("missing $schema"),
					`Should report why the template was skipped. Got: ${result.stderr}`,
				);
			},
		);
	});

	test("cold cache: resolves a template from the Desktop Modeler user-data dir", async () => {
		await withLocalTemplateProject({}, async ({ modelerDir, run }) => {
			const userTemplates = join(
				modelerDir,
				"resources",
				"element-templates",
				"nested",
			);
			mkdirSync(userTemplates, { recursive: true });
			writeFileSync(
				join(userTemplates, "custom.json"),
				JSON.stringify(localTemplateVersion(7)),
			);
			const result = await run(
				tmpdir(),
				"element-template",
				"get",
				LOCAL_TEMPLATE_ID,
			);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			assert.strictEqual(JSON.parse(result.stdout).version, 7);
		});
	});
});

// ---------------------------------------------------------------------------
// element-template — npm package sync and cache
// ---------------------------------------------------------------------------

function ootbTemplate(id: string, version: number) {
	return {
		id,
		name: `${id} v${version}`,
		version,
		engines: { camunda: "^8.7" },
		appliesTo: ["bpmn:Task"],
		elementType: { value: "bpmn:ServiceTask" },
		properties: [],
	};
}

function syncEnv(dataDir: string, packageDir: string) {
	return {
		...process.env,
		HOME: "/tmp/c8ctl-test-nonexistent-home",
		C8CTL_DATA_DIR: dataDir,
		C8CTL_ELEMENT_TEMPLATES_PACKAGE: packageDir,
	};
}

function writeTemplatePackage(
	dir: string,
	templates: unknown[],
	version = "1.0.0",
): void {
	const templatesDir = join(dir, "src", "element-templates");
	mkdirSync(templatesDir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name: "test-element-templates", version }),
	);
	writeFileSync(join(templatesDir, "agent.json"), JSON.stringify(templates));
}

function readCache(dataDir: string): Array<Record<string, unknown>> {
	const raw: unknown = JSON.parse(
		readFileSync(join(dataDir, "element-templates", "templates.json"), "utf-8"),
	);
	assert.ok(Array.isArray(raw), "cache should be a JSON array");
	return raw.filter(isRecord);
}

function upstreamRefOf(template: Record<string, unknown>): string {
	assert.ok(isRecord(template.metadata), "template should carry metadata");
	const ref = template.metadata.upstreamRef;
	assert.ok(typeof ref === "string", "template should carry an upstreamRef");
	return ref;
}

describe("CLI behavioural: element-template npm sync", () => {
	test("syncs every version and embedded migration recipe from a local npm package", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-et-npm-"));
		const packageDir = join(dataDir, "package");
		writeTemplatePackage(packageDir, [
			ootbTemplate("io.example.Agent", 1),
			{
				...ootbTemplate("io.example.Agent", 2),
				metadata: { migratesFrom: { schemaVersion: 1, sources: [] } },
			},
			{ ...ootbTemplate("io.example.Legacy", 1), engines: undefined },
			{ ...ootbTemplate("io.example.Agent", 3), version: undefined },
		]);
		try {
			const result = await asyncSpawn(
				"node",
				["--experimental-strip-types", CLI, "element-template", "sync"],
				{
					env: syncEnv(dataDir, packageDir),
				},
			);
			assert.strictEqual(result.status, 0, result.stderr);
			const cache = readCache(dataDir);
			assert.deepStrictEqual(
				cache.map((template) => `${template.id}@${template.version}`),
				["io.example.Agent@1", "io.example.Agent@2", "io.example.Legacy@1"],
			);
			assert.ok(isRecord(cache[1].metadata));
			assert.deepStrictEqual(cache[1].metadata.migratesFrom, {
				schemaVersion: 1,
				sources: [],
			});
			assert.match(
				upstreamRefOf(cache[1]),
				/^npm:test-element-templates@1\.0\.0#/,
			);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	test("updates an existing cache and prunes only missing versions", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-et-prune-"));
		const packageDir = join(dataDir, "package");
		writeTemplatePackage(packageDir, [
			ootbTemplate("io.example.Agent", 1),
			ootbTemplate("io.example.Old", 1),
		]);
		try {
			const first = await asyncSpawn(
				"node",
				["--experimental-strip-types", CLI, "element-template", "sync"],
				{
					env: syncEnv(dataDir, packageDir),
				},
			);
			assert.strictEqual(first.status, 0, first.stderr);
			writeTemplatePackage(
				packageDir,
				[ootbTemplate("io.example.Agent", 2)],
				"1.0.1",
			);
			const second = await asyncSpawn(
				"node",
				[
					"--experimental-strip-types",
					CLI,
					"--json",
					"element-template",
					"sync",
					"--prune",
				],
				{ env: syncEnv(dataDir, packageDir) },
			);
			assert.strictEqual(second.status, 0, second.stderr);
			assert.deepStrictEqual(
				readCache(dataDir).map((tpl) => `${tpl.id}@${tpl.version}`),
				["io.example.Agent@2"],
			);
			const summary: unknown = JSON.parse(second.stdout.trim());
			assert.ok(isRecord(summary));
			assert.strictEqual(summary.pruned, 2);
			assert.strictEqual(summary.fetched, 1);
			assert.ok(!existsSync(join(dataDir, "element-templates", ".sync.lock")));
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	test("a failed package download leaves cached templates and freshness intact", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-et-failure-"));
		const packageDir = join(dataDir, "package");
		writeTemplatePackage(packageDir, [ootbTemplate("io.example.Agent", 1)]);
		try {
			const first = await asyncSpawn(
				"node",
				["--experimental-strip-types", CLI, "element-template", "sync"],
				{
					env: syncEnv(dataDir, packageDir),
				},
			);
			assert.strictEqual(first.status, 0, first.stderr);
			const cachePath = join(dataDir, "element-templates", "templates.json");
			const timestampPath = join(dataDir, "element-templates", "fetched-at");
			const before = readFileSync(cachePath, "utf-8");
			const timestamp = readFileSync(timestampPath, "utf-8");
			rmSync(packageDir, { recursive: true });
			const second = await asyncSpawn(
				"node",
				[
					"--experimental-strip-types",
					CLI,
					"--json",
					"element-template",
					"sync",
					"--prune",
				],
				{ env: syncEnv(dataDir, packageDir) },
			);
			assert.strictEqual(second.status, 0, second.stderr);
			assert.strictEqual(readFileSync(cachePath, "utf-8"), before);
			assert.strictEqual(readFileSync(timestampPath, "utf-8"), timestamp);
			const summary: unknown = JSON.parse(second.stdout.trim());
			assert.ok(isRecord(summary));
			assert.strictEqual(summary.errors, 1);
			assert.strictEqual(summary.pruned, 0);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	test("refuses a second sync while the cache is locked", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-et-lock-"));
		const cacheDir = join(dataDir, "element-templates");
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(
			join(cacheDir, ".sync.lock"),
			JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
		);
		try {
			const result = await asyncSpawn(
				"node",
				["--experimental-strip-types", CLI, "element-template", "sync"],
				{ env: syncEnv(dataDir, join(dataDir, "missing")) },
			);
			assert.strictEqual(result.status, 1);
			assert.match(
				result.stderr + result.stdout,
				/Another sync is in progress/,
			);
			assert.ok(existsSync(join(cacheDir, ".sync.lock")));
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// element-template — atomic in-place write + EPIPE
// ---------------------------------------------------------------------------

describe("CLI behavioural: element-template apply --in-place atomicity", () => {
	test("leaves no .tmp file in the BPMN directory after a successful apply", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-et-tmp-"));
		const bpmnDir = mkdtempSync(join(tmpdir(), "c8ctl-et-bpmn-"));
		const bpmnPath = join(bpmnDir, "process.bpmn");
		writeFileSync(bpmnPath, readFileSync(BPMN_FILE, "utf-8"));
		try {
			const result = await asyncSpawn(
				"node",
				[
					"--experimental-strip-types",
					CLI,
					"element-template",
					"apply",
					"-i",
					TEMPLATE_FILE,
					"Activity_17s7axj",
					bpmnPath,
				],
				{
					env: {
						...process.env,
						CAMUNDA_BASE_URL: "http://test-cluster/v2",
						HOME: "/tmp/c8ctl-test-nonexistent-home",
						C8CTL_DATA_DIR: dataDir,
					},
				},
			);
			assert.strictEqual(
				result.status,
				0,
				`apply -i should succeed. stderr: ${result.stderr}`,
			);
			const leftovers = readdirSync(bpmnDir).filter((name) =>
				name.endsWith(".tmp"),
			);
			assert.deepStrictEqual(
				leftovers,
				[],
				`No .tmp file should survive a clean apply. Found: ${leftovers.join(", ")}`,
			);
			// And the file must have been updated (contains zeebe namespace
			// after applying the HTTP JSON connector template).
			const updated = readFileSync(bpmnPath, "utf-8");
			assert.ok(
				updated.includes("zeebe:taskDefinition"),
				"BPMN file should contain the applied template's zeebe:taskDefinition",
			);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
			rmSync(bpmnDir, { recursive: true, force: true });
		}
	});
});

// EPIPE behaviour is POSIX-specific: `sh`, `head`, and `/dev/null` are not
// available on Windows. The test is skipped there and remains a full guard
// on POSIX CI.
describe("CLI behavioural: element-template stdout EPIPE handling", () => {
	test("apply: closing the downstream pipe early exits cleanly without an unhandled error stack", {
		skip:
			process.platform === "win32"
				? "POSIX-only: requires sh, head, and /dev/null"
				: false,
	}, async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-et-epipe-"));
		try {
			// Use a template file (no cache lookup) so we test the EPIPE
			// path itself, not the OOTB resolution path.
			// Pipe the apply output into `head -c 1` to slam the pipe shut
			// just after the first byte; without the EPIPE handler this
			// crashes the child process with an 'Unhandled error' stack.
			const child = await asyncSpawn(
				"sh",
				[
					"-c",
					[
						"node",
						"--experimental-strip-types",
						CLI,
						"element-template",
						"apply",
						JSON.stringify(TEMPLATE_FILE),
						"Activity_17s7axj",
						JSON.stringify(BPMN_FILE),
						"| head -c 1 > /dev/null",
					].join(" "),
				],
				{
					env: {
						...process.env,
						CAMUNDA_BASE_URL: "http://test-cluster/v2",
						HOME: "/tmp/c8ctl-test-nonexistent-home",
						C8CTL_DATA_DIR: dataDir,
					},
				},
			);
			// The child invokes node + head; sh's exit status is head's
			// (always 0 here). What we really care about is no unhandled
			// error stack on stderr from the node child.
			assert.ok(
				!child.stderr.includes("Unhandled"),
				`stderr should not contain an unhandled-error stack. Got: ${child.stderr.slice(0, 300)}`,
			);
			assert.ok(
				!child.stderr.includes("EPIPE"),
				`stderr should not surface a raw EPIPE. Got: ${child.stderr.slice(0, 300)}`,
			);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
