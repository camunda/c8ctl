import { extname } from "node:path";
import { load, YAMLException } from "js-yaml";
import { isRecord } from "../../core/index.ts";

export interface MarkdownDeploymentResource {
	path: string;
	deploymentName: string;
	content: Buffer;
}

function prepareMarkdownResource(resource: MarkdownDeploymentResource): void {
	if (extname(resource.path).toLowerCase() !== ".md") return;

	const source = resource.content.toString("utf8");
	const opening = source.match(/^(?:\uFEFF)?---[ \t]*\r?\n/);
	if (!opening) return;

	const afterOpening = source.slice(opening[0].length);
	const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(afterOpening);
	if (!closing) {
		throw new Error(
			`Invalid Markdown frontmatter in ${resource.path}: missing closing delimiter`,
		);
	}

	const yaml = afterOpening.slice(0, closing.index);
	let metadata: unknown;
	try {
		metadata = load(yaml);
	} catch (error) {
		if (
			error instanceof YAMLException &&
			error.reason === "duplicated mapping key"
		) {
			throw new Error(
				`Duplicate Markdown identity metadata in ${resource.path}: ${error.message}`,
			);
		}
		throw new Error(
			`Invalid Markdown frontmatter in ${resource.path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (metadata !== undefined && !isRecord(metadata)) {
		throw new Error(
			`Invalid Markdown frontmatter in ${resource.path}: expected a YAML mapping`,
		);
	}

	const camunda = isRecord(metadata) ? metadata.camunda : undefined;
	if (camunda !== undefined && !isRecord(camunda)) {
		throw new Error(
			`Invalid Markdown frontmatter in ${resource.path}: "camunda" must be a mapping`,
		);
	}

	const resourceId = isRecord(camunda) ? camunda.resourceId : undefined;
	if (
		resourceId !== undefined &&
		(typeof resourceId !== "string" || resourceId.trim().length === 0)
	) {
		throw new Error(
			`Invalid Markdown frontmatter in ${resource.path}: "camunda.resourceId" must be a non-empty string`,
		);
	}

	if (typeof resourceId === "string") {
		resource.deploymentName = resourceId.trim();
	}
	resource.content = Buffer.from(
		afterOpening.slice(closing.index + closing[0].length),
		"utf8",
	);
}

export function prepareMarkdownResources(
	resources: MarkdownDeploymentResource[],
): void {
	const resourcesById = new Map<string, string[]>();
	for (const resource of resources) {
		prepareMarkdownResource(resource);
		if (extname(resource.path).toLowerCase() !== ".md") continue;

		const paths = resourcesById.get(resource.deploymentName);
		if (paths) {
			paths.push(resource.path);
		} else {
			resourcesById.set(resource.deploymentName, [resource.path]);
		}
	}

	for (const [resourceId, paths] of resourcesById) {
		if (paths.length > 1) {
			throw new Error(
				`Duplicate Markdown resource ID "${resourceId}" in: ${paths.join(", ")}`,
			);
		}
	}
}
