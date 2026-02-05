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
  get       <resource> <key> Get resource by key (pi, pd, topology)
  create    <resource>       Create resource (pi)
  cancel    <resource> <key> Cancel resource (pi)
  await     <resource> <key> Await resource completion (pi)
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
  help                       Show this help${pluginSection}

Flags:
  --profile <name>      Use specific profile for this command
  --from <url>          Load plugin from URL (use with 'load plugin')
  --xml                 Get process definition as XML (use with 'get pd')
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
  c8ctl get pd 123456                Get process definition by key
  c8ctl get pd 123456 --xml          Get process definition XML
  c8ctl create pi --id=myProcess
  c8ctl create pi --id=myProcess --awaitCompletion
  c8ctl await pi 123456              Wait for process instance to complete
  c8ctl deploy ./my-process.bpmn     Deploy a BPMN file
  c8ctl run ./my-process.bpmn        Deploy and start process
  c8ctl watch ./src                  Watch directory for changes
  c8ctl use profile prod             Set active profile
  c8ctl output json                  Switch to JSON output
  c8ctl load plugin my-plugin        Load plugin from npm registry
  c8ctl load plugin --from file:///path/to/plugin  Load plugin from file URL
  c8ctl sync plugin                  Synchronize plugins
  c8ctl completion bash              Generate bash completion script
`.trim());
}

/**
 * Show available resources for a verb
 */
export function showVerbResources(verb: string): void {
  const resources: Record<string, string> = {
    list: 'process-instances (pi), process-definitions (pd), user-tasks (ut), incidents (inc), jobs, profiles, plugins',
    get: 'process-instance (pi), process-definition (pd), topology',
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
