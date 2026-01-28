/**
 * Help and version commands
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLogger } from '../logger.ts';

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
  console.log(`
c8ctl - Camunda 8 CLI v${version}

Usage: c8 <command> [resource] [options]

Commands:
  list      <resource>       List resources (pi, ut, inc, jobs, profiles)
  get       <resource> <key> Get resource by key (pi, topology)
  create    <resource>       Create resource (pi)
  cancel    <resource> <key> Cancel resource (pi)
  complete  <resource> <key> Complete resource (ut, job)
  fail      job <key>        Fail a job
  activate  jobs <type>      Activate jobs by type
  resolve   inc <key>        Resolve incident
  publish   msg <name>       Publish message
  correlate msg <name>       Correlate message
  deploy    [path...]        Deploy BPMN/DMN/forms (use --all to deploy all from dir)
  run       <path>           Deploy and start process
  add       profile <name>   Add a profile
  remove    profile <name>   Remove a profile (alias: rm)
  load      plugin <name>    Load a c8ctl plugin (npm install wrapper)
  unload    plugin <name>    Unload a c8ctl plugin (npm uninstall wrapper)
  use       profile|tenant   Set active profile or tenant
  output    json|text        Set output format
  help                       Show this help

Flags:
  --profile <name>  Use specific profile for this command
  --all             Deploy all resources from directory
  --version, -v     Show version
  --help, -h        Show help

Resource Aliases:
  pi   = process-instance(s)
  ut   = user-task(s)
  inc  = incident(s)
  msg  = message

Examples:
  c8 list pi                      List process instances
  c8 get pi 123456                Get process instance by key
  c8 create pi --bpmnProcessId=myProcess
  c8 deploy ./my-process.bpmn     Deploy a BPMN file
  c8 run ./my-process.bpmn        Deploy and start process
  c8 use profile prod             Set active profile
  c8 output json                  Switch to JSON output
`.trim());
}

/**
 * Show available resources for a verb
 */
export function showVerbResources(verb: string): void {
  const resources: Record<string, string> = {
    list: 'process-instances (pi), user-tasks (ut), incidents (inc), jobs, profiles, plugins',
    get: 'process-instance (pi), topology',
    create: 'process-instance (pi)',
    complete: 'user-task (ut), job',
    cancel: 'process-instance (pi)',
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
    use: 'profile, tenant',
    output: 'json, text',
  };

  const available = resources[verb];
  if (available) {
    console.log(`\nUsage: c8 ${verb} <resource>\n`);
    console.log(`Available resources:\n  ${available}`);
  } else {
    console.log(`\nUnknown command: ${verb}`);
    console.log('Run "c8 help" for usage information.');
  }
}
