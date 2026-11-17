/**
 * Unit tests for the `c8ctl setup` content and renderers:
 * banner alignment, plan tailoring, and the JSON plan payload.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	defaultSelection,
	renderSetupPlan,
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

describe("renderSetupPlan()", () => {
	test("numbers every step when nothing is skipped", () => {
		const all = new Set(SETUP_COMPONENTS.map((c) => c.id));
		const plan = renderSetupPlan(all, { color: false });
		for (const [i, step] of SETUP_STEPS.entries()) {
			assert.ok(
				plan.includes(`${String(i + 1).padStart(2, "0")}. ${step.title}`),
				`step ${i + 1} missing`,
			);
		}
		assert.doesNotMatch(plan, /skipped/);
	});

	test("unselected components are listed as skipped, keeping order", () => {
		const plan = renderSetupPlan(new Set(), { color: false });
		assert.match(plan, /01\. Check prerequisites/);
		assert.match(plan, /- Install Camunda 8 Run — skipped/);
		assert.match(plan, /- Open Operate — skipped/);
		// The always-run steps are the only numbered ones left.
		assert.doesNotMatch(plan, /02\./);
	});

	test("default selection skips only the docs MCP step", () => {
		const plan = renderSetupPlan(defaultSelection(), { color: false });
		assert.match(plan, /- Configure the docs MCP server — skipped/);
		assert.match(plan, /Configure the cluster MCP server/);
		assert.doesNotMatch(plan, /- Configure the cluster MCP server — skipped/);
	});

	test("colored output styles step numbers in the brand color", () => {
		const plan = renderSetupPlan(defaultSelection(), { color: true });
		assert.ok(plan.includes(BRAND_BLUE), "brand color missing");
		assert.strictEqual(
			stripVTControlCharacters(plan),
			renderSetupPlan(defaultSelection(), { color: false }),
		);
	});

	test("the plan is the contract: no preview note, execution follows", () => {
		const plan = renderSetupPlan(defaultSelection(), { color: false });
		assert.doesNotMatch(plan, /Nothing was installed/);
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
