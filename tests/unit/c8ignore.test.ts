/**
 * Unit tests for .c8ignore support in deploy and watch commands
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

const CLI_ENTRY = join(process.cwd(), "src", "index.ts");

/**
 * Run the CLI and return parsed JSON from combined stderr+stdout.
 * Uses --dry-run so no server is needed and the output lists
 * the resources that would be deployed (dry-run always emits JSON).
 */
function dryRunDeploy(
	cwd: string,
	paths: string[] = ["."],
): { body: { resources: { name: string }[] } } {
	const result = spawnSync(
		"node",
		["--experimental-strip-types", CLI_ENTRY, "deploy", ...paths, "--dry-run"],
		{
			cwd,
			encoding: "utf-8",
			env: {
				...process.env,
				XDG_DATA_HOME: join(tmpdir(), `c8ctl-ignore-xdg-${Date.now()}`),
			},
			timeout: 15000,
		},
	);

	const output = (result.stdout ?? "") + (result.stderr ?? "");

	// The dry-run JSON may be on stdout or stderr depending on output mode.
	// Extract first JSON object from combined output.
	const jsonMatch = output.match(/\{[\s\S]*\}/);
	assert.ok(jsonMatch, `Expected JSON output, got:\n${output}`);
	return JSON.parse(jsonMatch[0]);
}

function resourceNames(result: {
	body: { resources: { name: string }[] };
}): string[] {
	return result.body.resources.map((r) => r.name).sort();
}

describe(".c8ignore", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `c8ctl-c8ignore-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	// ── Default ignore patterns ──────────────────────────────────────

	describe("default ignore patterns (no .c8ignore file)", () => {
		test("ignores node_modules directory", () => {
			writeFileSync(join(testDir, "root.bpmn"), "<bpmn/>");
			mkdirSync(join(testDir, "node_modules", "pkg"), { recursive: true });
			writeFileSync(
				join(testDir, "node_modules", "pkg", "hidden.bpmn"),
				"<bpmn/>",
			);

			const result = dryRunDeploy(testDir);
			const names = resourceNames(result);
			assert.deepStrictEqual(names, ["root.bpmn"]);
		});

		test("ignores target directory", () => {
			writeFileSync(join(testDir, "root.bpmn"), "<bpmn/>");
			mkdirSync(join(testDir, "target", "classes"), { recursive: true });
			writeFileSync(
				join(testDir, "target", "classes", "hidden.bpmn"),
				"<bpmn/>",
			);

			const result = dryRunDeploy(testDir);
			const names = resourceNames(result);
			assert.deepStrictEqual(names, ["root.bpmn"]);
		});

		test("ignores .git directory", () => {
			writeFileSync(join(testDir, "root.bpmn"), "<bpmn/>");
			mkdirSync(join(testDir, ".git", "objects"), { recursive: true });
			writeFileSync(join(testDir, ".git", "objects", "hidden.bpmn"), "<bpmn/>");

			const result = dryRunDeploy(testDir);
			const names = resourceNames(result);
			assert.deepStrictEqual(names, ["root.bpmn"]);
		});

		test("ignores all default dirs together", () => {
			writeFileSync(join(testDir, "main.bpmn"), "<bpmn/>");
			mkdirSync(join(testDir, "node_modules"), { recursive: true });
			writeFileSync(join(testDir, "node_modules", "a.bpmn"), "<bpmn/>");
			mkdirSync(join(testDir, "target"), { recursive: true });
			writeFileSync(join(testDir, "target", "b.bpmn"), "<bpmn/>");
			mkdirSync(join(testDir, ".git"), { recursive: true });
			writeFileSync(join(testDir, ".git", "c.bpmn"), "<bpmn/>");

			const result = dryRunDeploy(testDir);
			const names = resourceNames(result);
			assert.deepStrictEqual(names, ["main.bpmn"]);
		});

		test("does not ignore regular subdirectories", () => {
			writeFileSync(join(testDir, "root.bpmn"), "<bpmn/>");
			mkdirSync(join(testDir, "src"), { recursive: true });
			writeFileSync(join(testDir, "src", "sub.bpmn"), "<bpmn/>");

			const result = dryRunDeploy(testDir);
			const names = resourceNames(result);
			assert.deepStrictEqual(names, ["root.bpmn", "sub.bpmn"]);
		});
	});

	// ── .c8ignore file patterns ──────────────────────────────────────

	describe(".c8ignore file patterns", () => {
		test("ignores files matching a glob pattern", () => {
			writeFileSync(join(testDir, ".c8ignore"), "build/\n");
			writeFileSync(join(testDir, "main.bpmn"), "<bpmn/>");
			mkdirSync(join(testDir, "build"), { recursive: true });
			writeFileSync(join(testDir, "build", "output.bpmn"), "<bpmn/>");

			const result = dryRunDeploy(testDir);
			const names = resourceNames(result);
			assert.deepStrictEqual(names, ["main.bpmn"]);
		});

		test("ignores files matching a wildcard pattern", () => {
			writeFileSync(join(testDir, ".c8ignore"), "**/temp-*.bpmn\n");
			writeFileSync(join(testDir, "main.bpmn"), "<bpmn/>");
			writeFileSync(join(testDir, "temp-draft.bpmn"), "<bpmn/>");
			mkdirSync(join(testDir, "sub"), { recursive: true });
			writeFileSync(join(testDir, "sub", "temp-old.bpmn"), "<bpmn/>");

			const result = dryRunDeploy(testDir);
			const names = resourceNames(result);
			assert.deepStrictEqual(names, ["main.bpmn"]);
		});

		test("supports negation patterns (!)", () => {
			// gitignore spec: you cannot re-include a file under an ignored parent directory.
			// Negation works for file-level patterns, not directory-level re-inclusion.
			writeFileSync(
				join(testDir, ".c8ignore"),
				"*.draft.bpmn\n!important.draft.bpmn\n",
			);
			writeFileSync(join(testDir, "main.bpmn"), "<bpmn/>");
			writeFileSync(join(testDir, "sketch.draft.bpmn"), "<bpmn/>");
			writeFileSync(join(testDir, "important.draft.bpmn"), "<bpmn/>");

			const result = dryRunDeploy(testDir);
			const names = resourceNames(result);
			assert.ok(names.includes("main.bpmn"), "root file should be included");
			assert.ok(
				names.includes("important.draft.bpmn"),
				"negated file should be included",
			);
			assert.ok(
				!names.includes("sketch.draft.bpmn"),
				"non-negated match should be excluded",
			);
		});

		test("supports comments in .c8ignore", () => {
			writeFileSync(
				join(testDir, ".c8ignore"),
				"# This is a comment\nbuild/\n# Another comment\n",
			);
			writeFileSync(join(testDir, "main.bpmn"), "<bpmn/>");
			mkdirSync(join(testDir, "build"), { recursive: true });
			writeFileSync(join(testDir, "build", "gone.bpmn"), "<bpmn/>");

			const result = dryRunDeploy(testDir);
			const names = resourceNames(result);
			assert.deepStrictEqual(names, ["main.bpmn"]);
		});

		test("supports blank lines in .c8ignore", () => {
			writeFileSync(join(testDir, ".c8ignore"), "\nbuild/\n\n");
			writeFileSync(join(testDir, "main.bpmn"), "<bpmn/>");
			mkdirSync(join(testDir, "build"), { recursive: true });
			writeFileSync(join(testDir, "build", "gone.bpmn"), "<bpmn/>");

			const result = dryRunDeploy(testDir);
			const names = resourceNames(result);
			assert.deepStrictEqual(names, ["main.bpmn"]);
		});

		test(".c8ignore patterns add to (do not replace) defaults", () => {
			writeFileSync(join(testDir, ".c8ignore"), "dist/\n");
			writeFileSync(join(testDir, "main.bpmn"), "<bpmn/>");
			mkdirSync(join(testDir, "node_modules"), { recursive: true });
			writeFileSync(join(testDir, "node_modules", "a.bpmn"), "<bpmn/>");
			mkdirSync(join(testDir, "dist"), { recursive: true });
			writeFileSync(join(testDir, "dist", "b.bpmn"), "<bpmn/>");

			const result = dryRunDeploy(testDir);
			const names = resourceNames(result);
			assert.deepStrictEqual(names, ["main.bpmn"]);
		});

		test("ignores deeply nested files matching pattern", () => {
			writeFileSync(join(testDir, ".c8ignore"), "vendor/\n");
			writeFileSync(join(testDir, "main.bpmn"), "<bpmn/>");
			mkdirSync(join(testDir, "vendor", "deep", "nested"), { recursive: true });
			writeFileSync(
				join(testDir, "vendor", "deep", "nested", "gone.bpmn"),
				"<bpmn/>",
			);

			const result = dryRunDeploy(testDir);
			const names = resourceNames(result);
			assert.deepStrictEqual(names, ["main.bpmn"]);
		});
	});

	// ── Edge cases ───────────────────────────────────────────────────

	describe("edge cases", () => {
		test("works when .c8ignore file does not exist", () => {
			writeFileSync(join(testDir, "main.bpmn"), "<bpmn/>");

			const result = dryRunDeploy(testDir);
			const names = resourceNames(result);
			assert.deepStrictEqual(names, ["main.bpmn"]);
		});

		test("empty .c8ignore still applies default patterns", () => {
			writeFileSync(join(testDir, ".c8ignore"), "");
			writeFileSync(join(testDir, "main.bpmn"), "<bpmn/>");
			mkdirSync(join(testDir, "node_modules"), { recursive: true });
			writeFileSync(join(testDir, "node_modules", "hidden.bpmn"), "<bpmn/>");

			const result = dryRunDeploy(testDir);
			const names = resourceNames(result);
			assert.deepStrictEqual(names, ["main.bpmn"]);
		});

		test("does not ignore building block folders unless explicitly listed", () => {
			writeFileSync(join(testDir, "main.bpmn"), "<bpmn/>");
			mkdirSync(join(testDir, "_bb-blocks"), { recursive: true });
			writeFileSync(join(testDir, "_bb-blocks", "block.bpmn"), "<bpmn/>");

			const result = dryRunDeploy(testDir);
			const names = resourceNames(result);
			assert.ok(
				names.includes("block.bpmn"),
				"building block files should be included",
			);
			assert.ok(names.includes("main.bpmn"), "root file should be included");
		});

		test("can explicitly ignore building block folder via .c8ignore", () => {
			writeFileSync(join(testDir, ".c8ignore"), "_bb-old-blocks/\n");
			writeFileSync(join(testDir, "main.bpmn"), "<bpmn/>");
			mkdirSync(join(testDir, "_bb-old-blocks"), { recursive: true });
			writeFileSync(join(testDir, "_bb-old-blocks", "old.bpmn"), "<bpmn/>");
			mkdirSync(join(testDir, "_bb-active"), { recursive: true });
			writeFileSync(join(testDir, "_bb-active", "active.bpmn"), "<bpmn/>");

			const result = dryRunDeploy(testDir);
			const names = resourceNames(result);
			assert.ok(names.includes("main.bpmn"));
			assert.ok(
				names.includes("active.bpmn"),
				"non-ignored BB folder should be included",
			);
			assert.ok(
				!names.includes("old.bpmn"),
				"ignored BB folder should be excluded",
			);
		});

		test("handles all resource extensions (.bpmn, .dmn, .form)", () => {
			writeFileSync(join(testDir, ".c8ignore"), "ignored/\n");
			writeFileSync(join(testDir, "process.bpmn"), "<bpmn/>");
			writeFileSync(join(testDir, "decision.dmn"), "<dmn/>");
			writeFileSync(join(testDir, "input.form"), "{}");
			mkdirSync(join(testDir, "ignored"), { recursive: true });
			writeFileSync(join(testDir, "ignored", "hidden.bpmn"), "<bpmn/>");
			writeFileSync(join(testDir, "ignored", "hidden.dmn"), "<dmn/>");
			writeFileSync(join(testDir, "ignored", "hidden.form"), "{}");

			const result = dryRunDeploy(testDir);
			const names = resourceNames(result);
			assert.deepStrictEqual(names, [
				"decision.dmn",
				"input.form",
				"process.bpmn",
			]);
		});

		test("ignoring a specific file by name", () => {
			writeFileSync(join(testDir, ".c8ignore"), "draft.bpmn\n");
			writeFileSync(join(testDir, "main.bpmn"), "<bpmn/>");
			writeFileSync(join(testDir, "draft.bpmn"), "<bpmn/>");

			const result = dryRunDeploy(testDir);
			const names = resourceNames(result);
			assert.deepStrictEqual(names, ["main.bpmn"]);
		});
	});

	// ── loadIgnoreRules / isIgnored unit tests ───────────────────────

	describe("ignore module (unit)", () => {
		// Import the module functions directly
		let loadIgnoreRules: typeof import("../../src/ignore.ts").loadIgnoreRules;
		let isIgnored: typeof import("../../src/ignore.ts").isIgnored;

		beforeEach(async () => {
			const mod = await import("../../src/ignore.ts");
			loadIgnoreRules = mod.loadIgnoreRules;
			isIgnored = mod.isIgnored;
		});

		test("loadIgnoreRules returns ignore instance with defaults", () => {
			const ig = loadIgnoreRules(testDir);
			assert.ok(ig, "should return an ignore instance");
			assert.strictEqual(ig.ignores("node_modules/foo"), true);
			assert.strictEqual(ig.ignores("target/classes/bar"), true);
			assert.strictEqual(ig.ignores(".git/HEAD"), true);
			assert.strictEqual(ig.ignores("src/main.bpmn"), false);
		});

		test("loadIgnoreRules merges .c8ignore with defaults", () => {
			writeFileSync(join(testDir, ".c8ignore"), "dist/\n");
			const ig = loadIgnoreRules(testDir);
			assert.strictEqual(ig.ignores("dist/output.js"), true);
			assert.strictEqual(ig.ignores("node_modules/pkg"), true);
			assert.strictEqual(ig.ignores("src/main.ts"), false);
		});

		test("isIgnored handles paths relative to baseDir", () => {
			const ig = loadIgnoreRules(testDir);
			const full = join(testDir, "node_modules", "pkg", "file.bpmn");
			assert.strictEqual(isIgnored(ig, full, testDir), true);
		});

		test("isIgnored returns false for paths outside baseDir", () => {
			const ig = loadIgnoreRules(testDir);
			assert.strictEqual(
				isIgnored(ig, "/some/other/path/file.bpmn", testDir),
				false,
			);
		});
	});

	// ── Watch mode filtering ─────────────────────────────────────────

	describe("watch mode respects .c8ignore", () => {
		test("ignored file change does not trigger deploy", () => {
			// Set up directory with .c8ignore and an ignored subfolder
			writeFileSync(join(testDir, ".c8ignore"), "ignored/\n");
			mkdirSync(join(testDir, "ignored"), { recursive: true });
			writeFileSync(join(testDir, "ignored", "hidden.bpmn"), "<bpmn/>");
			writeFileSync(join(testDir, "visible.bpmn"), "<bpmn/>");

			// Use a helper script that starts watch, modifies an ignored file,
			// then collects output. The helper runs in testDir so .c8ignore is found.
			const helperScript = `
        const { spawn, execSync } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const { join } = require('node:path');

        const proc = spawn('node', [
          '--experimental-strip-types',
          ${JSON.stringify(CLI_ENTRY)},
          'watch', '.',
        ], { stdio: 'pipe', cwd: ${JSON.stringify(testDir)} });

        let output = '';
        proc.stdout.on('data', d => output += d);
        proc.stderr.on('data', d => output += d);

        setTimeout(() => {
          writeFileSync(join(${JSON.stringify(testDir)}, 'ignored', 'hidden.bpmn'), '<updated/>');
          setTimeout(() => {
            proc.kill('SIGTERM');
            process.stdout.write(output);
            process.exit(0);
          }, 1500);
        }, 500);
      `;

			const result = spawnSync("node", ["-e", helperScript], {
				encoding: "utf-8",
				timeout: 5000,
				cwd: testDir,
				env: {
					...process.env,
					XDG_DATA_HOME: join(tmpdir(), `c8ctl-watch-ign-${Date.now()}`),
				},
			});

			const output = (result.stdout ?? "") + (result.stderr ?? "");

			// "Change detected" should NOT appear for the ignored file
			assert.ok(
				!output.includes("Change detected"),
				`Watch should not detect changes in ignored directories, but got:\n${output}`,
			);
		});
	});
});
