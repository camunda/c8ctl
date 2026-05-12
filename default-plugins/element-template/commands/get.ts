/**
 * `c8ctl element-template get` — print the raw template JSON to stdout
 * (pipe-friendly).
 *
 * For local paths and URLs we pass the source bytes through unchanged (no
 * parse/stringify round-trip — preserves whitespace, key order, trailing
 * newline). For OOTB ids we don't have the upstream bytes, so we
 * serialize the cached object with a 2-space indent. Designed for shell
 * redirection:
 *
 *   c8ctl element-template get <id> > template.json
 *
 * No trailing hints or colored output — they would corrupt the piped
 * payload.
 */

import type {} from "../../../src/runtime.ts";
import { parseTemplateJson, readFileOrUrl, type Template } from "../helpers.ts";
import { loadCache } from "../marketplace.ts";
import { parseTemplateRef, resolveOotbTemplate } from "../template-ref.ts";

export async function getSubcommand(args: string[]): Promise<void> {
	const usage = "Usage: c8ctl element-template get <template> [--no-icon]";

	let templateArg: string | undefined;
	let noIcon = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") {
			break;
		}
		if (arg === "--no-icon") {
			noIcon = true;
			continue;
		}
		if (arg.startsWith("-")) {
			throw new Error(`Unknown flag: ${arg}. ${usage}`);
		}
		if (templateArg === undefined) {
			templateArg = arg;
			continue;
		}
		throw new Error(`Unexpected argument: ${arg}. ${usage}`);
	}

	if (!templateArg) {
		throw new Error(`Missing template argument. ${usage}`);
	}

	const ref = parseTemplateRef(templateArg);
	if (!ref) {
		throw new Error(`Missing template argument. ${usage}`);
	}

	if (ref.kind === "path" || ref.kind === "url") {
		const content = await readFileOrUrl(ref.value);
		// Pass-through preserves whitespace + key order — but --no-icon
		// requires a parse/strip/re-stringify round-trip, which loses
		// that. The user is opting in to the rewrite by asking for it.
		if (noIcon) {
			const template = parseTemplateJson(content);
			const stripped = stripIcon(template);
			process.stdout.write(`${JSON.stringify(stripped, null, 2)}\n`);
			return;
		}
		process.stdout.write(content);
		return;
	}

	// OOTB id: no upstream bytes available — stringify the cached object.
	// We deliberately do NOT auto-bootstrap here: the bootstrap log lines
	// would interleave with the JSON payload on stdout and corrupt any
	// shell redirect (`> template.json`). Surface the missing-cache case
	// as an explicit error pointing at `sync`.
	if (loadCache() === null) {
		throw new Error(
			"Element template cache not found. Run 'c8ctl element-template sync' first.",
		);
	}
	const template = await resolveOotbTemplate(ref);

	// The cache injects `metadata.upstreamRef` (our internal pointer for
	// incremental sync); strip it so the output matches what you'd get
	// from the marketplace, not c8ctl's cache shape.
	let cleaned = stripInternalMetadata(template);
	if (noIcon) {
		cleaned = stripIcon(cleaned);
	}
	process.stdout.write(`${JSON.stringify(cleaned, null, 2)}\n`);
}

function stripInternalMetadata(template: Template): Template {
	if (!template.metadata?.upstreamRef) {
		return template;
	}
	const { metadata, ...rest } = template;
	const { upstreamRef: _ignored, ...metaRest } = metadata;
	if (Object.keys(metaRest).length === 0) {
		return { ...rest, properties: template.properties };
	}
	return { ...rest, properties: template.properties, metadata: metaRest };
}

function stripIcon(template: Template): Template {
	if (!template.icon) {
		return template;
	}
	const { icon: _icon, ...rest } = template;
	return { ...rest, properties: template.properties };
}
