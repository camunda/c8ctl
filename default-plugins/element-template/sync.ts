/**
 * `c8ctl element-template sync` — refresh the local OOTB element template
 * cache from the marketplace.
 */

import type {} from "../../src/runtime.ts";
import { syncTemplates } from "./marketplace.ts";

const c8ctl = globalThis.c8ctl!;

export async function syncSubcommand(args: string[]): Promise<void> {
	const logger = c8ctl.getLogger();
	let prune = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--prune") {
			prune = true;
			continue;
		}
		if (arg === "--") {
			break;
		}
		if (arg.startsWith("-")) {
			throw new Error(
				`Unknown flag: ${arg}. Usage: c8ctl element-template sync [--prune]`,
			);
		}
		throw new Error(
			`Unexpected argument: ${arg}. Usage: c8ctl element-template sync [--prune]`,
		);
	}

	const summary = await syncTemplates({ logger, prune });

	if (c8ctl.outputMode === "json") {
		logger.json(summary);
	}
}
