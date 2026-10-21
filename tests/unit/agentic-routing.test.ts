import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflow = new URL(
	"../../.github/workflows/agentic-controller.yml",
	import.meta.url,
);

function source(): string {
	assert.ok(
		existsSync(workflow),
		"the trusted agentic controller workflow must exist",
	);
	return readFileSync(workflow, "utf8");
}

describe("agentic controller trust boundary", () => {
	it("routes issue, PR, CI, base-branch and recovery events", () => {
		const yaml = source();
		for (const event of [
			"issues",
			"issue_comment",
			"pull_request_target",
			"workflow_run",
			"push",
			"schedule",
			"workflow_dispatch",
		]) {
			assert.match(yaml, new RegExp(`^  ${event}:`, "m"));
		}
		assert.doesNotMatch(yaml, /^ {2}(pull_request|pull_request_review):/m);
		assert.match(yaml, /workflows: \[Test, Release,/);
		assert.match(yaml, /types: \[completed\]/);
		assert.match(yaml, /command:\n\s+description:/);
		assert.match(yaml, /options: \[reconcile, resume\]/);
	});

	it("is disabled unless explicitly enabled on the trusted default branch", () => {
		const yaml = source();
		assert.match(yaml, /vars\.C8CTL_AUTOMATION_ENABLED == 'true'/);
		assert.match(yaml, /github\.ref == 'refs\/heads\/main'/);
		assert.match(
			yaml,
			/github\.event\.comment\.user\.login != vars\.C8CTL_APP_BOT_LOGIN/,
		);
		assert.match(
			yaml,
			/C8CTL_AUTO_MERGE_ENABLED: \$\{\{ vars\.C8CTL_AUTO_MERGE_ENABLED \}\}/,
		);
		assert.match(
			yaml,
			/C8CTL_AUTOMATION_SINCE: \$\{\{ vars\.C8CTL_AUTOMATION_SINCE \}\}/,
		);
	});

	it("serializes transitions and never executes reviewed code with App credentials", () => {
		const yaml = source();
		assert.match(yaml, /group: c8ctl-agentic-controller/);
		assert.match(yaml, /cancel-in-progress: false/);
		assert.match(yaml, /permissions:\n {2}contents: read/);
		assert.match(yaml, /ref: \$\{\{ github\.sha \}\}/);
		assert.match(yaml, /persist-credentials: false/);
		assert.match(yaml, /node-version: "22"/);
		assert.match(
			yaml,
			/node --experimental-strip-types scripts\/agentic\/coordinator\.ts/,
		);
		assert.doesNotMatch(
			yaml,
			/npm (ci|install|test|run)|refs\/pull|pull_request\.head|uses: \.\//,
		);
		assert.doesNotMatch(
			yaml,
			/permission-workflows:|ANTHROPIC_API_KEY|COPILOT_GITHUB_TOKEN/,
		);
		for (const action of ["checkout", "setup-node"]) {
			assert.match(
				yaml,
				new RegExp(`uses: actions/${action}@[0-9a-f]{40} # v`),
			);
		}
	});
	it("requests supported live-variable permissions and revokes its short-lived App token", () => {
		const yaml = source();
		assert.match(yaml, /app-token\.ts create controller/);
		assert.match(
			yaml,
			/if: \$\{\{ always\(\) && steps\.app\.outputs\.token != '' \}\}/,
		);
		assert.match(yaml, /app-token\.ts revoke/);
		assert.doesNotMatch(
			yaml,
			/permission-variables:|actions\/create-github-app-token@/,
		);
	});
});
