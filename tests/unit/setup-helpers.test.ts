/**
 * Unit tests for the `c8ctl setup` content and renderers:
 * banner alignment, plan tailoring, and the JSON plan payload.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	createLineForwarder,
	defaultSelection,
	formatStepResult,
	isClusterProgressLine,
	renderWelcomeBanner,
	SETUP_COMPONENTS,
	SETUP_STEPS,
	setupPlanPayload,
} from "../../src/utils/index.ts";

const BRAND_BLUE = "\x1b[38;2;79;57;246m";

describe("SETUP_COMPONENTS", () => {
	test("ids are unique", () => {
		const ids = SETUP_COMPONENTS.map((c) => c.id);
		assert.strictEqual(new Set(ids).size, ids.length);
	});

	test("the docs MCP server is opt-in, everything else is pre-selected", () => {
		for (const c of SETUP_COMPONENTS) {
			assert.strictEqual(
				c.defaultSelected,
				c.id !== "docs-mcp",
				`${c.id} defaultSelected`,
			);
		}
	});

	test("every component carries a one-line why", () => {
		for (const c of SETUP_COMPONENTS) {
			assert.ok(c.why.length > 10, `${c.id} has a why`);
			assert.ok(!c.why.includes("\n"), `${c.id} why is one line`);
		}
	});

	test("defaultSelection matches defaultSelected", () => {
		assert.deepStrictEqual(
			[...defaultSelection()].sort(),
			SETUP_COMPONENTS.filter((c) => c.defaultSelected)
				.map((c) => c.id)
				.sort(),
		);
	});
});

describe("SETUP_STEPS", () => {
	test("every step belongs to a known component or always runs", () => {
		const ids = new Set(SETUP_COMPONENTS.map((c) => c.id));
		for (const step of SETUP_STEPS) {
			assert.ok(
				step.component === null || ids.has(step.component),
				`step "${step.title}" references unknown component`,
			);
		}
	});

	test("prerequisites always run first", () => {
		assert.strictEqual(SETUP_STEPS[0].component, null);
		assert.match(SETUP_STEPS[0].title, /prerequisites/i);
	});

	test("step ids are unique", () => {
		const ids = SETUP_STEPS.map((s) => s.id);
		assert.strictEqual(new Set(ids).size, ids.length);
	});
});

describe("renderWelcomeBanner()", () => {
	test("plain output has no ANSI escapes and aligned box edges", () => {
		const banner = renderWelcomeBanner({ color: false });
		assert.strictEqual(banner, stripVTControlCharacters(banner));
		const lines = banner.split("\n");
		const widths = new Set(lines.map((l) => l.length));
		assert.deepStrictEqual(
			[...widths],
			[lines[0].length],
			`box rows differ in width: ${[...widths].join(", ")}`,
		);
		assert.match(banner, /Welcome to Camunda 8!/);
		assert.match(banner, /Nothing runs without your say\./);
	});

	test("colored output styles the logo in Camunda Royal Blue", () => {
		const banner = renderWelcomeBanner({ color: true });
		assert.ok(banner.includes(BRAND_BLUE), "brand color missing");
		assert.strictEqual(
			stripVTControlCharacters(banner),
			renderWelcomeBanner({ color: false }),
			"colored and plain banners differ beyond styling",
		);
	});
});

describe("formatStepResult()", () => {
	test("plain output aligns the tags in one column", () => {
		const width = "Start the local cluster".length;
		const success = formatStepResult("Check prerequisites", "success", width, {
			color: false,
		});
		const skipped = formatStepResult(
			"Start the local cluster",
			"skipped",
			width,
			{ color: false },
		);
		assert.strictEqual(success, stripVTControlCharacters(success));
		assert.strictEqual(
			success.indexOf("[SUCCESS]"),
			skipped.indexOf("[SKIPPED]"),
		);
	});

	test("colored output paints success green, error red and skipped dim", () => {
		const success = formatStepResult("A", "success", 3, { color: true });
		const error = formatStepResult("A", "error", 3, { color: true });
		const skipped = formatStepResult("A", "skipped", 3, { color: true });
		assert.ok(success.includes("\x1b[32m[SUCCESS]\x1b[0m"), success);
		assert.ok(error.includes("\x1b[31m[ERROR]\x1b[0m"), error);
		assert.ok(skipped.includes("\x1b[2m[SKIPPED]\x1b[0m"), skipped);
		// Styling must not change the visible text.
		assert.strictEqual(
			stripVTControlCharacters(success),
			formatStepResult("A", "success", 3, { color: false }),
		);
	});
});

describe("isClusterProgressLine()", () => {
	test("matches the cluster plugin's download progress lines", () => {
		assert.ok(
			isClusterProgressLine(
				"//> 42% (360.7 MB / 860.6 MB) at 10.8 MB/s, ETA 40s",
			),
		);
		assert.ok(
			isClusterProgressLine("  //> 360.7 MB (total size unknown) at 10.8 MB/s"),
		);
	});

	test("keeps regular child output", () => {
		assert.ok(!isClusterProgressLine("Downloading Camunda 8.10 for darwin..."));
		assert.ok(!isClusterProgressLine("c8run 8.10 installed successfully."));
		assert.ok(!isClusterProgressLine(""));
	});
});

describe("createLineForwarder()", () => {
	test("forwards lines and drops skipped ones", () => {
		const written: string[] = [];
		const forwarder = createLineForwarder({
			write: (line) => written.push(line),
			skip: isClusterProgressLine,
		});
		forwarder.push("Downloading c8run...\n//> 5% (43 MB)\nDone.\n");
		assert.deepStrictEqual(written, ["Downloading c8run...", "Done."]);
	});

	test("buffers partial lines across chunks and flushes the tail", () => {
		const written: string[] = [];
		const forwarder = createLineForwarder({
			write: (line) => written.push(line),
			skip: isClusterProgressLine,
		});
		forwarder.push("partial");
		assert.deepStrictEqual(written, []);
		forwarder.push(" line\n//> tail without newline");
		forwarder.flush();
		assert.deepStrictEqual(written, ["partial line"]);
	});
});

describe("setupPlanPayload()", () => {
	test("marks each component's selection and each step's status", () => {
		const payload = setupPlanPayload(defaultSelection());
		assert.strictEqual(payload.command, "setup");
		assert.strictEqual(payload.preview, true);
		assert.strictEqual(payload.components.length, SETUP_COMPONENTS.length);
		assert.strictEqual(payload.steps.length, SETUP_STEPS.length);
		const docsMcp = payload.components.find((c) => c.id === "docs-mcp");
		assert.strictEqual(docsMcp?.selected, false);
		const docsStep = payload.steps.find(
			(s) => s.title === "Configure the docs MCP server",
		);
		assert.strictEqual(docsStep?.status, "skipped");
		const prereq = payload.steps.find((s) => s.title === "Check prerequisites");
		assert.strictEqual(prereq?.status, "planned");
	});

	test("reports the chosen blueprint, null when none was picked", () => {
		assert.strictEqual(setupPlanPayload(defaultSelection()).blueprint, null);
		assert.strictEqual(
			setupPlanPayload(defaultSelection(), { blueprint: "ai-agent" }).blueprint,
			"ai-agent",
		);
	});
});
