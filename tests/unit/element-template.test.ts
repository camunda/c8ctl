/**
 * Behavioural tests for the element-template commands
 * (default-plugins/element-template/)
 */

import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		assert.ok(output.includes("info"), "Should list info");
		assert.ok(output.includes("get-properties"), "Should list get-properties");
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

	test("rejects a positional that matches nothing — points at info", async () => {
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
			output.includes("c8ctl element-template info"),
			"Should redirect to the info command",
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
