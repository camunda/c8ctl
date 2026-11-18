import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fchmodSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	applyEdits,
	findNodeAtLocation,
	modify,
	type ParseError,
	parse,
	parseTree,
} from "jsonc-parser";
import { isRecord } from "../../core/index.ts";
import { executableIsOnPath } from "./skills-install-helpers.ts";

const DOCS_URL = "https://camunda-docs.mcp.kapa.ai";

interface McpHarness {
	id: string;
	path: string;
	key: "mcpServers" | "servers";
	directories: string[];
	executable?: string;
	stdioType?: "stdio" | "local";
}

export interface McpChange {
	server: string;
	status: "installed" | "updated" | "removed" | "unchanged" | "absent";
	config?: Record<string, unknown>;
}

export interface McpConfigPlan {
	harness: string;
	path: string;
	targetPath: string;
	original: string | undefined;
	content: string;
	mode: number;
	changes: McpChange[];
}

function selectHarnesses(requested: readonly string[]): McpHarness[] {
	const home =
		(process.platform === "win32"
			? process.env.USERPROFILE
			: process.env.HOME) || homedir();
	const appData =
		process.platform === "darwin"
			? join(home, "Library", "Application Support")
			: process.platform === "win32"
				? process.env.APPDATA || join(home, "AppData", "Roaming")
				: process.env.XDG_CONFIG_HOME || join(home, ".config");
	const claude = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
	const copilot = process.env.COPILOT_HOME || join(home, ".copilot");
	const harnesses: McpHarness[] = [
		{
			id: "claude-code",
			path: join(process.env.CLAUDE_CONFIG_DIR || home, ".claude.json"),
			key: "mcpServers",
			directories: [claude],
			executable: "claude",
			stdioType: "stdio",
		},
		{
			id: "github-copilot",
			path: join(copilot, "mcp-config.json"),
			key: "mcpServers",
			directories: [copilot],
			executable: "copilot",
			stdioType: "local",
		},
		{
			id: "cursor",
			path: join(home, ".cursor", "mcp.json"),
			key: "mcpServers",
			directories: [join(home, ".cursor"), join(appData, "Cursor")],
			executable: "cursor",
			stdioType: "stdio",
		},
		{
			id: "vscode",
			path: join(appData, "Code", "User", "mcp.json"),
			key: "servers",
			directories: [join(appData, "Code")],
			executable: "code",
			stdioType: "stdio",
		},
	];
	if (process.platform === "darwin" || process.platform === "win32") {
		harnesses.push({
			id: "claude-desktop",
			path: join(appData, "Claude", "claude_desktop_config.json"),
			key: "mcpServers",
			directories: [join(appData, "Claude")],
		});
	}
	const aliases: Readonly<Record<string, string>> = {
		claude: "claude-code",
		copilot: "github-copilot",
		code: "vscode",
	};
	if (requested.length > 0) {
		const ids = new Set(
			requested.map((name) => {
				const id = name.trim().toLowerCase();
				return Object.hasOwn(aliases, id) ? aliases[id] : id;
			}),
		);
		return [...ids].map((id) => {
			const harness = harnesses.find((candidate) => candidate.id === id);
			if (!harness) {
				throw new Error(
					`Unsupported MCP harness '${id}' on ${process.platform}. Choose: ${harnesses.map((candidate) => candidate.id).join(", ")}.`,
				);
			}
			return harness;
		});
	}
	const detected = harnesses.filter(
		(harness) =>
			existsSync(harness.path) ||
			harness.directories.some((directory) => existsSync(directory)) ||
			(harness.executable &&
				executableIsOnPath({
					name: harness.executable,
					env: process.env,
					platform: process.platform,
				})),
	);
	if (detected.length === 0) {
		throw new Error(
			`No supported MCP harness was detected. Specify a harness: ${harnesses.map((harness) => harness.id).join(", ")}.`,
		);
	}
	return detected;
}

function docsEntry(harness: McpHarness): Record<string, unknown> {
	if (harness.id === "claude-desktop") {
		return process.platform === "win32"
			? {
					command: "cmd.exe",
					args: ["/d", "/c", "npx", "-y", "mcp-remote", DOCS_URL],
				}
			: { command: "npx", args: ["-y", "mcp-remote", DOCS_URL] };
	}
	return {
		...(harness.id === "cursor" ? {} : { type: "http" }),
		url: DOCS_URL,
	};
}

function isOrchestrationEntry(entry: unknown): boolean {
	if (!isRecord(entry) || !Array.isArray(entry.args)) return false;
	const [script, command, flag, profile] = entry.args;
	return (
		typeof entry.command === "string" &&
		["node", "node.exe"].includes(basename(entry.command)) &&
		entry.args.length === 4 &&
		typeof script === "string" &&
		["index.js", "index.ts"].includes(basename(script)) &&
		command === "mcp-proxy" &&
		flag === "--profile" &&
		typeof profile === "string" &&
		isRecord(entry.env) &&
		typeof entry.env.C8CTL_DATA_DIR === "string"
	);
}

function isDocsEntry(entry: unknown): boolean {
	if (!isRecord(entry)) return false;
	return (
		entry.url === DOCS_URL ||
		(Array.isArray(entry.args) && entry.args.includes(DOCS_URL))
	);
}

function readOptionalFile(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function matchesServerConfig(
	current: unknown,
	expected: Record<string, unknown>,
): boolean {
	return (
		isRecord(current) &&
		Object.entries(expected).every(
			([key, value]) =>
				Object.hasOwn(current, key) &&
				(isRecord(value)
					? matchesServerConfig(current[key], value)
					: isDeepStrictEqual(current[key], value)),
		)
	);
}

export function planMcpConfigs({
	requested,
	operation,
	docs,
	orchestration,
	alias,
	connection,
}: {
	requested: readonly string[];
	operation: "install" | "uninstall";
	docs: boolean;
	orchestration: boolean;
	alias: string;
	connection?: Record<string, unknown>;
}): McpConfigPlan[] {
	return selectHarnesses(requested).map((harness) => {
		const path = resolve(harness.path);
		const existing = lstatSync(path, { throwIfNoEntry: false });
		// Follow an existing config symlink without replacing the link itself.
		const targetPath = existing ? realpathSync(path) : path;
		const original = readOptionalFile(targetPath);
		let content = original ?? "{}\n";
		const errors: ParseError[] = [];
		const parseOptions = {
			disallowComments: harness.id !== "vscode",
			allowTrailingComma: harness.id === "vscode",
		};
		const root = parseTree(content, errors, parseOptions);
		if (errors.length > 0 || !root || root.type !== "object") {
			throw new Error(
				`Invalid MCP config in ${path}. Repair it before continuing.`,
			);
		}
		const config: unknown = parse(content, undefined, parseOptions);
		if (!isRecord(config)) throw new Error(`Expected an object in ${path}.`);
		const servers = Object.hasOwn(config, harness.key)
			? config[harness.key]
			: {};
		if (!isRecord(servers)) {
			throw new Error(`Expected '${harness.key}' to be an object in ${path}.`);
		}
		for (const node of [root, findNodeAtLocation(root, [harness.key])]) {
			const keys: unknown[] =
				node?.children?.map((property) => property.children?.[0]?.value) ?? [];
			if (new Set(keys).size !== keys.length) {
				throw new Error(
					`Duplicate configuration keys in ${path}. Repair them before continuing.`,
				);
			}
		}
		const entries: Array<{
			name: string;
			config: Record<string, unknown>;
			docs: boolean;
		}> = [];
		if (orchestration) {
			entries.push({
				name: alias,
				config: {
					...(harness.stdioType ? { type: harness.stdioType } : {}),
					...connection,
				},
				docs: false,
			});
		}
		if (docs)
			entries.push({
				name: "camunda-docs",
				config: docsEntry(harness),
				docs: true,
			});

		const changes = entries.map((entry): McpChange => {
			const present = Object.hasOwn(servers, entry.name);
			const current = servers[entry.name];
			const matches =
				operation === "uninstall" && !entry.docs
					? isOrchestrationEntry(current)
					: matchesServerConfig(current, entry.config);
			// An entry c8ctl installed earlier can drift when the install
			// moved (another Node, a global vs. checkout install, a renamed
			// profile): it is still ours, so install updates it in place
			// instead of blocking a re-run. A foreign entry under the same
			// name still conflicts.
			const owned = entry.docs
				? isDocsEntry(current)
				: isOrchestrationEntry(current);
			if (present && !matches && !(operation === "install" && owned)) {
				throw new Error(
					`MCP entry '${entry.name}' conflicts in ${path}. Inspect it before changing it${entry.docs ? "." : ", or choose another --alias."}`,
				);
			}
			const status =
				operation === "install"
					? !present
						? "installed"
						: matches
							? "unchanged"
							: "updated"
					: present
						? "removed"
						: "absent";
			if (
				status === "installed" ||
				status === "updated" ||
				status === "removed"
			) {
				content = applyEdits(
					content,
					modify(
						content,
						[harness.key, entry.name],
						operation === "install" ? entry.config : undefined,
						{
							formattingOptions: {
								insertSpaces: true,
								tabSize: 2,
								eol: content.includes("\r\n") ? "\r\n" : "\n",
							},
						},
					),
				);
			}
			return {
				server: entry.name,
				status,
				...(operation === "install" ? { config: entry.config } : {}),
			};
		});
		return {
			harness: harness.id,
			path,
			targetPath,
			original,
			content,
			mode: existing ? statSync(targetPath).mode & 0o600 : 0o600,
			changes,
		};
	});
}

export interface WriteMcpConfigOptions {
	/** Total time to wait for another c8ctl writer before failing. */
	lockTimeoutMs?: number;
	/** Delay between lock acquisition attempts. */
	lockRetryMs?: number;
}

/**
 * Take the per-target cross-process lock (`<target>.lock`), created
 * exclusively so exactly one c8ctl writer holds it at a time. Held from
 * snapshot validation through replacement in `writeMcpConfig`, a second
 * writer observes the first's replacement and is rejected by the stale
 * snapshot check rather than silently discarding the other connection.
 */
function acquireConfigLock(
	targetPath: string,
	timeoutMs: number,
	retryMs: number,
): string {
	const lockPath = `${targetPath}.lock`;
	const deadline = Date.now() + timeoutMs;
	const waitSlot = new Int32Array(new SharedArrayBuffer(4));
	for (;;) {
		try {
			closeSync(openSync(lockPath, "wx", 0o600));
			return lockPath;
		} catch (error) {
			if (!(isRecord(error) && error.code === "EEXIST")) throw error;
			if (Date.now() >= deadline) {
				throw new Error(
					`Another c8ctl process is updating ${targetPath}. Retry shortly, or remove the stale lock ${lockPath} if that process crashed.`,
				);
			}
			Atomics.wait(waitSlot, 0, 0, retryMs);
		}
	}
}

export function writeMcpConfig(
	plan: McpConfigPlan,
	options?: WriteMcpConfigOptions,
): void {
	if (
		!plan.changes.some(
			(change) =>
				change.status === "installed" ||
				change.status === "updated" ||
				change.status === "removed",
		)
	)
		return;
	mkdirSync(dirname(plan.targetPath), { recursive: true });
	const lockPath = acquireConfigLock(
		plan.targetPath,
		options?.lockTimeoutMs ?? 5000,
		options?.lockRetryMs ?? 50,
	);
	try {
		const temp = `${plan.targetPath}.${randomUUID()}.tmp`;
		let fd: number | undefined;
		let created = false;
		try {
			fd = openSync(temp, "wx", 0o600);
			created = true;
			writeFileSync(fd, plan.content, "utf8");
			if (process.platform !== "win32") fchmodSync(fd, plan.mode);
			fsyncSync(fd);
			closeSync(fd);
			fd = undefined;
			if (readOptionalFile(plan.targetPath) !== plan.original) {
				throw new Error(
					`MCP config changed during installation: ${plan.path}. Run the command again.`,
				);
			}
			renameSync(temp, plan.targetPath);
		} finally {
			if (fd !== undefined) closeSync(fd);
			if (created) rmSync(temp, { force: true });
		}
	} finally {
		rmSync(lockPath, { force: true });
	}
}
