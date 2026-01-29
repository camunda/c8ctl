#!/usr/bin/env node
/**
 * c8ctl - Camunda 8 CLI
 * Main entry point
 */
import { parseArgs } from 'node:util';
import { getLogger } from "./logger.js";
import { loadSessionState } from "./config.js";
import { showHelp, showVersion, showVerbResources } from "./commands/help.js";
import { useProfile, useTenant, setOutputFormat } from "./commands/session.js";
import { listProfiles, addProfile, removeProfile } from "./commands/profiles.js";
import { listProcessInstances, getProcessInstance, createProcessInstance, cancelProcessInstance, } from "./commands/process-instances.js";
import { listUserTasks, completeUserTask } from "./commands/user-tasks.js";
import { listIncidents, resolveIncident } from "./commands/incidents.js";
import { listJobs, activateJobs, completeJob, failJob } from "./commands/jobs.js";
import { publishMessage, correlateMessage } from "./commands/messages.js";
import { getTopology } from "./commands/topology.js";
import { deploy } from "./commands/deployments.js";
import { run } from "./commands/run.js";
import { watchFiles } from "./commands/watch.js";
import { loadPlugin, unloadPlugin, listPlugins } from "./commands/plugins.js";
import { loadInstalledPlugins, executePluginCommand } from "./plugin-loader.js";
/**
 * Normalize resource aliases
 */
function normalizeResource(resource) {
    const aliases = {
        pi: 'process-instance',
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
                version: { type: 'boolean', short: 'v' },
                all: { type: 'boolean' },
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
    }
    catch (error) {
        console.error(`Error parsing arguments: ${error.message}`);
        process.exit(1);
    }
}
/**
 * Main CLI handler
 */
async function main() {
    const { values, positionals } = parseCliArgs();
    // Load session state and initialize logger
    const session = loadSessionState();
    const logger = getLogger(session.outputMode);
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
            baseUrl: typeof values.baseUrl === 'string' ? values.baseUrl : undefined,
            clientId: typeof values.clientId === 'string' ? values.clientId : undefined,
            clientSecret: typeof values.clientSecret === 'string' ? values.clientSecret : undefined,
            audience: typeof values.audience === 'string' ? values.audience : undefined,
            oAuthUrl: typeof values.oAuthUrl === 'string' ? values.oAuthUrl : undefined,
            defaultTenantId: typeof values.defaultTenantId === 'string' ? values.defaultTenantId : undefined,
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
        const fromUrl = values.from;
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
    // Handle process instance commands
    if (verb === 'list' && (normalizedResource === 'process-instance' || normalizedResource === 'process-instances')) {
        await listProcessInstances({
            profile: values.profile,
            processDefinitionId: values.bpmnProcessId,
            state: values.state,
            all: values.all,
        });
        return;
    }
    if (verb === 'get' && normalizedResource === 'process-instance') {
        if (!args[0]) {
            logger.error('Process instance key required. Usage: c8 get pi <key>');
            process.exit(1);
        }
        await getProcessInstance(args[0], {
            profile: values.profile,
        });
        return;
    }
    if (verb === 'create' && normalizedResource === 'process-instance') {
        await createProcessInstance({
            profile: values.profile,
            processDefinitionId: values.bpmnProcessId,
            version: (values.version_num && typeof values.version_num === 'string') ? parseInt(values.version_num) : undefined,
            variables: values.variables,
        });
        return;
    }
    if (verb === 'cancel' && normalizedResource === 'process-instance') {
        if (!args[0]) {
            logger.error('Process instance key required. Usage: c8 cancel pi <key>');
            process.exit(1);
        }
        await cancelProcessInstance(args[0], {
            profile: values.profile,
        });
        return;
    }
    // Handle user task commands
    if (verb === 'list' && (normalizedResource === 'user-task' || normalizedResource === 'user-tasks')) {
        await listUserTasks({
            profile: values.profile,
            state: values.state,
            assignee: values.assignee,
            all: values.all,
        });
        return;
    }
    if (verb === 'complete' && normalizedResource === 'user-task') {
        if (!args[0]) {
            logger.error('User task key required. Usage: c8 complete ut <key>');
            process.exit(1);
        }
        await completeUserTask(args[0], {
            profile: values.profile,
            variables: values.variables,
        });
        return;
    }
    // Handle incident commands
    if (verb === 'list' && (normalizedResource === 'incident' || normalizedResource === 'incidents')) {
        await listIncidents({
            profile: values.profile,
            state: values.state,
            processInstanceKey: values.processInstanceKey,
        });
        return;
    }
    if (verb === 'resolve' && normalizedResource === 'incident') {
        if (!args[0]) {
            logger.error('Incident key required. Usage: c8 resolve inc <key>');
            process.exit(1);
        }
        await resolveIncident(args[0], {
            profile: values.profile,
        });
        return;
    }
    // Handle job commands
    if (verb === 'list' && normalizedResource === 'jobs') {
        await listJobs({
            profile: values.profile,
            state: values.state,
            type: values.type,
        });
        return;
    }
    if (verb === 'activate' && normalizedResource === 'jobs') {
        if (!args[0]) {
            logger.error('Job type required. Usage: c8 activate jobs <type>');
            process.exit(1);
        }
        await activateJobs(args[0], {
            profile: values.profile,
            maxJobsToActivate: (values.maxJobsToActivate && typeof values.maxJobsToActivate === 'string') ? parseInt(values.maxJobsToActivate) : undefined,
            timeout: (values.timeout && typeof values.timeout === 'string') ? parseInt(values.timeout) : undefined,
            worker: values.worker,
        });
        return;
    }
    if (verb === 'complete' && normalizedResource === 'job') {
        if (!args[0]) {
            logger.error('Job key required. Usage: c8 complete job <key>');
            process.exit(1);
        }
        await completeJob(args[0], {
            profile: values.profile,
            variables: values.variables,
        });
        return;
    }
    if (verb === 'fail' && normalizedResource === 'job') {
        if (!args[0]) {
            logger.error('Job key required. Usage: c8 fail job <key>');
            process.exit(1);
        }
        await failJob(args[0], {
            profile: values.profile,
            retries: (values.retries && typeof values.retries === 'string') ? parseInt(values.retries) : undefined,
            errorMessage: values.errorMessage,
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
            profile: values.profile,
            correlationKey: values.correlationKey,
            variables: values.variables,
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
            profile: values.profile,
            correlationKey: values.correlationKey,
            variables: values.variables,
            timeToLive: (values.timeToLive && typeof values.timeToLive === 'string') ? parseInt(values.timeToLive) : undefined,
        });
        return;
    }
    // Handle topology command
    if (verb === 'get' && normalizedResource === 'topology') {
        await getTopology({
            profile: values.profile,
        });
        return;
    }
    // Handle deploy command
    if (verb === 'deploy') {
        const paths = resource ? [resource, ...args] : (args.length > 0 ? args : ['.']);
        await deploy(paths, {
            profile: values.profile,
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
            profile: values.profile,
            variables: values.variables,
        });
        return;
    }
    // Handle watch command
    if (verb === 'watch' || verb === 'w') {
        const paths = resource ? [resource, ...args] : (args.length > 0 ? args : ['.']);
        await watchFiles(paths, {
            profile: values.profile,
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
// Run the CLI
main().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map