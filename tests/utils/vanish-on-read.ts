/**
 * Preload (`node --import`) that simulates a file disappearing between the
 * selection walk and the content read: the first `readFileSync` of the
 * path in `C8CTL_TEST_VANISH_ON_READ` deletes the file before reading it.
 */

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const target = process.env.C8CTL_TEST_VANISH_ON_READ;
if (target) {
	const original = fs.readFileSync;
	let vanished = false;
	const patched = (...args: Parameters<typeof original>): unknown => {
		const [path] = args;
		if (!vanished && typeof path === "string" && path === target) {
			vanished = true;
			fs.unlinkSync(target);
		}
		return Reflect.apply(original, fs, args);
	};
	Object.defineProperty(fs, "readFileSync", { value: patched });
	syncBuiltinESMExports();
}
