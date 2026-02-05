/**
 * c8ctl - Camunda 8 CLI
 * Runtime-agnostic CLI runner (Node entrypoint + Deno entrypoint call into this)
 */

import { parseArgs } from 'node:util';
import { getLogger } from './logger.ts';
import { c8ctl } from './runtime.ts';
import { loadSessionState } from './config.ts';
import { showHelp, showVersion, showVerbResources } from './commands/help.ts';
import { useProfile, useTenant, setOutputFormat } from './commands/session.ts';
import { listProfiles, addProfile, removeProfile } from './commands/profiles.ts';
import { loadPlugin, unloadPlugin, listPlugins, syncPlugins } from './commands/plugins.ts';
import { showCompletion } from './commands/completion.ts';
import {
  loadInstalledPlugins,
  executePluginCommand,
} from './plugin-loader.ts';

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
function parseCliArgs(argv: string[]) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        all: { type: 'boolean' },
        xml: { type: 'boolean' },
        profile: { type: 'string' },
        bpmnProcessId: { type: 'string' },
        processInstanceKey: { type: 'string' },
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
        version_num: { type: 'string' },
        from: { type: 'string' },
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
 * Main CLI handler
 */
export async function runCli(argv: string[]): Promise<void> {
  // Load session state from disk at startup
  loadSessionState();

  const { values, positionals } = parseCliArgs(argv);

  // Initialize logger with current output mode from c8ctl runtime
  const logger = getLogger(c8ctl.outputMode);

  // Load installed plugins
  await loadInstalledPlugins();

  // Handle global flags
  if (values.version) {
    showVersion();
    return;
  }

  if (values.help && positionals.length === 0) {
    showHelp();
    return;
  }

  // Extract command and resource
  const [verb, resource, ...args] = positionals;

  if (!verb) {
    showHelp();
    return;
  }

  // Handle help command
  if (verb === 'help' || verb === 'menu' || verb === '--help' || verb === '-h') {
    showHelp();
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

  // Handle process instance commands
  if (verb === 'list' && (normalizedResource === 'process-instance' || normalizedResource === 'process-instances')) {
    const { listProcessInstances } = await import('./commands/process-instances.ts');
    await listProcessInstances({
      profile: values.profile as string | undefined,
      processDefinitionId: values.bpmnProcessId as string | undefined,
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
    const { getProcessInstance } = await import('./commands/process-instances.ts');
    await getProcessInstance(args[0], {
      profile: values.profile as string | undefined,
    });
    return;
  }

  if (verb === 'create' && normalizedResource === 'process-instance') {
    const { createProcessInstance } = await import('./commands/process-instances.ts');
    await createProcessInstance({
      profile: values.profile as string | undefined,
      processDefinitionId: values.bpmnProcessId as string | undefined,
      version: (values.version_num && typeof values.version_num === 'string') ? parseInt(values.version_num) : undefined,
      variables: values.variables as string | undefined,
    });
    return;
  }

  if (verb === 'cancel' && normalizedResource === 'process-instance') {
    if (!args[0]) {
      logger.error('Process instance key required. Usage: c8 cancel pi <key>');
      process.exit(1);
    }
    const { cancelProcessInstance } = await import('./commands/process-instances.ts');
    await cancelProcessInstance(args[0], {
      profile: values.profile as string | undefined,
    });
    return;
  }

  // Handle process definition commands
  if (verb === 'list' && (normalizedResource === 'process-definition' || normalizedResource === 'process-definitions')) {
    const { listProcessDefinitions } = await import('./commands/process-definitions.ts');
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
    const { getProcessDefinition } = await import('./commands/process-definitions.ts');
    await getProcessDefinition(args[0], {
      profile: values.profile as string | undefined,
      xml: values.xml as boolean | undefined,
    });
    return;
  }

  // Handle user task commands
  if (verb === 'list' && (normalizedResource === 'user-task' || normalizedResource === 'user-tasks')) {
    const { listUserTasks } = await import('./commands/user-tasks.ts');
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
    const { completeUserTask } = await import('./commands/user-tasks.ts');
    await completeUserTask(args[0], {
      profile: values.profile as string | undefined,
      variables: values.variables as string | undefined,
    });
    return;
  }

  // Handle incident commands
  if (verb === 'list' && (normalizedResource === 'incident' || normalizedResource === 'incidents')) {
    const { listIncidents } = await import('./commands/incidents.ts');
    await listIncidents({
      profile: values.profile as string | undefined,
      state: values.state as string | undefined,
      processInstanceKey: values.processInstanceKey as string | undefined,
    });
    return;
  }

  if (verb === 'resolve' && normalizedResource === 'incident') {
    if (!args[0]) {
      logger.error('Incident key required. Usage: c8 resolve inc <key>');
      process.exit(1);
    }
    const { resolveIncident } = await import('./commands/incidents.ts');
    await resolveIncident(args[0], {
      profile: values.profile as string | undefined,
    });
    return;
  }

  // Handle job commands
  if (verb === 'list' && normalizedResource === 'jobs') {
    const { listJobs } = await import('./commands/jobs.ts');
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
    const { activateJobs } = await import('./commands/jobs.ts');
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
    const { completeJob } = await import('./commands/jobs.ts');
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
    const { failJob } = await import('./commands/jobs.ts');
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
    const { publishMessage } = await import('./commands/messages.ts');
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
    const { correlateMessage } = await import('./commands/messages.ts');
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
    const { getTopology } = await import('./commands/topology.ts');
    await getTopology({
      profile: values.profile as string | undefined,
    });
    return;
  }

  // Handle deploy command
  if (verb === 'deploy') {
    const paths = resource ? [resource, ...args] : (args.length > 0 ? args : ['.']);
    const { deploy } = await import('./commands/deployments.ts');
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
    const { run } = await import('./commands/run.ts');
    await run(resource, {
      profile: values.profile as string | undefined,
      variables: values.variables as string | undefined,
    });
    return;
  }

  // Handle watch command
  if (verb === 'watch' || verb === 'w') {
    const paths = resource ? [resource, ...args] : (args.length > 0 ? args : ['.']);
    const { watchFiles } = await import('./commands/watch.ts');
    await watchFiles(paths, {
      profile: values.profile as string | undefined,
    });
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
