#!/usr/bin/env node
/**
 * c8ctl - Camunda 8 CLI
 * Main entry point
 */

import { parseArgs } from 'node:util';
import { getLogger } from './logger.ts';
import { c8ctl } from './runtime.ts';
import { loadSessionState } from './config.ts';
import { showHelp, showVersion, showVerbResources, showCommandHelp } from './commands/help.ts';
import { useProfile, useTenant, setOutputFormat } from './commands/session.ts';
import { listProfiles, addProfile, removeProfile } from './commands/profiles.ts';
import {
  listProcessInstances,
  getProcessInstance,
  createProcessInstance,
  cancelProcessInstance,
} from './commands/process-instances.ts';
import {
  listProcessDefinitions,
  getProcessDefinition,
} from './commands/process-definitions.ts';
import {
  searchProcessDefinitions,
  searchProcessInstances,
  searchUserTasks,
  searchIncidents,
  searchJobs,
  searchVariables,
} from './commands/search.ts';
import { listUserTasks, completeUserTask } from './commands/user-tasks.ts';
import { listIncidents, getIncident, resolveIncident } from './commands/incidents.ts';
import { listJobs, activateJobs, completeJob, failJob } from './commands/jobs.ts';
import { publishMessage, correlateMessage } from './commands/messages.ts';
import { getTopology } from './commands/topology.ts';
import { deploy } from './commands/deployments.ts';
import { run } from './commands/run.ts';
import { watchFiles } from './commands/watch.ts';
import { loadPlugin, unloadPlugin, listPlugins, syncPlugins, upgradePlugin, downgradePlugin, initPlugin } from './commands/plugins.ts';
import { showCompletion } from './commands/completion.ts';
import { getUserTaskForm, getStartForm, getForm } from './commands/forms.ts';
import { 
  loadInstalledPlugins, 
  executePluginCommand
} from './plugin-loader.ts';
import { mcpProxy } from './commands/mcp-proxy.ts';

/**
 * Normalize resource aliases
 */
function normalizeResource(resource: string): string {
  const aliases: Record<string, string> = {
    pi: 'process-instance',
    pd: 'process-definition',
    ut: 'user-task',
    inc: 'incident',
    msg: 'message',
    profile: 'profile',
    profiles: 'profile',
    plugin: 'plugin',
    plugins: 'plugin',
  };
  return aliases[resource] || resource;
}

/**
 * Parse command line arguments
 */
function parseCliArgs() {
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'string', short: 'v' },
        all: { type: 'boolean' },
        xml: { type: 'boolean' },
        profile: { type: 'string' },
        bpmnProcessId: { type: 'string' },
        id: { type: 'string' },
        processDefinitionId: { type: 'string' },
        processInstanceKey: { type: 'string' },
        processDefinitionKey: { type: 'string' },
        parentProcessInstanceKey: { type: 'string' },
        variables: { type: 'string' },
        state: { type: 'string' },
        assignee: { type: 'string' },
        type: { type: 'string' },
        correlationKey: { type: 'string' },
        timeToLive: { type: 'string' },
        maxJobsToActivate: { type: 'string' },
        timeout: { type: 'string' },
        worker: { type: 'string' },
        retries: { type: 'string' },
        errorMessage: { type: 'string' },
        baseUrl: { type: 'string' },
        clientId: { type: 'string' },
        clientSecret: { type: 'string' },
        audience: { type: 'string' },
        oAuthUrl: { type: 'string' },
        defaultTenantId: { type: 'string' },
        from: { type: 'string' },
        name: { type: 'string' },
        key: { type: 'string' },
        elementId: { type: 'string' },
        errorType: { type: 'string' },
        awaitCompletion: { type: 'boolean' },
        fetchVariables: { type: 'boolean' },
        value: { type: 'string' },
        scopeKey: { type: 'string' },
        fullValue: { type: 'boolean' },
        userTask: { type: 'boolean' },
        processDefinition: { type: 'boolean' },
        iname: { type: 'string' },
        iid: { type: 'string' },
        iassignee: { type: 'string' },
        ierrorMessage: { type: 'string' },
        itype: { type: 'string' },
        ivalue: { type: 'string' },
      },
      allowPositionals: true,
      strict: false,
    });

    return { values, positionals };
  } catch (error: any) {
    console.error(`Error parsing arguments: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Resolve process definition ID from --id, --processDefinitionId, or --bpmnProcessId flag
 */
function resolveProcessDefinitionId(values: any): string | undefined {
  return (values.id || values.processDefinitionId || values.bpmnProcessId) as string | undefined;
}

/**
 * Main CLI handler
 */
async function main() {
  // Load session state from disk at startup
  loadSessionState();
  
  const { values, positionals } = parseCliArgs();

  // Initialize logger with current output mode from c8ctl runtime
  const logger = getLogger(c8ctl.outputMode);

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
  if (verb === 'help' || verb === 'menu' || verb === '--help' || verb === '-h') {
    // Check if user wants help for a specific command
    if (resource) {
      showCommandHelp(resource);
    } else {
      showHelp();
    }
    return;
  }

  // Handle completion command
  if (verb === 'completion') {
    showCompletion(resource);
    return;
  }

  // Normalize resource
  const normalizedResource = resource ? normalizeResource(resource) : '';

  // Handle session commands
  if (verb === 'use') {
    if (normalizedResource === 'profile') {
      if (!args[0]) {
        logger.error('Profile name required. Usage: c8 use profile <name>');
        process.exit(1);
      }
      useProfile(args[0]);
      return;
    }
    if (normalizedResource === 'tenant') {
      if (!args[0]) {
        logger.error('Tenant ID required. Usage: c8 use tenant <id>');
        process.exit(1);
      }
      useTenant(args[0]);
      return;
    }
    showVerbResources('use');
    return;
  }

  if (verb === 'output') {
    if (!resource) {
      logger.error('Output mode required. Usage: c8 output json|text');
      process.exit(1);
    }
    setOutputFormat(resource);
    return;
  }

  // Handle profile commands
  if (verb === 'list' && normalizedResource === 'profile') {
    listProfiles();
    return;
  }

  if (verb === 'add' && normalizedResource === 'profile') {
    if (!args[0]) {
      logger.error('Profile name required. Usage: c8 add profile <name> --baseUrl=<url>');
      process.exit(1);
    }
    addProfile(args[0], {
      url: typeof values.baseUrl === 'string' ? values.baseUrl : undefined,
      clientId: typeof values.clientId === 'string' ? values.clientId : undefined,
      clientSecret: typeof values.clientSecret === 'string' ? values.clientSecret : undefined,
      audience: typeof values.audience === 'string' ? values.audience : undefined,
      oauthUrl: typeof values.oAuthUrl === 'string' ? values.oAuthUrl : undefined,
      tenantId: typeof values.defaultTenantId === 'string' ? values.defaultTenantId : undefined,
    });
    return;
  }

  if ((verb === 'remove' || verb === 'rm') && normalizedResource === 'profile') {
    if (!args[0]) {
      logger.error('Profile name required. Usage: c8 remove profile <name>');
      process.exit(1);
    }
    removeProfile(args[0]);
    return;
  }

  // Handle plugin commands
  if (verb === 'list' && normalizedResource === 'plugin') {
    listPlugins();
    return;
  }

  if (verb === 'load' && normalizedResource === 'plugin') {
    const fromUrl = values.from as string | undefined;
    const packageName = args[0];
    
    // Ensure exclusive usage
    if (packageName && fromUrl) {
      logger.error('Cannot specify both package name and --from flag. Use either "c8 load plugin <name>" or "c8 load plugin --from <url>"');
      process.exit(1);
    }
    
    if (!packageName && !fromUrl) {
      logger.error('Package name or --from URL required. Usage: c8 load plugin <package-name> OR c8 load plugin --from <url>');
      process.exit(1);
    }
    
    await loadPlugin(packageName, fromUrl);
    return;
  }

  if ((verb === 'unload' || verb === 'remove' || verb === 'rm') && normalizedResource === 'plugin') {
    if (!args[0]) {
      logger.error('Package name required. Usage: c8 unload plugin <package-name>');
      process.exit(1);
    }
    await unloadPlugin(args[0]);
    return;
  }

  if (verb === 'sync' && normalizedResource === 'plugin') {
    await syncPlugins();
    return;
  }

  if (verb === 'upgrade' && normalizedResource === 'plugin') {
    if (!args[0]) {
      logger.error('Package name required. Usage: c8 upgrade plugin <package-name> [version]');
      process.exit(1);
    }
    await upgradePlugin(args[0], args[1]);
    return;
  }

  if (verb === 'downgrade' && normalizedResource === 'plugin') {
    if (!args[0] || !args[1]) {
      logger.error('Package name and version required. Usage: c8 downgrade plugin <package-name> <version>');
      process.exit(1);
    }
    await downgradePlugin(args[0], args[1]);
    return;
  }

  if (verb === 'init' && normalizedResource === 'plugin') {
    await initPlugin(args[0]);
    return;
  }

  // Handle process instance commands
  if (verb === 'list' && (normalizedResource === 'process-instance' || normalizedResource === 'process-instances')) {
    await listProcessInstances({
      profile: values.profile as string | undefined,
      processDefinitionId: resolveProcessDefinitionId(values),
      state: values.state as string | undefined,
      all: values.all as boolean | undefined,
    });
    return;
  }

  if (verb === 'get' && normalizedResource === 'process-instance') {
    if (!args[0]) {
      logger.error('Process instance key required. Usage: c8 get pi <key>');
      process.exit(1);
    }
    // Check if --variables flag is present via parsed arguments
    // When used as a flag without value, it becomes true; with a value it becomes a string
    const includeVariables = Boolean(values.variables);
    await getProcessInstance(args[0], {
      profile: values.profile as string | undefined,
      variables: includeVariables,
    });
    return;
  }

  if (verb === 'create' && normalizedResource === 'process-instance') {
    await createProcessInstance({
      profile: values.profile as string | undefined,
      processDefinitionId: resolveProcessDefinitionId(values),
      version: (values.version && typeof values.version === 'string') ? parseInt(values.version) : undefined,
      variables: values.variables as string | undefined,
      awaitCompletion: values.awaitCompletion as boolean | undefined,
      fetchVariables: values.fetchVariables as boolean | undefined,
    });
    return;
  }

  if (verb === 'cancel' && normalizedResource === 'process-instance') {
    if (!args[0]) {
      logger.error('Process instance key required. Usage: c8 cancel pi <key>');
      process.exit(1);
    }
    await cancelProcessInstance(args[0], {
      profile: values.profile as string | undefined,
    });
    return;
  }

  // Handle await command - alias for create with awaitCompletion
  if (verb === 'await' && normalizedResource === 'process-instance') {
    // await pi is an alias for create pi with --awaitCompletion
    // It supports the same flags as create (id, variables, version, etc.)
    await createProcessInstance({
      profile: values.profile as string | undefined,
      processDefinitionId: resolveProcessDefinitionId(values),
      version: values.version as number | undefined,
      variables: values.variables as string | undefined,
      awaitCompletion: true,  // Always true for await command
      fetchVariables: values.fetchVariables as boolean | undefined,
    });
    return;
  }

  // Handle process definition commands
  if (verb === 'list' && (normalizedResource === 'process-definition' || normalizedResource === 'process-definitions')) {
    await listProcessDefinitions({
      profile: values.profile as string | undefined,
    });
    return;
  }

  if (verb === 'get' && normalizedResource === 'process-definition') {
    if (!args[0]) {
      logger.error('Process definition key required. Usage: c8 get pd <key>');
      process.exit(1);
    }
    await getProcessDefinition(args[0], {
      profile: values.profile as string | undefined,
      xml: values.xml as boolean | undefined,
    });
    return;
  }

  // Handle user task commands
  if (verb === 'list' && (normalizedResource === 'user-task' || normalizedResource === 'user-tasks')) {
    await listUserTasks({
      profile: values.profile as string | undefined,
      state: values.state as string | undefined,
      assignee: values.assignee as string | undefined,
      all: values.all as boolean | undefined,
    });
    return;
  }

  if (verb === 'complete' && normalizedResource === 'user-task') {
    if (!args[0]) {
      logger.error('User task key required. Usage: c8 complete ut <key>');
      process.exit(1);
    }
    await completeUserTask(args[0], {
      profile: values.profile as string | undefined,
      variables: values.variables as string | undefined,
    });
    return;
  }

  // Handle incident commands
  if (verb === 'list' && (normalizedResource === 'incident' || normalizedResource === 'incidents')) {
    await listIncidents({
      profile: values.profile as string | undefined,
      state: values.state as string | undefined,
      processInstanceKey: values.processInstanceKey as string | undefined,
    });
    return;
  }

  if (verb === 'get' && normalizedResource === 'incident') {
    if (!args[0]) {
      logger.error('Incident key required. Usage: c8 get inc <key>');
      process.exit(1);
    }
    await getIncident(args[0], {
      profile: values.profile as string | undefined,
    });
    return;
  }

  if (verb === 'resolve' && normalizedResource === 'incident') {
    if (!args[0]) {
      logger.error('Incident key required. Usage: c8 resolve inc <key>');
      process.exit(1);
    }
    await resolveIncident(args[0], {
      profile: values.profile as string | undefined,
    });
    return;
  }

  // Handle job commands
  if (verb === 'list' && normalizedResource === 'jobs') {
    await listJobs({
      profile: values.profile as string | undefined,
      state: values.state as string | undefined,
      type: values.type as string | undefined,
    });
    return;
  }

  if (verb === 'activate' && normalizedResource === 'jobs') {
    if (!args[0]) {
      logger.error('Job type required. Usage: c8 activate jobs <type>');
      process.exit(1);
    }
    await activateJobs(args[0], {
      profile: values.profile as string | undefined,
      maxJobsToActivate: (values.maxJobsToActivate && typeof values.maxJobsToActivate === 'string') ? parseInt(values.maxJobsToActivate) : undefined,
      timeout: (values.timeout && typeof values.timeout === 'string') ? parseInt(values.timeout) : undefined,
      worker: values.worker as string | undefined,
    });
    return;
  }

  if (verb === 'complete' && normalizedResource === 'job') {
    if (!args[0]) {
      logger.error('Job key required. Usage: c8 complete job <key>');
      process.exit(1);
    }
    await completeJob(args[0], {
      profile: values.profile as string | undefined,
      variables: values.variables as string | undefined,
    });
    return;
  }

  if (verb === 'fail' && normalizedResource === 'job') {
    if (!args[0]) {
      logger.error('Job key required. Usage: c8 fail job <key>');
      process.exit(1);
    }
    await failJob(args[0], {
      profile: values.profile as string | undefined,
      retries: (values.retries && typeof values.retries === 'string') ? parseInt(values.retries) : undefined,
      errorMessage: values.errorMessage as string | undefined,
    });
    return;
  }

  // Handle message commands
  if (verb === 'publish' && normalizedResource === 'message') {
    if (!args[0]) {
      logger.error('Message name required. Usage: c8 publish msg <name>');
      process.exit(1);
    }
    await publishMessage(args[0], {
      profile: values.profile as string | undefined,
      correlationKey: values.correlationKey as string | undefined,
      variables: values.variables as string | undefined,
      timeToLive: (values.timeToLive && typeof values.timeToLive === 'string') ? parseInt(values.timeToLive) : undefined,
    });
    return;
  }

  if (verb === 'correlate' && normalizedResource === 'message') {
    if (!args[0]) {
      logger.error('Message name required. Usage: c8 correlate msg <name>');
      process.exit(1);
    }
    await correlateMessage(args[0], {
      profile: values.profile as string | undefined,
      correlationKey: values.correlationKey as string | undefined,
      variables: values.variables as string | undefined,
      timeToLive: (values.timeToLive && typeof values.timeToLive === 'string') ? parseInt(values.timeToLive) : undefined,
    });
    return;
  }

  // Handle topology command
  if (verb === 'get' && normalizedResource === 'topology') {
    await getTopology({
      profile: values.profile as string | undefined,
    });
    return;
  }

  // Handle form commands
  if (verb === 'get' && normalizedResource === 'form') {
    if (!args[0]) {
      logger.error('Key required. Usage: c8 get form <key> [--userTask|--ut] [--processDefinition|--pd]');
      process.exit(1);
    }
    
    // Check for flags and their aliases
    const isUserTask = process.argv.includes('--userTask') || process.argv.includes('--ut');
    const isProcessDefinition = process.argv.includes('--processDefinition') || process.argv.includes('--pd');
    
    // If both flags specified, error
    if (isUserTask && isProcessDefinition) {
      logger.error('Cannot specify both --userTask|--ut and --processDefinition|--pd. Use one or the other, or omit both to search both types.');
      process.exit(1);
    }
    
    // If specific flag provided, use that API
    if (isUserTask) {
      await getUserTaskForm(args[0], {
        profile: values.profile as string | undefined,
      });
    } else if (isProcessDefinition) {
      await getStartForm(args[0], {
        profile: values.profile as string | undefined,
      });
    } else {
      // No flag provided - try both
      await getForm(args[0], {
        profile: values.profile as string | undefined,
      });
    }
    return;
  }

  // Handle deploy command
  if (verb === 'deploy') {
    const paths = resource ? [resource, ...args] : (args.length > 0 ? args : ['.']);
    await deploy(paths, {
      profile: values.profile as string | undefined,
    });
    return;
  }

  // Handle run command
  if (verb === 'run') {
    if (!resource) {
      logger.error('BPMN file path required. Usage: c8 run <path>');
      process.exit(1);
    }
    await run(resource, {
      profile: values.profile as string | undefined,
      variables: values.variables as string | undefined,
    });
    return;
  }

  // Handle watch command
  if (verb === 'watch' || verb === 'w') {
    const paths = resource ? [resource, ...args] : (args.length > 0 ? args : ['.']);
    await watchFiles(paths, {
      profile: values.profile as string | undefined,
    });
    return;
  }

  // Handle mcp-proxy command
  if (verb === 'mcp-proxy') {
    await mcpProxy(positionals.slice(1), {
      profile: values.profile as string | undefined,
    });
    return;
  }

  // Handle search commands
  if (verb === 'search') {
    const normalizedSearchResource = normalizeResource(resource);
    
    if (normalizedSearchResource === 'process-definition' || normalizedSearchResource === 'process-definitions') {
      await searchProcessDefinitions({
        profile: values.profile as string | undefined,
        processDefinitionId: values.bpmnProcessId as string | undefined,
        name: values.name as string | undefined,
        version: (values.version_num && typeof values.version_num === 'string') ? parseInt(values.version_num) : undefined,
        key: values.key as string | undefined,
        iProcessDefinitionId: values.iid as string | undefined,
        iName: values.iname as string | undefined,
      });
      return;
    }

    if (normalizedSearchResource === 'process-instance' || normalizedSearchResource === 'process-instances') {
      await searchProcessInstances({
        profile: values.profile as string | undefined,
        processDefinitionId: values.bpmnProcessId as string | undefined,
        processDefinitionKey: values.processDefinitionKey as string | undefined,
        state: values.state as string | undefined,
        key: values.key as string | undefined,
        parentProcessInstanceKey: values.parentProcessInstanceKey as string | undefined,
        iProcessDefinitionId: values.iid as string | undefined,
      });
      return;
    }

    if (normalizedSearchResource === 'user-task' || normalizedSearchResource === 'user-tasks') {
      await searchUserTasks({
        profile: values.profile as string | undefined,
        state: values.state as string | undefined,
        assignee: values.assignee as string | undefined,
        processInstanceKey: values.processInstanceKey as string | undefined,
        processDefinitionKey: values.processDefinitionKey as string | undefined,
        elementId: values.elementId as string | undefined,
        iAssignee: values.iassignee as string | undefined,
      });
      return;
    }

    if (normalizedSearchResource === 'incident' || normalizedSearchResource === 'incidents') {
      await searchIncidents({
        profile: values.profile as string | undefined,
        state: values.state as string | undefined,
        processInstanceKey: values.processInstanceKey as string | undefined,
        processDefinitionKey: values.processDefinitionKey as string | undefined,
        processDefinitionId: values.bpmnProcessId as string | undefined,
        errorType: values.errorType as string | undefined,
        errorMessage: values.errorMessage as string | undefined,
        iErrorMessage: values.ierrorMessage as string | undefined,
        iProcessDefinitionId: values.iid as string | undefined,
      });
      return;
    }

    if (normalizedSearchResource === 'jobs') {
      await searchJobs({
        profile: values.profile as string | undefined,
        state: values.state as string | undefined,
        type: values.type as string | undefined,
        processInstanceKey: values.processInstanceKey as string | undefined,
        processDefinitionKey: values.processDefinitionKey as string | undefined,
        iType: values.itype as string | undefined,
      });
      return;
    }

    if (normalizedSearchResource === 'variable' || normalizedSearchResource === 'variables') {
      await searchVariables({
        profile: values.profile as string | undefined,
        name: values.name as string | undefined,
        value: values.value as string | undefined,
        processInstanceKey: values.processInstanceKey as string | undefined,
        scopeKey: values.scopeKey as string | undefined,
        fullValue: values.fullValue as boolean | undefined,
        iName: values.iname as string | undefined,
        iValue: values.ivalue as string | undefined,
      });
      return;
    }

    // If resource not recognized for search, show available resources
    showVerbResources('search');
    return;
  }

  // Try to execute plugin command (before verb-only check)
  if (await executePluginCommand(verb, resource ? [resource, ...args] : args)) {
    return;
  }

  // Handle verb-only invocations (show available resources)
  if (!resource) {
    showVerbResources(verb);
    return;
  }

  // Unknown command
  logger.error(`Unknown command: ${verb} ${resource}`);
  logger.info('Run "c8 help" for usage information');
  process.exit(1);
}

// Run the CLI
main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
