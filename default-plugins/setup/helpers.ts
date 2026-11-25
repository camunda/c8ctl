/**
 * Content and renderers for `c8ctl setup`: the welcome banner, the list
 * of components the wizard can set up, and the ordered step plan.
 *
 * Pure string builders — the command handler owns all I/O. Renderers
 * take a `color` flag: colored output uses true-color ANSI escapes and
 * belongs on an interactive terminal; piped output gets plain text.
 *
 * Colors follow the Camunda brand guide (camunda.com/brand): Royal Blue
 * is the primary brand color.
 */

// ── Brand styling ──────────────────────────────────────────────────

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;

/** Camunda Royal Blue (#4F39F6), the primary brand color. */
const BRAND_BLUE = `${ESC}38;2;79;57;246m`;
/** Royal Blue as a background, with white text: fixed colors on both
 * sides, so the pair reads the same on dark and light terminals. */
const BRAND_BLUE_BG = `${ESC}48;2;79;57;246m`;
const WHITE = `${ESC}38;2;255;255;255m`;

export interface BannerStyle {
	readonly brand: string;
	readonly bold: string;
	readonly dim: string;
	readonly reset: string;
}

export function bannerStyle({ color }: { color: boolean }): BannerStyle {
	return color
		? { brand: BRAND_BLUE, bold: BOLD, dim: DIM, reset: RESET }
		: { brand: "", bold: "", dim: "", reset: "" };
}

// ── What setup can install ─────────────────────────────────────────

export type SetupComponentId =
	| "cluster"
	| "modeler"
	| "blueprint"
	| "skills"
	| "cluster-mcp"
	| "docs-mcp";

export interface SetupComponent {
	readonly id: SetupComponentId;
	/** Short name shown in the checkbox list. */
	readonly label: string;
	/** Why it is worth installing — shown dimmed next to the label. */
	readonly why: string;
	/** Section of the wizard's checkbox list this component sits under. */
	readonly group: SetupComponentGroup;
	/** Pre-checked state, also the non-interactive and --yes default. */
	readonly defaultSelected: boolean;
	/**
	 * Components this one cannot work without: while any of them is
	 * deselected, this option is greyed out with the reason and forced
	 * off.
	 */
	readonly requires?: readonly { id: SetupComponentId; reason: string }[];
}

/** Wizard sections, in display order. */
export type SetupComponentGroup = "Essentials" | "AI-assisted development";

/**
 * Everything the setup wizard offers, grouped by what it is for: the
 * Essentials get a local Camunda 8 running with something to look at,
 * AI-assisted development wires the AI tooling into it. The docs MCP
 * server stays opt-in: the onboarding decision is to add it only on
 * request.
 */
export const SETUP_COMPONENTS: readonly SetupComponent[] = [
	{
		id: "cluster",
		label: "Local cluster",
		why: "Download and run Camunda 8 Run on this machine",
		group: "Essentials",
		defaultSelected: true,
	},
	{
		id: "modeler",
		label: "Desktop Modeler",
		why: "Install the desktop app to edit BPMN, DMN, and forms visually",
		group: "Essentials",
		defaultSelected: true,
	},
	{
		id: "blueprint",
		label: "Example project",
		why: "Create an example project, then deploy and start it on your local cluster",
		group: "Essentials",
		defaultSelected: true,
		requires: [{ id: "cluster", reason: "requires the local cluster" }],
	},
	{
		id: "skills",
		label: "AI assistant skills",
		why: "Teach Claude Code, GitHub Copilot CLI, or Cursor to build on Camunda 8",
		group: "AI-assisted development",
		defaultSelected: true,
	},
	{
		id: "cluster-mcp",
		label: "Cluster MCP server",
		why: "Connect your AI assistant to your local cluster",
		group: "AI-assisted development",
		defaultSelected: true,
		requires: [{ id: "cluster", reason: "requires the local cluster" }],
	},
	{
		id: "docs-mcp",
		label: "Docs MCP server",
		why: "Search current Camunda 8 docs from your AI assistant (browser sign-in on first use)",
		group: "AI-assisted development",
		defaultSelected: false,
	},
];

/**
 * Drop components whose requirements are not selected. Each pass only
 * ever removes, so this settles quickly even for chains. Applied after
 * flag overrides too, so a flag cannot resurrect a disabled component.
 */
export function enforceComponentDependencies(
	selected: ReadonlySet<SetupComponentId>,
): Set<SetupComponentId> {
	const next = new Set(selected);
	for (let changed = true; changed; ) {
		changed = false;
		for (const c of SETUP_COMPONENTS) {
			if (next.has(c.id) && c.requires?.some((r) => !next.has(r.id))) {
				next.delete(c.id);
				changed = true;
			}
		}
	}
	return next;
}

/** Selected component ids when the wizard cannot ask (non-TTY, --yes). */
export function defaultSelection(): ReadonlySet<SetupComponentId> {
	return enforceComponentDependencies(
		new Set(SETUP_COMPONENTS.filter((c) => c.defaultSelected).map((c) => c.id)),
	);
}

// ── The ordered plan ───────────────────────────────────────────────

export type SetupStepId =
	| "prerequisites"
	| "start-cluster"
	| "install-modeler"
	| "scaffold-blueprint"
	| "deploy-blueprint"
	| "install-skills"
	| "cluster-mcp"
	| "docs-mcp";

export interface SetupStep {
	readonly id: SetupStepId;
	readonly title: string;
	readonly detail: string;
	/** The component this step belongs to; null = always runs. */
	readonly component: SetupComponentId | null;
	/**
	 * Steps that must have succeeded for this step to run; otherwise it
	 * is reported as skipped with the unmet steps named.
	 */
	readonly dependsOn?: readonly SetupStepId[];
	/**
	 * When true, the step runs only if every earlier step succeeded —
	 * for the finale that must not run on a partially broken setup.
	 */
	readonly requiresCleanRun?: boolean;
}

/**
 * What `c8ctl setup` does, in order. Steps whose component was not
 * selected are reported as skipped instead of running.
 */
export const SETUP_STEPS: readonly SetupStep[] = [
	{
		id: "prerequisites",
		title: "Check prerequisites",
		detail: "Node.js ≥ 22.18, supported OS, network access",
		component: null,
	},
	{
		id: "start-cluster",
		title: "Start the local cluster",
		detail: "downloads Camunda 8 Run on first run, waits until healthy",
		component: "cluster",
	},
	{
		id: "install-modeler",
		title: "Install Desktop Modeler",
		detail: "the visual BPMN editor",
		component: "modeler",
	},
	{
		id: "scaffold-blueprint",
		title: "Create the blueprint project",
		detail: "Rocket Launch example",
		component: "blueprint",
	},
	{
		id: "install-skills",
		title: "Install AI assistant skills",
		detail: "for the AI coding tools found on this machine",
		component: "skills",
	},
	{
		id: "cluster-mcp",
		title: "Configure the cluster MCP server",
		detail: "connect your AI assistant to the cluster",
		component: "cluster-mcp",
		dependsOn: ["start-cluster"],
	},
	{
		id: "docs-mcp",
		title: "Configure the docs MCP server",
		detail:
			"Camunda 8 docs in your AI assistant — browser sign-in on first use",
		component: "docs-mcp",
	},
	{
		// The finale: runs last, and only when every earlier step
		// succeeded — no first process on a partially broken setup.
		id: "deploy-blueprint",
		title: "Deploy and start the process",
		detail: "your first running process instance",
		component: "blueprint",
		dependsOn: ["scaffold-blueprint", "start-cluster"],
		requiresCleanRun: true,
	},
];

// ── Step results ───────────────────────────────────────────────────

export type SetupStepStatus = "success" | "error" | "skipped";

const STATUS_TAGS: Record<SetupStepStatus, string> = {
	success: "[SUCCESS]",
	error: "[ERROR]",
	skipped: "[SKIPPED]",
};

const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;

const STATUS_COLORS: Record<SetupStepStatus, string> = {
	success: GREEN,
	error: RED,
	skipped: DIM,
};

/**
 * The tail of a finished step's line: a dot leader and the status tag.
 * `width` is the longest title in the plan, so the tags line up. With
 * `color`, the tag is green on success, red on error and dim when
 * skipped.
 */
export function formatStepStatusSuffix(
	title: string,
	status: SetupStepStatus,
	width: number,
	{ color }: { color: boolean },
): string {
	const dots = ".".repeat(Math.max(2, width - title.length + 2));
	const tag = STATUS_TAGS[status];
	const styled = color ? `${STATUS_COLORS[status]}${tag}${RESET}` : tag;
	return ` ${dots} ${styled}`;
}

/**
 * One finished step, aligned for a wizard report: the title followed by
 * the status suffix (`formatStepStatusSuffix`).
 */
export function formatStepResult(
	title: string,
	status: SetupStepStatus,
	width: number,
	{ color }: { color: boolean },
): string {
	return `  ${title}${formatStepStatusSuffix(title, status, width, { color })}`;
}

// ── Step activity spinner ──────────────────────────────────────────

/**
 * Braille frames cycled while a step runs. Ten frames at 80 ms give a
 * smooth, quiet tick that reads as "working" without scrolling output.
 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

export interface StepSpinner {
	/** Stop ticking. Idempotent; the caller redraws or closes the line. */
	readonly stop: () => void;
}

/**
 * Animate a spinner on a step's open title line: the first frame is
 * written immediately (the indicator appears with the step, not one
 * interval later — and a caller can observe it without waiting), then
 * every interval the line is redrawn as `\r  ${title} ${frame}`, so the
 * glyph spins in place and the eventual status tag overwrites it.
 * Terminal-only — the caller starts one only when stdout is a TTY, so
 * piped and --quiet output never see a frame. The interval is unref'd:
 * a stuck step can never keep the process alive through the spinner
 * alone.
 */
export function startStepSpinner({
	title,
	write,
	intervalMs = SPINNER_INTERVAL_MS,
}: {
	title: string;
	write: (text: string) => void;
	intervalMs?: number;
}): StepSpinner {
	let frame = 0;
	const tick = () => {
		write(`\r  ${title} ${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}`);
		frame += 1;
	};
	tick();
	const timer = setInterval(tick, intervalMs);
	timer.unref();
	let stopped = false;
	return {
		stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
		},
	};
}

// ── Welcome banner ─────────────────────────────────────────────────

/** Block-letter c8ctl wordmark, 6 rows. */
const LOGO = [
	" ██████╗  █████╗    ██████╗ ████████╗ ██╗     ",
	"██╔════╝ ██╔══██╗  ██╔════╝ ╚══██╔══╝ ██║     ",
	"██║      ╚█████╔╝  ██║         ██║    ██║     ",
	"██║      ██╔══██╗  ██║         ██║    ██║     ",
	"╚██████╗ ██████╔╝  ╚██████╗    ██║    ███████╗",
	" ╚═════╝ ╚═════╝    ╚═════╝    ╚═╝    ╚══════╝",
];

const BANNER_WIDTH = 68;

/**
 * The boxed welcome screen: brand-colored wordmark, a one-line promise,
 * and the ground rule that nothing runs without confirmation.
 */
export function renderWelcomeBanner({ color }: { color: boolean }): string {
	const s = bannerStyle({ color });
	const top = ` ╭${"─".repeat(BANNER_WIDTH)}╮`;
	const bottom = ` ╰${"─".repeat(BANNER_WIDTH)}╯`;
	const empty = ` │${" ".repeat(BANNER_WIDTH)}│`;
	const pad = (text: string, visibleLength: number) =>
		` │${text}${" ".repeat(Math.max(0, BANNER_WIDTH - visibleLength))}│`;

	const logoPad = "      ";
	const textPad = "        ";
	// Width is measured on the same string that is printed, so copy
	// edits cannot misalign the right border.
	const textRow = (text: string, style = "") =>
		pad(
			`${textPad}${style}${text}${style ? s.reset : ""}`,
			textPad.length + text.length,
		);
	return [
		top,
		empty,
		...LOGO.map((line) =>
			pad(
				`${logoPad}${s.brand}${line}${s.reset}`,
				logoPad.length + line.length,
			),
		),
		empty,
		textRow("Welcome to Camunda 8", s.bold),
		textRow("Get a local cluster running with your first process."),
		empty,
		textRow("Choose what to set up. Nothing runs until you confirm.", s.dim),
		empty,
		bottom,
	].join("\n");
}

// ── Next steps ─────────────────────────────────────────────────────

/**
 * The boxed completion block after the step report: the takeaway of the
 * whole run, visually set apart from the status lines so it cannot
 * blend in. The box is as wide as its longest line. The heading reads
 * white on a brand-blue band (boxed) or highlight (unboxed) — fixed
 * colors on both sides, so it stays readable on dark and light terminal
 * backgrounds alike; plain brand-blue text was near-invisible on dark
 * themes. When the content would exceed the terminal's width
 * (`maxWidth`), the borders would wrap — the block degrades to an
 * unboxed, indented list that keeps long paths and URLs intact.
 */
export function renderNextSteps(
	lines: readonly string[],
	{ color, maxWidth }: { color: boolean; maxWidth?: number },
): string {
	const s = bannerStyle({ color });
	const heading = "What's next";
	const headingStyle = color ? `${BRAND_BLUE_BG}${WHITE}${BOLD}` : "";
	const width = Math.max(heading.length, ...lines.map((line) => line.length));
	// `.length` counts UTF-16 code units, not terminal columns — non-ASCII
	// content (CJK paths, emoji) would misalign the borders. Box only
	// printable-ASCII lines; anything wider gets the unboxed fallback.
	const printableAscii = lines.every((line) =>
		[...line].every((char) => {
			const code = char.codePointAt(0) ?? 0;
			return code >= 0x20 && code <= 0x7e;
		}),
	);
	if (!printableAscii || (maxWidth !== undefined && width + 6 > maxWidth)) {
		return [
			color ? `${headingStyle}${heading}${s.reset}` : heading,
			...lines.map((line) => `  ${line}`),
		].join("\n");
	}
	const top = `╭${"─".repeat(width + 4)}╮`;
	const bottom = `╰${"─".repeat(width + 4)}╯`;
	const row = (text: string, visibleLength: number) =>
		`│  ${text}${" ".repeat(width - visibleLength)}  │`;
	// The heading row's whole inner width carries the band — only the
	// borders stay in the terminal's default color.
	const band = color
		? `│${headingStyle}  ${heading}${" ".repeat(width - heading.length)}  ${s.reset}│`
		: row(heading, heading.length);
	return [
		top,
		band,
		row("", 0),
		...lines.map((line) => row(line, line.length)),
		bottom,
	].join("\n");
}

// ── Cluster child-process output ─────────────────────────────────

/**
 * The cluster plugin reports download progress as `//> 42% (…) at …`
 * lines. Setup streams the child's output live, minus this noise — the
 * step's own status line is the progress signal.
 */
export function isClusterProgressLine(line: string): boolean {
	return line.trimStart().startsWith("//>");
}

/**
 * Incremental line forwarder over child-process chunks: buffers partial
 * lines across pushes, drops lines `skip` rejects, and passes the rest
 * to `write`. `flush` emits a trailing unterminated line.
 */
export function createLineForwarder({
	write,
	skip,
}: {
	write: (line: string) => void;
	skip: (line: string) => boolean;
}): { push: (chunk: string) => void; flush: () => void } {
	let pending = "";
	const emit = (line: string) => {
		if (!skip(line)) write(line);
	};
	return {
		push(chunk) {
			pending += chunk;
			let newline = pending.indexOf("\n");
			while (newline !== -1) {
				emit(pending.slice(0, newline));
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
			}
		},
		flush() {
			if (pending.length > 0) {
				emit(pending);
				pending = "";
			}
		},
	};
}

// ── Plan rendering ─────────────────────────────────────────────────

/** Structured plan for JSON output mode and --dry-run. */
export function setupPlanPayload(
	selected: ReadonlySet<SetupComponentId>,
	{ blueprint }: { blueprint?: string } = {},
): {
	command: string;
	preview: true;
	blueprint: string | null;
	components: readonly {
		id: string;
		label: string;
		group: SetupComponentGroup;
		selected: boolean;
	}[];
	steps: readonly {
		title: string;
		detail: string;
		status: "planned" | "skipped";
	}[];
} {
	return {
		command: "setup",
		preview: true,
		blueprint: blueprint ?? null,
		components: SETUP_COMPONENTS.map((c) => ({
			id: c.id,
			label: c.label,
			group: c.group,
			selected: selected.has(c.id),
		})),
		steps: SETUP_STEPS.map((step) => ({
			title: step.title,
			detail: step.detail,
			status:
				step.component === null || selected.has(step.component)
					? "planned"
					: "skipped",
		})),
	};
}
