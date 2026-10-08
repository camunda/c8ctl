/**
 * Unit tests for completion module
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	after,
	afterEach,
	before,
	beforeEach,
	describe,
	test,
} from "node:test";
import { showCompletion } from "../../src/framework/ui/completion.ts";
import { c8WithEnv } from "../utils/cli.ts";
import { mockProcessExit } from "../utils/mocks.ts";
import { asyncSpawn } from "../utils/spawn.ts";

describe("Loaded plugin flag completions", () => {
	const dir = mkdtempSync(join(tmpdir(), "c8ctl-completion-flags-"));
	before(() => {
		for (const name of ["plugin-with-flags", "plugin-with-verb-scoped-flag"]) {
			const destination = join(dir, "plugins", "node_modules", name);
			mkdirSync(destination, { recursive: true });
			cpSync(
				new URL(`../fixtures/plugins/${name}/`, import.meta.url),
				destination,
				{
					recursive: true,
				},
			);
		}
	});
	after(() => rmSync(dir, { recursive: true, force: true }));

	for (const shell of ["bash", "zsh", "fish"]) {
		test(`${shell} scopes plugin flags and metadata to their owning command`, {
			skip:
				shell !== "fish" && spawnSync(shell, ["--version"]).status !== 0
					? `${shell} is not installed`
					: false,
		}, async () => {
			const result = await c8WithEnv(
				{ C8CTL_DATA_DIR: dir },
				"completion",
				shell,
			);
			assert.strictEqual(result.status, 0, result.stderr);
			if (shell === "fish") {
				for (const [command, name, description] of [
					["test-flags", "source", "Source element ID"],
					["test-required", "required-name", "A required string flag"],
					["verb-scoped-demo", "limit", "Plugin"],
				]) {
					const lines = result.stdout
						.split("\n")
						.filter(
							(line) =>
								line.includes(`-l ${name} `) && line.includes(description),
						);
					assert.strictEqual(lines.length, 2);
					for (const line of lines) {
						assert.ok(
							line.includes(`-n '__fish_seen_subcommand_from ${command}'`),
							line,
						);
						assert.ok(line.endsWith(" -r"), line);
					}
				}
				return;
			}
			for (const [command, expected, excluded] of [
				["test-flags", "--source", "--required-name"],
				["test-required", "--required-name", "--source"],
				["verb-scoped-demo", "--limit", "--source"],
				["test-bare", "--profile", "--source"],
				["list", "--profile", "--source"],
				["cluster", "--profile", "--source"],
				["missing-command", "--profile", "--source"],
			]) {
				for (const argument of command.startsWith("test-") ||
				command === "verb-scoped-demo"
					? ["argument ", ""]
					: ["argument "]) {
					const script =
						shell === "bash"
							? `${result.stdout}\nCOMP_WORDS=(c8ctl ${command} ${argument}--)\nCOMP_CWORD=${argument ? 3 : 2}\n_c8ctl_completions\nprintf '%s\\n' "\${COMPREPLY[@]}"`
							: `${result.stdout}\n_arguments() { printf '%s\\n' "$@"; }\nwords=(c8ctl ${command} ${argument}--)\nCURRENT=${argument ? 4 : 3}\n_c8ctl`;
					const completed = await asyncSpawn(
						shell,
						shell === "bash"
							? ["--norc", "--noprofile", "-c", script]
							: ["-f", "-c", script],
					);
					assert.strictEqual(completed.status, 0, completed.stderr);
					assert.ok(
						completed.stdout.includes(expected),
						`${command}: missing ${expected}`,
					);
					assert.ok(
						!completed.stdout.includes(excluded),
						`${command}: leaked ${excluded}`,
					);
					if (command === "verb-scoped-demo" && shell === "zsh") {
						assert.ok(completed.stdout.includes("Plugin"), completed.stdout);
						assert.ok(completed.stdout.includes("]:limit:"), completed.stdout);
					}
				}
			}
		});

		test(`${shell} includes usable flags from every loaded plugin command`, async () => {
			const result = await c8WithEnv(
				{ C8CTL_DATA_DIR: dir },
				"completion",
				shell,
			);
			assert.strictEqual(result.status, 0, result.stderr);
			for (const name of [
				"source",
				"target",
				"debug",
				"required-name",
				"safe",
				"label-value",
				"limit",
				"between",
			]) {
				const token = shell === "fish" ? `-l ${name} ` : `--${name}`;
				assert.ok(
					result.stdout.includes(token),
					`Missing plugin flag ${token}`,
				);
			}
			assert.ok(
				!result.stdout.includes("Collides with built-in --verbose flag"),
			);
			assert.ok(!result.stdout.includes("Plugin's own --profile"));
			if (shell === "bash") {
				const flags = result.stdout
					.match(/local flags="([^"]*)"/)?.[1]
					?.split(" ");
				assert.ok(flags);
				assert.strictEqual(flags.length, new Set(flags).size);
			} else if (shell === "zsh") {
				assert.ok(
					result.stdout.includes("--source[Source element ID]:source:"),
				);
				assert.ok(result.stdout.includes("--debug[Enable debug output]'"));
				assert.ok(!result.stdout.includes("-y[Short alias collides"));
				assert.strictEqual(result.stdout.match(/'--limit\[Plugin/g)?.length, 1);
			} else {
				assert.ok(
					result.stdout.includes("-l source -d 'Source element ID' -r"),
				);
				assert.ok(
					result.stdout.includes("-l debug -d 'Enable debug output'\n"),
				);
				assert.ok(!result.stdout.includes("-s y -l label-value"));
				assert.strictEqual(
					result.stdout.match(/-l limit -d 'Plugin/g)?.length,
					2,
				);
			}
		});
	}
});

describe("Completion Module", () => {
	let consoleLogSpy: unknown[];
	let consoleErrorSpy: unknown[];
	let originalLog: typeof console.log;
	let originalError: typeof console.error;
	let restoreExit: (() => void) | undefined;

	beforeEach(() => {
		consoleLogSpy = [];
		consoleErrorSpy = [];
		originalLog = console.log;
		originalError = console.error;

		console.log = (...args: unknown[]) => {
			consoleLogSpy.push(args.join(" "));
		};

		console.error = (...args: unknown[]) => {
			consoleErrorSpy.push(args.join(" "));
		};

		// Stub process.exit so any stray call throws (kept as a safety net
		// even though migrated handlers now throw instead of calling exit).
		restoreExit = mockProcessExit((code) => {
			throw new Error(`process.exit(${code})`);
		});
	});

	afterEach(() => {
		console.log = originalLog;
		console.error = originalError;
		restoreExit?.();
	});

	test("generates bash completion script", () => {
		showCompletion("bash");

		const output = consoleLogSpy.join("\n");

		// Check for bash-specific content
		assert.ok(output.includes("# c8ctl bash completion"));
		assert.ok(output.includes("_c8ctl_completions()"));
		assert.ok(
			output.includes(`cur="\${COMP_WORDS[COMP_CWORD]}"`),
			"Should initialize cur variable",
		);
		assert.ok(output.includes("COMPREPLY=()"), "Should initialize COMPREPLY");
		assert.ok(output.includes("complete -F _c8ctl_completions c8ctl"));
		assert.ok(output.includes("complete -F _c8ctl_completions c8"));

		// Check for verbs (derived from COMMAND_REGISTRY)
		assert.ok(output.includes("list"));
		assert.ok(output.includes("get"));
		assert.ok(output.includes("create"));
		assert.ok(output.includes("deploy"));
		assert.ok(output.includes("run"));
		assert.ok(output.includes("upgrade"));
		assert.ok(output.includes("downgrade"));
		assert.ok(output.includes("init"));

		// Check for resources (derived from RESOURCE_ALIASES)
		assert.ok(output.includes("process-instance"));
		assert.ok(output.includes("user-task"));
		assert.ok(output.includes("incident"));

		// Check for open command (resources are app names from registry)
		assert.ok(output.includes("open"), "Should include open verb");
		assert.ok(output.includes("operate"), "Should include operate resource");
		assert.ok(output.includes("tasklist"), "Should include tasklist resource");

		// Check for feedback command
		assert.ok(output.includes("feedback"), "Should include feedback verb");
	});

	test("generates zsh completion script", () => {
		showCompletion("zsh");

		const output = consoleLogSpy.join("\n");

		// Check for zsh-specific content
		assert.ok(output.includes("#compdef c8ctl c8"));
		assert.ok(output.includes("_c8ctl()"));
		assert.ok(output.includes("_describe"));
		assert.ok(output.includes("_arguments"));

		// Check for verbs with descriptions (derived from registry)
		assert.ok(output.includes("'list:List resources"));
		assert.ok(output.includes("'get:Get resource by key'"));
		assert.ok(output.includes("'deploy:Deploy resources'"));
		assert.ok(output.includes("'upgrade:Upgrade a plugin'"));
		assert.ok(output.includes("'downgrade:Downgrade a plugin"));
		assert.ok(
			output.includes("'init:Create a new plugin from TypeScript template'"),
		);

		// Check for flags (descriptions from registry)
		assert.ok(output.includes("--profile[Use a specific profile]"));
		assert.ok(output.includes("--help[Show help]"));

		// Check for open command
		assert.ok(
			output.includes("'open:Open Camunda web application in browser'"),
			"Should include open verb",
		);
		assert.ok(output.includes("operate:"), "Should include operate resource");
		assert.ok(output.includes("tasklist:"), "Should include tasklist resource");
		assert.ok(output.includes("modeler:"), "Should include modeler resource");
		assert.ok(output.includes("optimize:"), "Should include optimize resource");

		// Check for feedback command
		assert.ok(
			output.includes(
				"'feedback:Open the feedback page to report issues or request features'",
			),
			"Should include feedback verb",
		);
	});

	test("generates fish completion script", () => {
		showCompletion("fish");

		const output = consoleLogSpy.join("\n");

		// Check for fish-specific content
		assert.ok(output.includes("# c8ctl fish completion"));
		assert.ok(output.includes("complete -c c8ctl"));
		assert.ok(output.includes("complete -c c8"));
		assert.ok(output.includes("__fish_use_subcommand"));
		assert.ok(output.includes("__fish_seen_subcommand_from"));

		// Check for commands (descriptions from registry)
		assert.ok(output.includes("'list' -d 'List resources"));
		assert.ok(output.includes("'deploy' -d 'Deploy resources'"));

		// Check for flags
		assert.ok(output.includes("-s h -l help"));
		assert.ok(output.includes("-l profile"));

		// Check for open command
		assert.ok(
			output.includes("'open' -d 'Open Camunda web application in browser'"),
			"Should include open verb",
		);
		assert.ok(output.includes("'operate'"), "Should include operate resource");
		assert.ok(
			output.includes("'tasklist'"),
			"Should include tasklist resource",
		);

		// Check for feedback command
		assert.ok(
			output.includes(
				"'feedback' -d 'Open the feedback page to report issues or request features'",
			),
			"Should include feedback verb",
		);
	});

	test("handles missing shell argument", () => {
		try {
			showCompletion(undefined);
			assert.fail("Should have thrown an error");
		} catch (error) {
			assert.ok(
				error instanceof Error && error.message.includes("Shell type required"),
			);
			assert.ok(
				error instanceof Error &&
					error.message.includes("c8 completion <bash|zsh|fish>"),
			);
		}
	});

	test("handles unknown shell", () => {
		try {
			showCompletion("powershell");
			assert.fail("Should have thrown an error");
		} catch (error) {
			assert.ok(
				error instanceof Error &&
					error.message.includes("Unknown shell: powershell"),
			);
			assert.ok(
				error instanceof Error &&
					error.message.includes("Supported shells: bash, zsh, fish"),
			);
		}
	});

	test("handles case-insensitive shell names", () => {
		showCompletion("BASH");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("# c8ctl bash completion"));

		consoleLogSpy.length = 0;
		showCompletion("Zsh");

		const output2 = consoleLogSpy.join("\n");
		assert.ok(output2.includes("#compdef c8ctl c8"));

		consoleLogSpy.length = 0;
		showCompletion("FiSh");

		const output3 = consoleLogSpy.join("\n");
		assert.ok(output3.includes("# c8ctl fish completion"));
	});
});
