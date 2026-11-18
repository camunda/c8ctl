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
	/**
	 * Components this one cannot work without: while any of them is
	 * deselected, this option is greyed out with the reason and forced
	 * off.
	 */
	readonly requires?: readonly { id: SetupComponentId; reason: string }[];
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
		requires: [{ id: "cluster", reason: "needs the local cluster" }],
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
		why: "Always-current Camunda 8 docs in your AI assistant (browser sign-in)",
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
		detail: "Rocket Launch, Service worker, or AI agent",
		component: "blueprint",
	},
	{
		id: "deploy-blueprint",
		title: "Deploy and start the process",
		detail: "your first running process instance",
		component: "blueprint",
		dependsOn: ["scaffold-blueprint", "start-cluster"],
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
			"Camunda 8 docs in your AI assistant — a browser window opens to sign in",
		component: "docs-mcp",
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
 * One finished step, aligned for a wizard report: the title followed by
 * a dot leader and the status tag in a fixed column. `width` is the
 * longest title in the plan, so the tags line up. With `color`, the tag
 * is green on success, red on error and dim when skipped.
 */
export function formatStepResult(
	title: string,
	status: SetupStepStatus,
	width: number,
	{ color }: { color: boolean },
): string {
	const dots = ".".repeat(Math.max(2, width - title.length + 2));
	const tag = STATUS_TAGS[status];
	const styled = color ? `${STATUS_COLORS[status]}${tag}${RESET}` : tag;
	return `  ${title} ${dots} ${styled}`;
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
		blueprint: blueprint ?? null,
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
