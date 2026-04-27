/**
 * Run command — deploy a BPMN file and start a process instance in one step.
 *
 * Per #288, the body lives directly in the `defineCommand` handler:
 * dry-run preview via the framework's `dryRun()` helper, validation
 * up-front, and `throw` on every error path so the framework's
 * `handleCommandError` wrapper owns process termination.
 */

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import {
	ProcessDefinitionId,
	TenantId,
} from "@camunda8/orchestration-cluster-api";
import { defineCommand, dryRun } from "../command-framework.ts";
import { resolveTenantId } from "../config.ts";
import { DEPLOYABLE_EXTENSIONS } from "./resource-extensions.ts";

/**
 * Extract process ID from BPMN file content.
 */
function extractProcessId(bpmnContent: string): string | null {
	const match = bpmnContent.match(/process[^>]+id="([^"]+)"/);
	return match ? match[1] : null;
}

// ─── defineCommand ───────────────────────────────────────────────────────────

/**
 * Side-effectful: deploys a BPMN file and creates a process instance,
 * logging progress inline. Self-rendering, so returns `{ kind: "none" }`.
 */
export const runCommand = defineCommand("run", "", async (ctx, flags) => {
	const path = ctx.resource;

	// Dry-run preview comes first, mirroring the pre-#288 order pinned by
	// `tests/unit/form-topology-run-behaviour.test.ts`. The body shape
	// `{ path, variables }` is part of that contract.
	const dr = dryRun({
		command: "run",
		method: "POST",
		endpoint: "/deployments + /process-instances",
		profile: ctx.profile,
		body: { path, variables: flags.variables },
	});
	if (dr) return dr;

	// Validate file extension unless --force is set.
	const ext = extname(path);
	if (!flags.force && ext && !DEPLOYABLE_EXTENSIONS.includes(ext)) {
		throw new Error(
			`Unsupported file extension "${ext}". Use --force to deploy any file type.`,
		);
	}

	// Parse --variables up-front, before any I/O. Pre-#288 this happened
	// after the deploy network call, which made the bad-JSON path
	// untestable in unit tests and wasted a deploy round-trip on a
	// user-fixable input error. Validate at the boundary, where it
	// belongs.
	let variables: Record<string, unknown> | undefined;
	if (flags.variables !== undefined) {
		try {
			variables = JSON.parse(flags.variables);
		} catch (error) {
			throw new Error(
				`Invalid JSON for variables: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	// Read BPMN file and extract process ID.
	const content = readFileSync(path, "utf-8");
	const processId = extractProcessId(content);
	if (!processId) {
		throw new Error("Could not extract process ID from BPMN file");
	}

	const { client, logger } = ctx;
	const tenantId = resolveTenantId(ctx.profile);

	logger.info(`Deploying ${path}...`);

	// Deploy the BPMN file. Convert to a File object with the correct
	// MIME type so the multipart boundary the SDK builds is well-formed.
	const fileName = basename(path) || "process.bpmn";
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

	// Create process instance.
	logger.info(`Creating process instance for ${processId}...`);
	const createResult = await client.createProcessInstance({
		processDefinitionId: ProcessDefinitionId.assumeExists(processId),
		tenantId: TenantId.assumeExists(tenantId),
		...(variables !== undefined && { variables }),
	});
	logger.success("Process instance created", createResult.processInstanceKey);

	return { kind: "none" };
});
