/**
 * Help and version commands
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLogger } from '../logger.ts';
import { getPluginCommandsInfo } from '../plugin-loader.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  const version = getVersion();
  const pluginCommandsInfo = getPluginCommandsInfo();
  
  let pluginSection = '';
  if (pluginCommandsInfo.length > 0) {
    pluginSection = '\n\nPlugin Commands:';
    for (const cmd of pluginCommandsInfo) {
      const desc = cmd.description ? `  ${cmd.description}` : '';
      pluginSection += `\n  ${cmd.commandName.padEnd(20)}${desc}`;
    }
  }
  
  console.log(`
c8ctl - Camunda 8 CLI v${version}

Usage: c8ctl <command> [resource] [options]

Commands:
  list      <resource>       List resources (pi, pd, ut, inc, jobs, profiles)
  get       <resource> <key> Get resource by key (pi, pd, inc, topology, form)
  create    <resource>       Create resource (pi)
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
  add       profile <name>   Add a profile
  remove    profile <name>   Remove a profile (alias: rm)
  load      plugin <name>    Load a c8ctl plugin from npm registry
  load      plugin --from    Load a c8ctl plugin from URL (file://, https://, git://)
  unload    plugin <name>    Unload a c8ctl plugin (npm uninstall wrapper)
  sync      plugin           Synchronize plugins from registry (rebuild/reinstall)
  use       profile|tenant   Set active profile or tenant
  output    json|text        Set output format
  completion bash|zsh|fish   Generate shell completion script
  help      [command]        Show help (detailed help for list, get, create, complete, await)${pluginSection}

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
  --version, -v         Show version
  --help, -h            Show help

Resource Aliases:
  pi   = process-instance(s)
  pd   = process-definition(s)
  ut   = user-task(s)
  inc  = incident(s)
  msg  = message

Examples:
  c8ctl list pi                      List process instances
  c8ctl list pd                      List process definitions
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
  c8ctl use profile prod             Set active profile
  c8ctl output json                  Switch to JSON output
  c8ctl load plugin my-plugin        Load plugin from npm registry
  c8ctl load plugin --from file:///path/to/plugin  Load plugin from file URL
  c8ctl sync plugin                  Synchronize plugins
  c8ctl completion bash              Generate bash completion script

For detailed help on specific commands with all available flags:
  c8ctl help list                    Show all list resources and their flags
  c8ctl help get                     Show all get resources and their flags
  c8ctl help create                  Show all create resources and their flags
  c8ctl help complete                Show all complete resources and their flags
  c8ctl help await                   Show await command with all flags
`.trim());
}

/**
 * Show available resources for a verb
 */
export function showVerbResources(verb: string): void {
  const resources: Record<string, string> = {
    list: 'process-instances (pi), process-definitions (pd), user-tasks (ut), incidents (inc), jobs, profiles, plugins',
    get: 'process-instance (pi), process-definition (pd), incident (inc), topology, form',
    create: 'process-instance (pi)',
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
    use: 'profile, tenant',
    output: 'json, text',
    completion: 'bash, zsh, fish',
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
    --state <state>          Filter by state (ACTIVE, COMPLETED, etc.)
    --all                    List all instances (pagination)
    --profile <name>         Use specific profile

  process-definitions (pd)
    --profile <name>         Use specific profile

  user-tasks (ut)
    --state <state>          Filter by state (CREATED, COMPLETED, etc.)
    --assignee <name>        Filter by assignee
    --all                    List all tasks (pagination)
    --profile <name>         Use specific profile

  incidents (inc)
    --state <state>          Filter by state (ACTIVE, RESOLVED, etc.)
    --processInstanceKey <key>  Filter by process instance
    --profile <name>         Use specific profile

  jobs
    --state <state>          Filter by state (ACTIVATABLE, ACTIVATED, etc.)
    --type <type>            Filter by job type
    --profile <name>         Use specific profile

  profiles
    Lists both c8ctl and Camunda Modeler profiles
    (Modeler profiles are shown with 'modeler:' prefix)

  plugins
    Shows installed plugins with sync status

Examples:
  c8ctl list pi --state=ACTIVE
  c8ctl list ut --assignee=john.doe
  c8ctl list inc --processInstanceKey=123456
  c8ctl list jobs --type=email-service
  c8ctl list profiles
  c8ctl list plugins
`.trim());
}

/**
 * Show detailed help for get command
 */
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
    --profile <name>         Use specific profile

Examples:
  c8ctl create pi --id=order-process
  c8ctl create pi --id=order-process --version=2
  c8ctl create pi --id=order-process --variables='{"orderId":"12345"}'
  c8ctl create pi --id=order-process --awaitCompletion
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
    --profile <name>         Use specific profile

Description:
  Creates a process instance and waits for it to reach a terminal state (COMPLETED, CANCELED).
  Returns the full process instance with all variables when complete.
  Uses the Camunda 8 API's built-in awaitCompletion parameter for reliable server-side waiting.

Examples:
  c8ctl await pi --id=order-process
  c8ctl await pi --id=order-process --variables='{"orderId":"12345"}'
  
  # Equivalent to:
  c8ctl create pi --id=order-process --awaitCompletion
`.trim());
}

/**
 * Show detailed help for specific commands
 */
export function showCommandHelp(command: string): void {
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
    default:
      console.log(`\nNo detailed help available for: ${command}`);
      console.log('Run "c8ctl help" for general usage information.');
  }
}
