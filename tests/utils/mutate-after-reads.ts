/**
 * Preload (`node --import`) that changes a file after it has been read a
 * given number of times, to simulate an edit that lands between two reads
 * of the same invocation. Configured by `C8CTL_TEST_MUTATE_AFTER_READS`:
 * `<absolute path>|<read count>|<"delete" or replacement content>`. Reads
 * are counted under both the given and the real path of the file.
 * Set `C8CTL_TEST_TRACE_READS=1` to log each counted read to stderr.
 */

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const spec = process.env.C8CTL_TEST_MUTATE_AFTER_READS;
if (spec) {
	const [target, count, action] = spec.split("|");
	const after = Number(count);
	const trace = process.env.C8CTL_TEST_TRACE_READS === "1";
	const original = fs.readFileSync;
	// Match the path under either spelling (e.g. /var vs /private/var).
	const spellings = new Set([target, fs.realpathSync(target)]);
	let reads = 0;
	const patched = (...args: Parameters<typeof original>): unknown => {
		const result: unknown = Reflect.apply(original, fs, args);
		if (typeof args[0] === "string" && spellings.has(args[0])) {
			reads++;
			if (trace) process.stderr.write(`[read ${reads}] ${target}\n`);
			if (reads === after) {
				if (action === "delete") fs.unlinkSync(target);
				else fs.writeFileSync(target, action);
			}
		}
		return result;
	};
	Object.defineProperty(fs, "readFileSync", { value: patched });
	syncBuiltinESMExports();
}
