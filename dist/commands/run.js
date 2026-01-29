/**
 * Run command - Deploy and create process instance in one step
 */
import { getLogger } from "../logger.js";
import { createClient } from "../client.js";
import { resolveTenantId } from "../config.js";
import { readFileSync } from 'node:fs';
/**
 * Extract process ID from BPMN file
 */
function extractProcessId(bpmnContent) {
    const match = bpmnContent.match(/process[^>]+id="([^"]+)"/);
    return match ? match[1] : null;
}
/**
 * Run - deploy and start process instance
 */
export async function run(path, options) {
    const logger = getLogger();
    const client = createClient(options.profile);
    const tenantId = resolveTenantId(options.profile);
    try {
        // Read BPMN file
        const content = readFileSync(path, 'utf-8');
        const processId = extractProcessId(content);
        if (!processId) {
            logger.error('Could not extract process ID from BPMN file');
            process.exit(1);
        }
        logger.info(`Deploying ${path}...`);
        // Deploy the BPMN file - convert to File object with proper MIME type
        const fileName = path.split('/').pop() || 'process.bpmn';
        const deployResult = await client.createDeployment({
            tenantId,
            resources: [new File([Buffer.from(content)], fileName, { type: 'application/xml' })],
        });
        logger.success('Deployment successful', deployResult.deploymentKey.toString());
        // Create process instance
        logger.info(`Creating process instance for ${processId}...`);
        const createRequest = {
            processDefinitionId: processId,
            tenantId,
        };
        if (options.variables) {
            try {
                createRequest.variables = JSON.parse(options.variables);
            }
            catch (error) {
                logger.error('Invalid JSON for variables', error);
                process.exit(1);
            }
        }
        const createResult = await client.createProcessInstance(createRequest);
        logger.success('Process instance created', createResult.processInstanceKey);
    }
    catch (error) {
        logger.error('Failed to run process', error);
        process.exit(1);
    }
}
//# sourceMappingURL=run.js.map