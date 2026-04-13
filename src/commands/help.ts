/**
 * Help and version commands
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLogger } from '../logger.ts';
import { getPluginCommandsInfo, type PluginCommandInfo } from '../plugin-loader.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Build structured JSON help data for machine/agent consumption.
 * Returned by showHelp() and showCommandHelp() in JSON output mode.
 */
function buildHelpJson(version: string, pluginCommandsInfo: PluginCommandInfo[]): object {
  return {
    version,
    usage: 'c8ctl <command> [resource] [options]',
    commands: [
      { verb: 'list',      resource: '<resource>',       resources: ['pi','pd','ut','inc','jobs','profiles','plugins','users','roles','groups','tenants','auth','mapping-rules'], description: 'List resources (process, identity)', mutating: false },
      { verb: 'search',    resource: '<resource>',       resources: ['pi','pd','ut','inc','jobs','vars','users','roles','groups','tenants','auth','mapping-rules'], description: 'Search resources with filters', mutating: false },
      { verb: 'get',       resource: '<resource> <key>', resources: ['pi','pd','inc','topology','form','user','role','group','tenant','auth','mapping-rule'],  description: 'Get resource by key', mutating: false },
      { verb: 'create',    resource: '<resource>',       resources: ['pi','user','role','group','tenant','auth','mapping-rule'], description: 'Create resource', mutating: true },
      { verb: 'delete',    resource: '<resource> <key>', resources: ['user','role','group','tenant','auth','mapping-rule'], description: 'Delete resource', mutating: true },
      { verb: 'assign',    resource: '<resource> <id> --to-<target>=<id>', resources: ['role','user','group','mapping-rule'], description: 'Assign resource to target', mutating: true },
      { verb: 'unassign',  resource: '<resource> <id> --from-<target>=<id>', resources: ['role','user','group','mapping-rule'], description: 'Unassign resource from target', mutating: true },
      { verb: 'cancel',    resource: '<resource> <key>', resources: ['pi'], description: 'Cancel resource', mutating: true },
      { verb: 'await',     resource: '<resource>',       resources: ['pi'], description: 'Create and await completion (alias for create --awaitCompletion)', mutating: true },
      { verb: 'complete',  resource: '<resource> <key>', resources: ['ut','job'], description: 'Complete resource', mutating: true },
      { verb: 'fail',      resource: 'job <key>',        resources: ['job'], description: 'Fail a job', mutating: true },
      { verb: 'activate',  resource: 'jobs <type>',      resources: ['jobs'], description: 'Activate jobs by type', mutating: true },
      { verb: 'resolve',   resource: 'inc <key>',        resources: ['inc'], description: 'Resolve incident', mutating: true },
      { verb: 'publish',   resource: 'msg <name>',       resources: ['msg'], description: 'Publish message', mutating: true },
      { verb: 'correlate', resource: 'msg <name>',       resources: ['msg'], description: 'Correlate message', mutating: true },
      { verb: 'deploy',    resource: '[path...]',        resources: [], description: 'Deploy BPMN/DMN/forms', mutating: true },
      { verb: 'run',       resource: '<path>',           resources: [], description: 'Deploy and start process', mutating: true },
      { verb: 'watch',     resource: '[path...]',        resources: [], description: 'Watch files for changes and auto-deploy', mutating: false },
      { verb: 'open',      resource: '<app>',            resources: ['operate','tasklist','modeler','optimize'], description: 'Open Camunda web application in browser', mutating: false },
      { verb: 'add',       resource: 'profile <name>',   resources: ['profile'], description: 'Add a profile', mutating: false },
      { verb: 'remove',    resource: 'profile <name>',   resources: ['profile'], description: 'Remove a profile (alias: rm)', mutating: false },
      { verb: 'load',      resource: 'plugin <name>',    resources: ['plugin'], description: 'Load a c8ctl plugin', mutating: false },
      { verb: 'unload',    resource: 'plugin <name>',    resources: ['plugin'], description: 'Unload a c8ctl plugin', mutating: false },
      { verb: 'upgrade',   resource: 'plugin <name>',    resources: ['plugin'], description: 'Upgrade a plugin', mutating: false },
      { verb: 'downgrade', resource: 'plugin <name> <version>', resources: ['plugin'], description: 'Downgrade a plugin to a specific version', mutating: false },
      { verb: 'sync',      resource: 'plugin',           resources: ['plugin'], description: 'Synchronize plugins', mutating: false },
      { verb: 'init',      resource: 'plugin [name]', resources: ['plugin'], description: 'Create a new plugin from TypeScript template', mutating: false },
      { verb: 'use',       resource: 'profile|tenant',   resources: ['profile','tenant'], description: 'Set active profile or tenant', mutating: false },
      { verb: 'output',    resource: '[json|text]',      resources: ['json','text'], description: 'Show or set output format', mutating: false },
      { verb: 'completion',resource: 'bash|zsh|fish',    resources: ['bash','zsh','fish'], description: 'Generate shell completion script', mutating: false },
      { verb: 'mcp-proxy', resource: '[mcp-path]',       resources: [], description: 'Start a STDIO to remote HTTP MCP proxy server', mutating: false },
      { verb: 'feedback', resource: '',                resources: [], description: 'Open the feedback page to report issues or request features', mutating: false },
      { verb: 'help',      resource: '[command]',        resources: [], description: 'Show help', mutating: false },
      ...pluginCommandsInfo.map(cmd => ({
        verb: cmd.commandName, resource: '', resources: [], description: cmd.description || '', mutating: false,
        examples: cmd.examples || [],
      })),
    ],
    resourceAliases: {
      pi: 'process-instance(s)',
      pd: 'process-definition(s)',
      ut: 'user-task(s)',
      inc: 'incident(s)',
      msg: 'message',
      vars: 'variable(s)',
      auth: 'authorization(s)',
      mr: 'mapping-rule(s)',
    },
    globalFlags: [
      { flag: '--profile', type: 'string', description: 'Use specific profile for this command' },
      { flag: '--sortBy',  type: 'string', description: 'Sort list/search output by column name' },
      { flag: '--asc',     type: 'boolean', description: 'Sort in ascending order (default)' },
      { flag: '--desc',    type: 'boolean', description: 'Sort in descending order' },
      { flag: '--limit',   type: 'string', description: 'Maximum number of items to fetch (default: 1000000)' },
      { flag: '--between', type: 'string', description: 'Filter by date range: <from>..<to> (YYYY-MM-DD or ISO 8601; open-ended: ..to or from..)' },
      { flag: '--dateField', type: 'string', description: 'Date field to filter on with --between (default depends on resource)' },
      { flag: '--state',   type: 'string', description: 'Filter by state (ACTIVE, COMPLETED, etc.)' },
      { flag: '--id',      type: 'string', description: 'Process definition ID (alias for --bpmnProcessId)' },
      { flag: '--verbose', type: 'boolean', description: 'Enable SDK trace logging and show full error details' },
      { flag: '--version', type: 'string', short: '-v', description: 'Show version' },
      { flag: '--help',    type: 'boolean', short: '-h', description: 'Show help' },
    ],
    searchFlags: [
      { flag: '--bpmnProcessId',           type: 'string',  description: 'Filter by process definition ID' },
      { flag: '--processDefinitionKey',    type: 'string',  description: 'Filter by process definition key' },
      { flag: '--processInstanceKey',      type: 'string',  description: 'Filter by process instance key' },
      { flag: '--parentProcessInstanceKey',type: 'string',  description: 'Filter by parent process instance key' },
      { flag: '--name',                    type: 'string',  description: 'Filter by name (variables, process definitions); supports wildcards * and ?' },
      { flag: '--key',                     type: 'string',  description: 'Filter by key' },
      { flag: '--assignee',                type: 'string',  description: 'Filter by assignee (user tasks)' },
      { flag: '--elementId',               type: 'string',  description: 'Filter by element ID (user tasks)' },
      { flag: '--errorType',               type: 'string',  description: 'Filter by error type (incidents)' },
      { flag: '--errorMessage',            type: 'string',  description: 'Filter by error message (incidents); supports wildcards' },
      { flag: '--type',                    type: 'string',  description: 'Filter by type (jobs); supports wildcards' },
      { flag: '--value',                   type: 'string',  description: 'Filter by variable value' },
      { flag: '--scopeKey',                type: 'string',  description: 'Filter by scope key (variables)' },
      { flag: '--fullValue',               type: 'boolean', description: 'Return full variable values (default: truncated)' },
      { flag: '--iname',                   type: 'string',  description: 'Case-insensitive --name filter (supports wildcards)' },
      { flag: '--iid',                     type: 'string',  description: 'Case-insensitive --bpmnProcessId filter' },
      { flag: '--iassignee',               type: 'string',  description: 'Case-insensitive --assignee filter' },
      { flag: '--ierrorMessage',           type: 'string',  description: 'Case-insensitive --errorMessage filter' },
      { flag: '--itype',                   type: 'string',  description: 'Case-insensitive --type filter' },
      { flag: '--ivalue',                  type: 'string',  description: 'Case-insensitive --value filter' },
      { flag: '--username',                type: 'string',  description: 'Filter by username (users)' },
      { flag: '--email',                   type: 'string',  description: 'Filter by email (users)' },
      { flag: '--roleId',                  type: 'string',  description: 'Filter by role ID (roles)' },
      { flag: '--groupId',                 type: 'string',  description: 'Filter by group ID (groups)' },
      { flag: '--ownerId',                 type: 'string',  description: 'Filter by owner ID (authorizations)' },
      { flag: '--ownerType',               type: 'string',  description: 'Filter by owner type (authorizations)' },
      { flag: '--resourceType',            type: 'string',  description: 'Filter by resource type (authorizations)' },
      { flag: '--resourceId',              type: 'string',  description: 'Filter by resource ID (authorizations)' },
      { flag: '--claimName',               type: 'string',  description: 'Filter by claim name (mapping rules)' },
      { flag: '--claimValue',              type: 'string',  description: 'Filter by claim value (mapping rules)' },
      { flag: '--mappingRuleId',           type: 'string',  description: 'Filter by mapping rule ID (mapping rules)' },
    ],
    agentFlags: [
      {
        flag: '--fields',
        type: 'string',
        description: 'Comma-separated list of output fields to include. Reduces context window size. Case-insensitive. Example: --fields Key,State,processDefinitionId',
        appliesTo: 'all list/search/get commands',
      },
      {
        flag: '--dry-run',
        type: 'boolean',
        description: 'Preview the API request that would be sent without executing it. Emits { dryRun, command, method, url, body } as JSON. Always exits 0.',
        appliesTo: 'mutating commands: create, cancel, deploy, complete, fail, activate, resolve, publish, correlate, delete, assign, unassign',
      },
    ],
  };
}

/**
 * Get package version
 */
export function getVersion(): string {
  const packagePath = join(__dirname, '../../package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8'));
  return packageJson.version;
}

/**
 * Display version
 */
export function showVersion(): void {
  const logger = getLogger();
  logger.info(`c8ctl v${getVersion()}`);
}

/**
 * Display full help
 */
export function showHelp(): void {
  const logger = getLogger();
  const version = getVersion();
  const pluginCommandsInfo = getPluginCommandsInfo();

  // JSON mode: emit structured command tree for machine consumption
  if (logger.mode === 'json') {
    logger.json(buildHelpJson(version, pluginCommandsInfo));
    return;
  }
  
  let pluginSection = '';
  if (pluginCommandsInfo.length > 0) {
    pluginSection = '\n\nPlugin Commands:';
    for (const cmd of pluginCommandsInfo) {
      const desc = cmd.description ? `  ${cmd.description}` : '';
      pluginSection += `\n  ${cmd.commandName.padEnd(20)}${desc}`;
    }
  }

  let pluginExamples = '';
  for (const cmd of pluginCommandsInfo) {
    for (const ex of cmd.examples ?? []) {
      pluginExamples += `\n  ${ex.command.padEnd(35)}${ex.description}`;
    }
  }
  
  console.log(`
c8ctl - Camunda 8 CLI v${version}

Usage: c8ctl <command> [resource] [options]

Commands:
  list      <resource>       List resources (pi, pd, ut, inc, jobs, profiles, users, roles, groups, tenants, auth, mapping-rules)
  search    <resource>       Search resources with filters (pi, pd, ut, inc, jobs, variables/vars, users, roles, groups, tenants, auth, mapping-rules)
  get       <resource> <key> Get resource by key (pi, pd, inc, topology, form, user, role, group, tenant, auth, mapping-rule)
  create    <resource>       Create resource (pi, user, role, group, tenant, auth, mapping-rule)
  delete    <resource> <key> Delete resource (user, role, group, tenant, auth, mapping-rule)
  assign    <resource> <id>  Assign resource to target (role, user, group, mapping-rule)
  unassign  <resource> <id>  Unassign resource from target (role, user, group, mapping-rule)
  cancel    <resource> <key> Cancel resource (pi)
  await     <resource>       Create and await completion (pi, alias for create --awaitCompletion)
  complete  <resource> <key> Complete resource (ut, job)
  fail      job <key>        Fail a job
  activate  jobs <type>      Activate jobs by type
  resolve   inc <key>        Resolve incident
  publish   msg <name>       Publish message
  correlate msg <name>       Correlate message
  deploy    [path...]        Deploy BPMN/DMN/forms
  run       <path>           Deploy and start process
  watch     [path...]        Watch files for changes and auto-deploy
  open      <app>            Open Camunda web app in browser (operate, tasklist, modeler, optimize)
  add       profile <name>   Add a profile
  remove    profile <name>   Remove a profile (alias: rm)
  load      plugin <name>    Load a c8ctl plugin from npm registry
  load      plugin --from <url>  Load a c8ctl plugin from URL (https://, git://, file://)
  unload    plugin <name>    Unload a c8ctl plugin (npm uninstall wrapper)
  upgrade   plugin <name> [version]  Upgrade a plugin (respects source type)
  downgrade plugin <name> <version>  Downgrade a plugin to a specific version
  sync      plugin           Synchronize plugins from registry (rebuild/reinstall)
  init      plugin [name]    Create a new plugin from TypeScript template
  use       profile|tenant   Set active profile or tenant
  output    [json|text]      Show or set output format
  completion bash|zsh|fish   Generate shell completion script
  mcp-proxy [mcp-path]       Start a STDIO to remote HTTP MCP proxy server
  feedback                   Open the feedback page to report issues or request features
  help      [command]        Show help (detailed help for list, get, create, complete, await, delete, assign, unassign)${pluginSection}

Flags:
  --profile <name>      Use specific profile for this command
  --from <url>          Load plugin from URL (use with 'load plugin')
  --xml                 Get process definition as XML (use with 'get pd')
  --variables           Get process instance with variables (use with 'get pi')
  --userTask, --ut      Get form for a user task (optional, use with 'get form')
  --processDefinition, --pd  Get start form for a process definition (optional, use with 'get form')
  --id <process-id>     Process definition ID (alias for --bpmnProcessId)
  --awaitCompletion     Wait for process instance to complete (use with 'create pi')
  --fetchVariables <v>  Reserved for future use (all variables returned by default)
  --requestTimeout <ms> Timeout in milliseconds for process completion (use with --awaitCompletion)
  --sortBy <column>     Sort list/search output by column name (use with 'list' or 'search')
  --asc                 Sort in ascending order (default)
  --desc                Sort in descending order
  --limit <n>           Maximum number of items to fetch (default: 1000000)
  --between <from>..<to>  Filter by date range (use with 'list' or 'search'; short dates YYYY-MM-DD or ISO 8601; omit either end for open-ended range)
  --dateField <field>   Date field to filter on with --between (default depends on resource)
  --verbose             Enable SDK trace logging and show full error details
  --version, -v         Show version
  --help, -h            Show help

Search Flags:
  --bpmnProcessId <id>              Filter by process definition ID
  --processDefinitionKey <key>      Filter by process definition key
  --processInstanceKey <key>        Filter by process instance key
  --parentProcessInstanceKey <key>  Filter by parent process instance key
  --state <state>                   Filter by state (ACTIVE, COMPLETED, etc.)
  --name <name>                     Filter by name (variables, process definitions)
  --key <key>                       Filter by key
  --assignee <user>                 Filter by assignee (user tasks)
  --elementId <id>                  Filter by element ID (user tasks)
  --errorType <type>                Filter by error type (incidents)
  --errorMessage <msg>              Filter by error message (incidents)
  --type <type>                     Filter by type (jobs)
  --value <value>                   Filter by variable value
  --scopeKey <key>                  Filter by scope key (variables)
  --fullValue                       Return full variable values (default: truncated)

  Wildcard Search:
  String filters support wildcards: * (any chars) and ? (single char).
  Example: --name='*main*' matches all names containing "main".

  Case-Insensitive Search (--i prefix):
  --iname <pattern>                 Case-insensitive --name filter
  --iid <pattern>                   Case-insensitive --bpmnProcessId filter
  --iassignee <pattern>             Case-insensitive --assignee filter
  --ierrorMessage <pattern>         Case-insensitive --errorMessage filter
  --itype <pattern>                 Case-insensitive --type filter
  --ivalue <pattern>                Case-insensitive --value filter
  Prefix any string filter with 'i' for case-insensitive matching.
  Wildcards (* and ?) are supported. Filtering is applied client-side.
  Example: --iname='*ORDER*' matches "order", "Order", "ORDER", etc.

Resource Aliases:
  pi   = process-instance(s)
  pd   = process-definition(s)
  ut   = user-task(s)
  inc  = incident(s)
  msg  = message
  auth = authorization(s)
  mr   = mapping-rule(s)

━━━ Agent Flags (for programmatic / AI-agent consumption) ━━━

  --fields <columns>    Comma-separated list of output fields to include.
                        Reduces context window size when parsing output.
                        Example: c8ctl list pi --fields Key,State,processDefinitionId
                        Applies to all list/search/get commands. Case-insensitive.

  --dry-run             Preview the API request that would be sent, without executing it.
                        Emits JSON: { dryRun, command, method, url, body }
                        Applies to all mutating commands: create, cancel, deploy, complete,
                        fail, activate, resolve, publish, correlate, delete, assign, unassign.
                        Always exits 0. Use before confirming a mutating operation.

  Note: In JSON output mode (c8ctl output json), help is returned as structured JSON.
        Use 'c8ctl output json && c8ctl help' to get machine-readable command reference.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Examples:
  c8ctl list pi                      List process instances
  c8ctl list pd                      List process definitions
  c8ctl search pi --state=ACTIVE     Search for active process instances
  c8ctl search pd --bpmnProcessId=myProcess  Search process definitions by ID
  c8ctl search pd --name='*main*'    Search process definitions with wildcard
  c8ctl search ut --assignee=john    Search user tasks assigned to john
  c8ctl search inc --state=ACTIVE    Search for active incidents
  c8ctl search jobs --type=myJobType Search jobs by type
  c8ctl search jobs --type='*service*' Search jobs with type containing "service"
  c8ctl search variables --name=myVar  Search for variables by name
  c8ctl search variables --value=foo Search for variables by value
  c8ctl search variables --processInstanceKey=123 --fullValue  Search variables with full values
  c8ctl search pd --iname='*order*'    Case-insensitive search by name
  c8ctl search ut --iassignee=John     Case-insensitive search by assignee
  c8ctl get pi 123456                Get process instance by key
  c8ctl get pi 123456 --variables    Get process instance with variables
  c8ctl get pd 123456                Get process definition by key
  c8ctl get pd 123456 --xml          Get process definition XML
  c8ctl get form 123456              Get form (searches both user task and process definition)
  c8ctl get form 123456 --ut         Get form for user task only
  c8ctl get form 123456 --pd         Get start form for process definition only
  c8ctl create pi --id=myProcess
  c8ctl create pi --id=myProcess --awaitCompletion
  c8ctl await pi --id=myProcess      Create and wait for completion
  c8ctl deploy ./my-process.bpmn     Deploy a BPMN file
  c8ctl run ./my-process.bpmn        Deploy and start process
  c8ctl watch ./src                  Watch directory for changes
  c8ctl open operate                 Open Camunda Operate in browser
  c8ctl open tasklist                Open Camunda Tasklist in browser
  c8ctl open operate --profile=prod  Open Operate using a specific profile
  c8ctl use profile prod             Set active profile
  c8ctl which profile                Show currently active profile
  c8ctl output json                  Switch to JSON output
  c8ctl init plugin my-plugin        Create new plugin from template (c8ctl-plugin-my-plugin)
  c8ctl load plugin my-plugin        Load plugin from npm registry
  c8ctl load plugin --from https://github.com/org/plugin  Load plugin from URL
  c8ctl upgrade plugin my-plugin     Upgrade plugin to latest version
  c8ctl upgrade plugin my-plugin 1.2.3  Upgrade plugin to a specific version (source-aware)
  c8ctl sync plugin                  Synchronize plugins
  c8ctl completion bash              Generate bash completion script
  c8ctl list users                     List users
  c8ctl get user john                  Get user by username
  c8ctl create user --username=john --name='John Doe' --email=john@example.com --password=secret
  c8ctl delete user john               Delete user
  c8ctl assign role admin --to-user=john  Assign role to user
  c8ctl unassign role admin --from-user=john  Unassign role from user${pluginExamples}

For detailed help on specific commands with all available flags:
  c8ctl help list                    Show all list resources and their flags
  c8ctl help get                     Show all get resources and their flags
  c8ctl help create                  Show all create resources and their flags
  c8ctl help complete                Show all complete resources and their flags
  c8ctl help await                   Show await command with all flags
  c8ctl help mcp-proxy               Show mcp-proxy setup and usage
  c8ctl help search                  Show all search resources and their flags
  c8ctl help deploy                  Show deploy command with all flags
  c8ctl help run                     Show run command with all flags
  c8ctl help watch                   Show watch command with all flags
  c8ctl help open                    Show open command with all apps
  c8ctl help cancel                  Show cancel command with all flags
  c8ctl help resolve                 Show resolve command with all flags
  c8ctl help fail                    Show fail command with all flags
  c8ctl help activate                Show activate command with all flags
  c8ctl help publish                 Show publish command with all flags
  c8ctl help correlate               Show correlate command with all flags
  c8ctl help delete                    Show delete command with all flags
  c8ctl help assign                    Show assign command with all flags
  c8ctl help unassign                  Show unassign command with all flags
  c8ctl help profiles                Show profile management help
  c8ctl help plugin                  Show plugin management help
  c8ctl help plugins                 Alias for plugin management help

Feedback & Issues:
  https://github.com/camunda/c8ctl/issues
  Or run: c8ctl feedback
`.trim());
}

/**
 * Show available resources for a verb
 */
export function showVerbResources(verb: string): void {
  const resources: Record<string, string> = {
    list: 'process-instances (pi), process-definitions (pd), user-tasks (ut), incidents (inc), jobs, profiles, plugins, users, roles, groups, tenants, authorizations (auth), mapping-rules (mr)',
    search: 'process-instances (pi), process-definitions (pd), user-tasks (ut), incidents (inc), jobs, variables (vars), users, roles, groups, tenants, authorizations (auth), mapping-rules (mr)',
    get: 'process-instance (pi), process-definition (pd), incident (inc), topology, form, user, role, group, tenant, authorization (auth), mapping-rule (mr)',
    create: 'process-instance (pi), user, role, group, tenant, authorization (auth), mapping-rule (mr)',
    delete: 'user, role, group, tenant, authorization (auth), mapping-rule (mr)',
    assign: 'role, user, group, mapping-rule',
    unassign: 'role, user, group, mapping-rule',
    complete: 'user-task (ut), job',
    cancel: 'process-instance (pi)',
    await: 'process-instance (pi)',
    resolve: 'incident (inc)',
    activate: 'jobs',
    fail: 'job',
    publish: 'message (msg)',
    correlate: 'message (msg)',
    add: 'profile',
    remove: 'profile',
    rm: 'profile',
    load: 'plugin',
    unload: 'plugin',
    sync: 'plugin',
    upgrade: 'plugin',
    downgrade: 'plugin',
    init: 'plugin',
    use: 'profile, tenant',
    which: 'profile',
    output: 'json, text',
    open: 'operate, tasklist, modeler, optimize',
    completion: 'bash, zsh, fish',
    help: 'list, get, create, complete, await, search, deploy, run, watch, open, cancel, resolve, fail, activate, publish, correlate, delete, assign, unassign, upgrade, downgrade, init, profiles, profile, plugin, plugins',
  };

  const available = resources[verb];
  if (available) {
    console.log(`\nUsage: c8ctl ${verb} <resource>\n`);
    console.log(`Available resources:\n  ${available}`);
  } else {
    console.log(`\nUnknown command: ${verb}`);
    console.log('Run "c8ctl help" for usage information.');
  }
}

/**
 * Show detailed help for list command with all resources and their flags
 */
export function showListHelp(): void {
  console.log(`
c8ctl list - List resources

Usage: c8ctl list <resource> [flags]

Resources and their available flags:

  process-instances (pi)
    --id <id>                Filter by process definition ID (alias: --bpmnProcessId)
    --version <num>          Filter by process definition version
    --state <state>          Filter by state (ACTIVE, COMPLETED, etc.)
    --all                    List all instances (pagination)
    --between <from>..<to>   Filter by date range (default field: startDate)
    --dateField <field>      Date field for --between (startDate, endDate)
    --sortBy <column>        Sort by column (Key, Process ID, State, Version, Start Date, Tenant ID)
    --asc                    Sort in ascending order (default)
    --desc                   Sort in descending order
    --limit <n>              Maximum number of items to fetch (default: 1000000)
    --profile <name>         Use specific profile
    Note: instances with an active incident are marked with ⚠ before the Key

  process-definitions (pd)
    --sortBy <column>        Sort by column (Key, Process ID, Name, Version, Tenant ID)
    --asc                    Sort in ascending order (default)
    --desc                   Sort in descending order
    --limit <n>              Maximum number of items to fetch (default: 1000000)
    --profile <name>         Use specific profile

  user-tasks (ut)
    --state <state>          Filter by state (CREATED, COMPLETED, etc.)
    --assignee <name>        Filter by assignee
    --all                    List all tasks (pagination)
    --between <from>..<to>   Filter by date range (default field: creationDate)
    --dateField <field>      Date field for --between (creationDate, completionDate, followUpDate, dueDate)
    --sortBy <column>        Sort by column (Key, Name, State, Assignee, Created, Process Instance, Tenant ID)
    --asc                    Sort in ascending order (default)
    --desc                   Sort in descending order
    --limit <n>              Maximum number of items to fetch (default: 1000000)
    --profile <name>         Use specific profile

  incidents (inc)
    --state <state>          Filter by state (ACTIVE, RESOLVED, etc.)
    --processInstanceKey <key>  Filter by process instance
    --between <from>..<to>   Filter by date range (field: creationTime)
    --sortBy <column>        Sort by column (Key, Type, Message, State, Created, Process Instance, Tenant ID)
    --asc                    Sort in ascending order (default)
    --desc                   Sort in descending order
    --limit <n>              Maximum number of items to fetch (default: 1000000)
    --profile <name>         Use specific profile

  jobs
    --state <state>          Filter by state (ACTIVATABLE, ACTIVATED, etc.)
    --type <type>            Filter by job type
    --between <from>..<to>   Filter by date range (default field: creationTime)
    --dateField <field>      Date field for --between (creationTime, lastUpdateTime)
    --sortBy <column>        Sort by column (Key, Type, State, Retries, Created, Process Instance, Tenant ID)
    --asc                    Sort in ascending order (default)
    --desc                   Sort in descending order
    --limit <n>              Maximum number of items to fetch (default: 1000000)
    --profile <name>         Use specific profile

  profiles
    Lists both c8ctl and Camunda Modeler profiles
    (Modeler profiles are shown with 'modeler:' prefix)

  plugins
    Shows installed plugins with version and sync status

  users
    --sortBy <column>        Sort by column (Username, Name, Email)
    --asc                    Sort in ascending order (default)
    --desc                   Sort in descending order
    --limit <n>              Maximum number of items to fetch (default: 1000000)
    --profile <name>         Use specific profile

  roles
    --sortBy <column>        Sort by column (Role ID, Name, Description)
    --asc                    Sort in ascending order (default)
    --desc                   Sort in descending order
    --limit <n>              Maximum number of items to fetch (default: 1000000)
    --profile <name>         Use specific profile

  groups
    --sortBy <column>        Sort by column (Group ID, Name, Description)
    --asc                    Sort in ascending order (default)
    --desc                   Sort in descending order
    --limit <n>              Maximum number of items to fetch (default: 1000000)
    --profile <name>         Use specific profile

  tenants
    --sortBy <column>        Sort by column (Tenant ID, Name, Description)
    --asc                    Sort in ascending order (default)
    --desc                   Sort in descending order
    --limit <n>              Maximum number of items to fetch (default: 1000000)
    --profile <name>         Use specific profile

  authorizations (auth)
    --sortBy <column>        Sort by column (Key, Owner ID, Owner Type, Resource Type, Resource ID, Permissions)
    --asc                    Sort in ascending order (default)
    --desc                   Sort in descending order
    --limit <n>              Maximum number of items to fetch (default: 1000000)
    --profile <name>         Use specific profile

  mapping-rules (mr)
    --sortBy <column>        Sort by column (Mapping Rule ID, Name, Claim Name, Claim Value)
    --asc                    Sort in ascending order (default)
    --desc                   Sort in descending order
    --limit <n>              Maximum number of items to fetch (default: 1000000)
    --profile <name>         Use specific profile

Examples:
  c8ctl list pi --state=ACTIVE
  c8ctl list pi --between=2024-01-01..2024-12-31
  c8ctl list pi --between=2024-01-01T00:00:00Z..2024-06-30T23:59:59Z --dateField=endDate
  c8ctl list pi --sortBy=State
  c8ctl list pi --sortBy=State --desc
  c8ctl list ut --assignee=john.doe
  c8ctl list ut --between=2024-01-01..2024-03-31 --dateField=dueDate
  c8ctl list ut --sortBy=Assignee
  c8ctl list inc --processInstanceKey=123456
  c8ctl list inc --between=2024-06-01..2024-06-30
  c8ctl list inc --sortBy=Type --desc
  c8ctl list jobs --type=email-service
  c8ctl list jobs --between=2024-01-01..2024-12-31
  c8ctl list jobs --sortBy=Retries --asc
  c8ctl list profiles
  c8ctl list plugins
  c8ctl list users
  c8ctl list roles
  c8ctl list groups
  c8ctl list tenants
  c8ctl list auth
  c8ctl list mapping-rules
`.trim());
}
export function showGetHelp(): void {
  console.log(`
c8ctl get - Get resource by key

Usage: c8ctl get <resource> <key> [flags]

Resources and their available flags:

  process-instance (pi) <key>
    --variables              Include variables for the process instance
    --profile <name>         Use specific profile

  process-definition (pd) <key>
    --xml                    Return process definition as XML
    --profile <name>         Use specific profile

  incident (inc) <key>
    --profile <name>         Use specific profile

  topology
    --profile <name>         Use specific profile

  form <key>
    --userTask, --ut         (Optional) Get form for a user task only
    --processDefinition, --pd  (Optional) Get start form for a process definition only
    --profile <name>         Use specific profile
    
    If no flag is specified, searches both user task and process definition.

  user <username>
    --profile <name>         Use specific profile

  role <roleId>
    --profile <name>         Use specific profile

  group <groupId>
    --profile <name>         Use specific profile

  tenant <tenantId>
    --profile <name>         Use specific profile

  authorization (auth) <key>
    --profile <name>         Use specific profile

  mapping-rule (mr) <id>
    --profile <name>         Use specific profile

Examples:
  c8ctl get pi 2251799813685249
  c8ctl get pi 2251799813685249 --variables
  c8ctl get pd 2251799813685250
  c8ctl get pd 2251799813685250 --xml
  c8ctl get inc 2251799813685251
  c8ctl get topology
  c8ctl get form 2251799813685251
  c8ctl get form 2251799813685251 --ut
  c8ctl get form 2251799813685252 --pd
  c8ctl get user john
  c8ctl get role my-role
  c8ctl get group developers
  c8ctl get tenant prod
  c8ctl get auth 123456
  c8ctl get mapping-rule abc123
`.trim());
}

/**
 * Show detailed help for create command
 */
export function showCreateHelp(): void {
  console.log(`
c8ctl create - Create a resource

Usage: c8ctl create <resource> [flags]

Resources and their available flags:

  process-instance (pi)
    --id <id>                Process definition ID (required, alias: --bpmnProcessId)
    --version <num>          Process definition version
    --variables <json>       Process variables as JSON string
    --awaitCompletion        Wait for process instance to complete
    --fetchVariables <vars>  Reserved for future use (all variables returned by default)
    --requestTimeout <ms>    Timeout in milliseconds for process completion (use with --awaitCompletion)
    --profile <name>         Use specific profile

  user
    --username <name>        Username (required)
    --name <name>            Display name
    --email <email>          Email address
    --password <pwd>         Password (required)
    --profile <name>         Use specific profile

  role
    --name <name>            Role name (required)
    --profile <name>         Use specific profile

  group
    --name <name>            Group name (required)
    --profile <name>         Use specific profile

  tenant
    --tenantId <id>          Tenant ID (required)
    --name <name>            Tenant name (required)
    --profile <name>         Use specific profile

  authorization (auth)
    --ownerId <id>           Owner ID (required)
    --ownerType <type>       Owner type: USER, GROUP, ROLE, MAPPING_RULE (required)
    --resourceType <type>    Resource type (required)
    --resourceId <id>        Resource ID (required)
    --permissions <perms>    Comma-separated permissions: READ,CREATE,UPDATE,DELETE (required)
    --profile <name>         Use specific profile

  mapping-rule (mr)
    --mappingRuleId <id>     Mapping rule ID (required)
    --name <name>            Mapping rule name (required)
    --claimName <name>       Claim name (required)
    --claimValue <value>     Claim value (required)
    --profile <name>         Use specific profile

Examples:
  c8ctl create pi --id=order-process
  c8ctl create pi --id=order-process --version=2
  c8ctl create pi --id=order-process --variables='{"orderId":"12345"}'
  c8ctl create pi --id=order-process --awaitCompletion
  c8ctl create pi --id=order-process --awaitCompletion --requestTimeout=30000
  c8ctl create user --username=john --name='John Doe' --email=john@example.com --password=secret
  c8ctl create role --name=my-role
  c8ctl create group --name=developers
  c8ctl create tenant --tenantId=prod --name='Production'
  c8ctl create auth --ownerId=john --ownerType=USER --resourceType=process-definition --resourceId='*' --permissions=READ,CREATE
  c8ctl create mapping-rule --mappingRuleId=my-rule --name=my-rule --claimName=department --claimValue=engineering
`.trim());
}

/**
 * Show detailed help for complete command
 */
export function showCompleteHelp(): void {
  console.log(`
c8ctl complete - Complete a resource

Usage: c8ctl complete <resource> <key> [flags]

Resources and their available flags:

  user-task (ut) <key>
    --variables <json>       Completion variables as JSON string
    --profile <name>         Use specific profile

  job <key>
    --variables <json>       Completion variables as JSON string
    --profile <name>         Use specific profile

Examples:
  c8ctl complete ut 2251799813685250
  c8ctl complete ut 2251799813685250 --variables='{"approved":true}'
  c8ctl complete job 2251799813685252 --variables='{"result":"success"}'
`.trim());
}

/**
 * Show detailed help for await command
 */
export function showAwaitHelp(): void {
  console.log(`
c8ctl await - Create and await process instance completion

Usage: c8ctl await <resource> [flags]

Note: 'await pi' is an alias for 'create pi --awaitCompletion'

Resources and their available flags:

  process-instance (pi)
    --id <id>                Process definition ID (required, alias: --bpmnProcessId)
    --version <num>          Process definition version
    --variables <json>       Process variables as JSON string
    --fetchVariables <vars>  Reserved for future use (all variables returned by default)
    --requestTimeout <ms>    Timeout in milliseconds for process completion
    --profile <name>         Use specific profile

Description:
  Creates a process instance and waits for it to reach a terminal state (COMPLETED, CANCELED).
  Returns the full process instance with all variables when complete.
  Uses the Camunda 8 API's built-in awaitCompletion parameter for reliable server-side waiting.

Examples:
  c8ctl await pi --id=order-process
  c8ctl await pi --id=order-process --variables='{"orderId":"12345"}'
  c8ctl await pi --id=order-process --requestTimeout=30000
  
  # Equivalent to:
  c8ctl create pi --id=order-process --awaitCompletion
`.trim());
}

/**
 * Show detailed help for mcp-proxy command
 */
export function showMcpProxyHelp(): void {
  console.log(`
c8ctl mcp-proxy - Start MCP proxy server

Usage: c8ctl mcp-proxy [mcp-path] [flags]

Description:
  Starts a STDIO-based Model Context Protocol (MCP) proxy server that bridges
  between local MCP clients (like VSCode or other AI assistants) and
  remote Camunda 8 HTTP MCP servers. The proxy handles authentication by
  injecting Camunda credentials from your active profile.

Arguments:
  mcp-path                 Path to the remote MCP endpoint (default: /mcp/cluster)

Flags:
  --profile <name>         Use specific profile for authentication

How it works:
  1. Accepts MCP requests via STDIO (standard input/output)
  2. Forwards requests to the remote Camunda 8 cluster's MCP endpoint
  3. Injects authentication headers from your c8ctl profile
  4. Returns responses back through STDIO

Configuration:
  VSCode  example - add a block like the following to your mcp.json:

  {
    "servers": {
      "camunda-cluster": {
        "type": "stdio",
        "command": "npx",
        "args": ["c8ctl", "mcp-proxy"]
      }
    }
  }

Examples:
  # Start proxy with default MCP path and active profile
  c8ctl mcp-proxy

  # Use specific MCP endpoint path
  c8ctl mcp-proxy /api/mcp

  # Use specific profile for authentication
  c8ctl mcp-proxy --profile=production

  # Combine custom path and profile
  c8ctl mcp-proxy /mcp/v2 --profile=staging

Note:
  The mcp-proxy command runs in the foreground and communicates via STDIO.
  It's designed to be launched by MCP clients, not run directly in a terminal.
`.trim());
}

/**
 * Show detailed help for search command
 */
export function showSearchHelp(): void {
  console.log(`
c8ctl search - Search resources with filters

Usage: c8ctl search <resource> [flags]

Resources and their available flags:

  process-instances (pi)
    --bpmnProcessId, --id <id>        Filter by process definition ID
    --iid <pattern>                   Case-insensitive --bpmnProcessId filter
    --processDefinitionKey <key>      Filter by process definition key
    --version <num>                   Filter by process definition version
    --state <state>                   Filter by state (ACTIVE, COMPLETED, etc.)
    --key <key>                       Filter by key
    --parentProcessInstanceKey <key>  Filter by parent process instance key
    --between <from>..<to>            Filter by date range (default field: startDate)
    --dateField <field>               Date field for --between (startDate, endDate)
    --sortBy <column>                 Sort by column (Key, Process ID, State, Version, Tenant ID)
    --asc                             Sort in ascending order (default)
    --desc                            Sort in descending order
    --profile <name>                  Use specific profile

  process-definitions (pd)
    --bpmnProcessId, --id <id>        Filter by process definition ID
    --iid <pattern>                   Case-insensitive --bpmnProcessId filter
    --name <name>                     Filter by name
    --iname <pattern>                 Case-insensitive --name filter
    --version <num>                   Filter by process definition version
    --key <key>                       Filter by key
    --sortBy <column>                 Sort by column (Key, Process ID, Name, Version, Tenant ID)
    --asc                             Sort in ascending order (default)
    --desc                            Sort in descending order
    --profile <name>                  Use specific profile

  user-tasks (ut)
    --state <state>                   Filter by state (CREATED, COMPLETED, etc.)
    --assignee <user>                 Filter by assignee
    --iassignee <pattern>             Case-insensitive --assignee filter
    --processInstanceKey <key>        Filter by process instance key
    --processDefinitionKey <key>      Filter by process definition key
    --elementId <id>                  Filter by element ID
    --between <from>..<to>            Filter by date range (default field: creationDate)
    --dateField <field>               Date field for --between (creationDate, completionDate, followUpDate, dueDate)
    --sortBy <column>                 Sort by column (Key, Name, State, Assignee, Process Instance, Tenant ID)
    --asc                             Sort in ascending order (default)
    --desc                            Sort in descending order
    --profile <name>                  Use specific profile

  incidents (inc)
    --state <state>                   Filter by state (ACTIVE, RESOLVED, etc.)
    --processInstanceKey <key>        Filter by process instance key
    --processDefinitionKey <key>      Filter by process definition key
    --bpmnProcessId, --id <id>        Filter by process definition ID
    --iid <pattern>                   Case-insensitive --bpmnProcessId filter
    --errorType <type>                Filter by error type
    --errorMessage <msg>              Filter by error message
    --ierrorMessage <pattern>         Case-insensitive --errorMessage filter
    --between <from>..<to>            Filter by date range (field: creationTime)
    --sortBy <column>                 Sort by column (Key, Type, Message, State, Process Instance, Tenant ID)
    --asc                             Sort in ascending order (default)
    --desc                            Sort in descending order
    --profile <name>                  Use specific profile

  jobs
    --state <state>                   Filter by state (ACTIVATABLE, ACTIVATED, etc.)
    --type <type>                     Filter by job type
    --itype <pattern>                 Case-insensitive --type filter
    --processInstanceKey <key>        Filter by process instance key
    --processDefinitionKey <key>      Filter by process definition key
    --between <from>..<to>            Filter by date range (default field: creationTime)
    --dateField <field>               Date field for --between (creationTime, lastUpdateTime)
    --sortBy <column>                 Sort by column (Key, Type, State, Retries, Process Instance, Tenant ID)
    --asc                             Sort in ascending order (default)
    --desc                            Sort in descending order
    --profile <name>                  Use specific profile

  variables
    --name <name>                     Filter by variable name
    --iname <pattern>                 Case-insensitive --name filter
    --value <value>                   Filter by variable value
    --ivalue <pattern>                Case-insensitive --value filter
    --processInstanceKey <key>        Filter by process instance key
    --scopeKey <key>                  Filter by scope key
    --fullValue                       Return full variable values (default: truncated)
    --sortBy <column>                 Sort by column (Name, Value, Process Instance, Scope Key, Tenant ID)
    --asc                             Sort in ascending order (default)
    --desc                            Sort in descending order
    --limit <n>                       Maximum number of items to fetch (default: 1000000)
    --profile <name>                  Use specific profile

  users
    --username <name>                 Filter by username
    --name <name>                     Filter by name
    --email <email>                   Filter by email
    --sortBy <column>                 Sort by column (Username, Name, Email)
    --asc                             Sort in ascending order (default)
    --desc                            Sort in descending order
    --limit <n>                       Maximum number of items to fetch (default: 1000000)
    --profile <name>                  Use specific profile

  roles
    --roleId <id>                     Filter by role ID
    --name <name>                     Filter by name
    --sortBy <column>                 Sort by column (Role ID, Name, Description)
    --asc                             Sort in ascending order (default)
    --desc                            Sort in descending order
    --limit <n>                       Maximum number of items to fetch (default: 1000000)
    --profile <name>                  Use specific profile

  groups
    --groupId <id>                    Filter by group ID
    --name <name>                     Filter by name
    --sortBy <column>                 Sort by column (Group ID, Name, Description)
    --asc                             Sort in ascending order (default)
    --desc                            Sort in descending order
    --limit <n>                       Maximum number of items to fetch (default: 1000000)
    --profile <name>                  Use specific profile

  tenants
    --name <name>                     Filter by name
    --tenantId <id>                   Filter by tenant ID
    --sortBy <column>                 Sort by column (Tenant ID, Name, Description)
    --asc                             Sort in ascending order (default)
    --desc                            Sort in descending order
    --limit <n>                       Maximum number of items to fetch (default: 1000000)
    --profile <name>                  Use specific profile

  authorizations (auth)
    --ownerId <id>                    Filter by owner ID
    --ownerType <type>                Filter by owner type
    --resourceType <type>             Filter by resource type
    --resourceId <id>                 Filter by resource ID
    --sortBy <column>                 Sort by column (Key, Owner ID, Owner Type, Resource Type, Resource ID, Permissions)
    --asc                             Sort in ascending order (default)
    --desc                            Sort in descending order
    --limit <n>                       Maximum number of items to fetch (default: 1000000)
    --profile <name>                  Use specific profile

  mapping-rules (mr)
    --mappingRuleId <id>              Filter by mapping rule ID
    --name <name>                     Filter by name
    --claimName <name>                Filter by claim name
    --claimValue <value>              Filter by claim value
    --sortBy <column>                 Sort by column (Mapping Rule ID, Name, Claim Name, Claim Value)
    --asc                             Sort in ascending order (default)
    --desc                            Sort in descending order
    --limit <n>                       Maximum number of items to fetch (default: 1000000)
    --profile <name>                  Use specific profile

Date Range Filter:
  Use --between <from>..<to> to filter results by a date range.
  Dates can be short (YYYY-MM-DD) or full ISO 8601 datetimes.
  Short dates: 'from' is expanded to T00:00:00.000Z, 'to' to T23:59:59.999Z.
  Either end may be omitted for an open-ended range.
  Use --dateField to specify which date field to filter on (default depends on resource).
  Example: --between=2024-01-01..2024-12-31
  Example: --between=2024-01-01T00:00:00Z..2024-06-30T23:59:59Z --dateField=endDate
  Example: --between=..2024-12-31 (everything until end of 2024)
  Example: --between=2024-01-01.. (everything from start of 2024)

Wildcard Search:
  Some string filters support wildcards: * (any chars) and ? (single char).
  Supported: process definitions (name, bpmnProcessId), process instances (bpmnProcessId),
             jobs (type), variables (name, value), users (username, name, email), groups (groupId).
  Not supported (exact match only): roles, tenants, mapping-rules, authorizations.
  Example: --name='*main*' matches all names containing "main".

Case-Insensitive Search:
  Prefix any string filter with 'i' for case-insensitive matching.
  Wildcards (* and ?) are supported. Filtering is applied client-side.
  Example: --iname='*ORDER*' matches "order", "Order", "ORDER", etc.

Examples:
  c8ctl search pi --state=ACTIVE
  c8ctl search pi --bpmnProcessId=order-process
  c8ctl search pi --between=2024-01-01..2024-12-31
  c8ctl search pi --between=2024-01-01..2024-06-30 --dateField=endDate
  c8ctl search pd --name='*main*'
  c8ctl search pd --iname='*order*'
  c8ctl search pd --sortBy=Name --desc
  c8ctl search ut --assignee=john.doe
  c8ctl search ut --iassignee=John
  c8ctl search ut --between=2024-01-01..2024-03-31 --dateField=dueDate
  c8ctl search ut --sortBy=State --asc
  c8ctl search inc --state=ACTIVE --processInstanceKey=123456
  c8ctl search inc --between=2024-06-01..2024-06-30
  c8ctl search jobs --type=email-service
  c8ctl search jobs --itype='*SERVICE*'
  c8ctl search jobs --between=2024-01-01..2024-12-31
  c8ctl search jobs --sortBy=Type --desc
  c8ctl search variables --name=orderId
  c8ctl search variables --value=12345 --fullValue
  c8ctl search variables --sortBy=Name
  c8ctl search users --name=John
  c8ctl search roles --name=admin
  c8ctl search groups --name=developers
  c8ctl search tenants --name=Production
  c8ctl search auth --ownerId=john --resourceType=process-definition
  c8ctl search auth --ownerId=john --resourceId=my-resource
  c8ctl search mapping-rules --claimName=department
  c8ctl search mapping-rules --mappingRuleId=my-rule
`.trim());
}

/**
 * Show detailed help for deploy command
 */
export function showDeployHelp(): void {
  console.log(`
c8ctl deploy - Deploy BPMN, DMN, and form files

Usage: c8ctl deploy [path...] [flags]

Description:
  Deploy BPMN process definitions, DMN decision tables, and forms to Camunda 8.
  Automatically discovers all deployable files in the specified paths.
  If no path is provided, deploys from the current directory.

Flags:
  --profile <name>         Use specific profile

Supported File Types:
  - BPMN files (.bpmn)
  - DMN files (.dmn)
  - Form files (.form)

Building Blocks:
  Folders containing '_bb-' in their name are treated as building blocks
  and are deployed before regular processes.

Examples:
  c8ctl deploy                          Deploy all files in current directory
  c8ctl deploy ./src                    Deploy all files in ./src directory
  c8ctl deploy ./process.bpmn           Deploy a specific BPMN file
  c8ctl deploy ./src ./forms            Deploy from multiple directories
  c8ctl deploy --profile=prod          Deploy using specific profile
`.trim());
}

/**
 * Show detailed help for run command
 */
export function showRunHelp(): void {
  console.log(`
c8ctl run - Deploy and start a process

Usage: c8ctl run <path> [flags]

Description:
  Deploys a BPMN file and immediately creates a process instance from it.
  This is a convenience command that combines deploy and create operations.

Flags:
  --profile <name>         Use specific profile
  --variables <json>       Process variables as JSON string

Examples:
  c8ctl run ./my-process.bpmn
  c8ctl run ./my-process.bpmn --variables='{"orderId":"12345"}'
  c8ctl run ./my-process.bpmn --profile=prod
`.trim());
}

/**
 * Show detailed help for watch command
 */
export function showWatchHelp(): void {
  console.log(`
c8ctl watch - Watch files for changes and auto-deploy

Usage: c8ctl watch [path...] [flags]

Alias: w

Description:
  Watches BPMN, DMN, and form files for changes and automatically deploys them.
  Useful during development for rapid iteration.
  If no path is provided, watches the current directory.

  Validation errors (INVALID_ARGUMENT) are reported but do not stop the watcher,
  so you can fix the file and save again. Use --force to also continue on other
  errors such as network or authentication failures.

Flags:
  --profile <name>         Use specific profile
  --force                  Continue watching after all deployment errors

Supported File Types:
  - BPMN files (.bpmn)
  - DMN files (.dmn)
  - Form files (.form)

Examples:
  c8ctl watch                           Watch current directory
  c8ctl watch ./src                     Watch ./src directory
  c8ctl watch ./src ./forms             Watch multiple directories
  c8ctl w ./src                         Use short alias
  c8ctl watch --profile=dev             Watch using specific profile
  c8ctl watch --force                   Keep watching after all deployment errors
`.trim());
}

/**
 * Show detailed help for open command
 */
export function showOpenHelp(): void {
  console.log(`
c8ctl open - Open a Camunda web application in the browser

Usage: c8ctl open <app> [flags]

Applications:
  operate           Camunda Operate  – monitor process instances and incidents
  tasklist          Camunda Tasklist – manage user tasks
  modeler           Camunda Web Modeler – design BPMN/DMN processes
  optimize          Camunda Optimize – process analytics

Description:
  Derives the application URL from the active profile's base URL by stripping
  the API path suffix (e.g. /v2) and appending the application path.

  Example: baseUrl=http://localhost:8080/v2  →  http://localhost:8080/operate

  For this command, --dry-run resolves and prints the application URL instead
  of launching the browser.

Flags:
  --profile <name>         Use specific profile
  --dry-run                Resolve and print the URL without opening the browser

Examples:
  c8ctl open operate
  c8ctl open tasklist
  c8ctl open modeler
  c8ctl open optimize
  c8ctl open operate --profile=prod
  c8ctl open operate --dry-run
`.trim());
}

/**
 * Show detailed help for cancel command
 */
export function showCancelHelp(): void {
  console.log(`
c8ctl cancel - Cancel a resource

Usage: c8ctl cancel <resource> <key> [flags]

Resources and their available flags:

  process-instance (pi) <key>
    --profile <name>         Use specific profile

Examples:
  c8ctl cancel pi 2251799813685249
  c8ctl cancel pi 2251799813685249 --profile=prod
`.trim());
}

/**
 * Show detailed help for resolve command
 */
export function showResolveHelp(): void {
  console.log(`
c8ctl resolve - Resolve an incident

Usage: c8ctl resolve incident <key> [flags]

Alias: inc for incident

Description:
  Resolves an incident by its key. This marks the incident as resolved
  and allows the process instance to continue.

Flags:
  --profile <name>         Use specific profile

Examples:
  c8ctl resolve inc 2251799813685251
  c8ctl resolve incident 2251799813685251
  c8ctl resolve inc 2251799813685251 --profile=prod
`.trim());
}

/**
 * Show detailed help for fail command
 */
export function showFailHelp(): void {
  console.log(`
c8ctl fail - Fail a job

Usage: c8ctl fail job <key> [flags]

Description:
  Marks a job as failed with optional error message and retry count.

Flags:
  --profile <name>         Use specific profile
  --retries <num>          Number of retries remaining (default: 0)
  --errorMessage <msg>     Error message describing the failure

Examples:
  c8ctl fail job 2251799813685252
  c8ctl fail job 2251799813685252 --retries=3
  c8ctl fail job 2251799813685252 --errorMessage="Connection timeout"
  c8ctl fail job 2251799813685252 --retries=2 --errorMessage="Temporary failure"
`.trim());
}

/**
 * Show detailed help for activate command
 */
export function showActivateHelp(): void {
  console.log(`
c8ctl activate - Activate jobs by type

Usage: c8ctl activate jobs <type> [flags]

Description:
  Activates jobs of a specific type for processing by a worker.

Flags:
  --profile <name>         Use specific profile
  --maxJobsToActivate <num>  Maximum number of jobs to activate (default: 10)
  --timeout <ms>           Job lock timeout in milliseconds (default: 60000)
  --worker <name>          Worker name (default: "c8ctl")

Examples:
  c8ctl activate jobs email-service
  c8ctl activate jobs payment-processor --maxJobsToActivate=5
  c8ctl activate jobs data-sync --timeout=120000 --worker=my-worker
  c8ctl activate jobs batch-job --maxJobsToActivate=100 --profile=prod
`.trim());
}

/**
 * Show detailed help for publish command
 */
export function showPublishHelp(): void {
  console.log(`
c8ctl publish - Publish a message

Usage: c8ctl publish message <name> [flags]

Alias: msg for message

Description:
  Publishes a message to Camunda 8 for message correlation.

Flags:
  --profile <name>         Use specific profile
  --correlationKey <key>   Correlation key for the message
  --variables <json>       Message variables as JSON string
  --timeToLive <ms>        Message time-to-live in milliseconds

Examples:
  c8ctl publish msg payment-received
  c8ctl publish message order-confirmed --correlationKey=order-123
  c8ctl publish msg invoice-paid --variables='{"amount":1000}'
  c8ctl publish msg notification --correlationKey=user-456 --timeToLive=30000
`.trim());
}

/**
 * Show detailed help for correlate command
 */
export function showCorrelateHelp(): void {
  console.log(`
c8ctl correlate - Correlate a message

Usage: c8ctl correlate message <name> [flags]

Alias: msg for message

Description:
  Correlates a message to a specific process instance.

Flags:
  --profile <name>         Use specific profile
  --correlationKey <key>   Correlation key for the message (required)
  --variables <json>       Message variables as JSON string
  --timeToLive <ms>        Message time-to-live in milliseconds

Examples:
  c8ctl correlate msg payment-received --correlationKey=order-123
  c8ctl correlate message order-confirmed --correlationKey=order-456 --variables='{"status":"confirmed"}'
  c8ctl correlate msg invoice-paid --correlationKey=inv-789 --timeToLive=60000
`.trim());
}

/**
 * Show detailed help for profile management
 */
export function showProfilesHelp(): void {
  console.log(`
c8ctl profiles - Profile management

Usage: c8ctl <command> profile[s] [args] [flags]

Profile commands:

  list profiles
    List all profiles (c8ctl + Camunda Modeler profiles).
    Modeler profiles are shown with "modeler:" prefix.
    The currently active profile is marked with "*".

  which profile
    Show the name of the currently active profile.

  add profile <name> [flags]
    Add a c8ctl-managed profile.

  remove profile <name>
  rm profile <name>
    Remove a c8ctl-managed profile.

  use profile <name>
    Set active profile for the current session.

  use profile --none
    Clear the active session profile so env vars take effect.

Connection resolution order (highest to lowest priority):
  1. --profile <name> flag on the current command
  2. Active session profile (set with: c8ctl use profile <name>)
     ⚠ Warns if CAMUNDA_* env vars are also present
  3. Environment variables (CAMUNDA_BASE_URL, CAMUNDA_CLIENT_ID, …)
  4. Default 'local' profile from profiles.json

Default profile: "local"
  c8ctl ships with a built-in 'local' profile (http://localhost:8080/v2, demo/demo).
  It is created automatically in profiles.json on first use.
  Override it: c8ctl add profile local --baseUrl <url>

Flags for add profile:
  Required for all add profile calls:
    (none)

  Required for OAuth-secured clusters:
    --clientId <id>          OAuth client ID
    --clientSecret <secret>  OAuth client secret

  Optional (with defaults):
    --baseUrl <url>          Cluster base URL (default: http://localhost:8080/v2)
    --defaultTenantId <id>   Default tenant ID (default at runtime: <default>)

  Optional (no c8ctl default):
    --audience <audience>    OAuth audience
    --oAuthUrl <url>         OAuth token endpoint

  Import from file or environment:
    --from-file <path>       Create profile from a .env file containing CAMUNDA_* vars
    --from-env               Create profile from current CAMUNDA_* environment variables

Examples:
  c8ctl list profiles
  c8ctl which profile
  c8ctl add profile local --baseUrl=http://localhost:8080/v2
  c8ctl add profile prod --baseUrl=https://camunda.example.com --clientId=xxx --clientSecret=yyy
  c8ctl add profile staging --from-file .env.staging
  c8ctl add profile ci --from-env
  c8ctl use profile prod
  c8ctl use profile "modeler:Local Dev"
  c8ctl use profile --none
  c8ctl remove profile local
`.trim());
}

/**
 * Show detailed help for plugin management
 */
export function showPluginHelp(): void {
  console.log(`
c8ctl plugin - Plugin management

Usage: c8ctl <command> plugin [args] [flags]

Plugin commands:

  load plugin <name>
    Load a plugin from npm registry.

  load plugin --from <url>
    Load a plugin from URL source (file://, https://, git://, github:).

  unload plugin <name>
    Unload and unregister a plugin.

  unload plugin <name> --force
    Force-remove a plugin that is installed but not in the registry (limbo state).

  list plugins
    List installed plugins with version and sync status.

  sync plugins
    Rebuild/reinstall plugins from registry.

  upgrade plugin <name> [version]
    Upgrade plugin source.
    - without version: reinstalls registered source as-is
    - npm source with version: installs <name>@<version>
    - URL/git source with version: installs <source>#<version>
    - file:// source with version: not supported, use load plugin --from

  downgrade plugin <name> <version>
    Downgrade plugin source.
    - npm source: installs <name>@<version>
    - URL/git source: installs <source>#<version>
    - file:// source: not supported, use load plugin --from

  init plugin [name]
    Create a new plugin scaffold from template.
    Default name: c8ctl-plugin-myplugin

    Convention over configuration: the directory is always prefixed with
    "c8ctl-plugin-". The plugin is registered by the suffix after the prefix.
    Example: "c8ctl init plugin foo" creates directory "c8ctl-plugin-foo"
    and registers plugin name "foo". Likewise, "c8ctl init plugin
    c8ctl-plugin-foo" produces the same result.

Examples:
  c8ctl load plugin my-plugin
  c8ctl load plugin --from https://github.com/org/plugin
  c8ctl load plugin --from file:///path/to/plugin
  c8ctl list plugins
  c8ctl unload plugin my-plugin
  c8ctl unload plugin my-plugin --force
  c8ctl upgrade plugin my-plugin
  c8ctl upgrade plugin my-plugin 1.2.3
  c8ctl downgrade plugin my-plugin 1.0.0
  c8ctl init plugin my-plugin
`.trim());
}

/**
 * Show detailed help for delete command
 */
export function showDeleteHelp(): void {
  console.log(`
c8ctl delete - Delete a resource

Usage: c8ctl delete <resource> <id> [flags]

Resources and their available flags:

  user <username>
    --profile <name>         Use specific profile

  role <roleId>
    --profile <name>         Use specific profile

  group <groupId>
    --profile <name>         Use specific profile

  tenant <tenantId>
    --profile <name>         Use specific profile

  authorization (auth) <key>
    --profile <name>         Use specific profile

  mapping-rule (mr) <id>
    --profile <name>         Use specific profile

Examples:
  c8ctl delete user john
  c8ctl delete role my-role
  c8ctl delete group developers
  c8ctl delete tenant prod
  c8ctl delete auth 123456
  c8ctl delete mapping-rule abc123
`.trim());
}

/**
 * Show detailed help for assign command
 */
export function showAssignHelp(): void {
  console.log(`
c8ctl assign - Assign a resource to a target

Usage: c8ctl assign <resource> <id> --to-<target>=<targetId> [flags]

Resources:

  role <roleId>
    --to-user <username>     Assign role to user
    --to-group <groupId>     Assign role to group
    --to-tenant <tenantId>   Assign role to tenant
    --to-mapping-rule <id>   Assign role to mapping rule
    --profile <name>         Use specific profile

  user <username>
    --to-group <groupId>     Assign user to group
    --to-tenant <tenantId>   Assign user to tenant
    --profile <name>         Use specific profile

  group <groupId>
    --to-tenant <tenantId>   Assign group to tenant
    --profile <name>         Use specific profile

  mapping-rule <id>
    --to-group <groupId>     Assign mapping rule to group
    --to-tenant <tenantId>   Assign mapping rule to tenant
    --profile <name>         Use specific profile

Examples:
  c8ctl assign role admin --to-user=john
  c8ctl assign role admin --to-group=developers
  c8ctl assign user john --to-group=developers
  c8ctl assign user john --to-tenant=prod
  c8ctl assign group developers --to-tenant=prod
  c8ctl assign mapping-rule my-rule --to-group=developers
`.trim());
}

/**
 * Show detailed help for unassign command
 */
export function showUnassignHelp(): void {
  console.log(`
c8ctl unassign - Unassign a resource from a target

Usage: c8ctl unassign <resource> <id> --from-<target>=<targetId> [flags]

Resources:

  role <roleId>
    --from-user <username>     Unassign role from user
    --from-group <groupId>     Unassign role from group
    --from-tenant <tenantId>   Unassign role from tenant
    --from-mapping-rule <id>   Unassign role from mapping rule
    --profile <name>           Use specific profile

  user <username>
    --from-group <groupId>     Unassign user from group
    --from-tenant <tenantId>   Unassign user from tenant
    --profile <name>           Use specific profile

  group <groupId>
    --from-tenant <tenantId>   Unassign group from tenant
    --profile <name>           Use specific profile

  mapping-rule <id>
    --from-group <groupId>     Unassign mapping rule from group
    --from-tenant <tenantId>   Unassign mapping rule from tenant
    --profile <name>           Use specific profile

Examples:
  c8ctl unassign role admin --from-user=john
  c8ctl unassign role admin --from-group=developers
  c8ctl unassign user john --from-group=developers
  c8ctl unassign group developers --from-tenant=prod
  c8ctl unassign mapping-rule my-rule --from-group=developers
`.trim());
}

/**
 * Show detailed help for specific commands
 */
export function showCommandHelp(command: string): void {
  const logger = getLogger();

  // JSON mode: emit structured help for machine/agent consumption
  if (logger.mode === 'json') {
    const version = getVersion();
    const pluginCommandsInfo = getPluginCommandsInfo();
    const allHelp = buildHelpJson(version, pluginCommandsInfo) as Record<string, unknown>;
    const commands = allHelp.commands as Array<Record<string, unknown>> | undefined;
    const commandEntry = commands?.find((c) => c.verb === command);
    logger.json({
      command,
      ...(commandEntry ?? { verb: command, description: `No detailed help available for: ${command}` }),
      globalFlags: allHelp.globalFlags,
      searchFlags: allHelp.searchFlags,
      agentFlags: allHelp.agentFlags,
    });
    return;
  }

  switch (command) {
    case 'list':
      showListHelp();
      break;
    case 'get':
      showGetHelp();
      break;
    case 'create':
      showCreateHelp();
      break;
    case 'complete':
      showCompleteHelp();
      break;
    case 'await':
      showAwaitHelp();
      break;
    case 'mcp-proxy':
      showMcpProxyHelp();
      break;
    case 'search':
      showSearchHelp();
      break;
    case 'deploy':
      showDeployHelp();
      break;
    case 'run':
      showRunHelp();
      break;
    case 'watch':
    case 'w':
      showWatchHelp();
      break;
    case 'open':
      showOpenHelp();
      break;
    case 'cancel':
      showCancelHelp();
      break;
    case 'resolve':
      showResolveHelp();
      break;
    case 'fail':
      showFailHelp();
      break;
    case 'activate':
      showActivateHelp();
      break;
    case 'publish':
      showPublishHelp();
      break;
    case 'correlate':
      showCorrelateHelp();
      break;
    case 'delete':
      showDeleteHelp();
      break;
    case 'assign':
      showAssignHelp();
      break;
    case 'unassign':
      showUnassignHelp();
      break;
    case 'profiles':
    case 'profile':
      showProfilesHelp();
      break;
    case 'plugin':
    case 'plugins':
      showPluginHelp();
      break;
    default:
      console.log(`\nNo detailed help available for: ${command}`);
      console.log('Run "c8ctl help" for general usage information.');
  }
}
