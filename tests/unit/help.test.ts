/**
 * Unit tests for help module
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, test } from "node:test";
import { GLOBAL_FLAGS } from "../../src/command-registry.ts";
import {
	getVersion,
	showCommandHelp,
	showHelp,
	showVerbResources,
	showVersion,
} from "../../src/commands/help.ts";
import { c8ctl } from "../../src/runtime.ts";

describe("Help Module", () => {
	let consoleLogSpy: string[];
	let originalLog: typeof console.log;
	let originalOutputMode: typeof c8ctl.outputMode;

	beforeEach(() => {
		consoleLogSpy = [];
		originalLog = console.log;
		originalOutputMode = c8ctl.outputMode;
		c8ctl.outputMode = "text";

		console.log = (...args: unknown[]) => {
			consoleLogSpy.push(args.join(" "));
		};
	});

	afterEach(() => {
		console.log = originalLog;
		c8ctl.outputMode = originalOutputMode;
	});

	test("getVersion returns package version", () => {
		const version = getVersion();
		assert.ok(version);
		assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
	});

	test("showVersion outputs version", () => {
		showVersion();

		assert.strictEqual(consoleLogSpy.length, 1);
		assert.ok(consoleLogSpy[0].includes("c8ctl"));
		assert.ok(consoleLogSpy[0].includes("v"));
	});

	test("showHelp outputs full help text", () => {
		showHelp();

		const output = consoleLogSpy.join("\n");

		// Check for key sections
		assert.ok(output.includes("c8ctl - Camunda 8 CLI"));
		assert.ok(output.includes("Usage:"));
		assert.ok(output.includes("Commands:"));
		assert.ok(output.includes("Flags:"));

		// Check for main commands
		assert.ok(output.includes("list"));
		assert.ok(output.includes("get"));
		assert.ok(output.includes("create"));
		assert.ok(output.includes("await"));
		assert.ok(output.includes("deploy"));
		assert.ok(output.includes("run"));
		assert.ok(output.includes("load"));
		assert.ok(output.includes("unload"));

		// Check for aliases
		assert.ok(output.includes("pi"));
		assert.ok(output.includes("ut"));
		assert.ok(output.includes("inc"));
		assert.ok(output.includes("msg"));

		// Check for global flags only (per #321 — command-specific flags belong
		// in `c8ctl help <verb>`, not the top-level Flags section).
		assert.ok(output.includes("--profile"));
		assert.ok(output.includes("--version"));
		assert.ok(output.includes("--help"));
		assert.ok(output.includes("--dry-run"));
		assert.ok(output.includes("--verbose"));
		assert.ok(output.includes("--fields"));
		// Search flags still render in their dedicated Search Flags section.
		assert.ok(output.includes("--sortBy"));
		assert.ok(output.includes("--asc"));
		assert.ok(output.includes("--desc"));
		assert.ok(output.includes("--limit"));

		// Check for case-insensitive search flags
		assert.ok(output.includes("--iname"));
		assert.ok(output.includes("--iid"));
		assert.ok(output.includes("--iassignee"));
		assert.ok(output.includes("--ierrorMessage"));
		assert.ok(output.includes("--itype"));
		assert.ok(output.includes("--ivalue"));

		// Check for date range filter flags
		assert.ok(output.includes("--between"));
		assert.ok(output.includes("--dateField"));

		// Check for verbose flag
		assert.ok(output.includes("--verbose"));
	});

	test("showVerbResources shows resources for list", () => {
		showVerbResources("list");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl list"));
		assert.ok(output.includes("process-instance"));
		assert.ok(output.includes("user-task"));
		assert.ok(output.includes("incident"));
		assert.ok(output.includes("jobs"));
		assert.ok(output.includes("profile"));
		assert.ok(output.includes("plugin"));
	});

	test("showVerbResources shows resources for get", () => {
		showVerbResources("get");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl get"));
		assert.ok(output.includes("process-instance"));
		assert.ok(output.includes("incident"));
		assert.ok(output.includes("topology"));
		assert.ok(output.includes("form"));
	});

	test("showVerbResources shows resources for create", () => {
		showVerbResources("create");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl create"));
		assert.ok(output.includes("process-instance"));
	});

	test("showVerbResources shows resources for complete", () => {
		showVerbResources("complete");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl complete"));
		assert.ok(output.includes("user-task"));
		assert.ok(output.includes("job"));
	});

	test("showVerbResources shows resources for await", () => {
		showVerbResources("await");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl await"));
		assert.ok(output.includes("process-instance"));
	});

	test("showVerbResources shows resources for use", () => {
		showVerbResources("use");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl use"));
		assert.ok(output.includes("profile"));
		assert.ok(output.includes("tenant"));
	});

	test("showVerbResources shows resources for output", () => {
		showVerbResources("output");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl output"));
		assert.ok(output.includes("json"));
		assert.ok(output.includes("text"));
	});

	test("showVerbResources handles unknown verb", () => {
		showVerbResources("unknown");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("Unknown command"));
		assert.ok(output.includes("c8ctl help"));
	});

	test("showVerbResources shows resources for load", () => {
		showVerbResources("load");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl load"));
		assert.ok(output.includes("plugin"));
	});

	test("showVerbResources shows resources for unload", () => {
		showVerbResources("unload");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl unload"));
		assert.ok(output.includes("plugin"));
	});

	test("showVerbResources shows resources for upgrade", () => {
		showVerbResources("upgrade");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl upgrade"));
		assert.ok(output.includes("plugin"));
	});

	test("showVerbResources shows resources for downgrade", () => {
		showVerbResources("downgrade");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl downgrade"));
		assert.ok(output.includes("plugin"));
	});

	test("showVerbResources shows resources for init", () => {
		showVerbResources("init");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl init"));
		assert.ok(output.includes("plugin"));
	});

	test("showVerbResources shows resources for completion", () => {
		showVerbResources("completion");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl completion"));
		assert.ok(output.includes("bash"));
		assert.ok(output.includes("zsh"));
		assert.ok(output.includes("fish"));
	});

	test("showHelp includes completion command", () => {
		showHelp();

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("completion"));
		assert.ok(output.includes("bash|zsh|fish"));
	});

	test("showCommandHelp shows list help with resources and flags", () => {
		showCommandHelp("list");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl list"));
		assert.ok(output.includes("process-instance (pi)"));
		assert.ok(output.includes("--bpmnProcessId"));
		assert.ok(output.includes("--state"));
		assert.ok(output.includes("--assignee"));
		assert.ok(output.includes("--sortBy"));
		assert.ok(output.includes("--asc"));
		assert.ok(output.includes("--desc"));
		assert.ok(output.includes("--limit"));
		assert.ok(output.includes("user-task (ut)"));
		assert.ok(output.includes("incident (inc)"));
		assert.ok(output.includes("jobs"));
		assert.ok(output.includes("profile"));
		assert.ok(output.includes("plugin"));
		assert.ok(
			output.includes("--between"),
			"list help should include --between flag",
		);
		assert.ok(
			output.includes("--dateField"),
			"list help should include --dateField flag",
		);
	});

	test("showCommandHelp shows get help with resources and flags", () => {
		showCommandHelp("get");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl get"));
		assert.ok(output.includes("process-instance (pi)"));
		assert.ok(output.includes("--variables"));
		assert.ok(output.includes("process-definition (pd)"));
		assert.ok(output.includes("--xml"));
		assert.ok(output.includes("incident (inc)"));
		assert.ok(output.includes("topology"));
		assert.ok(output.includes("form"));
		assert.ok(output.includes("--userTask"));
		assert.ok(output.includes("--processDefinition"));
	});

	test("showCommandHelp shows create help with resources and flags", () => {
		showCommandHelp("create");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl create"));
		assert.ok(output.includes("process-instance"));
		assert.ok(
			output.includes("--processDefinitionId") ||
				output.includes("--bpmnProcessId"),
		);
		assert.ok(output.includes("--variables"));
	});

	test("showCommandHelp shows complete help with resources and flags", () => {
		showCommandHelp("complete");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl complete"));
		assert.ok(output.includes("user-task (ut)"));
		assert.ok(output.includes("job"));
		assert.ok(output.includes("--variables"));
	});

	test("showCommandHelp shows search help with resources and flags", () => {
		showCommandHelp("search");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl search"));
		assert.ok(output.includes("process-instance (pi)"));
		assert.ok(output.includes("process-definition (pd)"));
		assert.ok(output.includes("user-task (ut)"));
		assert.ok(output.includes("incident (inc)"));
		assert.ok(output.includes("jobs"));
		assert.ok(output.includes("variable"));
		assert.ok(output.includes("--bpmnProcessId"));
		assert.ok(output.includes("--id"));
		assert.ok(output.includes("--iid"));
		assert.ok(output.includes("--iname"));
		assert.ok(output.includes("--sortBy"));
		assert.ok(output.includes("--asc"));
		assert.ok(output.includes("--desc"));
		assert.ok(output.includes("--limit"));
		assert.ok(
			output.includes("--between"),
			"search help should include --between flag",
		);
		assert.ok(
			output.includes("--dateField"),
			"search help should include --dateField flag",
		);
	});

	test("showCommandHelp shows deploy help", () => {
		showCommandHelp("deploy");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl deploy"));
		assert.ok(output.includes("Deploy files"));
	});

	test("showCommandHelp shows run help", () => {
		showCommandHelp("run");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl run"));
		assert.ok(output.includes("Deploy and start"));
		assert.ok(output.includes("--variables"));
	});

	test("showCommandHelp shows watch help", () => {
		showCommandHelp("watch");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl watch"));
		assert.ok(output.includes("Watch files"));
		assert.ok(output.includes("Alias: w"));
		assert.ok(output.includes("--force"));
	});

	test("showCommandHelp shows open help", () => {
		showCommandHelp("open");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl open"));
		assert.ok(output.includes("operate"));
		assert.ok(output.includes("tasklist"));
		assert.ok(output.includes("modeler"));
		assert.ok(output.includes("optimize"));
		assert.ok(output.includes("--profile"));
	});

	test("showVerbResources shows resources for open", () => {
		showVerbResources("open");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl open"));
		assert.ok(output.includes("operate"));
		assert.ok(output.includes("tasklist"));
		assert.ok(output.includes("modeler"));
		assert.ok(output.includes("optimize"));
	});

	test("showHelp includes open command", () => {
		showHelp();

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("open"), "help should include open command");
		assert.ok(
			output.includes("c8ctl help open"),
			"help should include c8ctl help open link",
		);
	});

	test("showHelp includes feedback command and URL", () => {
		showHelp();

		const output = consoleLogSpy.join("\n");
		assert.ok(
			output.includes("feedback"),
			"help should include feedback command",
		);
		assert.match(
			output,
			/(^|\s)https:\/\/github\.com\/camunda\/c8ctl\/issues\b/,
			"help should include feedback URL",
		);
		assert.ok(
			output.includes("c8ctl feedback"),
			"help should include c8ctl feedback hint",
		);
	});

	test("showCommandHelp shows cancel help", () => {
		showCommandHelp("cancel");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl cancel"));
		assert.ok(output.includes("process-instance (pi)"));
	});

	test("showCommandHelp shows resolve help", () => {
		showCommandHelp("resolve");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl resolve"));
		assert.ok(output.includes("incident"));
	});

	test("showCommandHelp shows fail help", () => {
		showCommandHelp("fail");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl fail"));
		assert.ok(output.includes("job"));
		assert.ok(output.includes("--retries"));
		assert.ok(output.includes("--errorMessage"));
	});

	test("showCommandHelp shows activate help", () => {
		showCommandHelp("activate");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl activate"));
		assert.ok(output.includes("jobs"));
		assert.ok(output.includes("--maxJobsToActivate"));
		assert.ok(output.includes("--timeout"));
		assert.ok(output.includes("--worker"));
	});

	test("showCommandHelp shows publish help", () => {
		showCommandHelp("publish");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl publish"));
		assert.ok(output.includes("message"));
		assert.ok(output.includes("--correlationKey"));
		assert.ok(output.includes("--timeToLive"));
	});

	test("showCommandHelp shows correlate help", () => {
		showCommandHelp("correlate");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl correlate"));
		assert.ok(output.includes("message"));
		assert.ok(output.includes("--correlationKey"));
	});

	test("showCommandHelp handles watch alias w", () => {
		showCommandHelp("w");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl watch"));
		assert.ok(output.includes("Alias: w"));
	});

	test("showHelp includes all help commands", () => {
		showHelp();

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl help search"));
		assert.ok(output.includes("c8ctl help deploy"));
		assert.ok(output.includes("c8ctl help run"));
		assert.ok(output.includes("c8ctl help watch"));
		assert.ok(output.includes("c8ctl help open"));
		assert.ok(output.includes("c8ctl help cancel"));
		assert.ok(output.includes("c8ctl help resolve"));
		assert.ok(output.includes("c8ctl help fail"));
		assert.ok(output.includes("c8ctl help activate"));
		assert.ok(output.includes("c8ctl help publish"));
		assert.ok(output.includes("c8ctl help correlate"));
		assert.ok(output.includes("c8ctl help profiles"));
		assert.ok(output.includes("c8ctl help plugin"));
		assert.ok(output.includes("c8ctl help plugins"));
	});

	test("showVerbResources shows resources for help", () => {
		showVerbResources("help");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl help"));
		assert.ok(output.includes("list"));
		assert.ok(output.includes("get"));
		assert.ok(output.includes("create"));
		assert.ok(output.includes("complete"));
		assert.ok(output.includes("await"));
		assert.ok(output.includes("search"));
		assert.ok(output.includes("deploy"));
		assert.ok(output.includes("run"));
		assert.ok(output.includes("watch"));
		assert.ok(output.includes("open"));
		assert.ok(output.includes("cancel"));
		assert.ok(output.includes("resolve"));
		assert.ok(output.includes("fail"));
		assert.ok(output.includes("activate"));
		assert.ok(output.includes("publish"));
		assert.ok(output.includes("correlate"));
		assert.ok(output.includes("profiles"));
		assert.ok(output.includes("profile"));
		assert.ok(output.includes("plugin"));
		assert.ok(output.includes("plugins"));
	});

	test("showCommandHelp shows profile management help", () => {
		showCommandHelp("profiles");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("profiles"));
		assert.ok(output.includes("list"));
		assert.ok(output.includes("add"));
		assert.ok(output.includes("remove"));
		assert.ok(output.includes("use"));
		assert.ok(output.includes("profile"));
	});

	test("showCommandHelp shows profile management help for profile alias", () => {
		showCommandHelp("profile");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("profiles"));
		assert.ok(output.includes("add"));
		assert.ok(output.includes("use"));
		assert.ok(output.includes("profile"));
	});

	test("showCommandHelp shows plugin management help", () => {
		showCommandHelp("plugin");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("plugin"));
		assert.ok(output.includes("load"));
		assert.ok(output.includes("list"));
		assert.ok(output.includes("upgrade"));
		assert.ok(output.includes("downgrade"));
	});

	test("showCommandHelp shows plugin help for plugins alias", () => {
		showCommandHelp("plugins");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("plugin"));
		assert.ok(output.includes("sync"));
		assert.ok(output.includes("init"));
	});

	test("showCommandHelp handles unknown command", () => {
		showCommandHelp("unknown");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("No detailed help available"));
		assert.ok(output.includes("unknown"));
	});

	// ── Agent Flags ──────────────────────────────────────────────────────────

	test("showHelp includes agent flags section", () => {
		showHelp();

		const output = consoleLogSpy.join("\n");
		assert.ok(
			output.includes("Agent Flags"),
			"help should include Agent Flags section header",
		);
		assert.ok(output.includes("--fields"), "help should include --fields flag");
		assert.ok(
			output.includes("--dry-run"),
			"help should include --dry-run flag",
		);
	});

	test("showHelp agent flags section is clearly separated", () => {
		showHelp();

		const output = consoleLogSpy.join("\n");
		// Section header should be visually separated (uses ━ or similar separator)
		assert.ok(output.includes("Agent Flags"), "should have Agent Flags header");
		// Should appear after standard flags section
		const agentPos = output.indexOf("Agent Flags");
		const flagsPos = output.indexOf("--profile");
		assert.ok(
			agentPos > flagsPos,
			"Agent Flags section should appear after standard flags",
		);
	});

	test("showHelp --fields description explains context window purpose", () => {
		showHelp();

		const output = consoleLogSpy.join("\n");
		assert.ok(
			output.includes("context window") || output.includes("context"),
			"--fields description should mention context window",
		);
	});

	test("showHelp --dry-run description explains it applies to all commands", () => {
		showHelp();

		const output = consoleLogSpy.join("\n");
		assert.ok(
			output.includes("all commands"),
			"--dry-run description should mention it applies to all commands",
		);
	});

	// ── JSON Mode Help ────────────────────────────────────────────────────────

	test("showHelp emits JSON structure in JSON mode", () => {
		c8ctl.outputMode = "json";
		const jsonSpy: string[] = [];
		const originalConsoleLog = console.log;
		console.log = (...args: unknown[]) => {
			jsonSpy.push(args.join(" "));
		};

		showHelp();

		console.log = originalConsoleLog;
		assert.ok(jsonSpy.length > 0, "should have output");
		const parsed = JSON.parse(jsonSpy[0]);
		assert.ok(parsed.version, "JSON help should include version");
		assert.ok(
			Array.isArray(parsed.commands),
			"JSON help should include commands array",
		);
		assert.ok(
			Array.isArray(parsed.agentFlags),
			"JSON help should include agentFlags array",
		);
		assert.ok(
			Array.isArray(parsed.globalFlags),
			"JSON help should include globalFlags array",
		);
		assert.ok(
			parsed.resourceAliases,
			"JSON help should include resourceAliases",
		);
	});

	test("JSON help agentFlags contains --fields and --dry-run", () => {
		c8ctl.outputMode = "json";
		const jsonSpy: string[] = [];
		const originalConsoleLog = console.log;
		console.log = (...args: unknown[]) => {
			jsonSpy.push(args.join(" "));
		};

		showHelp();

		console.log = originalConsoleLog;
		const parsed = JSON.parse(jsonSpy[0]);
		const flagNames = parsed.agentFlags.map((f: { flag: string }) => f.flag);
		assert.ok(
			flagNames.includes("--fields"),
			"agentFlags should include --fields",
		);
		assert.ok(
			flagNames.includes("--dry-run"),
			"agentFlags should include --dry-run",
		);
	});

	test("JSON help commands marks mutating commands", () => {
		c8ctl.outputMode = "json";
		const jsonSpy: string[] = [];
		const originalConsoleLog = console.log;
		console.log = (...args: unknown[]) => {
			jsonSpy.push(args.join(" "));
		};

		showHelp();

		console.log = originalConsoleLog;
		const parsed = JSON.parse(jsonSpy[0]);
		const createCmd = parsed.commands.find(
			(c: { verb: string }) => c.verb === "create",
		);
		assert.ok(createCmd, "commands should include create");
		assert.strictEqual(createCmd.mutating, true, "create should be mutating");
		const listCmd = parsed.commands.find(
			(c: { verb: string }) => c.verb === "list",
		);
		assert.ok(listCmd, "commands should include list");
		assert.strictEqual(listCmd.mutating, false, "list should not be mutating");
	});

	test("showCommandHelp emits JSON in JSON mode", () => {
		c8ctl.outputMode = "json";
		const jsonSpy: string[] = [];
		const originalConsoleLog = console.log;
		console.log = (...args: unknown[]) => {
			jsonSpy.push(args.join(" "));
		};

		showCommandHelp("list");

		console.log = originalConsoleLog;
		assert.ok(jsonSpy.length > 0, "should have output");
		const parsed = JSON.parse(jsonSpy[0]);
		assert.strictEqual(parsed.command, "list");
		assert.ok(Array.isArray(parsed.agentFlags), "should include agentFlags");
	});

	// ── Identity Resources ──────────────────────────────────────────────────

	test("showVerbResources shows identity resources for list", () => {
		showVerbResources("list");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("users"), "list resources should include users");
		assert.ok(output.includes("roles"), "list resources should include roles");
		assert.ok(
			output.includes("groups"),
			"list resources should include groups",
		);
		assert.ok(
			output.includes("tenants"),
			"list resources should include tenants",
		);
		assert.ok(
			output.includes("auth"),
			"list resources should include auth alias",
		);
		assert.ok(
			output.includes("mapping-rules"),
			"list resources should include mapping-rules",
		);
	});

	test("showVerbResources shows identity resources for search", () => {
		showVerbResources("search");

		const output = consoleLogSpy.join("\n");
		assert.ok(
			output.includes("users"),
			"search resources should include users",
		);
		assert.ok(
			output.includes("roles"),
			"search resources should include roles",
		);
		assert.ok(
			output.includes("groups"),
			"search resources should include groups",
		);
		assert.ok(
			output.includes("tenants"),
			"search resources should include tenants",
		);
		assert.ok(
			output.includes("auth"),
			"search resources should include auth alias",
		);
		assert.ok(
			output.includes("mapping-rules"),
			"search resources should include mapping-rules",
		);
	});

	test("showVerbResources shows identity resources for get", () => {
		showVerbResources("get");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("user"), "get resources should include user");
		assert.ok(output.includes("role"), "get resources should include role");
		assert.ok(output.includes("group"), "get resources should include group");
		assert.ok(output.includes("tenant"), "get resources should include tenant");
		assert.ok(
			output.includes("auth"),
			"get resources should include auth alias",
		);
		assert.ok(
			output.includes("mapping-rule"),
			"get resources should include mapping-rule",
		);
	});

	test("showVerbResources shows identity resources for create", () => {
		showVerbResources("create");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("user"), "create resources should include user");
		assert.ok(output.includes("role"), "create resources should include role");
		assert.ok(
			output.includes("group"),
			"create resources should include group",
		);
		assert.ok(
			output.includes("tenant"),
			"create resources should include tenant",
		);
		assert.ok(
			output.includes("auth"),
			"create resources should include auth alias",
		);
		assert.ok(
			output.includes("mapping-rule"),
			"create resources should include mapping-rule",
		);
	});

	test("showVerbResources shows resources for delete", () => {
		showVerbResources("delete");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl delete"));
		assert.ok(output.includes("user"), "delete resources should include user");
		assert.ok(output.includes("role"), "delete resources should include role");
		assert.ok(
			output.includes("group"),
			"delete resources should include group",
		);
		assert.ok(
			output.includes("tenant"),
			"delete resources should include tenant",
		);
		assert.ok(
			output.includes("auth"),
			"delete resources should include auth alias",
		);
		assert.ok(
			output.includes("mapping-rule"),
			"delete resources should include mapping-rule",
		);
	});

	test("showVerbResources shows resources for assign", () => {
		showVerbResources("assign");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl assign"));
		assert.ok(output.includes("role"), "assign resources should include role");
		assert.ok(output.includes("user"), "assign resources should include user");
		assert.ok(
			output.includes("group"),
			"assign resources should include group",
		);
		assert.ok(
			output.includes("mapping-rule"),
			"assign resources should include mapping-rule",
		);
	});

	test("showVerbResources shows resources for unassign", () => {
		showVerbResources("unassign");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl unassign"));
		assert.ok(
			output.includes("role"),
			"unassign resources should include role",
		);
		assert.ok(
			output.includes("user"),
			"unassign resources should include user",
		);
		assert.ok(
			output.includes("group"),
			"unassign resources should include group",
		);
		assert.ok(
			output.includes("mapping-rule"),
			"unassign resources should include mapping-rule",
		);
	});

	test("showCommandHelp shows delete help", () => {
		showCommandHelp("delete");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl delete"));
		assert.ok(output.includes("user"));
		assert.ok(output.includes("role"));
		assert.ok(output.includes("group"));
		assert.ok(output.includes("tenant"));
		assert.ok(output.includes("authorization"));
		assert.ok(output.includes("mapping-rule"));
	});

	test("showCommandHelp shows assign help", () => {
		showCommandHelp("assign");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl assign"));
		assert.ok(output.includes("--to-user"));
		assert.ok(output.includes("--to-group"));
		assert.ok(output.includes("--to-tenant"));
		assert.ok(output.includes("--to-mapping-rule"));
	});

	test("showCommandHelp shows unassign help", () => {
		showCommandHelp("unassign");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("c8ctl unassign"));
		assert.ok(output.includes("--from-user"));
		assert.ok(output.includes("--from-group"));
		assert.ok(output.includes("--from-tenant"));
		assert.ok(output.includes("--from-mapping-rule"));
	});

	test("showHelp includes identity resources", () => {
		showHelp();

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("users"), "help should include users resource");
		assert.ok(output.includes("roles"), "help should include roles resource");
		assert.ok(output.includes("groups"), "help should include groups resource");
		assert.ok(
			output.includes("tenants"),
			"help should include tenants resource",
		);
		assert.ok(output.includes("auth"), "help should include auth alias");
		assert.ok(
			output.includes("mapping-rule"),
			"help should include mapping-rule resource",
		);
	});

	test("showHelp includes delete, assign, unassign commands", () => {
		showHelp();

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("delete"), "help should include delete command");
		assert.ok(output.includes("assign"), "help should include assign command");
		assert.ok(
			output.includes("unassign"),
			"help should include unassign command",
		);
	});

	test("showHelp includes identity resource aliases", () => {
		showHelp();

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("auth"), "help should include auth alias");
		assert.ok(output.includes("mr"), "help should include mr alias");
	});

	test("showCommandHelp list includes identity resources", () => {
		showCommandHelp("list");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("user"), "list help should include user");
		assert.ok(output.includes("role"), "list help should include role");
		assert.ok(output.includes("group"), "list help should include group");
		assert.ok(output.includes("tenant"), "list help should include tenant");
		assert.ok(
			output.includes("authorization"),
			"list help should include authorization",
		);
		assert.ok(
			output.includes("mapping-rule"),
			"list help should include mapping-rule",
		);
	});

	test("showCommandHelp get includes identity resources", () => {
		showCommandHelp("get");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("user"), "get help should include user");
		assert.ok(output.includes("role"), "get help should include role");
		assert.ok(output.includes("group"), "get help should include group");
		assert.ok(output.includes("tenant"), "get help should include tenant");
		assert.ok(
			output.includes("authorization"),
			"get help should include authorization",
		);
		assert.ok(
			output.includes("mapping-rule"),
			"get help should include mapping-rule",
		);
	});

	test("showCommandHelp create includes identity resources", () => {
		showCommandHelp("create");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("user"), "create help should include user");
		assert.ok(
			output.includes("--username"),
			"create help should include --username flag",
		);
		assert.ok(
			output.includes("--email"),
			"create help should include --email flag",
		);
		assert.ok(
			output.includes("--password"),
			"create help should include --password flag",
		);
		assert.ok(output.includes("role"), "create help should include role");
		assert.ok(output.includes("group"), "create help should include group");
		assert.ok(output.includes("tenant"), "create help should include tenant");
		assert.ok(
			output.includes("--tenantId"),
			"create help should include --tenantId flag",
		);
		assert.ok(
			output.includes("authorization"),
			"create help should include authorization",
		);
		assert.ok(
			output.includes("--ownerId"),
			"create help should include --ownerId flag",
		);
		assert.ok(
			output.includes("--ownerType"),
			"create help should include --ownerType flag",
		);
		assert.ok(
			output.includes("--resourceType"),
			"create help should include --resourceType flag",
		);
		assert.ok(
			output.includes("--permissions"),
			"create help should include --permissions flag",
		);
		assert.ok(
			output.includes("mapping-rule"),
			"create help should include mapping-rule",
		);
		assert.ok(
			output.includes("--claimName"),
			"create help should include --claimName flag",
		);
		assert.ok(
			output.includes("--claimValue"),
			"create help should include --claimValue flag",
		);
	});

	test("showCommandHelp search includes identity resources", () => {
		showCommandHelp("search");

		const output = consoleLogSpy.join("\n");
		assert.ok(output.includes("user"), "search help should include user");
		assert.ok(
			output.includes("--username"),
			"search help should include --username flag",
		);
		assert.ok(
			output.includes("--email"),
			"search help should include --email flag",
		);
		assert.ok(output.includes("role"), "search help should include role");
		assert.ok(output.includes("group"), "search help should include group");
		assert.ok(output.includes("tenant"), "search help should include tenant");
		assert.ok(
			output.includes("authorization"),
			"search help should include authorization",
		);
		assert.ok(
			output.includes("--ownerId"),
			"search help should include --ownerId flag",
		);
		assert.ok(
			output.includes("mapping-rule"),
			"search help should include mapping-rule",
		);
		assert.ok(
			output.includes("--claimName"),
			"search help should include --claimName flag",
		);
	});

	test("showVerbResources help includes identity verbs", () => {
		showVerbResources("help");

		const output = consoleLogSpy.join("\n");
		// help verb now shows verbs with hasDetailedHelp + virtual topics
		assert.ok(
			output.includes("delete"),
			"help resources should include delete",
		);
		assert.ok(
			output.includes("assign"),
			"help resources should include assign",
		);
		assert.ok(
			output.includes("unassign"),
			"help resources should include unassign",
		);
	});

	test("JSON help includes identity resources and verbs", () => {
		c8ctl.outputMode = "json";
		const jsonSpy: string[] = [];
		const originalConsoleLog = console.log;
		console.log = (...args: unknown[]) => {
			jsonSpy.push(args.join(" "));
		};

		showHelp();

		console.log = originalConsoleLog;
		const parsed = JSON.parse(jsonSpy[0]);

		// Check for new verbs
		const verbs = parsed.commands.map((c: { verb: string }) => c.verb);
		assert.ok(verbs.includes("delete"), "JSON help should include delete verb");
		assert.ok(verbs.includes("assign"), "JSON help should include assign verb");
		assert.ok(
			verbs.includes("unassign"),
			"JSON help should include unassign verb",
		);

		// Check for identity resource aliases
		assert.ok(
			parsed.resourceAliases.auth,
			"JSON help should include auth alias",
		);
		assert.ok(parsed.resourceAliases.mr, "JSON help should include mr alias");

		// Check identity resources in list verb
		const listCmd = parsed.commands.find(
			(c: { verb: string }) => c.verb === "list",
		);
		assert.ok(
			listCmd.resources.includes("users"),
			"list resources should include users",
		);
		assert.ok(
			listCmd.resources.includes("roles"),
			"list resources should include roles",
		);
		assert.ok(
			listCmd.resources.includes("auth"),
			"list resources should include auth",
		);

		// Check delete is mutating
		const deleteCmd = parsed.commands.find(
			(c: { verb: string }) => c.verb === "delete",
		);
		assert.ok(deleteCmd, "commands should include delete");
		assert.strictEqual(deleteCmd.mutating, true, "delete should be mutating");
	});
});

// ─── #321: top-level Flags scoped to GLOBAL_FLAGS only ──────────────────────
//
// Class-scoped regression guard for camunda/c8ctl#321. The top-level
// `c8ctl --help` Flags section must list only truly global flags. Every
// command-specific flag must continue to be reachable via `c8ctl help <verb>`.
// Tests in this block were written red-first against the pre-fix code path;
// they pin the contract so the same category of leak cannot recur.

describe("Top-level help is scoped to global flags (#321)", () => {
	let consoleLogSpy: string[];
	let originalLog: typeof console.log;
	let originalOutputMode: typeof c8ctl.outputMode;

	beforeEach(() => {
		consoleLogSpy = [];
		originalLog = console.log;
		originalOutputMode = c8ctl.outputMode;
		c8ctl.outputMode = "text";
		console.log = (...args: unknown[]) => {
			consoleLogSpy.push(args.join(" "));
		};
	});

	afterEach(() => {
		console.log = originalLog;
		c8ctl.outputMode = originalOutputMode;
	});

	/** Extract the `Flags:` section (between the `Flags:` heading and the next blank-line-then-heading). */
	function extractFlagsSection(output: string): string {
		const lines = output.split("\n");
		const start = lines.findIndex((l) => l.trim() === "Flags:");
		assert.ok(start >= 0, "expected a Flags: section in help output");
		const tail = lines.slice(start + 1);
		// Section ends at the first blank line followed by another heading
		// (e.g. "Search Flags:"), or at end of output.
		let end = tail.length;
		for (let i = 0; i < tail.length - 1; i++) {
			if (tail[i].trim() === "" && /^[A-Z][^\n]*:$/.test(tail[i + 1])) {
				end = i;
				break;
			}
		}
		return tail.slice(0, end).join("\n");
	}

	test("Flags section contains exactly the GLOBAL_FLAGS keys", () => {
		showHelp();
		const flagsSection = extractFlagsSection(consoleLogSpy.join("\n"));

		// Strongest possible guard: extract every `--<name>` token that
		// appears as a flag declaration in the section, then compare it
		// against the registry. Any command-specific flag that leaks in
		// (e.g. --xml, --id, --variables, --awaitCompletion, --from, --local)
		// will fail this assertion regardless of which one it is.
		const flagDeclarations = (
			flagsSection.match(/^\s*(--[a-zA-Z][\w-]*)/gm) ?? []
		)
			.map((m) => m.trim())
			.sort();
		const expected = Object.keys(GLOBAL_FLAGS)
			.map((name) => `--${name}`)
			.sort();
		assert.deepStrictEqual(
			flagDeclarations,
			expected,
			"top-level Flags section must contain exactly the GLOBAL_FLAGS keys — " +
				"any command-specific flag leaking in (e.g. --id, --variables, --xml, " +
				"--awaitCompletion, --from, --local) is a regression of #321",
		);
	});

	test("top-level help output contains no '(use with' context hints", () => {
		showHelp();
		const output = consoleLogSpy.join("\n");
		assert.ok(
			!output.includes("(use with '"),
			"per #321, the '(use with ...)' parenthetical workaround must not appear in top-level help",
		);
	});

	test("JSON help payload globalFlags contains only GLOBAL_FLAGS keys", () => {
		c8ctl.outputMode = "json";
		// Re-spy after mode flip — the runtime helper uses logger.json which
		// also writes via console.log in this test harness.
		showHelp();
		const raw = consoleLogSpy.join("\n");
		const parsed: { globalFlags: Array<{ flag: string }> } = JSON.parse(raw);
		const flagNames = parsed.globalFlags.map((f) => f.flag).sort();
		assert.deepStrictEqual(
			flagNames,
			[
				"--dry-run",
				"--fields",
				"--help",
				"--profile",
				"--verbose",
				"--version",
			],
			"JSON globalFlags must equal the GLOBAL_FLAGS keys (no command-specific leak)",
		);
	});

	// Class-scoped guard: every flag previously opted in via showInTopLevelHelp
	// must remain reachable through `c8ctl help <verb>`. Iterating the list
	// proves the per-resource help surface covers the whole class, not just
	// one instance — so a future addition to that list is automatically tested
	// once it's also added here.
	const perVerbFlagCoverage: Array<[verb: string, flag: string]> = [
		["get", "--xml"],
		["get", "--userTask"],
		["get", "--processDefinition"],
		["get", "--variables"],
		["create", "--id"],
		["create", "--awaitCompletion"],
		["create", "--fetchVariables"],
		["create", "--requestTimeout"],
		["set", "--variables"],
		["set", "--local"],
		["load", "--from"],
	];

	for (const [verb, flag] of perVerbFlagCoverage) {
		test(`c8ctl help ${verb} surfaces ${flag} (was previously top-level)`, async () => {
			await showCommandHelp(verb);
			const output = consoleLogSpy.join("\n");
			assert.ok(
				output.includes(flag),
				`'c8ctl help ${verb}' must surface ${flag}; otherwise removing it from top-level help loses discoverability`,
			);
		});
	}
});

// Reviewer follow-up on PR #322: SEARCH_FLAGS were duplicated under every
// resource block in `c8ctl help list` / `c8ctl help search`. They are a
// coherent shared shape across all list/search resources, so they belong in
// a single dedicated section per verb — not repeated 13× per resource.
describe("Search flags are consolidated into a single section per verb (#322 follow-up)", () => {
	let consoleLogSpy: string[];
	let originalLog: typeof console.log;

	beforeEach(() => {
		consoleLogSpy = [];
		originalLog = console.log;
		console.log = (...args: unknown[]) => {
			consoleLogSpy.push(
				args
					.map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
					.join(" "),
			);
		};
	});

	afterEach(() => {
		console.log = originalLog;
	});

	const sharedSearchFlags = [
		"--sortBy",
		"--asc",
		"--desc",
		"--limit",
		"--between",
		"--dateField",
	];

	for (const verb of ["list", "search"] as const) {
		for (const flag of sharedSearchFlags) {
			test(`c8ctl help ${verb} emits ${flag} exactly once`, async () => {
				await showCommandHelp(verb);
				const output = consoleLogSpy.join("\n");
				// Match the flag only when it appears as a flag declaration
				// (start of a line, after indent) — not when it is referenced
				// inside another flag's description text.
				const flagLine = new RegExp(
					`^\\s*${flag.replace(/-/g, "\\-")}\\b`,
					"gm",
				);
				const occurrences = (output.match(flagLine) ?? []).length;
				assert.strictEqual(
					occurrences,
					1,
					`'c8ctl help ${verb}' must emit ${flag} once (consolidated section), got ${occurrences} occurrences`,
				);
			});
		}

		test(`c8ctl help ${verb} groups search flags under a dedicated header`, async () => {
			await showCommandHelp(verb);
			const output = consoleLogSpy.join("\n");
			assert.ok(
				/Search flags/i.test(output),
				`'c8ctl help ${verb}' must include a 'Search flags' section header`,
			);
		});
	}
});
