import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { pathToFileURL } from "node:url";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import {
	type McpConfigPlan,
	writeMcpConfig,
} from "../../src/utils/command-local/mcp-install-helpers.ts";
import { c8, c8WithOptions, parseJson } from "../utils/cli.ts";
import { isRecord } from "../utils/guards.ts";
import { asyncSpawn } from "../utils/spawn.ts";

const DOCS_URL = "https://camunda-docs.mcp.kapa.ai";
const HARNESSES = [
	"claude-code",
	"github-copilot",
	"cursor",
	"vscode",
	...(process.platform === "linux" ? [] : ["claude-desktop"]),
];

function sandbox(t: TestContext) {
	const home = mkdtempSync(join(tmpdir(), "c8ctl-mcp-install-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const appData = join(home, "AppData", "Roaming");
	const configHome = join(home, ".config");
	const appSupport =
		process.platform === "darwin"
			? join(home, "Library", "Application Support")
			: process.platform === "win32"
				? appData
				: configHome;
	const paths: Record<string, string> = {
		"claude-code": join(home, ".claude.json"),
		"github-copilot": join(home, ".copilot", "mcp-config.json"),
		cursor: join(home, ".cursor", "mcp.json"),
		vscode: join(appSupport, "Code", "User", "mcp.json"),
		"claude-desktop": join(appSupport, "Claude", "claude_desktop_config.json"),
	};
	const env: Record<string, string | undefined> = {
		HOME: home,
		USERPROFILE: home,
		APPDATA: appData,
		LOCALAPPDATA: join(home, "AppData", "Local"),
		XDG_CONFIG_HOME: configHome,
		CLAUDE_CONFIG_DIR: undefined,
		COPILOT_HOME: undefined,
		PATH: dirname(process.execPath),
		C8CTL_DATA_DIR: join(home, "data"),
		C8CTL_MODELER_DIR: join(home, "modeler"),
		C8CTL_OUTPUT_MODE: "json",
		CAMUNDA_BASE_URL: undefined,
		CAMUNDA_REST_ADDRESS: undefined,
		CAMUNDA_AUTH_STRATEGY: undefined,
	};
	return {
		home,
		paths,
		env,
		run: (...args: string[]) => c8WithOptions({ env }, ...args),
		write(harness: string, content: string): void {
			mkdirSync(dirname(paths[harness]), { recursive: true });
			writeFileSync(paths[harness], content);
		},
	};
}

function configAt(path: string): Record<string, unknown> {
	const config: unknown = JSON.parse(readFileSync(path, "utf8"));
	assert.ok(isRecord(config));
	return config;
}

function jsoncConfigAt(path: string): Record<string, unknown> {
	const errors: ParseError[] = [];
	const config: unknown = parseJsonc(readFileSync(path, "utf8"), errors, {
		allowTrailingComma: true,
	});
	assert.deepEqual(errors, []);
	assert.ok(isRecord(config));
	return config;
}

function serversAt(path: string, harness: string): Record<string, unknown> {
	const servers =
		configAt(path)[harness === "vscode" ? "servers" : "mcpServers"];
	assert.ok(isRecord(servers));
	return servers;
}

async function addProfile(s: ReturnType<typeof sandbox>, name = "work") {
	const result = await s.run(
		"add",
		"profile",
		name,
		"--baseUrl",
		"https://cluster.example.invalid/v2",
		"--clientId",
		"fixture-client",
		"--clientSecret",
		"fixture-not-a-real-secret",
	);
	assert.equal(result.status, 0, result.stderr);
}

for (const harness of HARNESSES) {
	test(`${harness} installs independent MCP targets and uninstalls only selected entries`, async (t) => {
		const s = sandbox(t);
		const key = harness === "vscode" ? "servers" : "mcpServers";
		const unrelated = { url: "https://other.example.invalid/mcp" };
		s.write(
			harness,
			JSON.stringify({
				preferences: { theme: "dark" },
				[key]: { unrelated },
			}),
		);
		await addProfile(s);
		assert.equal((await s.run("use", "profile", "work")).status, 0);

		const installed = await s.run("mcp", "install", harness);
		assert.equal(installed.status, 0, installed.stderr);
		let servers = serversAt(s.paths[harness], harness);
		assert.ok(isRecord(servers.camunda));
		assert.ok(Array.isArray(servers.camunda.args));
		assert.deepEqual(servers.camunda.args.slice(-3), [
			"mcp-proxy",
			"--profile",
			"work",
		]);
		assert.ok(isRecord(servers.camunda.env));
		assert.equal(servers.camunda.env.C8CTL_DATA_DIR, s.env.C8CTL_DATA_DIR);
		assert.equal(servers["camunda-docs"], undefined);
		assert.doesNotMatch(
			readFileSync(s.paths[harness], "utf8"),
			/fixture-not-a-real-secret|CAMUNDA_CLIENT_SECRET/,
		);

		const docs = await s.run(
			"mcp",
			"install",
			harness,
			"--docs",
			"--profile",
			"missing",
		);
		assert.equal(docs.status, 0, docs.stderr);
		servers = serversAt(s.paths[harness], harness);
		assert.ok(isRecord(servers["camunda-docs"]));
		if (harness === "claude-desktop") {
			assert.ok(Array.isArray(servers["camunda-docs"].args));
			assert.ok(
				servers["camunda-docs"].args.some(
					(arg: unknown) => typeof arg === "string" && arg === DOCS_URL,
				),
			);
			assert.ok(servers["camunda-docs"].args.includes("mcp-remote"));
		} else {
			assert.equal(servers["camunda-docs"].url, DOCS_URL);
			if (harness !== "cursor") {
				assert.equal(servers["camunda-docs"].type, "http");
			}
		}
		assert.deepEqual(servers.unrelated, unrelated);
		assert.deepEqual(configAt(s.paths[harness]).preferences, { theme: "dark" });

		const content = readFileSync(s.paths[harness], "utf8");
		utimesSync(s.paths[harness], 1, 1);
		const repeated = await s.run(
			"mcp",
			"install",
			harness,
			"--docs",
			"--orchestration",
		);
		assert.equal(repeated.status, 0, repeated.stderr);
		assert.equal(readFileSync(s.paths[harness], "utf8"), content);
		assert.equal(statSync(s.paths[harness]).mtimeMs, 1000);

		const removedDocs = await s.run("mcp", "uninstall", harness, "--docs");
		assert.equal(removedDocs.status, 0, removedDocs.stderr);
		servers = serversAt(s.paths[harness], harness);
		assert.ok(servers.camunda);
		assert.equal(servers["camunda-docs"], undefined);
		const removedCluster = await s.run("mcp", "uninstall", harness);
		assert.equal(removedCluster.status, 0, removedCluster.stderr);
		assert.deepEqual(serversAt(s.paths[harness], harness), { unrelated });
		const absent = await s.run("mcp", "uninstall", harness);
		assert.equal(absent.status, 0, absent.stderr);
	});
}

test("installs into all detected harnesses, or only the explicit selection", async (t) => {
	const s = sandbox(t);
	for (const harness of HARNESSES) s.write(harness, "{}");
	const selected = await s.run("mcp", "install", "cursor", "claude", "--docs");
	assert.equal(selected.status, 0, selected.stderr);
	for (const harness of HARNESSES) {
		if (harness === "cursor" || harness === "claude-code") {
			assert.ok(serversAt(s.paths[harness], harness)["camunda-docs"]);
		} else {
			assert.equal(readFileSync(s.paths[harness], "utf8"), "{}");
		}
	}
	const detected = await s.run("mcp", "install", "--docs");
	assert.equal(detected.status, 0, detected.stderr);
	for (const harness of HARNESSES) {
		assert.ok(serversAt(s.paths[harness], harness)["camunda-docs"]);
	}
});

test("an explicit profile and alias create a separately named orchestration entry", async (t) => {
	const s = sandbox(t);
	await addProfile(s, "customer dev");
	const result = await s.run(
		"mcp",
		"install",
		"cursor",
		"--profile",
		"customer dev",
		"--alias",
		"customer",
		"--docs",
		"--orchestration",
	);
	assert.equal(result.status, 0, result.stderr);
	const servers = serversAt(s.paths.cursor, "cursor");
	assert.ok(isRecord(servers.customer));
	assert.ok(Array.isArray(servers.customer.args));
	assert.equal(servers.customer.args.at(-1), "customer dev");
	assert.ok(servers["camunda-docs"]);
	assert.equal(servers.camunda, undefined);
	const removed = await s.run(
		"mcp",
		"uninstall",
		"cursor",
		"--alias",
		"customer",
		"--profile",
		"missing",
	);
	assert.equal(removed.status, 0, removed.stderr);
	assert.deepEqual(Object.keys(serversAt(s.paths.cursor, "cursor")), [
		"camunda-docs",
	]);
});

test("repeat installation preserves client-added tool restrictions and uninstall still recognizes the entry", async (t) => {
	const s = sandbox(t);
	const installed = await s.run("mcp", "install", "github-copilot", "--docs");
	assert.equal(installed.status, 0, installed.stderr);
	const config = configAt(s.paths["github-copilot"]);
	assert.ok(isRecord(config.mcpServers));
	const docs = config.mcpServers["camunda-docs"];
	assert.ok(isRecord(docs));
	docs.tools = ["search_camunda_knowledge_sources"];
	s.write("github-copilot", JSON.stringify(config));
	const before = readFileSync(s.paths["github-copilot"], "utf8");
	const repeated = await s.run("mcp", "install", "github-copilot", "--docs");
	assert.equal(repeated.status, 0, repeated.stderr);
	assert.equal(readFileSync(s.paths["github-copilot"], "utf8"), before);
	const removed = await s.run("mcp", "uninstall", "github-copilot", "--docs");
	assert.equal(removed.status, 0, removed.stderr);
	assert.deepEqual(serversAt(s.paths["github-copilot"], "github-copilot"), {});
});

test("a drifted c8ctl-managed entry is updated on re-install; a foreign entry still conflicts", async (t) => {
	const s = sandbox(t);
	const oldNode = join(s.home, "old", basename(process.execPath));
	await addProfile(s);
	assert.equal((await s.run("use", "profile", "work")).status, 0);
	const installed = await s.run("mcp", "install", "claude-code");
	assert.equal(installed.status, 0, installed.stderr);
	const current = serversAt(s.paths["claude-code"], "claude-code").camunda;
	assert.ok(isRecord(current));

	// Drift the entry the way a moved install does — another Node and
	// script path — while keeping the c8ctl orchestration shape. A
	// client-added tools allowlist and an extra env var ride along.
	const drifted: unknown = JSON.parse(
		readFileSync(s.paths["claude-code"], "utf8"),
	);
	assert.ok(isRecord(drifted) && isRecord(drifted.mcpServers));
	const camunda = drifted.mcpServers.camunda;
	assert.ok(isRecord(camunda) && Array.isArray(camunda.args));
	assert.ok(isRecord(camunda.env));
	camunda.command = oldNode;
	camunda.args[0] = "/usr/local/lib/node_modules/@camunda8/cli/dist/index.js";
	delete camunda.type;
	camunda.tools = ["search_process_definitions"];
	camunda.env.EXTRA = "keep-me";
	s.write("claude-code", JSON.stringify(drifted));

	const updated = await s.run("mcp", "install", "claude-code");
	assert.equal(updated.status, 0, updated.stderr);
	const items = parseJson(updated);
	assert.ok(Array.isArray(items));
	assert.deepEqual(
		items.map((item: unknown) => {
			assert.ok(isRecord(item));
			return item.status;
		}),
		["updated"],
	);
	const after = serversAt(s.paths["claude-code"], "claude-code").camunda;
	assert.ok(isRecord(after) && isRecord(after.env));
	// Managed fields are rewritten to the current connection…
	assert.equal(after.command, process.execPath);
	assert.deepEqual(after.args, current.args);
	assert.equal(after.type, "stdio");
	assert.equal(after.env.C8CTL_DATA_DIR, s.env.C8CTL_DATA_DIR);
	// …while client settings survive the update.
	assert.deepEqual(after.tools, ["search_process_definitions"]);
	assert.equal(after.env.EXTRA, "keep-me");

	// A foreign entry under the same name is never clobbered.
	const foreign = JSON.stringify({
		mcpServers: { camunda: { command: "other-tool", args: ["serve"] } },
	});
	s.write("claude-code", foreign);
	const conflict = await s.run("mcp", "install", "claude-code");
	assert.equal(conflict.status, 1, conflict.stderr);
	assert.match(conflict.stderr, /conflicts/);
	assert.equal(readFileSync(s.paths["claude-code"], "utf8"), foreign);
});

test("updating a drifted entry preserves JSONC comments", async (t) => {
	const s = sandbox(t);
	const oldNode = join(s.home, "old", basename(process.execPath));
	await addProfile(s);
	assert.equal((await s.run("use", "profile", "work")).status, 0);
	s.write(
		"vscode",
		`{
	// keep this note
	"servers": {
		"camunda": {
			"type": "stdio",
			"command": ${JSON.stringify(oldNode)},
			// restrict the exposed tools
			"tools": ["search_process_definitions"],
			"args": ["/old/c8ctl/dist/index.js", "mcp-proxy", "--profile", "work"],
			"env": { "C8CTL_DATA_DIR": "/old/data" }
		}
	}
}`,
	);
	const result = await s.run("mcp", "install", "vscode");
	assert.equal(result.status, 0, result.stderr);
	const content = readFileSync(s.paths.vscode, "utf8");
	assert.match(content, /keep this note/);
	assert.match(content, /restrict the exposed tools/);
	assert.match(content, /"tools": \[\s*"search_process_definitions"\]/);
	assert.doesNotMatch(content, /\/old\/c8ctl/);
	assert.ok(!content.includes(JSON.stringify(oldNode)));
	assert.ok(
		content.includes(
			`"C8CTL_DATA_DIR": ${JSON.stringify(s.env.C8CTL_DATA_DIR)}`,
		),
	);
});

test("mcp uninstall recognizes orchestration entries with nonstandard Node executable basenames", async (t) => {
	const s = sandbox(t);
	await addProfile(s, "work");
	assert.equal((await s.run("use", "profile", "work")).status, 0);

	const installed = await s.run(
		"mcp",
		"install",
		"cursor",
		"--profile",
		"work",
	);
	assert.equal(installed.status, 0, installed.stderr);

	const config = configAt(s.paths.cursor);
	assert.ok(isRecord(config.mcpServers));
	const camunda = config.mcpServers.camunda;
	assert.ok(isRecord(camunda));
	camunda.command = "/usr/bin/node-22";
	s.write("cursor", JSON.stringify(config));

	const removed = await s.run("mcp", "uninstall", "cursor");
	assert.equal(removed.status, 0, removed.stderr);
	assert.deepEqual(serversAt(s.paths.cursor, "cursor"), {});
});

test("VS Code uninstall handles first, middle, last, and sole JSONC properties", async (t) => {
	const docsEntry = { type: "http", url: DOCS_URL };
	const githubEntry = {
		type: "http",
		url: "https://api.githubcopilot.com/mcp/",
	};
	const otherEntry = { type: "http", url: "https://example.invalid/mcp" };
	const docsProperty = `"camunda-docs": ${JSON.stringify(docsEntry)}`;
	const githubProperty = `"github": ${JSON.stringify(githubEntry)}`;
	const otherProperty = `"other": ${JSON.stringify(otherEntry)}`;
	const fixtures = [
		{
			name: "first property",
			content: `{
  "preferences": {"theme": "dark"},
  "servers": {
    /* preserve first-property comment */
    ${docsProperty},
    ${githubProperty}, // preserve GitHub comment
  }
}`,
			comments: [
				"/* preserve first-property comment */",
				"// preserve GitHub comment",
			],
			unrelatedProperties: [githubProperty],
			expectedServers: { github: githubEntry },
		},
		{
			name: "middle property",
			content: `{
  "preferences": {"theme": "dark"},
  "servers": {
    ${githubProperty}, // preserve GitHub comment
    /* preserve middle-property comment */
    ${docsProperty}, // preserve removed-entry comment
    ${otherProperty}, // preserve trailing-comma comment
  }
}`,
			comments: [
				"// preserve GitHub comment",
				"/* preserve middle-property comment */",
				"// preserve removed-entry comment",
				"// preserve trailing-comma comment",
			],
			unrelatedProperties: [githubProperty, otherProperty],
			expectedServers: { github: githubEntry, other: otherEntry },
		},
		{
			name: "last property without trailing comma",
			content: `{
  "preferences": {"theme": "dark"},
  "servers": {
    ${otherProperty}, // preserve preceding-entry comment
    ${docsProperty}
  }
}`,
			comments: ["// preserve preceding-entry comment"],
			unrelatedProperties: [otherProperty],
			expectedServers: { other: otherEntry },
		},
		{
			name: "last property with trailing comma",
			content: `{
  "preferences": {"theme": "dark"},
  "servers": {
    ${otherProperty}, // preserve preceding-entry comment
    ${docsProperty},
  }
}`,
			comments: ["// preserve preceding-entry comment"],
			unrelatedProperties: [otherProperty],
			expectedServers: { other: otherEntry },
		},
		{
			name: "sole property",
			content: `{
  "preferences": {"theme": "dark"},
  "servers": {
    /* preserve sole-property comment */
    ${docsProperty},
  }
}`,
			comments: ["/* preserve sole-property comment */"],
			unrelatedProperties: [],
			expectedServers: {},
		},
	];
	for (const fixture of fixtures) {
		const s = sandbox(t);
		s.write("vscode", fixture.content);
		const removed = await s.run("mcp", "uninstall", "vscode", "--docs");
		assert.equal(removed.status, 0, removed.stderr);

		const content = readFileSync(s.paths.vscode, "utf8");
		for (const comment of fixture.comments) {
			assert.ok(content.includes(comment), `${fixture.name}: ${comment}`);
		}
		for (const property of fixture.unrelatedProperties) {
			assert.ok(content.includes(property), `${fixture.name}: ${property}`);
		}
		assert.ok(!content.includes('"camunda-docs"'));
		const config = jsoncConfigAt(s.paths.vscode);
		assert.deepEqual(config.preferences, { theme: "dark" });
		assert.deepEqual(config.servers, fixture.expectedServers);
	}
});

test("VS Code uninstall removes both managed entries in either property order", async (t) => {
	const githubEntry = {
		type: "http",
		url: "https://api.githubcopilot.com/mcp/",
	};
	const otherEntry = { type: "http", url: "https://example.invalid/mcp" };
	const githubProperty = `"github": ${JSON.stringify(githubEntry)}`;
	const otherProperty = `"other": ${JSON.stringify(otherEntry)}`;
	const fixtures = [
		{ name: "orchestration before docs", order: ["camunda", "camunda-docs"] },
		{ name: "docs before orchestration", order: ["camunda-docs", "camunda"] },
	];
	for (const fixture of fixtures) {
		const s = sandbox(t);
		const orchestrationProperty = `"camunda": ${JSON.stringify({
			type: "stdio",
			command: process.execPath,
			args: ["/opt/c8ctl/dist/index.js", "mcp-proxy", "--profile", "work"],
			env: { C8CTL_DATA_DIR: s.env.C8CTL_DATA_DIR },
		})}`;
		const docsProperty = `"camunda-docs": ${JSON.stringify({
			type: "http",
			url: DOCS_URL,
		})}`;
		const managedProperties = fixture.order.map((name) =>
			name === "camunda"
				? `${orchestrationProperty}, // preserve orchestration comment`
				: `${docsProperty}, /* preserve docs comment */`,
		);
		s.write(
			"vscode",
			`{
  "preferences": {"theme": "dark"},
  "servers": {
    ${managedProperties[0]}
    ${githubProperty}, // preserve GitHub comment
    ${managedProperties[1]}
    ${otherProperty}, // preserve trailing-comma comment
  }
}`,
		);

		const removed = await s.run(
			"mcp",
			"uninstall",
			"vscode",
			"--docs",
			"--orchestration",
		);
		assert.equal(removed.status, 0, removed.stderr);

		const content = readFileSync(s.paths.vscode, "utf8");
		for (const comment of [
			"// preserve orchestration comment",
			"/* preserve docs comment */",
			"// preserve GitHub comment",
			"// preserve trailing-comma comment",
		]) {
			assert.ok(content.includes(comment), `${fixture.name}: ${comment}`);
		}
		assert.ok(content.includes(githubProperty));
		assert.ok(content.includes(otherProperty));
		const config = jsoncConfigAt(s.paths.vscode);
		assert.deepEqual(config.preferences, { theme: "dark" });
		assert.deepEqual(config.servers, {
			github: githubEntry,
			other: otherEntry,
		});
	}
});

test("docs dry-run needs no connection and does not expose unrelated config secrets", async (t) => {
	const s = sandbox(t);
	s.write(
		"cursor",
		'{"mcpServers":{"other":{"env":{"TOKEN":"fixture-private"}}}}',
	);
	const before = readFileSync(s.paths.cursor, "utf8");
	const result = await c8WithOptions(
		{ env: { ...s.env, CAMUNDA_AUTH_STRATEGY: "invalid" } },
		"mcp",
		"install",
		"cursor",
		"claude-code",
		"--docs",
		"--dry-run",
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(parseJson(result).dryRun, true);
	assert.match(result.stdout, /camunda-docs/);
	assert.doesNotMatch(result.stdout, /fixture-private/);
	assert.equal(readFileSync(s.paths.cursor, "utf8"), before);
	assert.equal(existsSync(s.paths["claude-code"]), false);
});

test("respects Claude Code and Copilot user configuration overrides", async (t) => {
	const s = sandbox(t);
	const claude = join(s.home, "custom-claude");
	const copilot = join(s.home, "custom-copilot");
	mkdirSync(claude);
	mkdirSync(copilot);
	const result = await c8WithOptions(
		{ env: { ...s.env, CLAUDE_CONFIG_DIR: claude, COPILOT_HOME: copilot } },
		"mcp",
		"install",
		"--docs",
	);
	assert.equal(result.status, 0, result.stderr);
	assert.ok(
		serversAt(join(claude, ".claude.json"), "claude-code")["camunda-docs"],
	);
	assert.ok(
		serversAt(join(copilot, "mcp-config.json"), "github-copilot")[
			"camunda-docs"
		],
	);
	assert.equal(existsSync(s.paths["claude-code"]), false);
	assert.equal(existsSync(s.paths["github-copilot"]), false);
});

test("preserves VS Code comments, trailing commas, and unrelated settings", async (t) => {
	const s = sandbox(t);
	s.write(
		"vscode",
		'{\n  // Keep this explanation.\n  "servers": {"other": {"url": "https://other.invalid"},},\n  "inputs": [],\n}\n',
	);
	const result = await s.run("mcp", "install", "vscode", "--docs");
	assert.equal(result.status, 0, result.stderr);
	const content = readFileSync(s.paths.vscode, "utf8");
	assert.match(content, /\/\/ Keep this explanation\./);
	assert.match(content, /"inputs": \[\]/);
	assert.match(content, /"other"/);
	assert.match(content, /"camunda-docs"/);
});

test("invalid selections and missing profiles fail before config writes", async (t) => {
	const s = sandbox(t);
	for (const args of [
		["mcp", "install", "--docs"],
		["mcp", "install", "cursor", "unknown", "--docs"],
		["mcp", "install", "cursor", "--profile", "missing"],
		["mcp", "install", "cursor", "--docs", "--alias", "unused"],
	]) {
		const result = await s.run(...args);
		assert.equal(result.status, 1, `${args.join(" ")}: ${result.stderr}`);
		assert.equal(existsSync(s.paths.cursor), false);
	}
	const environmentOnly = await c8WithOptions(
		{ env: { ...s.env, CAMUNDA_BASE_URL: "https://env.example.invalid" } },
		"mcp",
		"install",
		"cursor",
	);
	assert.equal(environmentOnly.status, 1, environmentOnly.stderr);
	assert.match(environmentOnly.stderr, /profile/i);
	assert.equal(existsSync(s.paths.cursor), false);
});

test("rejects profile names that a harness would expand as environment placeholders", async (t) => {
	const s = sandbox(t);
	const name = `literal-\${MCP_TARGET}`;
	await addProfile(s, name);
	const result = await s.run("mcp", "install", "cursor", "--profile", name);
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stderr, /placeholder/i);
	assert.equal(existsSync(s.paths.cursor), false);
});

test("malformed configs and name collisions never clobber any selected file", async (t) => {
	for (const content of [
		"",
		"{",
		"[]",
		"null",
		'{"mcpServers":[]}',
		'{"mcpServers":{"camunda-docs":{"url":"https://other.invalid"}}}',
	]) {
		const s = sandbox(t);
		s.write("claude-code", content);
		for (const action of ["install", "uninstall"]) {
			const result = await s.run(
				"mcp",
				action,
				"cursor",
				"claude-code",
				"--docs",
			);
			assert.equal(result.status, 1, `${action}: ${result.stderr}`);
			assert.match(
				result.stderr,
				/Invalid MCP config|Expected.*object|conflicts/,
			);
			assert.equal(readFileSync(s.paths["claude-code"], "utf8"), content);
			assert.equal(existsSync(s.paths.cursor), false);
		}
	}
});

test("a failed atomic replacement preserves the original and cleans up its temporary file", async (t) => {
	const s = sandbox(t);
	s.write("cursor", '{"mcpServers":{"other":{"url":"https://other.invalid"}}}');
	const before = readFileSync(s.paths.cursor, "utf8");
	const preload = join(s.home, "fail-rename.mjs");
	writeFileSync(
		preload,
		`
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(to) === process.env.FAIL_MCP_PATH) {
    throw Object.assign(new Error("MCP config replacement denied"), { code: "EACCES" });
  }
  return rename(from, to);
};
syncBuiltinESMExports();
`,
	);
	const result = await c8WithOptions(
		{
			env: { ...s.env, FAIL_MCP_PATH: realpathSync(s.paths.cursor) },
			nodeArgs: ["--import", pathToFileURL(preload).href],
		},
		"mcp",
		"install",
		"cursor",
		"--docs",
	);
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stderr, /replacement denied/);
	assert.equal(readFileSync(s.paths.cursor, "utf8"), before);
	assert.deepEqual(readdirSync(dirname(s.paths.cursor)), ["mcp.json"]);
});

test("concurrent writers serialize on a per-target lock", async (t) => {
	const s = sandbox(t);
	s.write("cursor", '{"mcpServers":{}}');
	const targetPath = realpathSync(s.paths.cursor);
	const original = readFileSync(targetPath, "utf8");
	const plan = (content: string): McpConfigPlan => ({
		harness: "cursor",
		path: s.paths.cursor,
		targetPath,
		original,
		content,
		mode: 0o600,
		changes: [{ server: "camunda-docs", status: "installed" }],
	});

	// A lock held by another process rejects this writer instead of racing it.
	writeFileSync(`${targetPath}.lock`, "");
	assert.throws(
		() =>
			writeMcpConfig(plan(`{"mcpServers":{"a":{}}}\n`), {
				lockTimeoutMs: 50,
				lockRetryMs: 10,
			}),
		/Another c8ctl process is updating/,
	);
	assert.equal(readFileSync(targetPath, "utf8"), original);
	rmSync(`${targetPath}.lock`);

	// Two writers planning from the same snapshot: the first wins, the second
	// observes the replacement under the lock and is rejected, keeping the
	// first writer's connection. The lock is released on success and failure.
	const first = plan(`{"mcpServers":{"camunda-docs":{"url":"${DOCS_URL}"}}}\n`);
	const second = plan(`{"mcpServers":{"camunda":{"command":"c8ctl"}}}\n`);
	writeMcpConfig(first);
	assert.equal(existsSync(`${targetPath}.lock`), false);
	assert.throws(() => writeMcpConfig(second), /changed during installation/);
	assert.equal(readFileSync(targetPath, "utf8"), first.content);
	assert.equal(existsSync(`${targetPath}.lock`), false);
});

test("uninstall --preserve-conflicts keeps a foreign entry instead of failing", async (t) => {
	const s = sandbox(t);
	await addProfile(s);
	assert.equal((await s.run("use", "profile", "work")).status, 0);
	const installed = await s.run(
		"mcp",
		"install",
		"claude-code",
		"--docs",
		"--orchestration",
	);
	assert.equal(installed.status, 0, installed.stderr);

	// Replace the orchestration entry with a foreign one under the same
	// name; the docs entry stays c8ctl-managed.
	const config = configAt(s.paths["claude-code"]);
	assert.ok(isRecord(config.mcpServers));
	config.mcpServers.camunda = { url: "https://foreign.example.invalid/mcp" };
	s.write("claude-code", JSON.stringify(config));

	const conflict = await s.run(
		"mcp",
		"uninstall",
		"claude-code",
		"--docs",
		"--orchestration",
	);
	assert.equal(conflict.status, 1, conflict.stderr);
	assert.match(conflict.stderr, /conflicts/);

	const preserved = await s.run(
		"mcp",
		"uninstall",
		"claude-code",
		"--docs",
		"--orchestration",
		"--preserve-conflicts",
	);
	assert.equal(preserved.status, 0, preserved.stderr);
	const servers = serversAt(s.paths["claude-code"], "claude-code");
	assert.deepEqual(servers.camunda, {
		url: "https://foreign.example.invalid/mcp",
	});
	assert.equal(servers["camunda-docs"], undefined);
});

test("MCP help and shell completions expose target selection and uninstall", async () => {
	const help = await c8WithOptions(
		{ env: { C8CTL_OUTPUT_MODE: "text" } },
		"help",
		"mcp",
	);
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /--orchestration/);
	assert.match(help.stdout, /--docs/);
	assert.match(help.stdout, /--preserve-conflicts/);
	assert.match(help.stdout, /uninstall/);
	assert.match(help.stdout, /list/);
	for (const shell of ["bash", "zsh", "fish"]) {
		const completion = await c8("completion", shell);
		assert.equal(completion.status, 0, completion.stderr);
		assert.match(completion.stdout, /orchestration/);
		assert.match(completion.stdout, /docs/);
		assert.match(
			completion.stdout,
			shell === "fish" ? /-l preserve-conflicts/ : /--preserve-conflicts/,
		);
	}
});

const SRC_CLI = resolve(import.meta.dirname, "../../src/index.ts");
const DIST_CLI = resolve(import.meta.dirname, "../../dist/index.js");

// The installed orchestration entry spawns `<node> <cli-entry> mcp-proxy`:
// if the entry path the installer writes does not match the layout the CLI
// actually runs from (source checkout vs. bundled dist), every harness
// config c8ctl writes is dead on arrival. Pin the entry for both layouts.
test("orchestration entry points at the source CLI entry when running from src", async (t) => {
	const s = sandbox(t);
	const result = await s.run("mcp", "install", "cursor");
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(serversAt(s.paths.cursor, "cursor").camunda, {
		type: "stdio",
		command: process.execPath,
		args: [realpathSync(SRC_CLI), "mcp-proxy", "--profile", "local"],
		env: { C8CTL_DATA_DIR: s.env.C8CTL_DATA_DIR },
	});
});

test("orchestration entry points at the built CLI entry when running from dist", async (t) => {
	if (!existsSync(DIST_CLI)) {
		t.skip("requires `npm run build` — dist/index.js is absent");
		return;
	}
	const s = sandbox(t);
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const [key, value] of Object.entries(s.env)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	// dist is compiled JavaScript — no type-stripping flags needed.
	const result = await asyncSpawn(
		process.execPath,
		[DIST_CLI, "mcp", "install", "cursor"],
		{ env },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(serversAt(s.paths.cursor, "cursor").camunda, {
		type: "stdio",
		command: process.execPath,
		args: [realpathSync(DIST_CLI), "mcp-proxy", "--profile", "local"],
		env: { C8CTL_DATA_DIR: s.env.C8CTL_DATA_DIR },
	});
});

// Plugin flag dispatch does not enforce the flag's `rejectEmpty` metadata, so
// the handler validates it: an empty or valueless --alias must fail the
// command before any harness config is planned or written.
test("empty or valueless --alias is rejected before any config write", async (t) => {
	const original = '{"mcpServers":{"other":{"url":"https://other.invalid"}}}';
	for (const action of ["install", "uninstall"]) {
		for (const aliasArgs of [["--alias="], ["--alias", ""], ["--alias"]]) {
			const s = sandbox(t);
			s.write("cursor", original);
			const result = await s.run("mcp", action, "cursor", ...aliasArgs);
			const label = `mcp ${action} ${aliasArgs.join(" ")}`;
			assert.equal(result.status, 1, `${label}: ${result.stderr}`);
			assert.match(result.stderr, /--alias/);
			assert.equal(readFileSync(s.paths.cursor, "utf8"), original, label);
		}
	}
});

test("mcp list surfaces c8ctl-managed entries across harnesses and skips foreign ones", async (t) => {
	const s = sandbox(t);
	await addProfile(s);
	s.write(
		"cursor",
		'{"mcpServers":{"foreign":{"url":"https://foreign.invalid/mcp"}}}',
	);
	s.write("vscode", "{}");
	assert.equal(
		(await s.run("mcp", "install", "cursor", "--profile", "work")).status,
		0,
	);
	assert.equal((await s.run("mcp", "install", "vscode", "--docs")).status, 0);

	const result = await s.run("mcp", "list");
	assert.equal(result.status, 0, result.stderr);
	const items = parseJson(result);
	assert.ok(Array.isArray(items));
	const byHarness = new Map(
		items.map((item: unknown) => {
			assert.ok(isRecord(item));
			return [item.harness, item];
		}),
	);
	const cursor = byHarness.get("cursor");
	assert.ok(cursor);
	assert.equal(cursor.server, "camunda");
	assert.equal(cursor.target, "orchestration");
	assert.equal(cursor.profile, "work");
	assert.equal(cursor.path, s.paths.cursor);
	const vscode = byHarness.get("vscode");
	assert.ok(vscode);
	assert.equal(vscode.server, "camunda-docs");
	assert.equal(vscode.target, "docs");
	assert.equal(items.length, 2);
});

test("mcp list scopes to named harnesses and resolves aliases", async (t) => {
	const s = sandbox(t);
	s.write("cursor", "{}");
	s.write("vscode", "{}");
	assert.equal((await s.run("mcp", "install", "cursor", "--docs")).status, 0);
	assert.equal((await s.run("mcp", "install", "vscode", "--docs")).status, 0);

	const result = await s.run("mcp", "list", "code");
	assert.equal(result.status, 0, result.stderr);
	const items = parseJson(result);
	assert.ok(Array.isArray(items));
	assert.equal(items.length, 1);
	const [item] = items;
	assert.ok(isRecord(item));
	assert.equal(item.harness, "vscode");
	assert.equal(item.server, "camunda-docs");
});

test("mcp list on a machine without managed entries exits 0 with an empty list", async (t) => {
	const s = sandbox(t);
	const result = await s.run("mcp", "list");
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(parseJson(result), []);
});

test("mcp list reports a corrupt config in its row and still lists other harnesses", async (t) => {
	const s = sandbox(t);
	s.write("cursor", "{not json");
	s.write("vscode", "{}");
	assert.equal((await s.run("mcp", "install", "vscode", "--docs")).status, 0);

	const result = await s.run("mcp", "list");
	assert.equal(result.status, 0, result.stderr);
	const items = parseJson(result);
	assert.ok(Array.isArray(items));
	assert.equal(items.length, 2);
	const corrupt = items.find(
		(item: unknown) => isRecord(item) && item.harness === "cursor",
	);
	assert.ok(isRecord(corrupt));
	assert.match(String(corrupt.error), /parse|invalid/i);
	assert.equal(corrupt.path, s.paths.cursor);
	assert.ok(
		items.some((item: unknown) => isRecord(item) && item.harness === "vscode"),
	);
});

test("mcp list rejects unknown harnesses and install-only flags", async (t) => {
	const s = sandbox(t);
	const unknown = await s.run("mcp", "list", "bogus");
	assert.equal(unknown.status, 1);
	assert.match(unknown.stderr, /Unsupported MCP harness 'bogus'/);

	for (const flag of [
		"--docs",
		"--orchestration",
		"--alias=x",
		"--preserve-conflicts",
	]) {
		const result = await s.run("mcp", "list", flag);
		assert.equal(result.status, 1, `mcp list ${flag}`);
		assert.match(result.stderr, new RegExp(flag.replace(/=.*/, "")));
	}
});

test("mcp list reports an unreadable config in its row and still lists other harnesses", async (t) => {
	const s = sandbox(t);
	// A directory at the config path makes readFileSync fail with EISDIR —
	// a different failure class than a missing file or malformed JSON.
	mkdirSync(s.paths.cursor, { recursive: true });
	s.write("vscode", "{}");
	assert.equal((await s.run("mcp", "install", "vscode", "--docs")).status, 0);

	const result = await s.run("mcp", "list");
	assert.equal(result.status, 0, result.stderr);
	const items = parseJson(result);
	assert.ok(Array.isArray(items));
	assert.equal(items.length, 2);
	const unreadable = items.find(
		(item: unknown) => isRecord(item) && item.harness === "cursor",
	);
	assert.ok(isRecord(unreadable));
	assert.match(String(unreadable.error), /read/i);
	assert.ok(
		items.some((item: unknown) => isRecord(item) && item.harness === "vscode"),
	);
});

test("mcp list only treats the reserved camunda-docs entry with the managed shape as docs", async (t) => {
	const s = sandbox(t);
	// A foreign stdio server that merely references the docs URL in its args
	// is not c8ctl-managed: uninstall --docs would reject it as foreign, so
	// list must not claim it either.
	s.write(
		"cursor",
		JSON.stringify({
			mcpServers: {
				"camunda-docs": { command: "wrapper", args: [DOCS_URL] },
				other: { command: "npx", args: ["-y", "mcp-remote", DOCS_URL] },
			},
		}),
	);
	const result = await s.run("mcp", "list");
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(parseJson(result), []);

	// A foreign entry squatting on the reserved name blocks install, so
	// replace it before checking that a genuinely managed entry is listed.
	s.write(
		"cursor",
		JSON.stringify({
			mcpServers: {
				other: { command: "npx", args: ["-y", "mcp-remote", DOCS_URL] },
			},
		}),
	);
	assert.equal((await s.run("mcp", "install", "cursor", "--docs")).status, 0);
	const items = parseJson(await s.run("mcp", "list"));
	assert.ok(Array.isArray(items));
	assert.equal(items.length, 1);
	const [item] = items;
	assert.ok(isRecord(item));
	assert.equal(item.server, "camunda-docs");
	assert.equal(item.target, "docs");
});
