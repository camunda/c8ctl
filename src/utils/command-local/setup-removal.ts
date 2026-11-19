import {
	planSetupBlueprintRemovals,
	type SetupBlueprintRemoval,
} from "./blueprint-scaffold.ts";
import { type McpConfigPlan, planMcpConfigs } from "./mcp-install-helpers.ts";
import {
	type CamundaSkillInstallation,
	camundaSkillRemovalPath,
	detectInstalledHarnesses,
	hasCamundaUserSkillsDirectory,
	listCamundaSkills,
} from "./skills-install-helpers.ts";

export interface SetupMcpRemoval {
	readonly plan: McpConfigPlan;
	readonly servers: readonly string[];
	readonly preservedServers: readonly string[];
}

export interface SetupSkillDiscoveryFailure {
	readonly harness: string;
	readonly message: string;
}

export interface SetupMcpPlanningFailure {
	readonly harness: string;
	readonly message: string;
}

export interface SetupRemovalInventory {
	readonly mcp: readonly SetupMcpRemoval[];
	readonly mcpPlanningFailures: readonly SetupMcpPlanningFailure[];
	readonly skills: readonly CamundaSkillInstallation[];
	readonly skillDiscoveryFailures: readonly SetupSkillDiscoveryFailure[];
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
	const mcpPlanningFailures: SetupMcpPlanningFailure[] = [];
	const plans = planMcpConfigs({
		requested: mcpHarnesses,
		operation: "uninstall",
		docs: true,
		orchestration: true,
		alias: "camunda",
		preserveConflicts: true,
		onError: (harness, error) => {
			mcpPlanningFailures.push({
				harness,
				message: error instanceof Error ? error.message : String(error),
			});
		},
	});
	const mcp = plans
		.map(
			(plan): SetupMcpRemoval => ({
				plan,
				servers: plan.changes
					.filter((change) => change.status === "removed")
					.map((change) => change.server),
				preservedServers: plan.changes
					.filter((change) => change.status === "preserved")
					.map((change) => change.server),
			}),
		)
		.filter(
			(entry) => entry.servers.length > 0 || entry.preservedServers.length > 0,
		);

	const skills: CamundaSkillInstallation[] = [];
	const skillDiscoveryFailures: SetupSkillDiscoveryFailure[] = [];
	for (const harness of detectInstalledHarnesses()) {
		try {
			if (!hasCamundaUserSkillsDirectory(harness)) continue;
			const discovered = await listCamundaSkills(harness);
			for (const skill of discovered) camundaSkillRemovalPath(skill);
			skills.push(...discovered);
		} catch (error) {
			skillDiscoveryFailures.push({
				harness,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return {
		mcp,
		mcpPlanningFailures,
		skills,
		skillDiscoveryFailures,
		blueprints: planSetupBlueprintRemovals({ cwd }),
	};
}
