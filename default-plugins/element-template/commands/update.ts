/**
 * `c8ctl element-template update` — move an element to a newer version of its
 * template, applying the migration recipe the newer version declares.
 */

import { runMigrate } from "./migrate.ts";

export function updateSubcommand(args: string[]): Promise<void> {
	return runMigrate("update", args);
}
