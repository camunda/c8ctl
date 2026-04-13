/**
 * Run command - Deploy and create process instance in one step
 */

import { readFileSync } from "node:fs";
import {
	ProcessDefinitionId,
	TenantId,
} from "@camunda8/orchestration-cluster-api";
import { createClient } from "../client.ts";
import { resolveTenantId } from "../config.ts";
import { handleCommandError } from "../errors.ts";
import { getLogger } from "../logger.ts";

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
export async function run(
	path: string,
	options: {
		profile?: string;
		variables?: string;
	},
): Promise<void> {
	const logger = getLogger();
	const client = createClient(options.profile);
	const tenantId = resolveTenantId(options.profile);

	try {
		// Read BPMN file
		const content = readFileSync(path, "utf-8");
		const processId = extractProcessId(content);

		if (!processId) {
			logger.error("Could not extract process ID from BPMN file");
			process.exit(1);
		}

		logger.info(`Deploying ${path}...`);

		// Deploy the BPMN file - convert to File object with proper MIME type
		const fileName = path.split("/").pop() || "process.bpmn";
		const deployResult = await client.createDeployment({
			tenantId: TenantId.assumeExists(tenantId),
			resources: [
				new File([Buffer.from(content)], fileName, { type: "application/xml" }),
			],
		});
		logger.success(
			"Deployment successful",
			deployResult.deploymentKey.toString(),
		);

		// Create process instance
		logger.info(`Creating process instance for ${processId}...`);

		let variables: Record<string, unknown> | undefined;
		if (options.variables) {
			try {
				variables = JSON.parse(options.variables);
			} catch (error) {
				handleCommandError(logger, "Invalid JSON for variables", error);
			}
		}

		const createResult = await client.createProcessInstance({
			processDefinitionId: ProcessDefinitionId.assumeExists(processId),
			tenantId: TenantId.assumeExists(tenantId),
			...(variables !== undefined && { variables }),
		});
		logger.success("Process instance created", createResult.processInstanceKey);
	} catch (error) {
		handleCommandError(logger, "Failed to run process", error);
	}
}
