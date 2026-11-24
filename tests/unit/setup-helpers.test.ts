/**
 * Unit tests for the `c8ctl setup` content and renderers:
 * banner alignment, plan tailoring, and the JSON plan payload.
 */

import assert from "node:assert";
import { describe, mock, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	createLineForwarder,
	defaultSelection,
	enforceComponentDependencies,
	formatStepResult,
	isClusterProgressLine,
	renderNextSteps,
	renderWelcomeBanner,
	SETUP_COMPONENTS,
	SETUP_STEPS,
	setupPlanPayload,
	startStepSpinner,
} from "../../default-plugins/setup/helpers.ts";

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

	test("deploy and start the process is the last step, gated on a clean run", () => {
		const last = SETUP_STEPS[SETUP_STEPS.length - 1];
		assert.strictEqual(last.id, "deploy-blueprint");
		assert.strictEqual(last.requiresCleanRun, true);
	});

	test("a step never runs after one it depends on", () => {
		const positions = new Map(SETUP_STEPS.map((s, i) => [s.id, i]));
		for (const step of SETUP_STEPS) {
			for (const dep of step.dependsOn ?? []) {
				assert.ok(
					(positions.get(dep) ?? -1) < (positions.get(step.id) ?? -1),
					`"${step.id}" must come after "${dep}"`,
				);
			}
		}
	});
});

describe("enforceComponentDependencies()", () => {
	test("deselecting the cluster also drops the blueprint and the cluster MCP server", () => {
		const selected = new Set(
			SETUP_COMPONENTS.map((c) => c.id).filter((id) => id !== "cluster"),
		);
		const enforced = enforceComponentDependencies(selected);
		assert.ok(!enforced.has("blueprint"));
		assert.ok(!enforced.has("cluster-mcp"));
		assert.ok(enforced.has("modeler"));
		assert.ok(enforced.has("skills"));
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
		assert.match(banner, /Welcome to Camunda 8/);
		assert.match(banner, /Nothing runs until you confirm\./);
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

describe("renderNextSteps()", () => {
	const LINES = [
		"Project: /tmp/demo/rocket-launch",
		"Guide: https://docs.camunda.io/docs/guides/getting-started-hello-world/",
		"Operate: http://localhost:8080/operate (demo/demo)",
	];

	test("plain output has no ANSI escapes and aligned box edges", () => {
		const box = renderNextSteps(LINES, { color: false });
		assert.strictEqual(box, stripVTControlCharacters(box));
		const rows = box.split("\n");
		const widths = new Set(rows.map((row) => row.length));
		assert.deepStrictEqual(
			[...widths],
			[rows[0].length],
			`box rows differ in width: ${[...widths].join(", ")}`,
		);
		assert.match(box, /╭/);
		assert.match(box, /╯/);
		assert.match(box, /What's next/);
		for (const line of LINES) {
			assert.ok(box.includes(line), `missing: ${line}`);
		}
	});

	test("colored output only styles, never changes the visible text", () => {
		const colored = renderNextSteps(LINES, { color: true });
		assert.strictEqual(
			stripVTControlCharacters(colored),
			renderNextSteps(LINES, { color: false }),
		);
	});

	test("the heading is white on brand blue — fixed colors, readable on dark and light terminals", () => {
		const colored = renderNextSteps(LINES, { color: true });
		const band = `\x1b[48;2;79;57;246m\x1b[38;2;255;255;255m\x1b[1m`;
		assert.ok(colored.includes(band), "white-on-brand heading band missing");
		assert.ok(
			colored.includes(`${band}  What's next`),
			"heading does not open the band",
		);
		// Plain brand-blue text was near-invisible on dark themes — the
		// heading must not fall back to it.
		const headingRow = colored.split("\n")[1];
		assert.ok(headingRow.startsWith(`│${band}`));
		// The unboxed fallback highlights the heading the same way.
		const fallback = renderNextSteps(LINES, { color: true, maxWidth: 40 });
		assert.ok(fallback.startsWith(`${band}What's next`));
	});

	test("falls back to an unboxed block when the content exceeds the width budget", () => {
		const fallback = renderNextSteps(LINES, { color: false, maxWidth: 40 });
		assert.doesNotMatch(fallback, /[╭╮╰╯│]/);
		assert.match(fallback, /What's next/);
		// Long paths and URLs stay intact — nothing is wrapped or truncated.
		for (const line of LINES) {
			assert.ok(fallback.includes(line), `missing: ${line}`);
		}
	});

	test("fits the box when the budget allows it", () => {
		const boxed = renderNextSteps(LINES, { color: false, maxWidth: 200 });
		assert.match(boxed, /╭/);
	});

	test("falls back for non-ASCII content, whose display width is not its length", () => {
		const wide = renderNextSteps(
			["Project: /home/ユーザー/rocket-launch", ...LINES.slice(1)],
			{ color: false },
		);
		assert.doesNotMatch(wide, /[╭╮╰╯│]/);
		assert.ok(wide.includes("Project: /home/ユーザー/rocket-launch"));
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

describe("startStepSpinner()", () => {
	test("writes the first frame immediately, then the next frame on every tick", () => {
		mock.timers.enable({ apis: ["setInterval"] });
		try {
			const written: string[] = [];
			startStepSpinner({ title: "Do a thing", write: (t) => written.push(t) });
			mock.timers.tick(80);
			mock.timers.tick(80);
			mock.timers.tick(80);
			assert.deepStrictEqual(written, [
				"\r  Do a thing ⠋",
				"\r  Do a thing ⠙",
				"\r  Do a thing ⠹",
				"\r  Do a thing ⠸",
			]);
		} finally {
			mock.timers.reset();
		}
	});

	test("wraps around after the last frame", () => {
		mock.timers.enable({ apis: ["setInterval"] });
		try {
			const written: string[] = [];
			startStepSpinner({ title: "X", write: (t) => written.push(t) });
			mock.timers.tick(80 * 10);
			assert.strictEqual(written.length, 11);
			assert.strictEqual(written[0], written[10]);
		} finally {
			mock.timers.reset();
		}
	});

	test("stop() ends the animation and is idempotent", () => {
		mock.timers.enable({ apis: ["setInterval"] });
		try {
			const written: string[] = [];
			const spinner = startStepSpinner({
				title: "X",
				write: (t) => written.push(t),
			});
			mock.timers.tick(160);
			spinner.stop();
			spinner.stop();
			mock.timers.tick(1000);
			assert.strictEqual(written.length, 3);
		} finally {
			mock.timers.reset();
		}
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
			setupPlanPayload(defaultSelection(), { blueprint: "service-worker" })
				.blueprint,
			"service-worker",
		);
	});
});
