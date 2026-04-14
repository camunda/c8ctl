#!/usr/bin/env node
/**
 * c8ctl - Camunda 8 CLI
 * Main entry point
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createClient } from "./client.ts";
import { deserializeFlags } from "./command-framework.ts";
import {
	COMMAND_REGISTRY,
	type CommandDef,
	getCommandDef,
	resolveAlias,
} from "./command-registry.ts";
import { detectUnknownFlags, validateFlags } from "./command-validation.ts";
import { showCompletion } from "./commands/completion.ts";
import { deploy } from "./commands/deployments.ts";
import { getForm, getStartForm, getUserTaskForm } from "./commands/forms.ts";
import {
	showCommandHelp,
	showHelp,
	showVerbResources,
	showVersion,
} from "./commands/help.ts";
import {
	createIdentityAuthorization,
	createIdentityGroup,
	createIdentityMappingRule,
	createIdentityRole,
	createIdentityTenant,
	createIdentityUser,
	deleteIdentityAuthorization,
	deleteIdentityGroup,
	deleteIdentityMappingRule,
	deleteIdentityRole,
	deleteIdentityTenant,
	deleteIdentityUser,
	getIdentityAuthorization,
	getIdentityGroup,
	getIdentityMappingRule,
	getIdentityRole,
	getIdentityTenant,
	getIdentityUser,
	handleAssign,
	handleUnassign,
	listAuthorizations,
	listGroups,
	listMappingRules,
	listRoles,
	listTenants,
	listUsers,
	searchIdentityAuthorizations,
	searchIdentityGroups,
	searchIdentityMappingRules,
	searchIdentityRoles,
	searchIdentityTenants,
	searchIdentityUsers,
	validateCreateAuthorizationOptions,
} from "./commands/identity.ts";
import {
	getIncident,
	listIncidents,
	resolveIncident,
} from "./commands/incidents.ts";
import {
	activateJobs,
	completeJob,
	failJob,
	listJobs,
} from "./commands/jobs.ts";
import { mcpProxy } from "./commands/mcp-proxy.ts";
import { correlateMessage, publishMessage } from "./commands/messages.ts";
import { openApp, openUrl, validateOpenAppOptions } from "./commands/open.ts";
import {
	downgradePlugin,
	initPlugin,
	listPlugins,
	loadPlugin,
	syncPlugins,
	unloadPlugin,
	upgradePlugin,
} from "./commands/plugins.ts";
import {
	getProcessDefinitionCommand,
	listProcessDefinitions,
} from "./commands/process-definitions.ts";
import {
	cancelProcessInstance,
	createProcessInstance,
	getProcessInstance,
	listProcessInstances,
} from "./commands/process-instances.ts";
import {
	addProfile,
	listProfiles,
	removeProfile,
	whichProfile,
} from "./commands/profiles.ts";
import { run } from "./commands/run.ts";
import {
	searchIncidents,
	searchJobs,
	searchProcessDefinitions,
	searchProcessInstances,
	searchUserTasks,
	searchVariables,
} from "./commands/search.ts";
import { setOutputFormat, useProfile, useTenant } from "./commands/session.ts";
import { getTopology } from "./commands/topology.ts";
import { completeUserTask, listUserTasks } from "./commands/user-tasks.ts";
import { watchFiles } from "./commands/watch.ts";
import { loadSessionState, resolveTenantId } from "./config.ts";
import { getLogger, type SortOrder } from "./logger.ts";
import { executePluginCommand, loadInstalledPlugins } from "./plugin-loader.ts";
import { c8ctl } from "./runtime.ts";

/**
 * Type guard: extract a string value from parseArgs values, or undefined.
 * parseArgs with strict:false returns values typed as string | boolean | (string|boolean)[] | undefined.
 * This narrows to string | undefined safely, without type assertions.
 */
function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * Type guard: extract a boolean value from parseArgs values, or undefined.
 */
function bool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

/**
 * Type guard: narrow unknown to Record<string, unknown>.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object";
}

/**
 * Parse --version flag value into a number, or undefined if not set.
 */
function parseVersionFlag(values: Record<string, unknown>): number | undefined {
	return values.version && typeof values.version === "string"
		? parseInt(values.version, 10)
		: undefined;
}

/**
 * Parse command line arguments
 */
function parseCliArgs() {
	try {
		const { values, positionals } = parseArgs({
			args: process.argv.slice(2),
			options: {
				help: { type: "boolean", short: "h" },
				version: { type: "string", short: "v" },
				all: { type: "boolean" },
				xml: { type: "boolean" },
				profile: { type: "string" },
				bpmnProcessId: { type: "string" },
				id: { type: "string" },
				processDefinitionId: { type: "string" },
				processInstanceKey: { type: "string" },
				processDefinitionKey: { type: "string" },
				parentProcessInstanceKey: { type: "string" },
				variables: { type: "string" },
				state: { type: "string" },
				assignee: { type: "string" },
				type: { type: "string" },
				correlationKey: { type: "string" },
				timeToLive: { type: "string" },
				maxJobsToActivate: { type: "string" },
				timeout: { type: "string" },
				worker: { type: "string" },
				retries: { type: "string" },
				errorMessage: { type: "string" },
				baseUrl: { type: "string" },
				clientId: { type: "string" },
				clientSecret: { type: "string" },
				audience: { type: "string" },
				oAuthUrl: { type: "string" },
				defaultTenantId: { type: "string" },
				from: { type: "string" },
				name: { type: "string" },
				key: { type: "string" },
				elementId: { type: "string" },
				errorType: { type: "string" },
				awaitCompletion: { type: "boolean" },
				fetchVariables: { type: "boolean" },
				requestTimeout: { type: "string" },
				value: { type: "string" },
				scopeKey: { type: "string" },
				fullValue: { type: "boolean" },
				userTask: { type: "boolean" },
				processDefinition: { type: "boolean" },
				iname: { type: "string" },
				iid: { type: "string" },
				iassignee: { type: "string" },
				ierrorMessage: { type: "string" },
				itype: { type: "string" },
				ivalue: { type: "string" },
				sortBy: { type: "string" },
				asc: { type: "boolean" },
				desc: { type: "boolean" },
				limit: { type: "string" },
				between: { type: "string" },
				dateField: { type: "string" },
				fields: { type: "string" },
				"dry-run": { type: "boolean" },
				verbose: { type: "boolean" },
				force: { type: "boolean" },
				none: { type: "boolean" },
				"from-file": { type: "string" },
				"from-env": { type: "boolean" },
				username: { type: "string" },
				email: { type: "string" },
				password: { type: "string" },
				ownerId: { type: "string" },
				ownerType: { type: "string" },
				resourceType: { type: "string" },
				resourceId: { type: "string" },
				permissions: { type: "string" },
				roleId: { type: "string" },
				groupId: { type: "string" },
				tenantId: { type: "string" },
				claimName: { type: "string" },
				claimValue: { type: "string" },
				mappingRuleId: { type: "string" },
				"to-user": { type: "string" },
				"to-group": { type: "string" },
				"to-tenant": { type: "string" },
				"to-mapping-rule": { type: "string" },
				"from-user": { type: "string" },
				"from-group": { type: "string" },
				"from-tenant": { type: "string" },
				"from-mapping-rule": { type: "string" },
			},
			allowPositionals: true,
			strict: false,
		});

		return { values, positionals };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Error parsing arguments: ${message}`);
		process.exit(1);
	}
}

/**
 * Resolve process definition ID from --id, --processDefinitionId, or --bpmnProcessId flag
 */
export function resolveProcessDefinitionId(
	values: Record<string, unknown>,
): string | undefined {
	return (
		str(values.id) ||
		str(values.processDefinitionId) ||
		str(values.bpmnProcessId)
	);
}

/**
 * Warn about unrecognized flags for a verb × resource combination.
 */
function warnUnknownFlags(
	logger: ReturnType<typeof getLogger>,
	unknownFlags: string[],
	verb: string,
	resource: string,
): void {
	if (unknownFlags.length === 0) return;
	const flagList = unknownFlags.map((f) => `--${f}`).join(", ");
	const command = resource ? `${verb} ${resource}` : verb;
	logger.warn(
		`Flag(s) ${flagList} not recognized for '${command}'. They will be ignored. Run "c8ctl help ${verb}" for valid options.`,
	);
}

/** Verbs that require a resource argument — derived from COMMAND_REGISTRY (includes aliases). */
const VERB_REQUIRES_RESOURCE = new Set(
	// biome-ignore lint/plugin: widen to CommandDef to access optional aliases property
	(Object.entries(COMMAND_REGISTRY) as [string, CommandDef][])
		.filter(([, def]) => def.requiresResource)
		.flatMap(([verb, def]) => [verb, ...(def.aliases ?? [])]),
);

/**
 * Main CLI handler
 */
async function main() {
	// Load session state from disk at startup
	loadSessionState();

	const { values, positionals } = parseCliArgs();

	// Initialize logger with current output mode from c8ctl runtime
	const logger = getLogger(c8ctl.outputMode);

	// Resolve sort order from --asc / --desc flags (default: asc)
	const sortOrder: SortOrder = values.desc ? "desc" : "asc";
	if (values.asc && values.desc) {
		logger.error("Cannot specify both --asc and --desc. Use one or the other.");
		process.exit(1);
	}

	// Resolve --limit flag (max items to fetch)
	const limitStr = str(values.limit);
	const limit = limitStr ? parseInt(limitStr, 10) : undefined;
	if (limit !== undefined && (Number.isNaN(limit) || limit < 1)) {
		logger.error("--limit must be a positive integer.");
		process.exit(1);
	}

	// Resolve --fields flag (agent feature: filter output keys)
	if (values.fields && typeof values.fields === "string") {
		c8ctl.fields = values.fields
			.split(",")
			.map((f) => f.trim())
			.filter(Boolean);
	}

	// Resolve --dry-run flag (agent feature: emit API request without executing)
	if (values["dry-run"]) {
		c8ctl.dryRun = true;
	}

	// Resolve --verbose flag (enable SDK trace logging and surface raw errors)
	if (values.verbose) {
		c8ctl.verbose = true;
	}

	// Inject dependencies into the runtime (breaks circular imports)
	c8ctl.init({ createClient, resolveTenantId, getLogger });

	// Load installed plugins
	await loadInstalledPlugins();

	// Extract command and resource
	const [verb, resource, ...args] = positionals;

	// Handle global --version flag (only when no verb/command is provided)
	if (values.version && !verb) {
		showVersion();
		return;
	}

	if (values.help && positionals.length === 0) {
		showHelp();
		return;
	}

	if (!verb) {
		showHelp();
		return;
	}

	// Handle help command
	if (
		verb === "help" ||
		verb === "menu" ||
		verb === "--help" ||
		verb === "-h"
	) {
		// Check if user wants help for a specific command
		if (resource) {
			showCommandHelp(resource);
		} else {
			showHelp();
		}
		return;
	}

	// Handle completion command
	if (verb === "completion") {
		showCompletion(resource);
		return;
	}

	// Normalize resource
	const normalizedResource = resource ? resolveAlias(resource) : "";

	// Resource validation guard — single chokepoint for all verbs that require a resource.
	// Derived from COMMAND_REGISTRY.requiresResource.
	// help/completion are dispatched before this point.
	if (!resource && VERB_REQUIRES_RESOURCE.has(verb)) {
		showVerbResources(verb);
		return;
	}

	// Flag validation — run all registered validators before dispatch.
	// Validators throw on invalid input; validateFlags catches and exits.
	const commandDef = getCommandDef(verb);
	if (commandDef) {
		validateFlags(values, commandDef.flags);
	}

	// Unknown flag detection — warn about flags not recognised for this verb × resource.
	// Derived from COMMAND_REGISTRY; resource-scoped for search/list.
	const unknownFlags = detectUnknownFlags(verb, normalizedResource, values);
	warnUnknownFlags(logger, unknownFlags, verb, resource);

	// Handle session commands
	if (verb === "use") {
		if (normalizedResource === "profile") {
			if (values.none) {
				useProfile("--none");
				return;
			}
			if (!args[0]) {
				logger.error("Profile name required. Usage: c8 use profile <name>");
				process.exit(1);
			}
			useProfile(args[0]);
			return;
		}
		if (normalizedResource === "tenant") {
			if (!args[0]) {
				logger.error("Tenant ID required. Usage: c8 use tenant <id>");
				process.exit(1);
			}
			useTenant(args[0]);
			return;
		}
		showVerbResources("use");
		return;
	}

	if (verb === "output") {
		if (!resource) {
			logger.info(`Current output mode: ${c8ctl.outputMode}`);
			if (c8ctl.outputMode === "text") {
				logger.info("");
			}
			logger.info("Available modes: json|text");
			return;
		}
		setOutputFormat(resource);
		return;
	}

	// Handle profile commands
	if (verb === "list" && normalizedResource === "profile") {
		listProfiles();
		return;
	}

	if (verb === "add" && normalizedResource === "profile") {
		if (!args[0]) {
			logger.error(
				"Profile name required. Usage: c8 add profile <name> --baseUrl=<url>",
			);
			process.exit(1);
		}
		const envFile =
			typeof values["from-file"] === "string" ? values["from-file"] : undefined;
		const fromEnv = values["from-env"] === true;
		addProfile(args[0], {
			url: typeof values.baseUrl === "string" ? values.baseUrl : undefined,
			clientId:
				typeof values.clientId === "string" ? values.clientId : undefined,
			clientSecret:
				typeof values.clientSecret === "string"
					? values.clientSecret
					: undefined,
			audience:
				typeof values.audience === "string" ? values.audience : undefined,
			oauthUrl:
				typeof values.oAuthUrl === "string" ? values.oAuthUrl : undefined,
			tenantId:
				typeof values.defaultTenantId === "string"
					? values.defaultTenantId
					: undefined,
			envFile,
			fromEnv,
		});
		return;
	}

	if (
		(verb === "remove" || verb === "rm") &&
		normalizedResource === "profile"
	) {
		if (!args[0]) {
			logger.error("Profile name required. Usage: c8 remove profile <name>");
			process.exit(1);
		}
		removeProfile(args[0]);
		return;
	}

	if (verb === "which" && normalizedResource === "profile") {
		whichProfile();
		return;
	}

	// Handle plugin commands
	if (verb === "list" && normalizedResource === "plugin") {
		listPlugins();
		return;
	}

	if (verb === "load" && normalizedResource === "plugin") {
		const fromUrl = str(values.from);
		const packageName = args[0];
		await loadPlugin(packageName, fromUrl);
		return;
	}

	if (
		(verb === "unload" || verb === "remove" || verb === "rm") &&
		normalizedResource === "plugin"
	) {
		if (!args[0]) {
			logger.error(
				"Package name required. Usage: c8 unload plugin <package-name>",
			);
			process.exit(1);
		}
		await unloadPlugin(args[0], { force: bool(values.force) });
		return;
	}

	if (verb === "sync" && normalizedResource === "plugin") {
		await syncPlugins();
		return;
	}

	if (verb === "upgrade" && normalizedResource === "plugin") {
		if (!args[0]) {
			logger.error(
				"Package name required. Usage: c8 upgrade plugin <package-name> [version]",
			);
			process.exit(1);
		}
		await upgradePlugin(args[0], args[1]);
		return;
	}

	if (verb === "downgrade" && normalizedResource === "plugin") {
		if (!args[0] || !args[1]) {
			logger.error(
				"Package name and version required. Usage: c8 downgrade plugin <package-name> <version>",
			);
			process.exit(1);
		}
		await downgradePlugin(args[0], args[1]);
		return;
	}

	if (verb === "init" && normalizedResource === "plugin") {
		await initPlugin(args[0]);
		return;
	}

	// Handle process instance commands
	if (
		verb === "list" &&
		(normalizedResource === "process-instance" ||
			normalizedResource === "process-instances")
	) {
		await listProcessInstances({
			profile: str(values.profile),
			processDefinitionId: resolveProcessDefinitionId(values),
			version: parseVersionFlag(values),
			state: str(values.state),
			all: bool(values.all),
			sortBy: str(values.sortBy),
			sortOrder,
			limit,
			between: str(values.between),
			dateField: str(values.dateField),
		});
		return;
	}

	if (verb === "get" && normalizedResource === "process-instance") {
		if (!args[0]) {
			logger.error("Process instance key required. Usage: c8 get pi <key>");
			process.exit(1);
		}
		// Check if --variables flag is present (for get command, it's a boolean flag)
		const includeVariables = process.argv.includes("--variables");
		await getProcessInstance(args[0], {
			profile: str(values.profile),
			variables: includeVariables,
		});
		return;
	}

	if (verb === "create" && normalizedResource === "process-instance") {
		await createProcessInstance({
			profile: str(values.profile),
			processDefinitionId: resolveProcessDefinitionId(values),
			version: parseVersionFlag(values),
			variables: str(values.variables),
			awaitCompletion: bool(values.awaitCompletion),
			fetchVariables: bool(values.fetchVariables),
			requestTimeout:
				values.requestTimeout && typeof values.requestTimeout === "string"
					? parseInt(values.requestTimeout, 10)
					: undefined,
		});
		return;
	}

	if (verb === "cancel" && normalizedResource === "process-instance") {
		if (!args[0]) {
			logger.error("Process instance key required. Usage: c8 cancel pi <key>");
			process.exit(1);
		}
		await cancelProcessInstance(args[0], {
			profile: str(values.profile),
		});
		return;
	}

	// Handle await command - alias for create with awaitCompletion
	if (verb === "await" && normalizedResource === "process-instance") {
		// await pi is an alias for create pi with --awaitCompletion
		// It supports the same flags as create (id, variables, version, etc.)
		await createProcessInstance({
			profile: str(values.profile),
			processDefinitionId: resolveProcessDefinitionId(values),
			version: parseVersionFlag(values),
			variables: str(values.variables),
			awaitCompletion: true, // Always true for await command
			fetchVariables: bool(values.fetchVariables),
			requestTimeout:
				values.requestTimeout && typeof values.requestTimeout === "string"
					? parseInt(values.requestTimeout, 10)
					: undefined,
		});
		return;
	}

	// Handle process definition commands
	if (
		verb === "list" &&
		(normalizedResource === "process-definition" ||
			normalizedResource === "process-definitions")
	) {
		await listProcessDefinitions({
			profile: str(values.profile),
			sortBy: str(values.sortBy),
			sortOrder,
			limit,
		});
		return;
	}

	if (verb === "get" && normalizedResource === "process-definition") {
		const flags = deserializeFlags(values, getProcessDefinitionCommand.flags);
		await getProcessDefinitionCommand.handler(
			{
				client: createClient(str(values.profile)),
				logger,
				tenantId: resolveTenantId(str(values.profile)),
				resource: normalizedResource,
				positionals: args,
				sortOrder,
				limit,
				dryRun: c8ctl.dryRun,
				profile: str(values.profile),
			},
			flags,
		);
		return;
	}

	// Handle user task commands
	if (
		verb === "list" &&
		(normalizedResource === "user-task" || normalizedResource === "user-tasks")
	) {
		await listUserTasks({
			profile: str(values.profile),
			state: str(values.state),
			assignee: str(values.assignee),
			all: bool(values.all),
			sortBy: str(values.sortBy),
			sortOrder,
			limit,
			between: str(values.between),
			dateField: str(values.dateField),
		});
		return;
	}

	if (verb === "complete" && normalizedResource === "user-task") {
		if (!args[0]) {
			logger.error("User task key required. Usage: c8 complete ut <key>");
			process.exit(1);
		}
		await completeUserTask(args[0], {
			profile: str(values.profile),
			variables: str(values.variables),
		});
		return;
	}

	// Handle incident commands
	if (
		verb === "list" &&
		(normalizedResource === "incident" || normalizedResource === "incidents")
	) {
		await listIncidents({
			profile: str(values.profile),
			state: str(values.state),
			processInstanceKey: str(values.processInstanceKey),
			sortBy: str(values.sortBy),
			sortOrder,
			limit,
			between: str(values.between),
		});
		return;
	}

	if (verb === "get" && normalizedResource === "incident") {
		if (!args[0]) {
			logger.error("Incident key required. Usage: c8 get inc <key>");
			process.exit(1);
		}
		await getIncident(args[0], {
			profile: str(values.profile),
		});
		return;
	}

	if (verb === "resolve" && normalizedResource === "incident") {
		if (!args[0]) {
			logger.error("Incident key required. Usage: c8 resolve inc <key>");
			process.exit(1);
		}
		await resolveIncident(args[0], {
			profile: str(values.profile),
		});
		return;
	}

	// Handle job commands
	if (verb === "list" && normalizedResource === "jobs") {
		await listJobs({
			profile: str(values.profile),
			state: str(values.state),
			type: str(values.type),
			sortBy: str(values.sortBy),
			sortOrder,
			limit,
			between: str(values.between),
			dateField: str(values.dateField),
		});
		return;
	}

	if (verb === "activate" && normalizedResource === "jobs") {
		if (!args[0]) {
			logger.error("Job type required. Usage: c8 activate jobs <type>");
			process.exit(1);
		}
		await activateJobs(args[0], {
			profile: str(values.profile),
			maxJobsToActivate:
				values.maxJobsToActivate && typeof values.maxJobsToActivate === "string"
					? parseInt(values.maxJobsToActivate, 10)
					: undefined,
			timeout:
				values.timeout && typeof values.timeout === "string"
					? parseInt(values.timeout, 10)
					: undefined,
			worker: str(values.worker),
		});
		return;
	}

	if (verb === "complete" && normalizedResource === "job") {
		if (!args[0]) {
			logger.error("Job key required. Usage: c8 complete job <key>");
			process.exit(1);
		}
		await completeJob(args[0], {
			profile: str(values.profile),
			variables: str(values.variables),
		});
		return;
	}

	if (verb === "fail" && normalizedResource === "job") {
		if (!args[0]) {
			logger.error("Job key required. Usage: c8 fail job <key>");
			process.exit(1);
		}
		await failJob(args[0], {
			profile: str(values.profile),
			retries:
				values.retries && typeof values.retries === "string"
					? parseInt(values.retries, 10)
					: undefined,
			errorMessage: str(values.errorMessage),
		});
		return;
	}

	// Handle message commands
	if (verb === "publish" && normalizedResource === "message") {
		if (!args[0]) {
			logger.error("Message name required. Usage: c8 publish msg <name>");
			process.exit(1);
		}
		await publishMessage(args[0], {
			profile: str(values.profile),
			correlationKey: str(values.correlationKey),
			variables: str(values.variables),
			timeToLive:
				values.timeToLive && typeof values.timeToLive === "string"
					? parseInt(values.timeToLive, 10)
					: undefined,
		});
		return;
	}

	if (verb === "correlate" && normalizedResource === "message") {
		if (!args[0]) {
			logger.error("Message name required. Usage: c8 correlate msg <name>");
			process.exit(1);
		}
		await correlateMessage(args[0], {
			profile: str(values.profile),
			correlationKey: str(values.correlationKey),
			variables: str(values.variables),
			timeToLive:
				values.timeToLive && typeof values.timeToLive === "string"
					? parseInt(values.timeToLive, 10)
					: undefined,
		});
		return;
	}

	// Handle topology command
	if (verb === "get" && normalizedResource === "topology") {
		await getTopology({
			profile: str(values.profile),
		});
		return;
	}

	// Handle form commands
	if (verb === "get" && normalizedResource === "form") {
		if (!args[0]) {
			logger.error(
				"Key required. Usage: c8 get form <key> [--userTask|--ut] [--processDefinition|--pd]",
			);
			process.exit(1);
		}

		// Check for flags and their aliases
		const isUserTask =
			process.argv.includes("--userTask") || process.argv.includes("--ut");
		const isProcessDefinition =
			process.argv.includes("--processDefinition") ||
			process.argv.includes("--pd");

		// If both flags specified, error
		if (isUserTask && isProcessDefinition) {
			logger.error(
				"Cannot specify both --userTask|--ut and --processDefinition|--pd. Use one or the other, or omit both to search both types.",
			);
			process.exit(1);
		}

		// If specific flag provided, use that API
		if (isUserTask) {
			await getUserTaskForm(args[0], {
				profile: str(values.profile),
			});
		} else if (isProcessDefinition) {
			await getStartForm(args[0], {
				profile: str(values.profile),
			});
		} else {
			// No flag provided - try both
			await getForm(args[0], {
				profile: str(values.profile),
			});
		}
		return;
	}

	// Handle deploy command
	if (verb === "deploy") {
		const paths = resource
			? [resource, ...args]
			: args.length > 0
				? args
				: ["."];
		await deploy(paths, {
			profile: str(values.profile),
		});
		return;
	}

	// Handle run command
	if (verb === "run") {
		await run(resource, {
			profile: str(values.profile),
			variables: str(values.variables),
		});
		return;
	}

	// Handle watch command
	if (verb === "watch" || verb === "w") {
		const paths = resource
			? [resource, ...args]
			: args.length > 0
				? args
				: ["."];
		await watchFiles(paths, {
			profile: str(values.profile),
			force: bool(values.force),
		});
		return;
	}

	// Handle open command
	if (verb === "open") {
		const validated = validateOpenAppOptions(resource, {
			profile: str(values.profile),
			dryRun: bool(values["dry-run"]),
		});
		await openApp(validated);
		return;
	}

	// Handle feedback command
	if (verb === "feedback") {
		const logger = getLogger();
		const url = "https://github.com/camunda/c8ctl/issues";
		logger.info(`Opening feedback page: ${url}`);
		openUrl(url);
		return;
	}

	// Handle mcp-proxy command
	if (verb === "mcp-proxy") {
		await mcpProxy(positionals.slice(1), {
			profile: str(values.profile),
		});
		return;
	}

	// Handle search commands
	if (verb === "search") {
		const normalizedSearchResource = resolveAlias(resource);

		if (
			normalizedSearchResource === "process-definition" ||
			normalizedSearchResource === "process-definitions"
		) {
			await searchProcessDefinitions({
				profile: str(values.profile),
				processDefinitionId: resolveProcessDefinitionId(values),
				name: str(values.name),
				version: parseVersionFlag(values),
				key: str(values.key),
				iProcessDefinitionId: str(values.iid),
				iName: str(values.iname),
				sortBy: str(values.sortBy),
				sortOrder,
			});
			return;
		}

		if (
			normalizedSearchResource === "process-instance" ||
			normalizedSearchResource === "process-instances"
		) {
			await searchProcessInstances({
				profile: str(values.profile),
				processDefinitionId: resolveProcessDefinitionId(values),
				processDefinitionKey: str(values.processDefinitionKey),
				version: parseVersionFlag(values),
				state: str(values.state),
				key: str(values.key),
				parentProcessInstanceKey: str(values.parentProcessInstanceKey),
				iProcessDefinitionId: str(values.iid),
				sortBy: str(values.sortBy),
				sortOrder,
				between: str(values.between),
				dateField: str(values.dateField),
			});
			return;
		}

		if (
			normalizedSearchResource === "user-task" ||
			normalizedSearchResource === "user-tasks"
		) {
			await searchUserTasks({
				profile: str(values.profile),
				state: str(values.state),
				assignee: str(values.assignee),
				processInstanceKey: str(values.processInstanceKey),
				processDefinitionKey: str(values.processDefinitionKey),
				elementId: str(values.elementId),
				iAssignee: str(values.iassignee),
				sortBy: str(values.sortBy),
				sortOrder,
				between: str(values.between),
				dateField: str(values.dateField),
			});
			return;
		}

		if (
			normalizedSearchResource === "incident" ||
			normalizedSearchResource === "incidents"
		) {
			await searchIncidents({
				profile: str(values.profile),
				state: str(values.state),
				processInstanceKey: str(values.processInstanceKey),
				processDefinitionKey: str(values.processDefinitionKey),
				processDefinitionId: resolveProcessDefinitionId(values),
				errorType: str(values.errorType),
				errorMessage: str(values.errorMessage),
				iErrorMessage: str(values.ierrorMessage),
				iProcessDefinitionId: str(values.iid),
				sortBy: str(values.sortBy),
				sortOrder,
				between: str(values.between),
			});
			return;
		}

		if (normalizedSearchResource === "jobs") {
			await searchJobs({
				profile: str(values.profile),
				state: str(values.state),
				type: str(values.type),
				processInstanceKey: str(values.processInstanceKey),
				processDefinitionKey: str(values.processDefinitionKey),
				iType: str(values.itype),
				sortBy: str(values.sortBy),
				sortOrder,
				between: str(values.between),
				dateField: str(values.dateField),
			});
			return;
		}

		if (
			normalizedSearchResource === "variable" ||
			normalizedSearchResource === "variables"
		) {
			await searchVariables({
				profile: str(values.profile),
				name: str(values.name),
				value: str(values.value),
				processInstanceKey: str(values.processInstanceKey),
				scopeKey: str(values.scopeKey),
				fullValue: bool(values.fullValue),
				iName: str(values.iname),
				iValue: str(values.ivalue),
				sortBy: str(values.sortBy),
				sortOrder,
				limit,
			});
			return;
		}

		if (normalizedSearchResource === "user") {
			await searchIdentityUsers({
				profile: str(values.profile),
				username: str(values.username),
				name: str(values.name),
				email: str(values.email),
				sortBy: str(values.sortBy),
				sortOrder,
				limit,
			});
			return;
		}

		if (normalizedSearchResource === "role") {
			await searchIdentityRoles({
				profile: str(values.profile),
				roleId: str(values.roleId),
				name: str(values.name),
				sortBy: str(values.sortBy),
				sortOrder,
				limit,
			});
			return;
		}

		if (normalizedSearchResource === "group") {
			await searchIdentityGroups({
				profile: str(values.profile),
				groupId: str(values.groupId),
				name: str(values.name),
				sortBy: str(values.sortBy),
				sortOrder,
				limit,
			});
			return;
		}

		if (normalizedSearchResource === "tenant") {
			await searchIdentityTenants({
				profile: str(values.profile),
				name: str(values.name),
				tenantId: str(values.tenantId),
				sortBy: str(values.sortBy),
				sortOrder,
				limit,
			});
			return;
		}

		if (normalizedSearchResource === "authorization") {
			await searchIdentityAuthorizations({
				profile: str(values.profile),
				ownerId: str(values.ownerId),
				ownerType: str(values.ownerType),
				resourceType: str(values.resourceType),
				resourceId: str(values.resourceId),
				sortBy: str(values.sortBy),
				sortOrder,
				limit,
			});
			return;
		}

		if (normalizedSearchResource === "mapping-rule") {
			await searchIdentityMappingRules({
				profile: str(values.profile),
				mappingRuleId: str(values.mappingRuleId),
				name: str(values.name),
				claimName: str(values.claimName),
				claimValue: str(values.claimValue),
				sortBy: str(values.sortBy),
				sortOrder,
				limit,
			});
			return;
		}

		// If resource not recognized for search, show available resources
		showVerbResources("search");
		return;
	}

	// Handle identity list commands
	if (verb === "list" && normalizedResource === "user") {
		await listUsers({
			profile: str(values.profile),
			sortBy: str(values.sortBy),
			sortOrder,
			limit,
		});
		return;
	}
	if (verb === "list" && normalizedResource === "role") {
		await listRoles({
			profile: str(values.profile),
			sortBy: str(values.sortBy),
			sortOrder,
			limit,
		});
		return;
	}
	if (verb === "list" && normalizedResource === "group") {
		await listGroups({
			profile: str(values.profile),
			sortBy: str(values.sortBy),
			sortOrder,
			limit,
		});
		return;
	}
	if (verb === "list" && normalizedResource === "tenant") {
		await listTenants({
			profile: str(values.profile),
			sortBy: str(values.sortBy),
			sortOrder,
			limit,
		});
		return;
	}
	if (verb === "list" && normalizedResource === "authorization") {
		await listAuthorizations({
			profile: str(values.profile),
			sortBy: str(values.sortBy),
			sortOrder,
			limit,
		});
		return;
	}
	if (verb === "list" && normalizedResource === "mapping-rule") {
		await listMappingRules({
			profile: str(values.profile),
			sortBy: str(values.sortBy),
			sortOrder,
			limit,
		});
		return;
	}

	// Handle identity get commands
	if (verb === "get" && normalizedResource === "user") {
		if (!args[0]) {
			logger.error("Username required. Usage: c8 get user <username>");
			process.exit(1);
		}
		await getIdentityUser(args[0], { profile: str(values.profile) });
		return;
	}
	if (verb === "get" && normalizedResource === "role") {
		if (!args[0]) {
			logger.error("Role ID required. Usage: c8 get role <roleId>");
			process.exit(1);
		}
		await getIdentityRole(args[0], { profile: str(values.profile) });
		return;
	}
	if (verb === "get" && normalizedResource === "group") {
		if (!args[0]) {
			logger.error("Group ID required. Usage: c8 get group <groupId>");
			process.exit(1);
		}
		await getIdentityGroup(args[0], { profile: str(values.profile) });
		return;
	}
	if (verb === "get" && normalizedResource === "tenant") {
		if (!args[0]) {
			logger.error("Tenant ID required. Usage: c8 get tenant <tenantId>");
			process.exit(1);
		}
		await getIdentityTenant(args[0], { profile: str(values.profile) });
		return;
	}
	if (verb === "get" && normalizedResource === "authorization") {
		if (!args[0]) {
			logger.error("Authorization key required. Usage: c8 get auth <key>");
			process.exit(1);
		}
		await getIdentityAuthorization(args[0], { profile: str(values.profile) });
		return;
	}
	if (verb === "get" && normalizedResource === "mapping-rule") {
		if (!args[0]) {
			logger.error("Mapping rule ID required. Usage: c8 get mapping-rule <id>");
			process.exit(1);
		}
		await getIdentityMappingRule(args[0], { profile: str(values.profile) });
		return;
	}

	// Handle identity create commands
	if (verb === "create" && normalizedResource === "user") {
		await createIdentityUser({
			profile: str(values.profile),
			username: str(values.username),
			name: str(values.name),
			email: str(values.email),
			password: str(values.password),
		});
		return;
	}
	if (verb === "create" && normalizedResource === "role") {
		await createIdentityRole({
			profile: str(values.profile),
			roleId: str(values.roleId),
			name: str(values.name),
		});
		return;
	}
	if (verb === "create" && normalizedResource === "group") {
		await createIdentityGroup({
			profile: str(values.profile),
			groupId: str(values.groupId),
			name: str(values.name),
		});
		return;
	}
	if (verb === "create" && normalizedResource === "tenant") {
		await createIdentityTenant({
			profile: str(values.profile),
			tenantId: str(values.tenantId),
			name: str(values.name),
		});
		return;
	}
	if (verb === "create" && normalizedResource === "authorization") {
		const validated = validateCreateAuthorizationOptions({
			profile: str(values.profile),
			ownerId: str(values.ownerId),
			ownerType: str(values.ownerType),
			resourceType: str(values.resourceType),
			resourceId: str(values.resourceId),
			permissions: str(values.permissions),
		});
		await createIdentityAuthorization(validated);
		return;
	}
	if (verb === "create" && normalizedResource === "mapping-rule") {
		await createIdentityMappingRule({
			profile: str(values.profile),
			mappingRuleId: str(values.mappingRuleId),
			name: str(values.name),
			claimName: str(values.claimName),
			claimValue: str(values.claimValue),
		});
		return;
	}

	// Handle identity delete commands
	if (verb === "delete" && normalizedResource === "user") {
		if (!args[0]) {
			logger.error("Username required. Usage: c8 delete user <username>");
			process.exit(1);
		}
		await deleteIdentityUser(args[0], { profile: str(values.profile) });
		return;
	}
	if (verb === "delete" && normalizedResource === "role") {
		if (!args[0]) {
			logger.error("Role ID required. Usage: c8 delete role <roleId>");
			process.exit(1);
		}
		await deleteIdentityRole(args[0], { profile: str(values.profile) });
		return;
	}
	if (verb === "delete" && normalizedResource === "group") {
		if (!args[0]) {
			logger.error("Group ID required. Usage: c8 delete group <groupId>");
			process.exit(1);
		}
		await deleteIdentityGroup(args[0], { profile: str(values.profile) });
		return;
	}
	if (verb === "delete" && normalizedResource === "tenant") {
		if (!args[0]) {
			logger.error("Tenant ID required. Usage: c8 delete tenant <tenantId>");
			process.exit(1);
		}
		await deleteIdentityTenant(args[0], { profile: str(values.profile) });
		return;
	}
	if (verb === "delete" && normalizedResource === "authorization") {
		if (!args[0]) {
			logger.error("Authorization key required. Usage: c8 delete auth <key>");
			process.exit(1);
		}
		await deleteIdentityAuthorization(args[0], {
			profile: str(values.profile),
		});
		return;
	}
	if (verb === "delete" && normalizedResource === "mapping-rule") {
		if (!args[0]) {
			logger.error(
				"Mapping rule ID required. Usage: c8 delete mapping-rule <id>",
			);
			process.exit(1);
		}
		await deleteIdentityMappingRule(args[0], { profile: str(values.profile) });
		return;
	}

	// Handle assign/unassign commands
	if (verb === "assign") {
		if (!args[0]) {
			logger.error(
				`ID required. Usage: c8 assign ${normalizedResource} <id> --to-<target>=<targetId>`,
			);
			process.exit(1);
		}
		await handleAssign(normalizedResource, args[0], values, {
			profile: str(values.profile),
		});
		return;
	}

	if (verb === "unassign") {
		if (!args[0]) {
			logger.error(
				`ID required. Usage: c8 unassign ${normalizedResource} <id> --from-<target>=<targetId>`,
			);
			process.exit(1);
		}
		await handleUnassign(normalizedResource, args[0], values, {
			profile: str(values.profile),
		});
		return;
	}

	// Try to execute plugin command (before verb-only check)
	if (await executePluginCommand(verb, resource ? [resource, ...args] : args)) {
		return;
	}

	// Unknown command
	logger.error(`Unknown command: ${verb}${resource ? ` ${resource}` : ""}`);
	logger.info('Run "c8 help" for usage information');
	process.exit(1);
}

// Run the CLI only when invoked directly (not when imported)
// Use realpathSync to resolve symlinks (e.g. when installed globally via npm link)
try {
	if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
		main().catch((error) => {
			if (c8ctl.verbose) {
				throw error;
			}
			console.error("Unexpected error:", error);
			process.exit(1);
		});
	}
} catch {
	/* not invoked directly */
}
