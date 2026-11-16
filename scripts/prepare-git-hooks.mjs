import { execFileSync } from "node:child_process";

function git(args, options = {}) {
	try {
		return execFileSync("git", args, {
			stdio: ["ignore", "pipe", "inherit"],
			encoding: "utf8",
			...options,
		});
	} catch {
		return null;
	}
}

const isRepo = git(["rev-parse", "--is-inside-work-tree"]);
if (!isRepo) {
	process.exit(0);
}

const currentHooksPath = (
	git(["config", "--local", "--get", "core.hooksPath"]) ?? ""
).trim();

if (!currentHooksPath || currentHooksPath === ".githooks") {
	execFileSync("git", ["config", "--local", "core.hooksPath", ".githooks"], {
		stdio: "inherit",
	});
} else {
	console.log(`prepare: leaving existing core.hooksPath=${currentHooksPath}`);
}
