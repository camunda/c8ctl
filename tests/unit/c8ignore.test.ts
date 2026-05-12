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
		let resolveIgnoreBaseDir: typeof import("../../src/ignore.ts").resolveIgnoreBaseDir;

		beforeEach(async () => {
			const mod = await import("../../src/ignore.ts");
			loadIgnoreRules = mod.loadIgnoreRules;
			isIgnored = mod.isIgnored;
			resolveIgnoreBaseDir = mod.resolveIgnoreBaseDir;
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

		test("resolveIgnoreBaseDir returns directory for a directory path", () => {
			const subDir = join(testDir, "myproject");
			mkdirSync(subDir, { recursive: true });
			assert.strictEqual(resolveIgnoreBaseDir([subDir]), subDir);
		});

		test("resolveIgnoreBaseDir returns parent for a file path", () => {
			const file = join(testDir, "process.bpmn");
			writeFileSync(file, "<bpmn/>");
			assert.strictEqual(resolveIgnoreBaseDir([file]), testDir);
		});

		test("resolveIgnoreBaseDir defaults to cwd for empty array", () => {
			const result = resolveIgnoreBaseDir([]);
			assert.strictEqual(result, process.cwd());
		});

		test("resolveIgnoreBaseDir returns common ancestor for multiple sibling dirs", () => {
			const dirA = join(testDir, "projA");
			const dirB = join(testDir, "projB");
			mkdirSync(dirA, { recursive: true });
			mkdirSync(dirB, { recursive: true });
			assert.strictEqual(
				resolveIgnoreBaseDir([dirA, dirB]),
				testDir,
				"common ancestor of sibling dirs should be their parent",
			);
		});

		test("resolveIgnoreBaseDir always returns a normalized path", () => {
			// The result must always be a valid directory path — never an
			// empty string or a bare drive letter like "C:".
			const result = resolveIgnoreBaseDir([
				join(testDir, "a"),
				join(testDir, "b"),
			]);
			assert.ok(result.length > 0, "should not return an empty string");
			assert.ok(!result.endsWith(":"), "should not return a bare drive letter");
			assert.strictEqual(
				result,
				testDir,
				"should return common ancestor of sibling paths",
			);
		});
	});

	// ── Target-directory resolution (#258) ───────────────────────────

	describe(".c8ignore resolves from target directory, not cwd (#258)", () => {
		test("deploy target dir picks up .c8ignore from that dir", () => {
			// Scenario from #258:
			//   testDir/           ← cwd (no .c8ignore here)
			//     project/
			//       .c8ignore      ← contains "dist/"
			//       main.bpmn
			//       dist/
			//         output.bpmn  ← should be ignored
			const projectDir = join(testDir, "project");
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(projectDir, ".c8ignore"), "dist/\n");
			writeFileSync(join(projectDir, "main.bpmn"), "<bpmn/>");
			mkdirSync(join(projectDir, "dist"), { recursive: true });
			writeFileSync(join(projectDir, "dist", "output.bpmn"), "<bpmn/>");

			// Deploy from parent (testDir as cwd), targeting ./project/
			const result = dryRunDeploy(testDir, ["./project/"]);
			const names = resourceNames(result);
			assert.deepStrictEqual(
				names,
				["main.bpmn"],
				"dist/output.bpmn should be ignored by project/.c8ignore",
			);
		});

		test("deploy with no target still uses cwd (backward compat)", () => {
			// .c8ignore at cwd should still work when no target is specified
			writeFileSync(join(testDir, ".c8ignore"), "dist/\n");
			writeFileSync(join(testDir, "main.bpmn"), "<bpmn/>");
			mkdirSync(join(testDir, "dist"), { recursive: true });
			writeFileSync(join(testDir, "dist", "output.bpmn"), "<bpmn/>");

			const result = dryRunDeploy(testDir);
			const names = resourceNames(result);
			assert.deepStrictEqual(names, ["main.bpmn"]);
		});

		test("deploy explicit file resolves .c8ignore from file's parent dir", () => {
			// When deploying an explicit file path, resolveIgnoreBaseDir
			// should use the file's parent directory. We verify by deploying
			// two explicit files from a directory that has a .c8ignore —
			// one file matches the ignore rule and should be filtered out.
			const projectDir = join(testDir, "project");
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(projectDir, ".c8ignore"), "draft-*.bpmn\n");
			writeFileSync(join(projectDir, "main.bpmn"), "<bpmn/>");
			writeFileSync(join(projectDir, "draft-wip.bpmn"), "<bpmn/>");

			// Deploy two explicit files from the parent dir — .c8ignore in
			// projectDir should filter out the draft file
			const result = dryRunDeploy(testDir, [
				"./project/main.bpmn",
				"./project/draft-wip.bpmn",
			]);
			const names = resourceNames(result);
			assert.deepStrictEqual(
				names,
				["main.bpmn"],
				"draft-wip.bpmn should be ignored by project/.c8ignore",
			);
		});

		test("deploy subdirectory picks up .c8ignore from subdirectory", () => {
			// .c8ignore in a subdirectory, deploy that subdirectory from grandparent
			const subDir = join(testDir, "a", "b");
			mkdirSync(subDir, { recursive: true });
			writeFileSync(join(subDir, ".c8ignore"), "scratch/\n");
			writeFileSync(join(subDir, "process.bpmn"), "<bpmn/>");
			mkdirSync(join(subDir, "scratch"), { recursive: true });
			writeFileSync(join(subDir, "scratch", "draft.bpmn"), "<bpmn/>");

			const result = dryRunDeploy(testDir, ["./a/b/"]);
			const names = resourceNames(result);
			assert.deepStrictEqual(
				names,
				["process.bpmn"],
				"scratch/draft.bpmn should be ignored by a/b/.c8ignore",
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

		test("watch target dir picks up .c8ignore from that dir (#258)", () => {
			// Watch from a parent directory, targeting a subdirectory that has .c8ignore
			const projectDir = join(testDir, "project");
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(projectDir, ".c8ignore"), "ignored/\n");
			mkdirSync(join(projectDir, "ignored"), { recursive: true });
			writeFileSync(join(projectDir, "ignored", "hidden.bpmn"), "<bpmn/>");
			writeFileSync(join(projectDir, "visible.bpmn"), "<bpmn/>");

			// Helper waits for the "Watching for changes" readiness banner
			// before writing a file, ensuring the watcher is actually live.
			const helperScript = `
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const { join } = require('node:path');

        const proc = spawn('node', [
          '--experimental-strip-types',
          ${JSON.stringify(CLI_ENTRY)},
          'watch', './project/',
        ], { stdio: 'pipe', cwd: ${JSON.stringify(testDir)} });

        let output = '';
        let ready = false;
        proc.stdout.on('data', d => {
          output += d;
          if (!ready && output.includes('Watching for changes')) {
            ready = true;
            writeFileSync(join(${JSON.stringify(projectDir)}, 'ignored', 'hidden.bpmn'), '<updated/>');
            setTimeout(() => {
              proc.kill('SIGTERM');
              process.stdout.write(output);
              process.exit(0);
            }, 1500);
          }
        });
        proc.stderr.on('data', d => {
          output += d;
          if (!ready && output.includes('Watching for changes')) {
            ready = true;
            writeFileSync(join(${JSON.stringify(projectDir)}, 'ignored', 'hidden.bpmn'), '<updated/>');
            setTimeout(() => {
              proc.kill('SIGTERM');
              process.stdout.write(output);
              process.exit(0);
            }, 1500);
          }
        });

        // Safety timeout: if watch never starts, fail explicitly
        setTimeout(() => {
          if (!ready) {
            proc.kill('SIGTERM');
            process.stderr.write('WATCH_NEVER_READY: ' + output);
            process.exit(1);
          }
        }, 4000);
      `;

			const result = spawnSync("node", ["-e", helperScript], {
				encoding: "utf-8",
				timeout: 8000,
				cwd: testDir,
				env: {
					...process.env,
					XDG_DATA_HOME: join(tmpdir(), `c8ctl-watch-ign-${Date.now()}`),
				},
			});

			const output = (result.stdout ?? "") + (result.stderr ?? "");

			// Assert the watcher actually started (didn't silently fail)
			assert.ok(
				!output.includes("WATCH_NEVER_READY"),
				`Watcher never reached readiness:\n${output}`,
			);
			assert.strictEqual(
				result.status,
				0,
				`Helper script should exit cleanly, got status ${result.status}:\n${output}`,
			);

			// .c8ignore from project/ dir should be picked up even though
			// watch was started from the parent (testDir)
			assert.ok(
				!output.includes("Change detected"),
				`Watch should pick up .c8ignore from target dir, but got:\n${output}`,
			);
		});
	});
});
