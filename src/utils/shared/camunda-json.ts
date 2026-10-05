/**
 * Camunda project descriptor (`camunda.json`) support.
 *
 * A `camunda.json` file in the root of a folder marks the folder as a
 * Camunda project — the unit that is built, tested, and deployed together.
 * It supersedes the `.process-application` marker; during the transition
 * both files are recognised as project markers.
 *
 * The file must contain a single JSON object. All fields are optional, so
 * an empty object (`{}`) is a valid descriptor. Invalid JSON is a hard
 * error: a malformed `camunda.json` must never silently count as a project
 * marker.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isRecord, normalizeToError } from "../../core/index.ts";

/** File that marks a folder as a Camunda project. */
export const CAMUNDA_PROJECT_FILE = "camunda.json";

/** Legacy marker, superseded by {@link CAMUNDA_PROJECT_FILE}. */
export const PROCESS_APPLICATION_FILE = ".process-application";

/** Parsed contents of a `camunda.json` descriptor. */
export interface CamundaProject {
	/** ID of the linked project in Camunda Hub (`hub.projectId`). */
	hubProjectId?: string;
}

/**
 * Parse the contents of a `camunda.json` descriptor.
 *
 * @param content - Raw file contents.
 * @param source - Path used in error messages.
 * @throws {Error} When the content is not valid JSON, the top level is not
 *   an object, or a known field has the wrong type.
 */
export function parseCamundaJson(
	content: string,
	source: string = CAMUNDA_PROJECT_FILE,
): CamundaProject {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new Error(
			`Invalid JSON in ${source}: ${normalizeToError(error).message}`,
		);
	}

	if (!isRecord(parsed)) {
		throw new Error(`${source} must contain a single JSON object`);
	}

	const project: CamundaProject = {};

	const hub = parsed.hub;
	if (hub !== undefined) {
		if (!isRecord(hub)) {
			throw new Error(`${source}: "hub" must be an object`);
		}
		const projectId = hub.projectId;
		if (projectId !== undefined) {
			if (typeof projectId !== "string") {
				throw new Error(`${source}: "hub.projectId" must be a string`);
			}
			project.hubProjectId = projectId;
		}
	}

	return project;
}

/**
 * Check whether a directory contains a `camunda.json` file.
 */
export function hasCamundaProjectFile(dirPath: string): boolean {
	try {
		return statSync(join(dirPath, CAMUNDA_PROJECT_FILE)).isFile();
	} catch {
		return false;
	}
}

/**
 * Read and parse the `camunda.json` descriptor in a directory.
 * Returns `null` when no descriptor exists.
 *
 * @throws {Error} When the file exists but is not a valid descriptor.
 */
export function readCamundaProject(dirPath: string): CamundaProject | null {
	const filePath = join(dirPath, CAMUNDA_PROJECT_FILE);
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
	return parseCamundaJson(content, filePath);
}
