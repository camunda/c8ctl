/**
 * `c8ctl element-template change` — move an element to another template,
 * applying the migration recipe the target template declares for the one the
 * element is on.
 */

import { runMigrate } from "./migrate.ts";

export function changeSubcommand(args: string[]): Promise<void> {
	return runMigrate("change", args);
}
