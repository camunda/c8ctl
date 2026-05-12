/**
 * `c8ctl element-template search` — search the local cache of OOTB
 * element templates by name/id, with auto-bootstrap on first run.
 */

import { styleText } from "node:util";
import type {} from "../../src/runtime.ts";
import { buildTemplateSummary, formatTemplateHeaderLines } from "./info.ts";
import {
	bootstrapIfNeeded,
	nudgeIfStale,
	searchTemplates,
} from "./marketplace.ts";

const c8ctl = globalThis.c8ctl!;

export async function searchSubcommand(args: string[]): Promise<void> {
	const logger = c8ctl.getLogger();
	const usage = "Usage: c8ctl element-template search <query> [--limit N]";

	// Default cap that covers the common "AWS"-shaped query without
	// dumping the whole catalogue. Pass --limit to widen.
	const DEFAULT_LIMIT = 20;
	let limit = DEFAULT_LIMIT;
	const queryParts: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") {
			queryParts.push(...args.slice(i + 1));
			break;
		}
		if (arg === "--limit" || arg.startsWith("--limit=")) {
			const value =
				arg === "--limit" ? args[++i] : arg.slice("--limit=".length);
			if (value === undefined || value === "") {
				throw new Error(
					`--limit requires a value (positive integer). ${usage}`,
				);
			}
			const parsed = Number(value);
			if (!Number.isInteger(parsed) || parsed < 1) {
				throw new Error(
					`--limit must be a positive integer; got "${value}". ${usage}`,
				);
			}
			limit = parsed;
			continue;
		}
		if (arg.startsWith("-")) {
			throw new Error(`Unknown flag: ${arg}. ${usage}`);
		}
		queryParts.push(arg);
	}

	const query = queryParts.join(" ").trim();
	if (!query) {
		throw new Error(`Missing query. ${usage}`);
	}

	await bootstrapIfNeeded({ logger });
	nudgeIfStale(logger);

	// Hide deprecated templates from search results — same as Modeler.
	// The schema's `deprecated` field is either `true` or `{ message }`;
	// both forms mean the same thing.
	const allMatches = searchTemplates(query).filter((t) => !t.deprecated);
	const total = allMatches.length;
	const limited = allMatches.slice(0, limit);
	const truncated = total > limited.length;

	if (c8ctl.outputMode === "json") {
		// JSON consumers see `count` (post-limit) and `total` (pre-limit).
		// `count !== total` is the explicit truncation signal — no need to
		// inspect a separate field.
		logger.json({
			query,
			count: limited.length,
			total,
			matches: limited.map(buildTemplateSummary),
		});
		return;
	}

	if (total === 0) {
		logger.output(`No element templates match '${query}'.`);
		logger.output("");
		logger.output(
			styleText(
				"dim",
				"Try a broader query, or run 'c8ctl element-template sync' to refresh the cache.",
			),
		);
		return;
	}

	// Header — when truncated, lead with "Showing X of Y" so the elision
	// is visible on the first line; otherwise the plain count is enough.
	// Dim because it's meta-info above the result cards, matching how
	// get-properties styles its "Showing X of Y properties" line.
	const matchWord = total === 1 ? "match" : "matches";
	logger.output(
		styleText(
			"dim",
			truncated
				? `Showing ${limited.length} of ${total} ${matchWord} for '${query}'`
				: `${total} ${matchWord} for '${query}'`,
		),
	);
	logger.output("");

	for (let i = 0; i < limited.length; i++) {
		const t = limited[i];
		for (const line of formatTemplateHeaderLines(t, t.id)) {
			logger.output(line);
		}
		if (i < limited.length - 1) {
			logger.output("");
		}
	}

	// Trailing hint.
	logger.output("");
	if (truncated) {
		logger.output(
			styleText(
				"dim",
				`Refine the query or pass --limit ${total} to see them all.`,
			),
		);
		logger.output("");
	}
	const exampleId = limited[0]?.id ?? "<id>";
	logger.output(
		styleText(
			"dim",
			"For details on a template:\n" +
				`  c8ctl element-template info ${exampleId}`,
		),
	);
}
