/**
 * Shared parity fixtures for `deployResources` — the tool-agnostic cases in
 * tests/fixtures/deploy-resources-parity (format: see its README.md).
 *
 * Acceptance criterion pinned here: "The same configured project resolves
 * to the same resource set in Desktop Modeler and c8ctl, verified with
 * shared fixtures covering defaults, negation, ordered overrides, hidden
 * files, and descendant re-inclusion."
 *
 * Every case is checked twice:
 *   1. Resolver level — exact project-relative paths (the contract other
 *      tools must match).
 *   2. CLI level — `c8 deploy <project> --dry-run` submits the same set
 *      (by resource name) or fails with the same error class and deploys
 *      nothing. Cases without `deployResources` pin the default scan.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
	DeployResourcesError,
	readDeployResources,
	resolveDeployResources,
} from "../../src/utils/index.ts";
import {
	basenames,
	buildParityProject,
	CLI_ERROR_SIGNATURE,
	deployDryRun,
	loadParityCases,
} from "../utils/deploy-resources.ts";

const cases = loadParityCases();
let workDir: string;

before(() => {
	workDir = mkdtempSync(join(tmpdir(), "c8ctl-deploy-resources-parity-"));
});

after(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("deployResources parity fixtures: inventory", () => {
	test("the fixtures cover defaults, negation, ordered overrides, hidden files, descendant re-inclusion, invalid and empty cases", () => {
		const names = cases.map((c) => c.name);
		for (const required of [
			"worked-example",
			"defaults-excluded",
			"defaults-overridden-by-matching-pattern",
			"negation",
			"ordered-overrides",
			"hidden-files",
			"hidden-directories",
			"descendant-reinclusion",
			"absent-field-default-scan",
			"absent-field-c8ignore",
		]) {
			assert.ok(names.includes(required), `missing parity case ${required}`);
		}
		assert.ok(names.some((n) => n.startsWith("invalid-")));
		assert.ok(names.some((n) => n.startsWith("empty-")));
	});
});

describe("deployResources parity fixtures: resolver selects the expected paths", () => {
	for (const c of cases.filter((c) => c.declaresField)) {
		test(`${c.name}: ${c.description}`, () => {
			const root = buildParityProject(c.name, join(workDir, "resolver"));
			const resolve = () => {
				const patterns = readDeployResources(root);
				assert.ok(patterns !== null, "the case declares deployResources");
				return resolveDeployResources(root, patterns);
			};
			if (c.expected.kind === "error") {
				const code = c.expected.error;
				assert.throws(
					resolve,
					(error: unknown) =>
						error instanceof DeployResourcesError && error.code === code,
					`expected a ${code} error`,
				);
				return;
			}
			assert.deepStrictEqual(resolve(), [...c.expected.selected].sort());
		});
	}
});

describe("deployResources parity fixtures: c8 deploy --dry-run submits the expected set", {
	concurrency: 4,
}, () => {
	for (const c of cases) {
		test(`${c.name}: ${c.description}`, async () => {
			const root = buildParityProject(c.name, join(workDir, "cli"));
			const result = await deployDryRun([root]);
			if (c.expected.kind === "error") {
				assert.notStrictEqual(
					result.status,
					0,
					`must fail without deploying. stdout:\n${result.stdout}`,
				);
				assert.match(result.stderr, CLI_ERROR_SIGNATURE[c.expected.error]);
				assert.doesNotMatch(result.stdout, /"dryRun"/);
				return;
			}
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			assert.deepStrictEqual(result.names, basenames(c.expected.selected));
		});
	}
});
