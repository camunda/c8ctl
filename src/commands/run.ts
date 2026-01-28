/**
 * Run command - Deploy and create process instance in one step
 */

import { getLogger } from '../logger.ts';
import { createClient } from '../client.ts';
import { resolveTenantId } from '../config.ts';
import { readFileSync } from 'node:fs';

/**
 * Extract process ID from BPMN file
 */
function extractProcessId(bpmnContent: string): string | null {
  const match = bpmnContent.match(/process[^>]+id="([^"]+)"/);
  return match ? match[1] : null;
}

/**
 * Run - deploy and start process instance
 */
export async function run(path: string, options: {
  profile?: string;
  variables?: string;
}): Promise<void> {
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

    // Deploy the BPMN file
    const deployResult = await client.createDeployment({
      tenantId,
      resources: [{
        name: path.split('/').pop() || 'process.bpmn',
        content: Buffer.from(content),
      }],
    });
    logger.success('Deployment successful', deployResult.key);

    // Create process instance
    logger.info(`Creating process instance for ${processId}...`);

    const createRequest: any = {
      bpmnProcessId: processId,
      tenantId,
    };

    if (options.variables) {
      try {
        createRequest.variables = JSON.parse(options.variables);
      } catch (error) {
        logger.error('Invalid JSON for variables', error as Error);
        process.exit(1);
      }
    }

    const createResult = await client.createProcessInstance(createRequest);
    logger.success('Process instance created', createResult.processInstanceKey);
  } catch (error) {
    logger.error('Failed to run process', error as Error);
    process.exit(1);
  }
}
