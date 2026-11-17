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
	/** Pre-checked state, also the non-interactive and --yes default. */
	readonly defaultSelected: boolean;
}

/**
 * Everything the setup wizard offers. The docs MCP server stays opt-in:
 * the onboarding decision is to add it only on request.
 */
export const SETUP_COMPONENTS: readonly SetupComponent[] = [
	{
		id: "cluster",
		label: "Local cluster",
		why: "Run Camunda 8 on this machine — no Docker, no cloud account",
		defaultSelected: true,
	},
	{
		id: "modeler",
		label: "Desktop Modeler",
		why: "Draw BPMN diagrams and forms visually, deploy from the canvas",
		defaultSelected: true,
	},
	{
		id: "blueprint",
		label: "Starter blueprint",
		why: "A working example project, deployed and started for you",
		defaultSelected: true,
	},
	{
		id: "skills",
		label: "AI assistant skills",
		why: "Teach Claude Code / Copilot / Cursor how to build on Camunda 8",
		defaultSelected: true,
	},
	{
		id: "cluster-mcp",
		label: "Cluster MCP server",
		why: "Let your AI assistant inspect and operate your cluster",
		defaultSelected: true,
	},
	{
		id: "docs-mcp",
		label: "Docs MCP server",
		why: "Always-current Camunda 8 docs inside your AI assistant",
		defaultSelected: false,
	},
];

/** Selected component ids when the wizard cannot ask (non-TTY, --yes). */
export function defaultSelection(): ReadonlySet<SetupComponentId> {
	return new Set(
		SETUP_COMPONENTS.filter((c) => c.defaultSelected).map((c) => c.id),
	);
}

// ── The ordered plan ───────────────────────────────────────────────

export interface SetupStep {
	readonly title: string;
	readonly detail: string;
	/** The component this step belongs to; null = always runs. */
	readonly component: SetupComponentId | null;
}

/**
 * What `c8ctl setup` does, in order. Steps whose component was not
 * selected are reported as skipped instead of running.
 */
export const SETUP_STEPS: readonly SetupStep[] = [
	{
		title: "Check prerequisites",
		detail: "Node.js ≥ 22.18, supported OS, network access",
		component: null,
	},
	{
		title: "Install Camunda 8 Run",
		detail: "download the latest release",
		component: "cluster",
	},
	{
		title: "Start the local cluster",
		detail: "wait until it reports healthy",
		component: "cluster",
	},
	{
		title: "Install Desktop Modeler",
		detail: "the visual BPMN editor",
		component: "modeler",
	},
	{
		title: "Pick a blueprint, create the project",
		detail: "Rocket Launch, Service worker, or AI agent",
		component: "blueprint",
	},
	{
		title: "Deploy and start the process",
		detail: "your first running process instance",
		component: "blueprint",
	},
	{
		title: "Install AI assistant skills",
		detail: "for the AI coding tools found on this machine",
		component: "skills",
	},
	{
		title: "Configure the cluster MCP server",
		detail: "connect your AI assistant to the cluster",
		component: "cluster-mcp",
	},
	{
		title: "Configure the docs MCP server",
		detail: "Camunda 8 documentation in your AI assistant",
		component: "docs-mcp",
	},
	{
		title: "Open Operate",
		detail: "http://localhost:8080/operate — log in with demo/demo",
		component: "cluster",
	},
];

// ── Welcome banner ─────────────────────────────────────────────────

/** Block-letter c8ctl wordmark, 6 rows. */
const LOGO = [
	" ██████╗  █████╗        ██████╗ ████████╗ ██╗     ",
	"██╔════╝ ██╔══██╗      ██╔════╝ ╚══██╔══╝ ██║     ",
	"██║      ╚█████╔╝      ██║         ██║    ██║     ",
	"██║      ██╔══██╗      ██║         ██║    ██║     ",
	"╚██████╗ ██████╔╝      ╚██████╗    ██║    ███████╗",
	" ╚═════╝ ╚═════╝        ╚═════╝    ╚═╝    ╚══════╝",
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
		pad(
			`${textPad}${s.bold}Welcome to Camunda 8!${s.reset} Let's get you from zero to a`,
			textPad.length +
				"Welcome to Camunda 8! Let's get you from zero to a".length,
		),
		pad(
			`${textPad}running local process — in a couple of minutes.`,
			textPad.length + "running local process — in a couple of minutes.".length,
		),
		empty,
		pad(
			`${textPad}${s.dim}Pick what to set up. Nothing runs without your say.${s.reset}`,
			textPad.length +
				"Pick what to set up. Nothing runs without your say.".length,
		),
		empty,
		bottom,
	].join("\n");
}

// ── Plan rendering ─────────────────────────────────────────────────

/**
 * The tailored step plan for a selection: chosen steps numbered with
 * their detail, unchosen steps dimmed and marked as skipped. Ends with
 * the skeleton honesty note — nothing has been installed yet.
 */
export function renderSetupPlan(
	selected: ReadonlySet<SetupComponentId>,
	{ color }: { color: boolean },
): string {
	const s = bannerStyle({ color });
	const lines: string[] = [
		"",
		`  ${s.bold}Here's what c8ctl setup will do:${s.reset}`,
		"",
	];
	let n = 0;
	for (const step of SETUP_STEPS) {
		const included = step.component === null || selected.has(step.component);
		if (included) {
			n += 1;
			lines.push(
				`   ${s.brand}${String(n).padStart(2, "0")}.${s.reset} ${s.bold}${step.title}${s.reset}`,
			);
			lines.push(`       ${s.dim}${step.detail}${s.reset}`);
		} else {
			lines.push(`   ${s.dim}  - ${step.title} — skipped${s.reset}`);
		}
	}
	lines.push("");
	lines.push(
		`  ${s.brand}✨${s.reset} Nothing was installed — this preview prints the plan only.`,
	);
	lines.push(
		`  ${s.dim}Real execution lands with the next setup steps.${s.reset}`,
	);
	lines.push("");
	return lines.join("\n");
}

/** Structured plan for JSON output mode and --dry-run. */
export function setupPlanPayload(selected: ReadonlySet<SetupComponentId>): {
	command: string;
	preview: true;
	components: readonly { id: string; label: string; selected: boolean }[];
	steps: readonly {
		title: string;
		detail: string;
		status: "planned" | "skipped";
	}[];
} {
	return {
		command: "setup",
		preview: true,
		components: SETUP_COMPONENTS.map((c) => ({
			id: c.id,
			label: c.label,
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
