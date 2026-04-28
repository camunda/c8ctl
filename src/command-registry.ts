/**
 * Declarative command registry — single source of truth for all
 * verb×resource combinations, their flags, constraints, and metadata.
 *
 * Consumers (help, completion, validation, dispatch) derive their
 * data from this registry instead of maintaining separate copies.
 */

import {
	AuthorizationKey,
	ElementInstanceKey,
	IncidentKey,
	JobKey,
	ProcessDefinitionId,
	ProcessDefinitionKey,
	ProcessInstanceKey,
	TenantId,
	Username,
	UserTaskKey,
} from "@camunda8/orchestration-cluster-api";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FlagDef {
	/** Value type: "string" expects an argument, "boolean" is a presence flag. */
	type: "string" | "boolean";
	/** One-line description shown in command-level help output. */
	description: string;
	/** Single-character alias (e.g. "k" → -k). */
	short?: string;
	/** When true, the flag must be supplied or the command exits with an error. */
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
	/** Rich description for agent-facing help (AI/programmatic consumers). Shown in Agent Flags section. */
	agentDescription?: string;
	/** Scope hint for agent-facing help (e.g. "all commands", "all list/search/get commands"). */
	agentAppliesTo?: string;
}

/**
 * Schema for a single positional argument.
 *
 * - `name`: used as the key in the typed args record and in error messages
 * - `required`: when true, missing value exits with an error
 * - `validate`: optional branded-type constructor (e.g. ProcessDefinitionKey.assumeExists)
 */
export interface PositionalDef {
	name: string;
	required?: boolean;
	// biome-ignore lint/suspicious/noExplicitAny: validators return branded types that vary per positional
	validate?: (value: string) => any;
}

export interface CommandDef {
	description: string;
	mutating: boolean;
	/** When true, a positional resource argument is required after the verb. */
	requiresResource: boolean;
	/** Valid resource names (canonical short forms used in help). */
	resources: string[];
	/**
	 * Verb-level flag schema. Per-resource flags must live exclusively in
	 * `resourceFlags` — they are *not* duplicated here. Mixing a flag into
	 * both buckets defeats unknown-flag detection (#256), and the
	 * structural disjointness invariant in
	 * `tests/unit/command-registry.test.ts` will fail.
	 *
	 * **Effective-resolution semantics** (see `ResolvedFlags` in
	 * `src/command-framework.ts` and `validateFlags` in `src/index.ts`):
	 * the handler's typed `flags` parameter and `validateFlags`'s
	 * required-field/validator checks resolve to
	 * `resourceFlags[resource] ?? flags`. So for a verb that declares
	 * **both** `flags` and `resourceFlags[r]`, the verb-level `flags` are
	 * **not** seen by the handler or by `validateFlags` when dispatching to
	 * resource `r` — only `resourceFlags[r]` is. Verb-level `flags` are
	 * still treated as valid by `detectUnknownFlags` (so `parseArgs` won't
	 * warn on them) and by `deriveParseArgsOptions` (so they parse), but
	 * they will not flow into the handler's typed parameter for any
	 * resource that has its own bucket.
	 *
	 * Practical guidance: if a flag must be visible to the handler for a
	 * given resource, declare it in that resource's `resourceFlags` bucket
	 * (typically by spreading a shared constant such as `SEARCH_FLAGS`
	 * into each per-resource bucket). Reserve verb-level `flags` for verbs
	 * with no `resourceFlags` at all, or for flags that are deliberately
	 * parse-only on resources with their own bucket.
	 */
	flags: Record<string, FlagDef>;
	/**
	 * Per-resource flag scoping. Keys are canonical resource names.
	 * Flags declared here must not also appear in `flags` (see above).
	 *
	 * When a resource has an entry here, the framework resolves the
	 * effective flag schema as `resourceFlags[resource]` and **ignores**
	 * the verb-level `flags` for handler typing and `validateFlags`.
	 * `parseArgs` still sees both via `deriveParseArgsOptions`, and the
	 * scoping lets `warnUnknownFlags` warn when a flag is passed against a
	 * resource that does not declare it. See the doc on `flags` above for
	 * the full effective-resolution semantics.
	 */
	resourceFlags?: Record<string, Record<string, FlagDef>>;
	/** Per-resource positional argument schemas. Keys are canonical resource names. */
	resourcePositionals?: Record<string, readonly PositionalDef[]>;
	/** Verb aliases that dispatch to this command (e.g. "rm" → remove, "w" → watch). */
	aliases?: string[];
	/**
	 * Override the resource column in `c8ctl help` output.
	 * Auto-derived from resources/positionals when omitted.
	 */
	helpResource?: string;
	/**
	 * Override the description shown in `c8ctl help` output.
	 * Falls back to `description` when omitted.
	 */
	helpDescription?: string;
	/**
	 * When true, `c8ctl help <verb>` is listed in the footer of main help.
	 * Derived: true for any verb with a showCommandHelp handler.
	 */
	hasDetailedHelp?: boolean;
	/**
	 * Short label for the `c8ctl help <verb>` footer entry.
	 * Defaults to "Show <verb> command with all flags".
	 */
	helpFooterLabel?: string;
	/**
	 * Examples shown in the top-level `c8ctl help` Examples section.
	 * Each entry: { command, description }. Rendered in declaration order.
	 */
	helpExamples?: readonly { command: string; description: string }[];
}

// ─── Resource Aliases ────────────────────────────────────────────────────────

/**
 * Maps short/plural resource names to their canonical singular form.
 * Used by the dispatch layer to normalize user input before lookup.
 */
export const RESOURCE_ALIASES: Record<string, string> = {
	pi: "process-instance",
	"process-instances": "process-instance",
	pd: "process-definition",
	"process-definitions": "process-definition",
	ut: "user-task",
	"user-tasks": "user-task",
	inc: "incident",
	incidents: "incident",
	msg: "message",
	vars: "variable",
	variables: "variable",
	var: "variable",
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
export const GLOBAL_FLAGS = {
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
		agentDescription:
			"Preview the API request that would be sent, without executing it.\nEmits JSON: { dryRun, command, method, url, body }\nAlways exits 0.",
		agentAppliesTo: "all commands",
	},
	verbose: { type: "boolean", description: "Show verbose output" },
	fields: {
		type: "string",
		description: "Comma-separated list of fields to display",
		agentDescription:
			"Comma-separated list of output fields to include.\nReduces context window size when parsing output.\nExample: c8ctl list pi --fields Key,State,processDefinitionId\nCase-insensitive.",
		agentAppliesTo: "all list/search/get commands",
	},
} as const satisfies Record<string, FlagDef>;

/**
 * Flags shared across all search/list commands.
 */
export const SEARCH_FLAGS = {
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
} as const satisfies Record<string, FlagDef>;

// ─── Reusable flag sets ──────────────────────────────────────────────────────

const PI_SEARCH_FLAGS = {
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
	state: {
		type: "string",
		description: "Filter by state (ACTIVE, COMPLETED, etc)",
	},
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
} as const satisfies Record<string, FlagDef>;

const PD_SEARCH_FLAGS = {
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
} as const satisfies Record<string, FlagDef>;

const UT_SEARCH_FLAGS = {
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
} as const satisfies Record<string, FlagDef>;

const INC_SEARCH_FLAGS = {
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
} as const satisfies Record<string, FlagDef>;

const JOB_SEARCH_FLAGS = {
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
} as const satisfies Record<string, FlagDef>;

const VAR_SEARCH_FLAGS = {
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
} as const satisfies Record<string, FlagDef>;

const USER_SEARCH_FLAGS = {
	username: {
		type: "string",
		description: "Filter by username",
		validate: Username.assumeExists,
	},
	name: { type: "string", description: "Filter by name" },
	email: { type: "string", description: "Filter by email" },
} as const satisfies Record<string, FlagDef>;

const ROLE_SEARCH_FLAGS = {
	roleId: { type: "string", description: "Filter by role ID" },
	name: { type: "string", description: "Filter by name" },
} as const satisfies Record<string, FlagDef>;

const GROUP_SEARCH_FLAGS = {
	groupId: { type: "string", description: "Filter by group ID" },
	name: { type: "string", description: "Filter by name" },
} as const satisfies Record<string, FlagDef>;

const TENANT_SEARCH_FLAGS = {
	tenantId: {
		type: "string",
		description: "Filter by tenant ID",
		validate: TenantId.assumeExists,
	},
	name: { type: "string", description: "Filter by name" },
} as const satisfies Record<string, FlagDef>;

const AUTH_SEARCH_FLAGS = {
	ownerId: { type: "string", description: "Filter by owner ID" },
	ownerType: { type: "string", description: "Filter by owner type" },
	resourceType: {
		type: "string",
		description: "Filter by resource type",
	},
	resourceId: { type: "string", description: "Filter by resource ID" },
} as const satisfies Record<string, FlagDef>;

const MR_SEARCH_FLAGS = {
	mappingRuleId: {
		type: "string",
		description: "Filter by mapping rule ID",
	},
	name: { type: "string", description: "Filter by name" },
	claimName: { type: "string", description: "Filter by claim name" },
	claimValue: { type: "string", description: "Filter by claim value" },
} as const satisfies Record<string, FlagDef>;

const ASSIGN_FLAGS = {
	"to-user": { type: "string", description: "Target user ID" },
	"to-group": { type: "string", description: "Target group ID" },
	"to-tenant": { type: "string", description: "Target tenant ID" },
	"to-mapping-rule": {
		type: "string",
		description: "Target mapping rule ID",
	},
} as const satisfies Record<string, FlagDef>;

const UNASSIGN_FLAGS = {
	"from-user": { type: "string", description: "Source user ID" },
	"from-group": { type: "string", description: "Source group ID" },
	"from-tenant": { type: "string", description: "Source tenant ID" },
	"from-mapping-rule": {
		type: "string",
		description: "Source mapping rule ID",
	},
} as const satisfies Record<string, FlagDef>;

const PROFILE_CONNECTION_FLAGS = {
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
} as const satisfies Record<string, FlagDef>;

// ─── Per-resource get flags ──────────────────────────────────────────────────

export const GET_PD_FLAGS = {
	xml: {
		type: "boolean",
		description: "Get BPMN XML (process definitions)",
	},
} as const satisfies Record<string, FlagDef>;

const GET_FORM_FLAGS = {
	userTask: {
		type: "boolean",
		description: "Get form for user task",
	},
	ut: {
		type: "boolean",
		description: "Alias for --userTask",
	},
	processDefinition: {
		type: "boolean",
		description: "Get form for process definition",
	},
	pd: {
		type: "boolean",
		description: "Alias for --processDefinition",
	},
} as const satisfies Record<string, FlagDef>;

const GET_PI_FLAGS = {
	variables: {
		type: "boolean",
		description: "Include variables in output",
	},
} as const satisfies Record<string, FlagDef>;

// ─── Per-resource get positionals ────────────────────────────────────────────

export const GET_PD_POSITIONALS = [
	{
		name: "key",
		required: true,
		validate: ProcessDefinitionKey.assumeExists,
	},
] as const satisfies readonly PositionalDef[];

const GET_PI_POSITIONALS = [
	{
		name: "key",
		required: true,
		validate: ProcessInstanceKey.assumeExists,
	},
] as const satisfies readonly PositionalDef[];

const GET_INCIDENT_POSITIONALS = [
	{
		name: "key",
		required: true,
		validate: IncidentKey.assumeExists,
	},
] as const satisfies readonly PositionalDef[];

const GET_USER_POSITIONALS = [
	{
		name: "username",
		required: true,
		validate: Username.assumeExists,
	},
] as const satisfies readonly PositionalDef[];

const GET_ROLE_POSITIONALS = [
	{ name: "roleId", required: true },
] as const satisfies readonly PositionalDef[];

const GET_GROUP_POSITIONALS = [
	{ name: "groupId", required: true },
] as const satisfies readonly PositionalDef[];

const GET_TENANT_POSITIONALS = [
	{
		name: "tenantId",
		required: true,
		validate: TenantId.assumeExists,
	},
] as const satisfies readonly PositionalDef[];

const GET_AUTHORIZATION_POSITIONALS = [
	{
		name: "authorizationKey",
		required: true,
		validate: AuthorizationKey.assumeExists,
	},
] as const satisfies readonly PositionalDef[];

const GET_MAPPING_RULE_POSITIONALS = [
	{ name: "mappingRuleId", required: true },
] as const satisfies readonly PositionalDef[];

const GET_FORM_POSITIONALS = [
	{ name: "key", required: true },
] as const satisfies readonly PositionalDef[];

// ─── Command Registry ────────────────────────────────────────────────────────

export const COMMAND_REGISTRY = {
	// ── Read commands ──────────────────────────────────────────────────────

	list: {
		description: "List resources (process, identity)",
		helpDescription: "List resources",
		hasDetailedHelp: true,
		helpFooterLabel: "Show all list resources and their flags",
		mutating: false,
		requiresResource: true,
		helpExamples: [
			{ command: "c8ctl list pi", description: "List process instances" },
			{ command: "c8ctl list pd", description: "List process definitions" },
			{ command: "c8ctl list users", description: "List users" },
		],
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
		// Verb-level `flags` holds only genuinely shared flags. Per-resource
		// flags live exclusively in `resourceFlags` so unknown-flag detection
		// warns when (e.g.) `--processDefinitionId` is passed against a
		// non-PD resource (#256). The flag is still parsed by `parseArgs`
		// (see `deriveParseArgsOptions`, which iterates `resourceFlags` too)
		// and the value is ignored — the warning is the user-facing signal.
		flags: {
			all: {
				type: "boolean",
				description: "List all (disable pagination limit)",
			},
			...SEARCH_FLAGS,
		},
		resourceFlags: {
			"process-definition": PD_SEARCH_FLAGS,
			"process-instance": PI_SEARCH_FLAGS,
			"user-task": UT_SEARCH_FLAGS,
			incident: INC_SEARCH_FLAGS,
			jobs: JOB_SEARCH_FLAGS,
			user: USER_SEARCH_FLAGS,
			role: ROLE_SEARCH_FLAGS,
			group: GROUP_SEARCH_FLAGS,
			tenant: TENANT_SEARCH_FLAGS,
			authorization: AUTH_SEARCH_FLAGS,
			"mapping-rule": MR_SEARCH_FLAGS,
		},
	},

	search: {
		description: "Search resources with filters",
		helpDescription:
			"Search resources with filters (wildcards, date ranges, case-insensitive)",
		hasDetailedHelp: true,
		helpFooterLabel: "Show all search resources and their flags",
		mutating: false,
		requiresResource: true,
		helpExamples: [
			{
				command: "c8ctl search pi --state=ACTIVE",
				description: "Search for active process instances",
			},
			{
				command: "c8ctl search pd --bpmnProcessId=myProcess",
				description: "Search process definitions by ID",
			},
			{
				command: "c8ctl search pd --name='*main*'",
				description: "Search process definitions with wildcard",
			},
			{
				command: "c8ctl search ut --assignee=john",
				description: "Search user tasks assigned to john",
			},
			{
				command: "c8ctl search inc --state=ACTIVE",
				description: "Search for active incidents",
			},
			{
				command: "c8ctl search jobs --type=myJobType",
				description: "Search jobs by type",
			},
			{
				command: "c8ctl search jobs --type='*service*'",
				description: 'Search jobs with type containing "service"',
			},
			{
				command: "c8ctl search variables --name=myVar",
				description: "Search for variables by name",
			},
			{
				command: "c8ctl search variables --value=foo",
				description: "Search for variables by value",
			},
			{
				command: "c8ctl search variables --processInstanceKey=123 --fullValue",
				description: "Search variables with full values",
			},
			{
				command: "c8ctl search pd --iname='*order*'",
				description: "Case-insensitive search by name",
			},
			{
				command: "c8ctl search ut --iassignee=John",
				description: "Case-insensitive search by assignee",
			},
		],
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
		// Verb-level `flags` holds only genuinely shared flags. Per-resource
		// flags live exclusively in `resourceFlags` so unknown-flag detection
		// warns when (e.g.) `--processDefinitionId` is passed against a
		// non-PD resource (#256). The flag is still parsed by `parseArgs`
		// (see `deriveParseArgsOptions`, which iterates `resourceFlags` too)
		// and the value is ignored — the warning is the user-facing signal.
		flags: {
			...SEARCH_FLAGS,
		},
		resourceFlags: {
			"process-definition": PD_SEARCH_FLAGS,
			"process-instance": PI_SEARCH_FLAGS,
			"user-task": UT_SEARCH_FLAGS,
			incident: INC_SEARCH_FLAGS,
			jobs: JOB_SEARCH_FLAGS,
			variable: VAR_SEARCH_FLAGS,
			user: USER_SEARCH_FLAGS,
			role: ROLE_SEARCH_FLAGS,
			group: GROUP_SEARCH_FLAGS,
			tenant: TENANT_SEARCH_FLAGS,
			authorization: AUTH_SEARCH_FLAGS,
			"mapping-rule": MR_SEARCH_FLAGS,
		},
	},

	get: {
		description: "Get resource by key",
		helpDescription: "Get a resource by key",
		hasDetailedHelp: true,
		helpFooterLabel: "Show all get resources and their flags",
		mutating: false,
		requiresResource: true,
		helpExamples: [
			{
				command: "c8ctl get pi 123456",
				description: "Get process instance by key",
			},
			{
				command: "c8ctl get pi 123456 --variables",
				description: "Get process instance with variables",
			},
			{
				command: "c8ctl get pd 123456",
				description: "Get process definition by key",
			},
			{
				command: "c8ctl get pd 123456 --xml",
				description: "Get process definition XML",
			},
			{
				command: "c8ctl get form 123456",
				description:
					"Get form (searches both user task and process definition)",
			},
			{
				command: "c8ctl get form 123456 --ut",
				description: "Get form for user task only",
			},
			{
				command: "c8ctl get form 123456 --pd",
				description: "Get start form for process definition only",
			},
			{ command: "c8ctl get user john", description: "Get user by username" },
		],
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
		// Verb-level `flags` holds only genuinely shared flags. Per-resource
		// flags live exclusively in `resourceFlags` so unknown-flag detection
		// warns when (e.g.) `--xml` is passed against a non-PD resource
		// (#256). The flag is still parsed by `parseArgs` (see
		// `deriveParseArgsOptions`, which iterates `resourceFlags` too) and
		// the value is ignored — the warning is the user-facing signal.
		flags: {},
		resourceFlags: {
			"process-definition": GET_PD_FLAGS,
			form: GET_FORM_FLAGS,
			"process-instance": GET_PI_FLAGS,
		},
		resourcePositionals: {
			"process-definition": GET_PD_POSITIONALS,
			"process-instance": GET_PI_POSITIONALS,
			incident: GET_INCIDENT_POSITIONALS,
			user: GET_USER_POSITIONALS,
			role: GET_ROLE_POSITIONALS,
			group: GET_GROUP_POSITIONALS,
			tenant: GET_TENANT_POSITIONALS,
			authorization: GET_AUTHORIZATION_POSITIONALS,
			"mapping-rule": GET_MAPPING_RULE_POSITIONALS,
			form: GET_FORM_POSITIONALS,
		},
	},

	// ── Mutating commands ──────────────────────────────────────────────────

	create: {
		description: "Create resource",
		helpDescription: "Create a resource (process instance, identity)",
		hasDetailedHelp: true,
		helpFooterLabel: "Show all create resources and their flags",
		mutating: true,
		requiresResource: true,
		helpExamples: [
			{
				command: "c8ctl create pi --id=myProcess",
				description: "Create a process instance",
			},
			{
				command: "c8ctl create pi --id=myProcess --awaitCompletion",
				description: "Create and await completion",
			},
			{
				command:
					"c8ctl create user --username=john --name='John Doe' --email=john@example.com --password=secret",
				description: "Create a user",
			},
		],
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
			// Identity mapping rule
			mappingRuleId: {
				type: "string",
				description: "Mapping rule ID",
			},
			claimName: { type: "string", description: "Claim name" },
			claimValue: { type: "string", description: "Claim value" },
		},
		// Resource-scoped flags: the authorization-specific flags below are
		// only required when creating an authorization. Declaring them at the
		// verb level would force every `create <resource>` invocation to
		// supply them (see #308 — required-flag enforcement).
		resourceFlags: {
			authorization: {
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
			},
		},
	},

	delete: {
		description: "Delete resource",
		helpDescription: "Delete a resource by key",
		helpResource: "<resource> <key>",
		hasDetailedHelp: true,
		helpFooterLabel: "Show delete command with all flags",
		mutating: true,
		requiresResource: true,
		helpExamples: [
			{ command: "c8ctl delete user john", description: "Delete user" },
		],
		resources: ["user", "role", "group", "tenant", "auth", "mapping-rule"],
		flags: {},
		resourcePositionals: {
			user: GET_USER_POSITIONALS,
			role: GET_ROLE_POSITIONALS,
			group: GET_GROUP_POSITIONALS,
			tenant: GET_TENANT_POSITIONALS,
			authorization: GET_AUTHORIZATION_POSITIONALS,
			"mapping-rule": GET_MAPPING_RULE_POSITIONALS,
		},
	},

	cancel: {
		description: "Cancel resource",
		helpDescription: "Cancel a process instance",
		helpResource: "<resource> <key>",
		hasDetailedHelp: true,
		helpFooterLabel: "Show cancel command with all flags",
		mutating: true,
		requiresResource: true,
		resources: ["pi"],
		flags: {},
		resourcePositionals: {
			"process-instance": GET_PI_POSITIONALS,
		},
	},

	await: {
		description:
			"Create and await completion (alias for create --awaitCompletion)",
		helpDescription:
			"Create and await process instance completion (server-side waiting)",
		helpResource: "<resource>",
		hasDetailedHelp: true,
		helpFooterLabel: "Show await command with all flags",
		mutating: true,
		requiresResource: true,
		helpExamples: [
			{
				command: "c8ctl await pi --id=myProcess",
				description: "Create and wait for completion",
			},
		],
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
		helpDescription: "Complete a user task or job",
		helpResource: "<resource> <key>",
		hasDetailedHelp: true,
		helpFooterLabel: "Show all complete resources and their flags",
		mutating: true,
		requiresResource: true,
		resources: ["ut", "job"],
		flags: {
			variables: { type: "string", description: "JSON variables" },
		},
		resourcePositionals: {
			"user-task": [
				{
					name: "key",
					required: true,
					validate: UserTaskKey.assumeExists,
				},
			] as const satisfies readonly PositionalDef[],
			job: [
				{
					name: "key",
					required: true,
					validate: JobKey.assumeExists,
				},
			] as const satisfies readonly PositionalDef[],
		},
	},

	fail: {
		description: "Fail a job",
		helpDescription:
			"Mark a job as failed with optional error message and retry count",
		hasDetailedHelp: true,
		helpFooterLabel: "Show fail command with all flags",
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
		resourcePositionals: {
			job: [
				{
					name: "key",
					required: true,
					validate: JobKey.assumeExists,
				},
			] as const satisfies readonly PositionalDef[],
		},
	},

	activate: {
		description: "Activate jobs by type",
		helpDescription: "Activate jobs of a specific type for processing",
		hasDetailedHelp: true,
		helpFooterLabel: "Show activate command with all flags",
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
		resourcePositionals: {
			jobs: [
				{ name: "type", required: true },
			] as const satisfies readonly PositionalDef[],
		},
	},

	resolve: {
		description: "Resolve incident",
		helpDescription:
			"Resolve an incident (marks resolved, allows process to continue)",
		hasDetailedHelp: true,
		helpFooterLabel: "Show resolve command with all flags",
		mutating: true,
		requiresResource: true,
		resources: ["inc"],
		flags: {},
		resourcePositionals: {
			incident: GET_INCIDENT_POSITIONALS,
		},
	},

	publish: {
		description: "Publish message",
		helpDescription: "Publish a message for message correlation",
		hasDetailedHelp: true,
		helpFooterLabel: "Show publish command with all flags",
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
		resourcePositionals: {
			message: [
				{ name: "name", required: true },
			] as const satisfies readonly PositionalDef[],
		},
	},

	correlate: {
		description: "Correlate message",
		helpDescription: "Correlate a message to a specific process instance",
		hasDetailedHelp: true,
		helpFooterLabel: "Show correlate command with all flags",
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
		resourcePositionals: {
			message: [
				{ name: "name", required: true },
			] as const satisfies readonly PositionalDef[],
		},
	},

	set: {
		description: "Set variables on an element instance",
		helpDescription:
			"Set variables on an element instance (process instance or flow element scope). Variables are propagated to the outermost scope by default; use --local to restrict to the specified scope.",
		helpResource: "variable <key>",
		hasDetailedHelp: true,
		helpFooterLabel: "Show set command with all flags",
		mutating: true,
		requiresResource: true,
		helpExamples: [
			{
				command:
					'c8ctl set variable 2251799813685249 --variables=\'{"status":"approved"}\'',
				description: "Set variables on a process instance",
			},
			{
				command:
					"c8ctl set variable 2251799813685249 --variables='{\"x\":1}' --local",
				description: "Set variables in local scope only",
			},
		],
		resources: ["variable"],
		flags: {
			variables: {
				type: "string",
				description: "JSON object of variables to set (required)",
				required: true,
			},
			local: {
				type: "boolean",
				description:
					"Set variables in local scope only (default: propagate to outermost scope)",
			},
		},
		resourcePositionals: {
			variable: [
				{
					name: "key",
					required: true,
					validate: ElementInstanceKey.assumeExists,
				},
			] as const satisfies readonly PositionalDef[],
		},
	},

	deploy: {
		description: "Deploy resources",
		helpDescription:
			"Deploy files to Camunda (auto-discovers deployable files in directories)",
		helpResource: "[path...]",
		hasDetailedHelp: true,
		helpFooterLabel: "Show deploy command with all flags",
		mutating: true,
		requiresResource: false,
		helpExamples: [
			{
				command: "c8ctl deploy ./my-process.bpmn",
				description: "Deploy a BPMN file",
			},
		],
		resources: [],
		flags: {
			force: {
				type: "boolean",
				description:
					"Deploy any file type, ignoring the default extension allow-list",
			},
		},
	},

	run: {
		description: "Deploy and start process",
		helpDescription: "Deploy and start a process instance from a BPMN file",
		helpResource: "<path>",
		hasDetailedHelp: true,
		helpFooterLabel: "Show run command with all flags",
		mutating: true,
		requiresResource: true,
		helpExamples: [
			{
				command: "c8ctl run ./my-process.bpmn",
				description: "Deploy and start process",
			},
		],
		resources: [],
		flags: {
			variables: { type: "string", description: "JSON variables" },
			force: {
				type: "boolean",
				description:
					"Deploy any file type, ignoring the default extension allow-list",
			},
		},
	},

	// ── Assignment commands ────────────────────────────────────────────────

	assign: {
		description: "Assign resource to target",
		helpDescription:
			"Assign a resource to a target (--to-user, --to-group, etc.)",
		helpResource: "<resource> <id>",
		hasDetailedHelp: true,
		helpFooterLabel: "Show assign command with all flags",
		mutating: true,
		requiresResource: true,
		helpExamples: [
			{
				command: "c8ctl assign role admin --to-user=john",
				description: "Assign role to user",
			},
		],
		resources: ["role", "user", "group", "mapping-rule"],
		flags: { ...ASSIGN_FLAGS },
		resourcePositionals: {
			role: GET_ROLE_POSITIONALS,
			user: GET_USER_POSITIONALS,
			group: GET_GROUP_POSITIONALS,
			"mapping-rule": GET_MAPPING_RULE_POSITIONALS,
		},
	},

	unassign: {
		description: "Unassign resource from target",
		helpDescription:
			"Unassign a resource from a target (--from-user, --from-group, etc.)",
		helpResource: "<resource> <id>",
		hasDetailedHelp: true,
		helpFooterLabel: "Show unassign command with all flags",
		mutating: true,
		requiresResource: true,
		helpExamples: [
			{
				command: "c8ctl unassign role admin --from-user=john",
				description: "Unassign role from user",
			},
		],
		resources: ["role", "user", "group", "mapping-rule"],
		flags: { ...UNASSIGN_FLAGS },
		resourcePositionals: {
			role: GET_ROLE_POSITIONALS,
			user: GET_USER_POSITIONALS,
			group: GET_GROUP_POSITIONALS,
			"mapping-rule": GET_MAPPING_RULE_POSITIONALS,
		},
	},

	// ── Operational commands ───────────────────────────────────────────────

	watch: {
		description: "Watch files for changes and auto-deploy",
		helpDescription: "Watch files for changes and auto-deploy",
		helpResource: "[path...]",
		hasDetailedHelp: true,
		helpFooterLabel: "Show watch command with all flags",
		mutating: false,
		requiresResource: false,
		helpExamples: [
			{
				command: "c8ctl watch ./src",
				description: "Watch directory for changes",
			},
		],
		resources: [],
		flags: {
			force: {
				type: "boolean",
				description: "Continue watching after all deployment errors",
			},
			extensions: {
				type: "string",
				description:
					"Comma-separated list of file extensions to watch (e.g. .bpmn,.dmn,.form)",
			},
		},
		aliases: ["w"],
	},

	open: {
		description: "Open Camunda web application in browser",
		helpDescription: "Open Camunda web app in browser",
		helpResource: "<app>",
		hasDetailedHelp: true,
		helpFooterLabel: "Show open command with all apps",
		mutating: false,
		requiresResource: true,
		helpExamples: [
			{
				command: "c8ctl open operate",
				description: "Open Camunda Operate in browser",
			},
			{
				command: "c8ctl open tasklist",
				description: "Open Camunda Tasklist in browser",
			},
			{
				command: "c8ctl open operate --profile=prod",
				description: "Open Operate using a specific profile",
			},
		],
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
		resourcePositionals: {
			profile: [
				{ name: "name", required: true },
			] as const satisfies readonly PositionalDef[],
		},
	},

	remove: {
		description: "Remove a profile or plugin",
		helpResource: "profile <name>",
		helpDescription: "Remove a profile (alias: rm)",
		mutating: false,
		requiresResource: true,
		resources: ["profile", "plugin"],
		flags: {
			none: {
				type: "boolean",
				description: "Clear active profile",
			},
		},
		aliases: ["rm"],
		resourcePositionals: {
			profile: [
				{ name: "name", required: true },
			] as const satisfies readonly PositionalDef[],
			plugin: [
				{ name: "package", required: true },
			] as const satisfies readonly PositionalDef[],
		},
	},

	load: {
		description: "Load a c8ctl plugin",
		helpResource: "plugin [name|--from url]",
		helpDescription: "Load a c8ctl plugin (npm registry or URL)",
		mutating: false,
		requiresResource: true,
		helpExamples: [
			{
				command: "c8ctl load plugin my-plugin",
				description: "Load plugin from npm registry",
			},
			{
				command: "c8ctl load plugin --from https://github.com/org/plugin",
				description: "Load plugin from URL",
			},
		],
		resources: ["plugin"],
		flags: {
			from: {
				type: "string",
				description: "Load plugin from URL",
			},
		},
		resourcePositionals: {
			plugin: [
				{ name: "package", required: false },
			] as const satisfies readonly PositionalDef[],
		},
	},

	unload: {
		description: "Unload a c8ctl plugin",
		helpResource: "plugin <name>",
		helpDescription: "Unload a c8ctl plugin (npm uninstall wrapper)",
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
		resourcePositionals: {
			plugin: [
				{ name: "package", required: true },
			] as const satisfies readonly PositionalDef[],
		},
	},

	upgrade: {
		description: "Upgrade a plugin",
		helpResource: "plugin <name> [version]",
		helpDescription: "Upgrade a plugin (respects source type)",
		mutating: false,
		requiresResource: true,
		helpExamples: [
			{
				command: "c8ctl upgrade plugin my-plugin",
				description: "Upgrade plugin to latest version",
			},
			{
				command: "c8ctl upgrade plugin my-plugin 1.2.3",
				description: "Upgrade plugin to a specific version (source-aware)",
			},
		],
		resources: ["plugin"],
		flags: {},
		resourcePositionals: {
			plugin: [
				{ name: "package", required: true },
				{ name: "version", required: false },
			] as const satisfies readonly PositionalDef[],
		},
	},

	downgrade: {
		description: "Downgrade a plugin to a specific version",
		helpResource: "plugin <name> <version>",
		mutating: false,
		requiresResource: true,
		resources: ["plugin"],
		flags: {},
		resourcePositionals: {
			plugin: [
				{ name: "package", required: true },
				{ name: "version", required: true },
			] as const satisfies readonly PositionalDef[],
		},
	},

	sync: {
		description: "Synchronize plugins",
		helpDescription: "Synchronize plugins from registry (rebuild/reinstall)",
		mutating: false,
		requiresResource: true,
		helpExamples: [
			{ command: "c8ctl sync plugin", description: "Synchronize plugins" },
		],
		resources: ["plugin"],
		flags: {},
	},

	init: {
		description: "Create a new plugin from TypeScript template",
		mutating: false,
		requiresResource: true,
		helpExamples: [
			{
				command: "c8ctl init plugin my-plugin",
				description: "Create new plugin from template (c8ctl-plugin-my-plugin)",
			},
		],
		resources: ["plugin"],
		flags: {},
		resourcePositionals: {
			plugin: [
				{ name: "name", required: false },
			] as const satisfies readonly PositionalDef[],
		},
	},

	// ── Session commands ───────────────────────────────────────────────────

	use: {
		description: "Set active profile or tenant",
		helpResource: "profile|tenant",
		mutating: false,
		requiresResource: true,
		helpExamples: [
			{ command: "c8ctl use profile prod", description: "Set active profile" },
		],
		resources: ["profile", "tenant"],
		flags: {
			none: {
				type: "boolean",
				description: "Clear active profile/tenant",
			},
		},
		resourcePositionals: {
			profile: [
				{ name: "name", required: false },
			] as const satisfies readonly PositionalDef[],
			tenant: [
				{ name: "tenantId", required: true },
			] as const satisfies readonly PositionalDef[],
		},
	},

	output: {
		description: "Show or set output format",
		helpResource: "[json|text]",
		mutating: false,
		requiresResource: false,
		helpExamples: [
			{ command: "c8ctl output json", description: "Switch to JSON output" },
		],
		resources: ["json", "text"],
		flags: {},
	},

	// ── Utility commands ───────────────────────────────────────────────────

	completion: {
		description: "Generate shell completion script",
		helpResource: "bash|zsh|fish|install",
		mutating: true,
		requiresResource: false,
		helpExamples: [
			{
				command: "c8ctl completion bash",
				description: "Generate bash completion script",
			},
			{
				command: "c8ctl completion install",
				description:
					"Auto-detect shell and install completions (auto-refreshes on upgrade)",
			},
			{
				command: "c8ctl completion install --shell zsh",
				description: "Install completions for a specific shell",
			},
		],
		resources: ["bash", "zsh", "fish", "install"],
		// `--shell` only applies to `completion install` — declared once in
		// `resourceFlags.install` so it triggers an unknown-flag warning when
		// passed to other resources (e.g. `completion zsh --shell bash`).
		// This is the original #256 defect class. `parseArgs` still accepts
		// the flag globally via `deriveParseArgsOptions` iterating
		// `resourceFlags`, and the value is ignored on non-install branches
		// of `completionCommand` — the warning is the user-facing signal.
		flags: {},
		resourceFlags: {
			install: {
				shell: {
					type: "string" as const,
					description: "Shell to install completions for (bash, zsh, fish)",
				},
			},
		},
	},

	"mcp-proxy": {
		description: "Start a STDIO to remote HTTP MCP proxy server",
		helpDescription:
			"Start a STDIO MCP proxy (bridges local MCP clients to remote Camunda 8)",
		helpResource: "[mcp-path]",
		hasDetailedHelp: true,
		helpFooterLabel: "Show mcp-proxy setup and usage",
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
		helpResource: "[command]",
		helpDescription: "Show help (run 'c8ctl help <command>' for details)",
		mutating: false,
		requiresResource: false,
		resources: [],
		flags: {},
		aliases: ["menu"],
	},

	which: {
		description: "Show active profile",
		mutating: false,
		requiresResource: true,
		helpExamples: [
			{
				command: "c8ctl which profile",
				description: "Show currently active profile",
			},
		],
		resources: ["profile"],
		flags: {},
	},
} satisfies Record<string, CommandDef>;

/** Union of all known verb names, derived from COMMAND_REGISTRY keys. */
export type Verb = keyof typeof COMMAND_REGISTRY;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Maps verb aliases to their canonical verb names.
 * Built from COMMAND_REGISTRY aliases fields.
 * e.g. { "rm": ["remove", "unload"], "w": ["watch"] }
 */
export const VERB_ALIASES: Record<string, string[]> = (() => {
	const map: Record<string, string[]> = {};
	// biome-ignore lint/plugin: widen to CommandDef to access optional aliases property
	for (const [verb, def] of Object.entries(COMMAND_REGISTRY) as [
		string,
		CommandDef,
	][]) {
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
	// biome-ignore lint/plugin: trust boundary — verb is unvalidated CLI input, must index dynamically
	const direct = (COMMAND_REGISTRY as Record<string, CommandDef>)[verb];
	if (direct) return direct;
	const targets = VERB_ALIASES[verb];
	return targets
		? // biome-ignore lint/plugin: trust boundary — alias target is a dynamic string
			(COMMAND_REGISTRY as Record<string, CommandDef>)[targets[0]]
		: undefined;
}

/**
 * Get all flags accepted for a given verb, including global flags and any
 * resource-scoped flags declared under `resourceFlags`.
 */
export function getAcceptedFlags(
	verb: string,
): Record<string, FlagDef> | undefined {
	const def = getCommandDef(verb);
	if (!def) return undefined;
	const merged: Record<string, FlagDef> = { ...GLOBAL_FLAGS, ...def.flags };
	if (def.resourceFlags) {
		for (const rFlags of Object.values(def.resourceFlags)) {
			Object.assign(merged, rFlags);
		}
	}
	return merged;
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
 *
 * When the same flag name appears with different types across commands
 * (e.g. `--variables` is boolean for `get pi` but string for `create pi`),
 * "string" wins because parseArgs with `type: "string"` can accept any
 * value, whereas `type: "boolean"` would discard the string payload.
 */
export function deriveParseArgsOptions(): Record<
	string,
	{ type: "string" | "boolean"; short?: string }
> {
	const options: Record<
		string,
		{ type: "string" | "boolean"; short?: string }
	> = {};

	function addFlags(flags: Record<string, FlagDef>): void {
		for (const [name, def] of Object.entries(flags)) {
			const existing = options[name];
			if (!existing) {
				options[name] = {
					type: def.type,
					...(def.short && { short: def.short }),
				};
			} else {
				// String is more permissive — upgrade when any usage is string
				if (def.type === "string") existing.type = "string";
				if (def.short && !existing.short) existing.short = def.short;
			}
		}
	}

	// Global flags
	addFlags(GLOBAL_FLAGS);

	// Search flags
	addFlags(SEARCH_FLAGS);

	// All command-specific flags
	for (const cmd of Object.values(COMMAND_REGISTRY)) {
		addFlags(cmd.flags);
		// Include resource-specific flags so parseArgs can parse them
		if ("resourceFlags" in cmd && cmd.resourceFlags) {
			for (const rFlags of Object.values(cmd.resourceFlags)) {
				addFlags(rFlags);
			}
		}
	}

	return options;
}
