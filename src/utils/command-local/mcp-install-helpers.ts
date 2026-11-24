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
	status:
		| "installed"
		| "updated"
		| "removed"
		| "unchanged"
		| "absent"
		| "preserved";
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

function buildHarnesses(): McpHarness[] {
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
	return harnesses;
}

/**
 * The MCP harnesses detectable on this machine, by the same rules
 * `planMcpConfigs` uses when no harness is named: config file, config
 * directory, or executable on PATH. Callers that treat "no harness" as
 * a soft skip (the setup wizard) probe with this before invoking the
 * install, so an absent harness never becomes a command failure.
 */
export function detectMcpHarnesses(): McpHarness[] {
	return buildHarnesses().filter(
		(harness) =>
			existsSync(harness.path) ||
			harness.directories.some((directory) => existsSync(directory)) ||
			(harness.executable !== undefined &&
				executableIsOnPath({
					name: harness.executable,
					env: process.env,
					platform: process.platform,
				})),
	);
}

function selectHarnesses(requested: readonly string[]): McpHarness[] {
	const harnesses = buildHarnesses();
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
	const detected = detectMcpHarnesses();
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

/**
 * Rewrite only the fields c8ctl manages in an owned entry, so
 * client-added keys (a `tools` allowlist, extra env vars) and JSONC
 * comments survive a drift update.
 */
function updateManagedEntry({
	content,
	path,
	current,
	expected,
}: {
	content: string;
	path: string[];
	current: Record<string, unknown>;
	expected: Record<string, unknown>;
}): string {
	const formattingOptions = {
		insertSpaces: true,
		tabSize: 2,
		eol: content.includes("\r\n") ? "\r\n" : "\n",
	};
	const edit = (keyPath: string[], value: unknown): void => {
		content = applyEdits(
			content,
			modify(content, keyPath, value, { formattingOptions }),
		);
	};
	for (const [key, value] of Object.entries(expected)) {
		const currentEnv = isRecord(current.env) ? current.env : undefined;
		if (key === "env" && isRecord(value) && currentEnv) {
			for (const [envKey, envValue] of Object.entries(value)) {
				if (!isDeepStrictEqual(currentEnv[envKey], envValue)) {
					edit([...path, "env", envKey], envValue);
				}
			}
			continue;
		}
		if (!isDeepStrictEqual(current[key], value)) edit([...path, key], value);
	}
	// The harness transport type is the only managed key an older install
	// could have written that the current shape no longer sets.
	if (Object.hasOwn(current, "type") && !Object.hasOwn(expected, "type")) {
		edit([...path, "type"], undefined);
	}
	return content;
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
	preserveConflicts = false,
	onError,
}: {
	requested: readonly string[];
	operation: "install" | "uninstall";
	docs: boolean;
	orchestration: boolean;
	alias: string;
	connection?: Record<string, unknown>;
	preserveConflicts?: boolean;
	onError?: (harness: string, error: unknown) => void;
}): McpConfigPlan[] {
	type TargetPlans = {
		original: string | undefined;
		content: string;
		mode: number;
		plans: McpConfigPlan[];
	};
	const plans: McpConfigPlan[] = [];
	const plansByTarget = new Map<string, TargetPlans>();
	for (const harness of selectHarnesses(requested)) {
		try {
			const path = resolve(harness.path);
			const existing = lstatSync(path, { throwIfNoEntry: false });
			// Follow an existing config symlink without replacing the link itself.
			const targetPath = existing ? realpathSync(path) : path;
			const previous = plansByTarget.get(targetPath);
			const original = previous
				? previous.original
				: readOptionalFile(targetPath);
			let content = previous ? previous.content : (original ?? "{}\n");
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
				throw new Error(
					`Expected '${harness.key}' to be an object in ${path}.`,
				);
			}
			for (const node of [root, findNodeAtLocation(root, [harness.key])]) {
				const keys: unknown[] =
					node?.children?.map((property) => property.children?.[0]?.value) ??
					[];
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
				// name still conflicts. The docs entry carries no local paths,
				// so only the orchestration entry can drift this way.
				const owned = !entry.docs && isOrchestrationEntry(current);
				if (present && !matches && !(operation === "install" && owned)) {
					if (operation === "uninstall" && preserveConflicts) {
						return { server: entry.name, status: "preserved" };
					}
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
				if (status === "updated") {
					content = updateManagedEntry({
						content,
						path: [harness.key, entry.name],
						current: isRecord(current) ? current : {},
						expected: entry.config,
					});
				} else if (status === "installed" || status === "removed") {
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
			const mode =
				previous?.mode ??
				(existing ? statSync(targetPath).mode & 0o600 : 0o600);
			const plan: McpConfigPlan = {
				harness: harness.id,
				path,
				targetPath,
				original,
				content,
				mode,
				changes,
			};
			const target: TargetPlans = previous ?? {
				original,
				content,
				mode,
				plans: [],
			};
			target.content = content;
			target.plans.push(plan);
			plansByTarget.set(targetPath, target);
			plans.push(plan);
		} catch (error) {
			if (!onError) throw error;
			onError(harness.id, error);
		}
	}

	for (const target of plansByTarget.values()) {
		for (const plan of target.plans) plan.content = target.content;
	}
	return plans;
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
 * writer observes the first's replacement and no-ops only when it matches
 * the same planned final content; otherwise the stale-snapshot check rejects it.
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
			const current = readOptionalFile(plan.targetPath);
			if (current === plan.content) return;
			if (current !== plan.original) {
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
