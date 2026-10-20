// Test preload: appends one byte to $CACHE_READ_LOG per read of templates.json.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const original = fs.readFileSync;
fs.readFileSync = function patched(path, ...rest) {
	if (typeof path === "string" && path.endsWith("templates.json")) {
		fs.appendFileSync(process.env.CACHE_READ_LOG, "x");
	}
	return original.call(this, path, ...rest);
};
syncBuiltinESMExports();
