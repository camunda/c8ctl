/**
 * Declarative command registry — single source of truth for all
 * verb×resource combinations, their flags, constraints, and metadata.
 *
 * Consumers (help, completion, validation, dispatch) derive their
 * data from this registry instead of maintaining separate copies.
 */

import {
	ProcessDefinitionId,
	ProcessDefinitionKey,
	ProcessInstanceKey,
	TenantId,
	Username,
} from "@camunda8/orchestration-cluster-api";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FlagDef {
	type: "string" | "boolean";
	description: string;
	short?: string;
	required?: boolean;
	/** SDK enum object for automatic validation (keys are valid values). */
	enum?: Record<string, string>;
	/** When true, flag value is comma-separated and each item is validated against enum. */
	csv?: boolean;
	/**
	 * Transform and validate raw CLI input into a typed value.
	 * Called at the validation boundary before dispatch.
	 * Should throw on invalid input (error message is surfaced to the user).
	 * Each concrete validator returns its branded type (e.g. ProcessDefinitionKey),
	 * erased to unknown here since FlagDef holds heterogeneous validators.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: validators return branded types that vary per flag
	validate?: (value: string) => any;
}

export interface CommandDef {
	description: string;
	mutating: boolean;
	/** When true, a positional resource argument is required after the verb. */
	requiresResource: boolean;
	/** Valid resource names (canonical short forms used in help). */
	resources: string[];
	/** Flags specific to this verb (beyond global flags). */
	flags: Record<string, FlagDef>;
	/** Verb aliases that dispatch to this command (e.g. "rm" → remove, "w" → watch). */
	aliases?: string[];
}

// ─── Resource Aliases ────────────────────────────────────────────────────────

/**
 * Maps short/plural resource names to their canonical singular form.
 * Used by the dispatch layer to normalize user input before lookup.
 */
export const RESOURCE_ALIASES: Record<string, string> = {
	pi: "process-instance",
	pd: "process-definition",
	ut: "user-task",
	inc: "incident",
	msg: "message",
	vars: "variable",
	profile: "profile",
	profiles: "profile",
	plugin: "plugin",
	plugins: "plugin",
	auth: "authorization",
	authorizations: "authorization",
	mr: "mapping-rule",
	"mapping-rules": "mapping-rule",
	users: "user",
	roles: "role",
	groups: "group",
	tenants: "tenant",
};

// ─── Global Flags ────────────────────────────────────────────────────────────

/**
 * Flags accepted by every command (infrastructure/agent flags).
 */
export const GLOBAL_FLAGS: Record<string, FlagDef> = {
	help: { type: "boolean", description: "Show help", short: "h" },
	version: {
		type: "string",
		description:
			"Show CLI version, or filter by process definition version on supported commands",
		short: "v",
	},
	profile: { type: "string", description: "Use a specific profile" },
	"dry-run": {
		type: "boolean",
		description: "Preview the API request without executing",
	},
	verbose: { type: "boolean", description: "Show verbose output" },
	fields: {
		type: "string",
		description: "Comma-separated list of fields to display",
	},
};

/**
 * Flags shared across all search/list commands.
 */
export const SEARCH_FLAGS: Record<string, FlagDef> = {
	sortBy: { type: "string", description: "Sort results by field" },
	asc: { type: "boolean", description: "Sort ascending" },
	desc: { type: "boolean", description: "Sort descending" },
	limit: { type: "string", description: "Maximum number of results" },
	between: {
		type: "string",
		description: "Date range filter (e.g. 7d, 30d, 2024-01-01..2024-12-31)",
	},
	dateField: {
		type: "string",
		description: "Date field for --between filter",
	},
};

// ─── Reusable flag sets ──────────────────────────────────────────────────────

const PI_SEARCH_FLAGS: Record<string, FlagDef> = {
	bpmnProcessId: {
		type: "string",
		description: "Filter by BPMN process ID",
	},
	id: { type: "string", description: "Filter by BPMN process ID (alias)" },
	processDefinitionId: {
		type: "string",
		description: "Filter by process definition ID",
		validate: ProcessDefinitionId.assumeExists,
	},
	processDefinitionKey: {
		type: "string",
		description: "Filter by process definition key",
		validate: ProcessDefinitionKey.assumeExists,
	},
	state: { type: "string", description: "Filter by state" },
	key: { type: "string", description: "Filter by key" },
	parentProcessInstanceKey: {
		type: "string",
		description: "Filter by parent process instance key",
		validate: ProcessInstanceKey.assumeExists,
	},
	iid: {
		type: "string",
		description: "Case-insensitive filter by BPMN process ID",
	},
};

const PD_SEARCH_FLAGS: Record<string, FlagDef> = {
	bpmnProcessId: {
		type: "string",
		description: "Filter by BPMN process ID",
	},
	id: { type: "string", description: "Filter by BPMN process ID (alias)" },
	processDefinitionId: {
		type: "string",
		description: "Filter by process definition ID",
		validate: ProcessDefinitionId.assumeExists,
	},
	name: { type: "string", description: "Filter by name" },
	key: { type: "string", description: "Filter by key" },
	iid: {
		type: "string",
		description: "Case-insensitive filter by BPMN process ID",
	},
	iname: { type: "string", description: "Case-insensitive filter by name" },
};

const UT_SEARCH_FLAGS: Record<string, FlagDef> = {
	state: { type: "string", description: "Filter by state" },
	assignee: { type: "string", description: "Filter by assignee" },
	processInstanceKey: {
		type: "string",
		description: "Filter by process instance key",
		validate: ProcessInstanceKey.assumeExists,
	},
	processDefinitionKey: {
		type: "string",
		description: "Filter by process definition key",
		validate: ProcessDefinitionKey.assumeExists,
	},
	elementId: { type: "string", description: "Filter by element ID" },
	iassignee: {
		type: "string",
		description: "Case-insensitive filter by assignee",
	},
};

const INC_SEARCH_FLAGS: Record<string, FlagDef> = {
	state: { type: "string", description: "Filter by state" },
	processInstanceKey: {
		type: "string",
		description: "Filter by process instance key",
		validate: ProcessInstanceKey.assumeExists,
	},
	processDefinitionKey: {
		type: "string",
		description: "Filter by process definition key",
		validate: ProcessDefinitionKey.assumeExists,
	},
	bpmnProcessId: {
		type: "string",
		description: "Filter by BPMN process ID",
	},
	id: { type: "string", description: "Filter by BPMN process ID (alias)" },
	processDefinitionId: {
		type: "string",
		description: "Filter by process definition ID",
		validate: ProcessDefinitionId.assumeExists,
	},
	errorType: { type: "string", description: "Filter by error type" },
	errorMessage: {
		type: "string",
		description: "Filter by error message",
	},
	ierrorMessage: {
		type: "string",
		description: "Case-insensitive filter by error message",
	},
	iid: {
		type: "string",
		description: "Case-insensitive filter by BPMN process ID",
	},
};

const JOB_SEARCH_FLAGS: Record<string, FlagDef> = {
	state: { type: "string", description: "Filter by state" },
	type: { type: "string", description: "Filter by job type" },
	processInstanceKey: {
		type: "string",
		description: "Filter by process instance key",
		validate: ProcessInstanceKey.assumeExists,
	},
	processDefinitionKey: {
		type: "string",
		description: "Filter by process definition key",
		validate: ProcessDefinitionKey.assumeExists,
	},
	itype: {
		type: "string",
		description: "Case-insensitive filter by job type",
	},
};

const VAR_SEARCH_FLAGS: Record<string, FlagDef> = {
	name: { type: "string", description: "Filter by variable name" },
	value: { type: "string", description: "Filter by value" },
	processInstanceKey: {
		type: "string",
		description: "Filter by process instance key",
		validate: ProcessInstanceKey.assumeExists,
	},
	scopeKey: { type: "string", description: "Filter by scope key" },
	fullValue: {
		type: "boolean",
		description: "Return full variable values (not truncated)",
	},
	iname: {
		type: "string",
		description: "Case-insensitive filter by name",
	},
	ivalue: {
		type: "string",
		description: "Case-insensitive filter by value",
	},
};

const USER_SEARCH_FLAGS: Record<string, FlagDef> = {
	username: {
		type: "string",
		description: "Filter by username",
		validate: Username.assumeExists,
	},
	name: { type: "string", description: "Filter by name" },
	email: { type: "string", description: "Filter by email" },
};

const ROLE_SEARCH_FLAGS: Record<string, FlagDef> = {
	roleId: { type: "string", description: "Filter by role ID" },
	name: { type: "string", description: "Filter by name" },
};

const GROUP_SEARCH_FLAGS: Record<string, FlagDef> = {
	groupId: { type: "string", description: "Filter by group ID" },
	name: { type: "string", description: "Filter by name" },
};

const TENANT_SEARCH_FLAGS: Record<string, FlagDef> = {
	tenantId: {
		type: "string",
		description: "Filter by tenant ID",
		validate: TenantId.assumeExists,
	},
	name: { type: "string", description: "Filter by name" },
};

const AUTH_SEARCH_FLAGS: Record<string, FlagDef> = {
	ownerId: { type: "string", description: "Filter by owner ID" },
	ownerType: { type: "string", description: "Filter by owner type" },
	resourceType: {
		type: "string",
		description: "Filter by resource type",
	},
	resourceId: { type: "string", description: "Filter by resource ID" },
};

const MR_SEARCH_FLAGS: Record<string, FlagDef> = {
	mappingRuleId: {
		type: "string",
		description: "Filter by mapping rule ID",
	},
	name: { type: "string", description: "Filter by name" },
	claimName: { type: "string", description: "Filter by claim name" },
	claimValue: { type: "string", description: "Filter by claim value" },
};

const ASSIGN_FLAGS: Record<string, FlagDef> = {
	"to-user": { type: "string", description: "Target user ID" },
	"to-group": { type: "string", description: "Target group ID" },
	"to-tenant": { type: "string", description: "Target tenant ID" },
	"to-mapping-rule": {
		type: "string",
		description: "Target mapping rule ID",
	},
};

const UNASSIGN_FLAGS: Record<string, FlagDef> = {
	"from-user": { type: "string", description: "Source user ID" },
	"from-group": { type: "string", description: "Source group ID" },
	"from-tenant": { type: "string", description: "Source tenant ID" },
	"from-mapping-rule": {
		type: "string",
		description: "Source mapping rule ID",
	},
};

const PROFILE_CONNECTION_FLAGS: Record<string, FlagDef> = {
	baseUrl: { type: "string", description: "Cluster base URL" },
	clientId: { type: "string", description: "OAuth client ID" },
	clientSecret: { type: "string", description: "OAuth client secret" },
	audience: { type: "string", description: "OAuth audience" },
	oAuthUrl: { type: "string", description: "OAuth token URL" },
	defaultTenantId: { type: "string", description: "Default tenant ID" },
	username: { type: "string", description: "Basic auth username" },
	password: { type: "string", description: "Basic auth password" },
	"from-file": { type: "string", description: "Import from .env file" },
	"from-env": {
		type: "boolean",
		description: "Import from environment variables",
	},
};

// ─── Command Registry ────────────────────────────────────────────────────────

export const COMMAND_REGISTRY: Record<string, CommandDef> = {
	// ── Read commands ──────────────────────────────────────────────────────

	list: {
		description: "List resources (process, identity)",
		mutating: false,
		requiresResource: true,
		resources: [
			"pi",
			"pd",
			"ut",
			"inc",
			"jobs",
			"profiles",
			"plugins",
			"users",
			"roles",
			"groups",
			"tenants",
			"auth",
			"mapping-rules",
		],
		flags: {
			all: {
				type: "boolean",
				description: "List all (disable pagination limit)",
			},
			...SEARCH_FLAGS,
			// List supports the same resource-specific filters as search;
			// per-resource scoping is handled by SEARCH_RESOURCE_FLAGS.
			...PI_SEARCH_FLAGS,
			...PD_SEARCH_FLAGS,
			...UT_SEARCH_FLAGS,
			...INC_SEARCH_FLAGS,
			...JOB_SEARCH_FLAGS,
			...USER_SEARCH_FLAGS,
			...ROLE_SEARCH_FLAGS,
			...GROUP_SEARCH_FLAGS,
			...TENANT_SEARCH_FLAGS,
			...AUTH_SEARCH_FLAGS,
			...MR_SEARCH_FLAGS,
		},
	},

	search: {
		description: "Search resources with filters",
		mutating: false,
		requiresResource: true,
		resources: [
			"pi",
			"pd",
			"ut",
			"inc",
			"jobs",
			"vars",
			"users",
			"roles",
			"groups",
			"tenants",
			"auth",
			"mapping-rules",
		],
		flags: {
			...SEARCH_FLAGS,
			// Resource-specific flags are all accepted; per-resource scoping
			// is handled by SEARCH_RESOURCE_FLAGS below.
			...PI_SEARCH_FLAGS,
			...PD_SEARCH_FLAGS,
			...UT_SEARCH_FLAGS,
			...INC_SEARCH_FLAGS,
			...JOB_SEARCH_FLAGS,
			...VAR_SEARCH_FLAGS,
			...USER_SEARCH_FLAGS,
			...ROLE_SEARCH_FLAGS,
			...GROUP_SEARCH_FLAGS,
			...TENANT_SEARCH_FLAGS,
			...AUTH_SEARCH_FLAGS,
			...MR_SEARCH_FLAGS,
		},
	},

	get: {
		description: "Get resource by key",
		mutating: false,
		requiresResource: true,
		resources: [
			"pi",
			"pd",
			"inc",
			"topology",
			"form",
			"user",
			"role",
			"group",
			"tenant",
			"auth",
			"mapping-rule",
		],
		flags: {
			xml: {
				type: "boolean",
				description: "Get BPMN XML (process definitions)",
			},
			userTask: {
				type: "boolean",
				description: "Get form for user task",
			},
			processDefinition: {
				type: "boolean",
				description: "Get form for process definition",
			},
		},
	},

	// ── Mutating commands ──────────────────────────────────────────────────

	create: {
		description: "Create resource",
		mutating: true,
		requiresResource: true,
		resources: [
			"pi",
			"user",
			"role",
			"group",
			"tenant",
			"auth",
			"mapping-rule",
		],
		flags: {
			// Process instance creation
			processDefinitionId: {
				type: "string",
				description: "Process definition ID (BPMN process ID)",
				validate: ProcessDefinitionId.assumeExists,
			},
			id: {
				type: "string",
				description: "Process definition ID (alias for --processDefinitionId)",
			},
			bpmnProcessId: {
				type: "string",
				description: "BPMN process ID (alias for --processDefinitionId)",
			},
			variables: { type: "string", description: "JSON variables" },
			awaitCompletion: {
				type: "boolean",
				description: "Wait for process to complete",
			},
			fetchVariables: {
				type: "boolean",
				description: "Fetch result variables on completion",
			},
			requestTimeout: {
				type: "string",
				description: "Await timeout in milliseconds",
			},
			// Identity user
			username: {
				type: "string",
				description: "Username",
				validate: Username.assumeExists,
			},
			name: { type: "string", description: "Display name" },
			email: { type: "string", description: "Email address" },
			password: { type: "string", description: "Password" },
			// Identity role
			roleId: { type: "string", description: "Role ID" },
			// Identity group
			groupId: { type: "string", description: "Group ID" },
			// Identity tenant
			tenantId: {
				type: "string",
				description: "Tenant ID",
				validate: TenantId.assumeExists,
			},
			// Identity authorization
			ownerId: {
				type: "string",
				description: "Authorization owner ID",
				required: true,
			},
			ownerType: {
				type: "string",
				description: "Authorization owner type",
				required: true,
			},
			resourceType: {
				type: "string",
				description: "Authorization resource type",
				required: true,
			},
			resourceId: {
				type: "string",
				description: "Authorization resource ID",
				required: true,
			},
			permissions: {
				type: "string",
				description: "Comma-separated permissions",
				required: true,
				csv: true,
			},
			// Identity mapping rule
			mappingRuleId: {
				type: "string",
				description: "Mapping rule ID",
			},
			claimName: { type: "string", description: "Claim name" },
			claimValue: { type: "string", description: "Claim value" },
		},
	},

	delete: {
		description: "Delete resource",
		mutating: true,
		requiresResource: true,
		resources: ["user", "role", "group", "tenant", "auth", "mapping-rule"],
		flags: {},
	},

	cancel: {
		description: "Cancel resource",
		mutating: true,
		requiresResource: true,
		resources: ["pi"],
		flags: {},
	},

	await: {
		description:
			"Create and await completion (alias for create --awaitCompletion)",
		mutating: true,
		requiresResource: true,
		resources: ["pi"],
		flags: {
			processDefinitionId: {
				type: "string",
				description: "Process definition ID (BPMN process ID)",
				validate: ProcessDefinitionId.assumeExists,
			},
			id: {
				type: "string",
				description: "Process definition ID (alias for --processDefinitionId)",
			},
			bpmnProcessId: {
				type: "string",
				description: "BPMN process ID (alias for --processDefinitionId)",
			},
			variables: { type: "string", description: "JSON variables" },
			fetchVariables: {
				type: "boolean",
				description: "Fetch result variables on completion",
			},
			requestTimeout: {
				type: "string",
				description: "Await timeout in milliseconds",
			},
		},
	},

	complete: {
		description: "Complete resource",
		mutating: true,
		requiresResource: true,
		resources: ["ut", "job"],
		flags: {
			variables: { type: "string", description: "JSON variables" },
		},
	},

	fail: {
		description: "Fail a job",
		mutating: true,
		requiresResource: true,
		resources: ["job"],
		flags: {
			retries: {
				type: "string",
				description: "Remaining retries",
			},
			errorMessage: {
				type: "string",
				description: "Error message",
			},
		},
	},

	activate: {
		description: "Activate jobs by type",
		mutating: true,
		requiresResource: true,
		resources: ["jobs"],
		flags: {
			maxJobsToActivate: {
				type: "string",
				description: "Maximum number of jobs to activate",
			},
			timeout: {
				type: "string",
				description: "Job timeout in milliseconds",
			},
			worker: { type: "string", description: "Worker name" },
		},
	},

	resolve: {
		description: "Resolve incident",
		mutating: true,
		requiresResource: true,
		resources: ["inc"],
		flags: {},
	},

	publish: {
		description: "Publish message",
		mutating: true,
		requiresResource: true,
		resources: ["msg"],
		flags: {
			correlationKey: {
				type: "string",
				description: "Correlation key",
			},
			variables: { type: "string", description: "JSON variables" },
			timeToLive: {
				type: "string",
				description: "Time to live in milliseconds",
			},
		},
	},

	correlate: {
		description: "Correlate message",
		mutating: true,
		requiresResource: true,
		resources: ["msg"],
		flags: {
			correlationKey: {
				type: "string",
				description: "Correlation key",
				required: true,
			},
			variables: { type: "string", description: "JSON variables" },
			timeToLive: {
				type: "string",
				description: "Time to live in milliseconds",
			},
		},
	},

	deploy: {
		description: "Deploy BPMN/DMN/forms",
		mutating: true,
		requiresResource: false,
		resources: [],
		flags: {},
	},

	run: {
		description: "Deploy and start process",
		mutating: true,
		requiresResource: true,
		resources: [],
		flags: {
			variables: { type: "string", description: "JSON variables" },
		},
	},

	// ── Assignment commands ────────────────────────────────────────────────

	assign: {
		description: "Assign resource to target",
		mutating: true,
		requiresResource: true,
		resources: ["role", "user", "group", "mapping-rule"],
		flags: { ...ASSIGN_FLAGS },
	},

	unassign: {
		description: "Unassign resource from target",
		mutating: true,
		requiresResource: true,
		resources: ["role", "user", "group", "mapping-rule"],
		flags: { ...UNASSIGN_FLAGS },
	},

	// ── Operational commands ───────────────────────────────────────────────

	watch: {
		description: "Watch files for changes and auto-deploy",
		mutating: false,
		requiresResource: false,
		resources: [],
		flags: {
			force: {
				type: "boolean",
				description: "Force re-deploy unchanged files",
			},
		},
		aliases: ["w"],
	},

	open: {
		description: "Open Camunda web application in browser",
		mutating: false,
		requiresResource: true,
		resources: ["operate", "tasklist", "modeler", "optimize"],
		flags: {},
	},

	// ── Profile & plugin management ────────────────────────────────────────

	add: {
		description: "Add a profile",
		mutating: false,
		requiresResource: true,
		resources: ["profile"],
		flags: { ...PROFILE_CONNECTION_FLAGS },
	},

	remove: {
		description: "Remove a profile",
		mutating: false,
		requiresResource: true,
		resources: ["profile"],
		flags: {
			none: {
				type: "boolean",
				description: "Clear active profile",
			},
		},
		aliases: ["rm"],
	},

	load: {
		description: "Load a c8ctl plugin",
		mutating: false,
		requiresResource: true,
		resources: ["plugin"],
		flags: {
			from: {
				type: "string",
				description: "Load plugin from URL",
			},
		},
	},

	unload: {
		description: "Unload a c8ctl plugin",
		mutating: false,
		requiresResource: true,
		resources: ["plugin"],
		flags: {
			force: {
				type: "boolean",
				description: "Force unload without confirmation",
			},
		},
		aliases: ["rm"],
	},

	upgrade: {
		description: "Upgrade a plugin",
		mutating: false,
		requiresResource: true,
		resources: ["plugin"],
		flags: {},
	},

	downgrade: {
		description: "Downgrade a plugin to a specific version",
		mutating: false,
		requiresResource: true,
		resources: ["plugin"],
		flags: {},
	},

	sync: {
		description: "Synchronize plugins",
		mutating: false,
		requiresResource: true,
		resources: ["plugin"],
		flags: {},
	},

	init: {
		description: "Create a new plugin from TypeScript template",
		mutating: false,
		requiresResource: true,
		resources: ["plugin"],
		flags: {},
	},

	// ── Session commands ───────────────────────────────────────────────────

	use: {
		description: "Set active profile or tenant",
		mutating: false,
		requiresResource: true,
		resources: ["profile", "tenant"],
		flags: {
			none: {
				type: "boolean",
				description: "Clear active profile/tenant",
			},
		},
	},

	output: {
		description: "Show or set output format",
		mutating: false,
		requiresResource: false,
		resources: ["json", "text"],
		flags: {},
	},

	// ── Utility commands ───────────────────────────────────────────────────

	completion: {
		description: "Generate shell completion script",
		mutating: false,
		requiresResource: false,
		resources: ["bash", "zsh", "fish"],
		flags: {},
	},

	"mcp-proxy": {
		description: "Start a STDIO to remote HTTP MCP proxy server",
		mutating: false,
		requiresResource: false,
		resources: [],
		flags: {},
	},

	feedback: {
		description: "Open the feedback page to report issues or request features",
		mutating: false,
		requiresResource: false,
		resources: [],
		flags: {},
	},

	help: {
		description: "Show help",
		mutating: false,
		requiresResource: false,
		resources: [],
		flags: {},
	},

	which: {
		description: "Show active profile",
		mutating: false,
		requiresResource: true,
		resources: ["profile"],
		flags: {},
	},
};

// ─── Per-resource search flag scoping ────────────────────────────────────────

/**
 * Maps each searchable resource (canonical name) to the set of flag names
 * that are valid for that resource's search command. Used for unknown-flag
 * detection in search commands.
 */
export const SEARCH_RESOURCE_FLAGS: Record<string, Set<string>> = {
	"process-definition": new Set(Object.keys(PD_SEARCH_FLAGS)),
	"process-instance": new Set(Object.keys(PI_SEARCH_FLAGS)),
	"user-task": new Set(Object.keys(UT_SEARCH_FLAGS)),
	incident: new Set(Object.keys(INC_SEARCH_FLAGS)),
	jobs: new Set(Object.keys(JOB_SEARCH_FLAGS)),
	variable: new Set(Object.keys(VAR_SEARCH_FLAGS)),
	user: new Set(Object.keys(USER_SEARCH_FLAGS)),
	role: new Set(Object.keys(ROLE_SEARCH_FLAGS)),
	group: new Set(Object.keys(GROUP_SEARCH_FLAGS)),
	tenant: new Set(Object.keys(TENANT_SEARCH_FLAGS)),
	authorization: new Set(Object.keys(AUTH_SEARCH_FLAGS)),
	"mapping-rule": new Set(Object.keys(MR_SEARCH_FLAGS)),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Maps verb aliases to their canonical verb names.
 * Built from COMMAND_REGISTRY aliases fields.
 * e.g. { "rm": ["remove", "unload"], "w": ["watch"] }
 */
export const VERB_ALIASES: Record<string, string[]> = (() => {
	const map: Record<string, string[]> = {};
	for (const [verb, def] of Object.entries(COMMAND_REGISTRY)) {
		for (const alias of def.aliases ?? []) {
			if (!map[alias]) {
				map[alias] = [];
			}
			map[alias].push(verb);
		}
	}
	return map;
})();

/**
 * Resolve a resource alias to its canonical form.
 * Returns the input unchanged if no alias exists.
 */
export function resolveAlias(resource: string): string {
	return RESOURCE_ALIASES[resource] ?? resource;
}

/**
 * Look up a command definition by verb (resolves verb aliases).
 * For alias verbs that map to multiple commands (e.g. "rm" → remove + unload),
 * returns the first match. Use VERB_ALIASES directly for multi-target aliases.
 */
export function getCommandDef(verb: string): CommandDef | undefined {
	const direct = COMMAND_REGISTRY[verb];
	if (direct) return direct;
	const targets = VERB_ALIASES[verb];
	return targets ? COMMAND_REGISTRY[targets[0]] : undefined;
}

/**
 * Get all flags accepted for a given verb, including global flags.
 */
export function getAcceptedFlags(
	verb: string,
): Record<string, FlagDef> | undefined {
	const def = getCommandDef(verb);
	if (!def) return undefined;
	return { ...GLOBAL_FLAGS, ...def.flags };
}

/**
 * Get the set of resource-specific search flags for a given canonical resource.
 */
export function getSearchFlagsForResource(
	resource: string,
): Set<string> | undefined {
	return SEARCH_RESOURCE_FLAGS[resource];
}

/**
 * Check whether a verb×resource combination is valid.
 * Accepts both raw aliases and canonical resource names.
 */
export function isValidCommand(verb: string, resource: string): boolean {
	const def = getCommandDef(verb);
	if (!def) return false;
	if (!def.requiresResource) return true;

	const canonical = resolveAlias(resource);
	return (
		def.resources.includes(resource) ||
		def.resources.includes(canonical) ||
		def.resources.some((r) => resolveAlias(r) === canonical)
	);
}

/**
 * Derive parseArgs options from the registry. This produces the flat
 * options object that node:util parseArgs expects, covering all flags
 * from all commands plus global flags.
 */
export function deriveParseArgsOptions(): Record<
	string,
	{ type: "string" | "boolean"; short?: string }
> {
	const options: Record<
		string,
		{ type: "string" | "boolean"; short?: string }
	> = {};

	// Global flags
	for (const [name, def] of Object.entries(GLOBAL_FLAGS)) {
		options[name] = { type: def.type, ...(def.short && { short: def.short }) };
	}

	// Search flags
	for (const [name, def] of Object.entries(SEARCH_FLAGS)) {
		options[name] = { type: def.type, ...(def.short && { short: def.short }) };
	}

	// All command-specific flags
	for (const cmd of Object.values(COMMAND_REGISTRY)) {
		for (const [name, def] of Object.entries(cmd.flags)) {
			if (!options[name]) {
				options[name] = {
					type: def.type,
					...(def.short && { short: def.short }),
				};
			}
		}
	}

	return options;
}
