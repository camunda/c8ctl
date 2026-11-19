import {
	planSetupBlueprintRemovals,
	type SetupBlueprintRemoval,
} from "./blueprint-scaffold.ts";
import { type McpConfigPlan, planMcpConfigs } from "./mcp-install-helpers.ts";
import {
	type CamundaSkillInstallation,
	camundaSkillRemovalPath,
	detectInstalledHarnesses,
	listCamundaSkills,
} from "./skills-install-helpers.ts";

export interface SetupMcpRemoval {
	readonly plan: McpConfigPlan;
	readonly servers: readonly string[];
}

export interface SetupRemovalInventory {
	readonly mcp: readonly SetupMcpRemoval[];
	readonly skills: readonly CamundaSkillInstallation[];
	readonly blueprints: readonly SetupBlueprintRemoval[];
}

const SETUP_MCP_HARNESSES = [
	"claude-code",
	"github-copilot",
	"cursor",
	"vscode",
] as const;

/**
 * Inspect setup-managed artifacts without changing them. MCP plans use an
 * explicit harness list so teardown can find entries even if a harness is no
 * longer detected by its executable.
 */
export async function inspectSetupRemovalInventory({
	cwd = process.cwd(),
}: {
	cwd?: string;
} = {}): Promise<SetupRemovalInventory> {
	const mcpHarnesses =
		process.platform === "darwin" || process.platform === "win32"
			? [...SETUP_MCP_HARNESSES, "claude-desktop"]
			: [...SETUP_MCP_HARNESSES];
	const plans = planMcpConfigs({
		requested: mcpHarnesses,
		operation: "uninstall",
		docs: true,
		orchestration: true,
		alias: "camunda",
	});
	const mcp = plans
		.map(
			(plan): SetupMcpRemoval => ({
				plan,
				servers: plan.changes
					.filter((change) => change.status === "removed")
					.map((change) => change.server),
			}),
		)
		.filter((entry) => entry.servers.length > 0);

	const skills = (
		await Promise.all(
			detectInstalledHarnesses().map((harness) => listCamundaSkills(harness)),
		)
	).flat();
	for (const skill of skills) camundaSkillRemovalPath(skill);

	return {
		mcp,
		skills,
		blueprints: planSetupBlueprintRemovals({ cwd }),
	};
}
