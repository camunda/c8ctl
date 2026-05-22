/**
 * Behavioural tests for the element-template commands
 * (default-plugins/element-template/)
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import {
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
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { isRecord } from "../../src/logger.ts";
import { c8 } from "../utils/cli.ts";
import { asyncSpawn, asyncSpawnWithStdin } from "../utils/spawn.ts";

const FIXTURES_DIR = resolve(import.meta.dirname, "..", "fixtures");
const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
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
// element-template — sync lockfile + --prune count
// ---------------------------------------------------------------------------

/**
 * In-process marketplace stub. Serves a configurable
 * `/ootb-connectors` index and an arbitrary number of per-ref
 * templates under `/t/<id>@<version>`. Each call to `serveIndex`
 * swaps the index in place so a test can simulate "the upstream
 * dropped a template" without restarting the server.
 */
type StubServer = {
	url: string;
	close: () => Promise<void>;
	setIndex: (index: Record<string, Array<unknown>>) => void;
};

/**
 * Pull the listening port off a Node `http.Server` without an `as`
 * cast — `server.address()` returns `string | AddressInfo | null` and
 * the plugin lint forbids the unsafe assertion.
 */
function getServerPort(server: Server): number {
	const addr = server.address();
	if (isRecord(addr) && typeof addr.port === "number") {
		return addr.port;
	}
	throw new Error("stub server has no port (not listening?)");
}

async function startMarketplaceStub(
	templates: Array<Record<string, unknown>>,
): Promise<StubServer> {
	type IndexEntry = {
		version: number;
		ref: string;
		engine: { camunda: string };
	};
	let currentIndex: Record<string, IndexEntry[]> = {};
	const templatesByRef = new Map<string, Record<string, unknown>>();

	const buildIndex = (entries: Array<Record<string, unknown>>) => {
		const idx: Record<string, IndexEntry[]> = {};
		templatesByRef.clear();
		for (const tpl of entries) {
			const id = String(tpl.id);
			const version = Number(tpl.version);
			const ref = `/t/${encodeURIComponent(id)}@${version}`;
			idx[id] = idx[id] || [];
			idx[id].push({
				version,
				ref: `__BASE__${ref}`,
				engine: { camunda: "^8.0" },
			});
			templatesByRef.set(ref, tpl);
		}
		return idx;
	};
	currentIndex = buildIndex(templates);

	const server: Server = createServer((req, res) => {
		if (!req.url) {
			res.statusCode = 400;
			res.end();
			return;
		}
		if (req.url === "/ootb-connectors") {
			// Stamp the real listening URL into ref placeholders so the
			// client follows them back to us.
			const baseUrl = `http://127.0.0.1:${getServerPort(server)}`;
			const rewritten: Record<string, IndexEntry[]> = {};
			for (const [id, versions] of Object.entries(currentIndex)) {
				rewritten[id] = versions.map((v) => ({
					...v,
					ref: v.ref.replace("__BASE__", baseUrl),
				}));
			}
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(rewritten));
			return;
		}
		const tpl = templatesByRef.get(req.url);
		if (tpl) {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(tpl));
			return;
		}
		res.statusCode = 404;
		res.end();
	});

	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolveListen());
	});
	const port = getServerPort(server);
	return {
		url: `http://127.0.0.1:${port}/ootb-connectors`,
		setIndex: (next) => {
			// Accept the public-facing index shape — caller crafts entries
			// matching IndexEntry. Currently unused by the tests but kept
			// on the API so a test can simulate "upstream changed" without
			// restarting the server.
			const reshaped: Record<string, IndexEntry[]> = {};
			for (const [id, versions] of Object.entries(next)) {
				if (!Array.isArray(versions)) continue;
				reshaped[id] = versions
					.filter(isRecord)
					.filter(
						(v): v is IndexEntry =>
							typeof v.version === "number" && typeof v.ref === "string",
					);
			}
			currentIndex = reshaped;
		},
		close: () =>
			new Promise<void>((resolveClose) => server.close(() => resolveClose())),
	};
}

describe("CLI behavioural: element-template sync lockfile", () => {
	test("second concurrent sync exits non-zero pointing at the lockfile", async () => {
		// Pre-seed a live lock owned by THIS test process. The lock helper
		// recognises an alive PID and refuses to acquire — exactly the
		// "two shells racing" scenario without the timing flakiness of
		// actually running two syncs in parallel.
		const stub = await startMarketplaceStub([
			{
				id: "io.example.locked",
				name: "Locked",
				version: 1,
				properties: [],
			},
		]);
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
				{
					env: {
						...process.env,
						HOME: "/tmp/c8ctl-test-nonexistent-home",
						C8CTL_DATA_DIR: dataDir,
						C8CTL_OOTB_ELEMENT_TEMPLATES_URL: stub.url,
					},
				},
			);
			assert.strictEqual(
				result.status,
				1,
				`Second sync should fail when a live lock is held. stderr: ${result.stderr}`,
			);
			const combined = result.stdout + result.stderr;
			assert.ok(
				combined.includes("Another sync is in progress"),
				`Expected lockfile contention message. Got: ${combined.slice(0, 300)}`,
			);
			// Pre-seeded lock must survive the failed attempt.
			assert.ok(
				existsSync(join(cacheDir, ".sync.lock")),
				"Lockfile from the simulated 'live' holder should not be removed by the loser.",
			);
		} finally {
			await stub.close();
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	test("stale lock (dead PID) is recovered and sync proceeds", async () => {
		const stub = await startMarketplaceStub([
			{
				id: "io.example.stale",
				name: "Stale",
				version: 1,
				properties: [],
			},
		]);
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-et-stale-"));
		const cacheDir = join(dataDir, "element-templates");
		mkdirSync(cacheDir, { recursive: true });
		// Spawn-then-await a no-op child to obtain a PID that's guaranteed
		// to have exited by the time we use it. (Hard-coded large PIDs can
		// collide on some platforms; this is portable across Linux/macOS/
		// Windows.)
		const exitedChild = spawnSync(process.execPath, ["-e", ""]);
		const exitedPid = exitedChild.pid;
		assert.ok(exitedPid, "Failed to obtain an exited PID for the test");
		writeFileSync(
			join(cacheDir, ".sync.lock"),
			JSON.stringify({
				pid: exitedPid,
				startedAt: Date.now(),
			}),
		);
		try {
			const result = await asyncSpawn(
				"node",
				["--experimental-strip-types", CLI, "element-template", "sync"],
				{
					env: {
						...process.env,
						HOME: "/tmp/c8ctl-test-nonexistent-home",
						C8CTL_DATA_DIR: dataDir,
						C8CTL_OOTB_ELEMENT_TEMPLATES_URL: stub.url,
					},
				},
			);
			assert.strictEqual(
				result.status,
				0,
				`Sync should recover from a stale lock. stderr: ${result.stderr}`,
			);
			assert.ok(
				result.stderr.includes("stale sync lock") ||
					result.stdout.includes("stale sync lock"),
				`Expected a 'stale sync lock' warning. Got: ${(result.stderr + result.stdout).slice(0, 300)}`,
			);
			// And the cache must have been written.
			assert.ok(
				existsSync(join(cacheDir, "templates.json")),
				"templates.json should exist after a successful recovery sync.",
			);
		} finally {
			await stub.close();
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});

describe("CLI behavioural: element-template sync --prune count", () => {
	test("reports the number of cache entries dropped from the fresh index", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-et-prune-"));
		const cacheDir = join(dataDir, "element-templates");
		mkdirSync(cacheDir, { recursive: true });
		// Seed the cache with TWO entries, one of which the upstream
		// will drop. Each entry carries `metadata.upstreamRef` matching
		// the stub's URL scheme so `byUpstreamRef` looks them up cleanly.
		const stub = await startMarketplaceStub([
			{
				id: "io.example.kept",
				name: "Kept",
				version: 1,
				properties: [],
			},
			// Note: "dropped" is NOT included here, so the fresh index
			// will lack it after sync.
		]);
		const keptRefUrl = `${stub.url.replace("/ootb-connectors", "")}/t/${encodeURIComponent("io.example.kept")}@1`;
		const droppedRefUrl = `${stub.url.replace("/ootb-connectors", "")}/t/${encodeURIComponent("io.example.dropped")}@1`;
		writeFileSync(
			join(cacheDir, "templates.json"),
			JSON.stringify(
				[
					{
						id: "io.example.kept",
						name: "Kept",
						version: 1,
						properties: [],
						metadata: { upstreamRef: keptRefUrl },
					},
					{
						id: "io.example.dropped",
						name: "Dropped",
						version: 1,
						properties: [],
						metadata: { upstreamRef: droppedRefUrl },
					},
				],
				null,
				2,
			),
		);
		writeFileSync(join(cacheDir, "fetched-at"), String(Date.now()));
		try {
			const result = await asyncSpawn(
				"node",
				[
					"--experimental-strip-types",
					CLI,
					"--json",
					"element-template",
					"sync",
					"--prune",
				],
				{
					env: {
						...process.env,
						HOME: "/tmp/c8ctl-test-nonexistent-home",
						C8CTL_DATA_DIR: dataDir,
						C8CTL_OOTB_ELEMENT_TEMPLATES_URL: stub.url,
						C8CTL_OUTPUT_MODE: "json",
					},
				},
			);
			assert.strictEqual(
				result.status,
				0,
				`sync --prune should succeed. stderr: ${result.stderr}`,
			);
			// The summary line is the last JSON object on stdout.
			const summaryLine = result.stdout
				.trim()
				.split("\n")
				.reverse()
				.find((line) => line.startsWith("{") && line.includes("pruned"));
			assert.ok(
				summaryLine,
				`expected a summary JSON line. Got stdout: ${result.stdout.slice(0, 500)}`,
			);
			const summary = JSON.parse(summaryLine ?? "{}");
			assert.strictEqual(
				summary.pruned,
				1,
				`Expected pruned=1 (the 'dropped' entry). Got summary: ${summaryLine}`,
			);
		} finally {
			await stub.close();
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

describe("CLI behavioural: element-template stdout EPIPE handling", () => {
	test("apply: closing the downstream pipe early exits cleanly without an unhandled error stack", async () => {
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
