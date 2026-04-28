/**
 * Behavioural tests for the element-template commands
 * (src/commands/element-template.ts)
 */

import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { c8 } from "../utils/cli.ts";
import { asyncSpawn } from "../utils/spawn.ts";

const FIXTURES_DIR = resolve(import.meta.dirname, "..", "fixtures");
const CLI = "src/index.ts";
const BPMN_FILE = join(FIXTURES_DIR, "simple.bpmn");
const TEMPLATE_FILE = join(FIXTURES_DIR, "http-json-connector.json");

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

function getTaskDefinitionType(xml: string): string | null {
	const match = xml.match(/<zeebe:taskDefinition[^>]+type="([^"]*)"/);
	return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// element-template verb
// ---------------------------------------------------------------------------

describe("CLI behavioural: element-template verb", () => {
	test("element-template with no subcommand shows usage", async () => {
		const result = await c8text("element-template");
		const output = result.stdout + result.stderr;
		assert.ok(output.includes("apply"), "Should list apply");
		assert.ok(
			output.includes("list-properties"),
			"Should list list-properties",
		);
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
});

// ---------------------------------------------------------------------------
// element-template list-properties
// ---------------------------------------------------------------------------

describe("CLI behavioural: element-template list-properties", () => {
	test("lists properties grouped by section in text mode", async () => {
		const result = await c8text(
			"element-template",
			"list-properties",
			TEMPLATE_FILE,
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const output = result.stdout;
		// Template name header
		assert.ok(
			output.includes("REST Outbound Connector"),
			"Should show template name",
		);
		// Group headers
		assert.ok(output.includes("HTTP endpoint"), "Should show endpoint group");
		assert.ok(
			output.includes("Authentication"),
			"Should show authentication group",
		);
		// Properties
		assert.ok(output.includes("method"), "Should list method property");
		assert.ok(output.includes("url"), "Should list url property");
		// Dropdown choices
		assert.ok(
			output.includes("POST") && output.includes("GET"),
			"Should show dropdown choices for method",
		);
		// Default values
		assert.ok(output.includes("default:"), "Should show default values");
		// Conditional marker
		assert.ok(
			output.includes("(conditional)"),
			"Should mark conditional properties",
		);
	});

	test("lists properties as JSON in JSON mode", async () => {
		const result = await c8(
			"element-template",
			"list-properties",
			TEMPLATE_FILE,
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed = JSON.parse(result.stdout);
		assert.strictEqual(parsed.name, "REST Outbound Connector");
		assert.ok(Array.isArray(parsed.properties), "Should have properties array");
		const method = parsed.properties.find(
			(p: Record<string, unknown>) => p.name === "method",
		);
		assert.ok(method, "Should include method property");
		assert.ok(
			Array.isArray(method.choices),
			"method should have choices array",
		);
		assert.ok(
			method.choices.includes("POST"),
			"method choices should include POST",
		);
	});

	test("missing template file exits 1", async () => {
		const result = await c8text(
			"element-template",
			"list-properties",
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

// ---------------------------------------------------------------------------
// element-template help
// ---------------------------------------------------------------------------

describe("CLI behavioural: element-template help", () => {
	test("help element-template shows apply and list-properties", async () => {
		const result = await c8text("help", "element-template");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const output = result.stdout + result.stderr;
		assert.ok(output.includes("apply"), "Should mention apply");
		assert.ok(
			output.includes("list-properties"),
			"Should mention list-properties",
		);
	});
});
