/**
 * Camunda project descriptor (`camunda.json`) support.
 *
 * A `camunda.json` file in the root of a folder marks the folder as a
 * Camunda project — the unit that is built, tested, and deployed together.
 * It supersedes the `.process-application` marker; during the transition
 * both files are recognised as project markers.
 *
 * The file must contain a single JSON object. All fields are optional, so
 * an empty object (`{}`) is a valid descriptor — as is a whitespace-only
 * file, the natural migration path from `touch camunda.json` or an empty
 * legacy marker. A UTF-8 or UTF-16LE BOM is tolerated (Windows editors and
 * Windows PowerShell 5.1 write both). Malformed JSON is a hard error: a
 * broken `camunda.json` must never silently count as a project marker.
 *
 * Marker detection only requires a JSON object. Known fields are extracted
 * when well-typed and ignored otherwise — a wrong-typed `hub.projectId`
 * must not break `deploy`/`watch` for a field no command consumes yet.
 * Strict field validation belongs to the integration that reads the field.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, normalizeToError } from "../../core/index.ts";

/** File that marks a folder as a Camunda project. */
export const CAMUNDA_PROJECT_FILE = "camunda.json";

/** Legacy marker, superseded by {@link CAMUNDA_PROJECT_FILE}. */
export const PROCESS_APPLICATION_FILE = ".process-application";

/**
 * Parsed contents of a `camunda.json` descriptor. Mirrors the JSON shape
 * of the file so future fields can be added in place.
 */
export interface CamundaProject {
	/** Camunda Hub connection settings. */
	hub?: {
		/** ID of the linked project in Camunda Hub. */
		projectId?: string;
	};
}

/**
 * Decode descriptor bytes, tolerating the BOMs that Windows tooling
 * writes: UTF-8 BOM (stripped) and UTF-16LE BOM (Windows PowerShell 5.1
 * `echo '{}' > camunda.json`, decoded).
 */
export function decodeCamundaJson(buffer: Buffer): string {
	if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
		return buffer.subarray(2).toString("utf16le");
	}
	return buffer.toString("utf-8").replace(/^\uFEFF/, "");
}

/**
 * Parse the contents of a `camunda.json` descriptor.
 *
 * @param content - Raw file contents (after {@link decodeCamundaJson}).
 * @param source - Path used in error messages.
 * @throws {Error} When the content is not valid JSON or the top level is
 *   not an object.
 */
export function parseCamundaJson(
	content: string,
	source: string = CAMUNDA_PROJECT_FILE,
): CamundaProject {
	// A whitespace-only file is an empty descriptor — the natural outcome
	// of `touch camunda.json` or renaming an empty legacy marker.
	if (content.trim() === "") {
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new Error(
			`Invalid JSON in ${source}: ${normalizeToError(error).message}. ` +
				"camunda.json must contain a JSON object; use {} for an empty descriptor",
		);
	}

	if (!isRecord(parsed)) {
		throw new Error(
			`${source} must contain a single JSON object; use {} for an empty descriptor`,
		);
	}

	const project: CamundaProject = {};

	const hub = parsed.hub;
	if (isRecord(hub)) {
		project.hub =
			typeof hub.projectId === "string" ? { projectId: hub.projectId } : {};
	}

	return project;
}

/**
 * Read and parse the `camunda.json` descriptor in a directory.
 * Returns `null` when no readable descriptor exists.
 *
 * @throws {Error} When the file exists but is not valid JSON.
 */
export function readCamundaProject(dirPath: string): CamundaProject | null {
	const filePath = join(dirPath, CAMUNDA_PROJECT_FILE);
	let buffer: Buffer;
	try {
		buffer = readFileSync(filePath);
	} catch {
		return null;
	}
	return parseCamundaJson(decodeCamundaJson(buffer), filePath);
}
