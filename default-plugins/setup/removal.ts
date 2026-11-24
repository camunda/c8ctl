import {
	type McpConfigPlan,
	planMcpConfigs,
} from "../../src/utils/command-local/mcp-install-helpers.ts";
import {
	type CamundaSkillInstallation,
	camundaSkillRemovalPath,
	detectInstalledHarnesses,
	hasCamundaUserSkillsDirectory,
	listCamundaSkills,
} from "../../src/utils/command-local/skills-install-helpers.ts";
import {
	planSetupBlueprintRemovals,
	type SetupBlueprintRemoval,
} from "./blueprint-scaffold.ts";
import { camunda8RunInstallDirs } from "./detectors.ts";

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

export interface SetupBlueprintPlanningFailure {
	readonly directory: string;
	readonly message: string;
}

export interface SetupModelerRemoval {
	/** The modeler plugin's own dry-run description of the removal. */
	readonly message: string;
	readonly target: {
		readonly method: string;
		readonly path: string;
	};
}

export interface SetupModelerInspectionFailure {
	readonly message: string;
}

export interface SetupClusterRemoval {
	/**
	 * Installed Camunda 8 Run versions. Teardown stops the local cluster,
	 * purges its runtime data (removing setup-deployed process state with
	 * it), and deletes every listed version's downloaded binary. Empty when
	 * only a running cluster was found (its install dir is gone, so there
	 * is nothing to purge or delete — only to stop).
	 */
	readonly versions: readonly string[];
	/**
	 * The version found running at preview time while no install dir
	 * remained — the confirmed stop-only target. The owner still tracks it
	 * via its durable record, so teardown can attribute the stop to it.
	 */
	readonly runningVersion?: string;
}

export interface SetupClusterInspectionFailure {
	readonly message: string;
}

/** The local cluster's running state, as probed from the owning plugin. */
export interface SetupClusterRunningState {
	readonly running: boolean;
	readonly version?: string;
}

export interface SetupRemovalInventory {
	readonly mcp: readonly SetupMcpRemoval[];
	readonly mcpPlanningFailures: readonly SetupMcpPlanningFailure[];
	readonly skills: readonly CamundaSkillInstallation[];
	readonly skillDiscoveryFailures: readonly SetupSkillDiscoveryFailure[];
	readonly blueprints: readonly SetupBlueprintRemoval[];
	readonly blueprintPlanningFailures: readonly SetupBlueprintPlanningFailure[];
	readonly modeler: SetupModelerRemoval | undefined;
	readonly modelerInspectionFailure: SetupModelerInspectionFailure | undefined;
	readonly cluster: SetupClusterRemoval | undefined;
	readonly clusterInspectionFailure: SetupClusterInspectionFailure | undefined;
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
 * longer detected by its executable. `detectModeler` probes the modeler
 * plugin's own `modeler uninstall --dry-run`, so whether a managed Modeler
 * installation exists — and how its removal is described — stays owned by
 * that plugin.
 */
export async function inspectSetupRemovalInventory({
	cwd = process.cwd(),
	detectModeler,
	detectClusterRunning,
}: {
	cwd?: string;
	detectModeler?: () => Promise<SetupModelerRemoval | undefined>;
	/**
	 * The local cluster's running state, in the cluster plugin's own words
	 * (its status command). Needed only when no install dirs remain: a
	 * cluster whose install dir was deleted out from under it is otherwise
	 * invisible here, yet still needs stopping — and the probe's version is
	 * the confirmed stop target.
	 */
	detectClusterRunning?: () => Promise<SetupClusterRunningState>;
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

	const blueprintPlanningFailures: SetupBlueprintPlanningFailure[] = [];
	const blueprints = planSetupBlueprintRemovals({
		cwd,
		onError: (directory, error) => {
			blueprintPlanningFailures.push({
				directory,
				message: error instanceof Error ? error.message : String(error),
			});
		},
	});

	let modeler: SetupModelerRemoval | undefined;
	let modelerInspectionFailure: SetupModelerInspectionFailure | undefined;
	if (detectModeler) {
		try {
			modeler = await detectModeler();
		} catch (error) {
			modelerInspectionFailure = {
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}

	// Setup's local cluster is the cache the cluster plugin manages. The
	// detector mirrors that plugin's install layout, so a cache the plugin
	// sees is a cache teardown can hand back to its stop/purge/delete. Every
	// install dir counts — including one whose binary went missing — so a
	// partial install's runtime data is purged instead of left behind. A
	// running cluster without any install dir is still found via the
	// running probe, so confirmed removal stops it.
	let cluster: SetupClusterRemoval | undefined;
	let clusterInspectionFailure: SetupClusterInspectionFailure | undefined;
	try {
		const versions = camunda8RunInstallDirs();
		let probe: SetupClusterRunningState | undefined;
		if (versions.length === 0 && detectClusterRunning) {
			try {
				probe = await detectClusterRunning();
			} catch (error) {
				clusterInspectionFailure = {
					message: error instanceof Error ? error.message : String(error),
				};
			}
		}
		if (versions.length > 0 || probe?.running) {
			cluster = {
				versions,
				...(probe?.running && probe.version
					? { runningVersion: probe.version }
					: {}),
			};
		}
	} catch (error) {
		clusterInspectionFailure = {
			message: error instanceof Error ? error.message : String(error),
		};
	}

	return {
		mcp,
		mcpPlanningFailures,
		skills,
		skillDiscoveryFailures,
		blueprints,
		blueprintPlanningFailures,
		modeler,
		modelerInspectionFailure,
		cluster,
		clusterInspectionFailure,
	};
}
