/**
 * `c8ctl element-template update` — move every element that uses a template
 * to a newer version of it, or to another template, applying the migration
 * recipe the target declares.
 */

import { runMigrate } from "./migrate.ts";

export function updateSubcommand(args: string[]): Promise<void> {
	return runMigrate(args);
}
