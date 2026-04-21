/**
 * Registry-driven command dispatch map.
 *
 * Maps "verb:resource" keys to command handlers. For resourceless verbs
 * (deploy, run, watch, etc.), the key is "verb:".
 *
 * This replaces the ~1800-line if/else dispatch chain that previously
 * lived in index.ts.
 */

import type { AnyCommandHandler } from "./command-framework.ts";
import { lintBpmnCommand } from "./commands/bpmn.ts";
import { completionCommand } from "./commands/completion.ts";
import {
	applyElementTemplateCommand,
	listPropertiesCommand,
} from "./commands/element-template.ts";
import { getFormCommand } from "./commands/forms.ts";
import {
	assignFallbackCommand,
	assignGroupCommand,
	assignMappingRuleCommand,
	assignRoleCommand,
	assignUserCommand,
	createIdentityAuthorizationCommand,
	createIdentityGroupCommand,
	createIdentityMappingRuleCommand,
	createIdentityRoleCommand,
	createIdentityTenantCommand,
	createIdentityUserCommand,
	deleteIdentityAuthorizationCommand,
	deleteIdentityGroupCommand,
	deleteIdentityMappingRuleCommand,
	deleteIdentityRoleCommand,
	deleteIdentityTenantCommand,
	deleteIdentityUserCommand,
	getIdentityAuthorizationCommand,
	getIdentityGroupCommand,
	getIdentityMappingRuleCommand,
	getIdentityRoleCommand,
	getIdentityTenantCommand,
	getIdentityUserCommand,
	listAuthorizationsCommand,
	listGroupsCommand,
	listMappingRulesCommand,
	listRolesCommand,
	listTenantsCommand,
	listUsersCommand,
	searchIdentityAuthorizationsCommand,
	searchIdentityGroupsCommand,
	searchIdentityMappingRulesCommand,
	searchIdentityRolesCommand,
	searchIdentityTenantsCommand,
	searchIdentityUsersCommand,
	unassignFallbackCommand,
	unassignGroupCommand,
	unassignMappingRuleCommand,
	unassignRoleCommand,
	unassignUserCommand,
} from "./commands/identity.ts";
import {
	getIncidentCommand,
	listIncidentsCommand,
	resolveIncidentCommand,
} from "./commands/incidents.ts";
import {
	activateJobsCommand,
	completeJobCommand,
	failJobCommand,
	listJobsCommand,
} from "./commands/jobs.ts";
import { mcpProxyCommand } from "./commands/mcp-proxy.ts";
import {
	correlateMessageCommand,
	publishMessageCommand,
} from "./commands/messages.ts";
import { feedbackCommand, openAppCommand } from "./commands/open.ts";
import {
	downgradePluginCommand,
	initPluginCommand,
	listPluginsCommand,
	loadPluginCommand,
	syncPluginsCommand,
	unloadPluginCommand,
	upgradePluginCommand,
} from "./commands/plugins.ts";
import {
	getProcessDefinitionCommand,
	listProcessDefinitionsCommand,
} from "./commands/process-definitions.ts";
import {
	awaitProcessInstanceCommand,
	cancelProcessInstanceCommand,
	createProcessInstanceCommand,
	getProcessInstanceCommand,
	listProcessInstancesCommand,
} from "./commands/process-instances.ts";
import {
	addProfileCommand,
	listProfileCommand,
	removeProfileCommand,
	whichProfileCommand,
} from "./commands/profiles.ts";
import { runCommand } from "./commands/run.ts";
import {
	searchIncidentsCommand,
	searchJobsCommand,
	searchProcessDefinitionsCommand,
	searchProcessInstancesCommand,
	searchUserTasksCommand,
	searchVariablesCommand,
} from "./commands/search.ts";
import {
	outputCommand,
	useProfileCommand,
	useTenantCommand,
} from "./commands/session.ts";
import { getTopologyCommand } from "./commands/topology.ts";
import {
	completeUserTaskCommand,
	listUserTasksCommand,
} from "./commands/user-tasks.ts";
import { setVariableCommand } from "./commands/variables.ts";
import { watchCommand } from "./commands/watch.ts";
import { deployCommand } from "./deployments.ts";

/**
 * Dispatch map keyed by "verb:resource".
 * For resourceless verbs the key is "verb:" (empty resource).
 */
export const COMMAND_DISPATCH: ReadonlyMap<string, AnyCommandHandler> = new Map<
	string,
	AnyCommandHandler
>([
	// ── Session / profile ──────────────────────────────────────────────
	["use:profile", useProfileCommand],
	["use:tenant", useTenantCommand],
	["output:", outputCommand],
	["list:profile", listProfileCommand],
	["add:profile", addProfileCommand],
	["remove:profile", removeProfileCommand],
	["which:profile", whichProfileCommand],

	// ── Plugins ────────────────────────────────────────────────────────
	["list:plugin", listPluginsCommand],
	["load:plugin", loadPluginCommand],
	["unload:plugin", unloadPluginCommand],
	["sync:plugin", syncPluginsCommand],
	["upgrade:plugin", upgradePluginCommand],
	["downgrade:plugin", downgradePluginCommand],
	["init:plugin", initPluginCommand],

	// ── Process instances ──────────────────────────────────────────────
	["list:process-instance", listProcessInstancesCommand],
	["get:process-instance", getProcessInstanceCommand],
	["create:process-instance", createProcessInstanceCommand],
	["cancel:process-instance", cancelProcessInstanceCommand],
	["await:process-instance", awaitProcessInstanceCommand],

	// ── Process definitions ────────────────────────────────────────────
	["list:process-definition", listProcessDefinitionsCommand],
	["get:process-definition", getProcessDefinitionCommand],

	// ── User tasks ─────────────────────────────────────────────────────
	["list:user-task", listUserTasksCommand],
	["complete:user-task", completeUserTaskCommand],

	// ── Incidents ──────────────────────────────────────────────────────
	["list:incident", listIncidentsCommand],
	["get:incident", getIncidentCommand],
	["resolve:incident", resolveIncidentCommand],

	// ── Jobs ────────────────────────────────────────────────────────────
	["list:jobs", listJobsCommand],
	["activate:jobs", activateJobsCommand],
	["complete:job", completeJobCommand],
	["fail:job", failJobCommand],

	// ── Messages ───────────────────────────────────────────────────────
	["publish:message", publishMessageCommand],
	["correlate:message", correlateMessageCommand],

	// ── Topology / forms ───────────────────────────────────────────────
	["get:topology", getTopologyCommand],
	["get:form", getFormCommand],

	// ── Search ─────────────────────────────────────────────────────────
	["search:process-definition", searchProcessDefinitionsCommand],
	["search:process-instance", searchProcessInstancesCommand],
	["search:user-task", searchUserTasksCommand],
	["search:incident", searchIncidentsCommand],
	["search:jobs", searchJobsCommand],
	["search:variable", searchVariablesCommand],
	["search:user", searchIdentityUsersCommand],
	["search:role", searchIdentityRolesCommand],
	["search:group", searchIdentityGroupsCommand],
	["search:tenant", searchIdentityTenantsCommand],
	["search:authorization", searchIdentityAuthorizationsCommand],
	["search:mapping-rule", searchIdentityMappingRulesCommand],

	// ── Identity: list ─────────────────────────────────────────────────
	["list:user", listUsersCommand],
	["list:role", listRolesCommand],
	["list:group", listGroupsCommand],
	["list:tenant", listTenantsCommand],
	["list:authorization", listAuthorizationsCommand],
	["list:mapping-rule", listMappingRulesCommand],

	// ── Identity: get ──────────────────────────────────────────────────
	["get:user", getIdentityUserCommand],
	["get:role", getIdentityRoleCommand],
	["get:group", getIdentityGroupCommand],
	["get:tenant", getIdentityTenantCommand],
	["get:authorization", getIdentityAuthorizationCommand],
	["get:mapping-rule", getIdentityMappingRuleCommand],

	// ── Identity: create ───────────────────────────────────────────────
	["create:user", createIdentityUserCommand],
	["create:role", createIdentityRoleCommand],
	["create:group", createIdentityGroupCommand],
	["create:tenant", createIdentityTenantCommand],
	["create:authorization", createIdentityAuthorizationCommand],
	["create:mapping-rule", createIdentityMappingRuleCommand],

	// ── Identity: delete ───────────────────────────────────────────────
	["delete:user", deleteIdentityUserCommand],
	["delete:role", deleteIdentityRoleCommand],
	["delete:group", deleteIdentityGroupCommand],
	["delete:tenant", deleteIdentityTenantCommand],
	["delete:authorization", deleteIdentityAuthorizationCommand],
	["delete:mapping-rule", deleteIdentityMappingRuleCommand],

	// ── Identity: assign / unassign ────────────────────────────────────
	["assign:role", assignRoleCommand],
	["assign:user", assignUserCommand],
	["assign:group", assignGroupCommand],
	["assign:mapping-rule", assignMappingRuleCommand],
	["unassign:role", unassignRoleCommand],
	["unassign:user", unassignUserCommand],
	["unassign:group", unassignGroupCommand],
	["unassign:mapping-rule", unassignMappingRuleCommand],
	// Fallbacks for unknown resource names — preserve the canonical
	// "Cannot (un)assign resource type: <name>" error from handleAssign.
	["assign:", assignFallbackCommand],
	["unassign:", unassignFallbackCommand],

	// ── Completion ─────────────────────────────────────────────────────
	// `completion` is resourceless in the registry; the handler branches
	// on ctx.resource (bash / zsh / fish / install).
	["completion:", completionCommand],

	// ── Variables ───────────────────────────────────────────────────────
	["set:variable", setVariableCommand],

	// ── Resourceless verbs ─────────────────────────────────────────────
	["deploy:", deployCommand],
	["run:", runCommand],
	["watch:", watchCommand],
	["open:", openAppCommand],
	["open:operate", openAppCommand],
	["open:tasklist", openAppCommand],
	["open:modeler", openAppCommand],
	["open:optimize", openAppCommand],
	["feedback:", feedbackCommand],
	["mcp-proxy:", mcpProxyCommand],

	// ── BPMN tooling ──────────────────────────────────────────────────
	["bpmn:lint", lintBpmnCommand],

	// ── Element template tooling ──────────────────────────────────────
	["element-template:apply", applyElementTemplateCommand],
	["element-template:list-properties", listPropertiesCommand],
]);
