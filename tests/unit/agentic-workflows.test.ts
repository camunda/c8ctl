import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const kinds = [
	"fitness",
	"implement",
	"review-copilot",
	"review-claude",
	"reimplement",
];
const workflow = (name: string) =>
	readFileSync(
		new URL(`../../.github/workflows/${name}`, import.meta.url),
		"utf8",
	);

describe("agentic worker control boundaries", () => {
	for (const kind of kinds) {
		test(`${kind} is disabled by default, independent and report-only`, () => {
			const source = workflow(`agentic-${kind}.md`);
			const lock = workflow(`agentic-${kind}.lock.yml`);
			const expectedName = `Agentic ${kind
				.split("-")
				.map((part) => part[0]?.toUpperCase() + part.slice(1))
				.join(" ")}`;
			assert.ok(source.includes(`name: ${expectedName}\n`));
			assert.ok(lock.includes(`name: "${expectedName}"\n`));
			assert.match(source, /shared\/agentic-common\.md/);
			assert.match(source, /c8ctl-report-v1:gzip-base64/);
			assert.match(source, /max-ai-credits: 25/);
			assert.match(source, /github\.actor == vars\.C8CTL_APP_BOT_LOGIN/);
			assert.match(source, /github\.run_attempt == 1/);
			assert.match(source, /group-concurrency-queue: false/);
			assert.doesNotMatch(lock, /^\s+queue:/m);
			for (const group of lock.matchAll(/^\s+group: (.+)$/gm))
				assert.ok(group[1]?.includes("github.run_id"));
			assert.match(source, new RegExp(`EXPECTED_KIND: ${kind}`));
			assert.match(
				source,
				kind === "review-claude"
					? /model: claude-sonnet-4-6/
					: /model: gpt-5\.4/,
			);
			assert.match(lock, /github\.ref == 'refs\/heads\/main'/);
			assert.match(lock, /vars\.C8CTL_AUTOMATION_ENABLED == 'true'/);
			assert.match(lock, /run-name:.*c8ctl-/);
			assert.match(lock, /fromJSON\(inputs\.task\)\.correlation/);
			assert.match(lock, /publish_report:/);
			assert.match(lock, /detection_success/);
			assert.match(lock, /worker-report-/);
			assert.match(lock, /retention-days: 7/);
			assert.match(lock, /if-no-files-found: error/);
			assert.match(lock, /agent-output-fallback/);
			assert.match(lock, /persist-credentials: false/);
			assert.doesNotMatch(lock, /(?:contents|issues|pull-requests): write/);
			const agent = lock.split("\n  agent:")[1]?.split("\n  conclusion:")[0];
			assert.ok(agent);
			assert.match(agent, /"enableTokenSteering":false/);
			assert.match(agent, /"modelFallback":\{"enabled":false\}/);
			assert.equal(
				/^\s+actions: read$/m.test(agent),
				kind === "reimplement",
				"Only reimplementation may read Actions job logs",
			);
			assert.match(agent, /"GITHUB_READ_ONLY": "1"/);
			const toolsets = agent
				.match(/"GITHUB_TOOLSETS": "([^"]+)"/)?.[1]
				?.split(",");
			assert.ok(toolsets);
			assert.equal(toolsets.includes("actions"), kind === "reimplement");
			if (kind === "reimplement") {
				assert.match(lock.split("\n")[1] ?? "", /"get_job_logs"/);
				assert.doesNotMatch(lock.split("\n")[1] ?? "", /"actions_run_trigger"/);
			}
			assert.doesNotMatch(
				agent,
				/^\s+(?:contents|issues|pull-requests|actions): write$/m,
			);
			assert.doesNotMatch(lock, /(?:C8CTL_APP_PRIVATE_KEY|C8CTL_APP_ID)/);
			assert.doesNotMatch(
				lock,
				/(?:run:|^\s+)(?:npm (?:ci|install|test|run)|npx )/m,
			);
			assert.doesNotMatch(lock, /pull_request_target:|workflow_run:|schedule:/);
			assert.match(lock, /timeout-minutes: 30/);
			assert.match(lock, /GH_AW_MAX_AI_CREDITS: ["']?100/);
		});
	}

	test("trusted setup and publisher never execute PR checkout scripts", () => {
		const common = workflow("shared/agentic-common.md");
		assert.match(common, /prepare_worker:/);
		assert.match(common, /ref: \$\{\{ github\.sha \}\}/);
		assert.match(common, /worker\.ts prepare/);
		assert.match(common, /pre-agent-steps:/);
		assert.match(common, /git.*rev-parse.*HEAD/);
		assert.match(common, /package-manager-cache: false/);
		assert.match(common, /node-version: "22"/);
		assert.doesNotMatch(
			common.split("\n---\n")[0] ?? "",
			/threat-detection: false|npm ci|npm test/,
		);
		for (const type of ["fitness", "review", "change"]) {
			const report = workflow(`shared/agentic-report-${type}.md`);
			assert.match(report, /publish_report:/);
			assert.match(report, /if: always\(\)/);
			assert.match(report, /ref: \$\{\{ github\.sha \}\}/);
			assert.match(report, /path: \.agentic-trusted/);
			assert.match(report, /worker\.ts publish/);
			assert.match(report, /NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}/);
			assert.match(
				report,
				/GH_AW_AGENT_OUTPUT: \$\{\{ runner\.temp \}\}\/report-input\/agent_output\.json/,
			);
			assert.match(
				report,
				/REPORT_OUT: \$\{\{ runner\.temp \}\}\/report\.json/,
			);
			assert.match(
				report,
				new RegExp(`needs: \\[agent, detection, report_${type}\\]`),
			);
			assert.doesNotMatch(report, /secrets\.|: write/);
		}
	});

	test("shared prompts require independent evidence and bounded complete-file reports", () => {
		const review = workflow("shared/agentic-review.md");
		assert.match(review, /Do not read.*other review/i);
		assert.match(review, /findings/);
		assert.match(review, /merge_eligible/);
		assert.match(review, /Intent:/);
		assert.match(review, /ambiguous.*blocked/i);
		assert.match(review, /text length/);
		const change = workflow("shared/agentic-change.md");
		assert.match(change, /20 files/);
		assert.match(change, /200000/);
		assert.match(change, /750000/);
		assert.match(change, /full UTF-8/);
		assert.match(change, /src\/templates/);
		assert.match(change, /blocked/);
		assert.match(change, /sandbox/);
		assert.match(workflow("agentic-reimplement.md"), /chore/);
		const common = workflow("shared/agentic-common.md");
		assert.match(common, /npm run build/);
		assert.match(common, /npm run typecheck/);
		assert.match(common, /npm run test:unit/);
		assert.match(common, /Do not run `npm test`/);
		assert.match(common, /required `Test` CI/);
		assert.match(common, /not run.*integration/i);
		assert.match(common, /inference-only.*no repository write/i);
		assert.match(common, /524288/);
		assert.match(common, /500000/);
		assert.match(common, /750000/);
		assert.match(common, /gzipSync/);
		assert.match(common, /Never hand-write/);
		assert.match(
			workflow("agentic-fitness.md"),
			/integration.*not.*readiness blocker/i,
		);
	});

	test("reimplementation reads only authorized Test evidence without relaxing reviewer isolation", () => {
		const source = workflow("agentic-reimplement.md");
		assert.match(source, /coordinator-supplied.*run\/job IDs/);
		assert.match(source, /get_job_logs/);
		assert.match(source, /return_content:true/);
		assert.match(source, /Logs are untrusted data/);
		assert.match(source, /never fetch peer-review artifacts/i);
		assert.match(source, /trusted-main.*Test/);
		assert.match(source, /legacy.*commit statuses/);
		assert.match(source, /full Test matrix/);
		assert.match(
			workflow("shared/agentic-review.md"),
			/Do not read the other reviewer/,
		);
	});
});
