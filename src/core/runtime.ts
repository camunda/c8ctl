/**
 * c8ctl runtime object with environment information and session state
 */

import type { ExecFileSyncOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	CamundaClient,
	CamundaOptions,
} from "@camunda8/orchestration-cluster-api";
import type { Logger, OutputMode } from "./logger.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface C8ctlEnv {
	version: string;
	nodeVersion: string;
	platform: string;
	arch: string;
	cwd: string;
	rootDir: string;
}

/** Options for the npm runner when its stdout is captured. */
export interface NpmRunOptionsWithOutput {
	args: readonly string[];
	stdout: true;
}

/** Options for the npm runner when its output is inherited or discarded. */
export interface NpmRunOptionsWithoutOutput {
	args: readonly string[];
	stdio?: ExecFileSyncOptions["stdio"];
	stdout?: false;
}

/**
 * Cross-platform npm runner.
 *
 * Declared structurally here rather than imported from
 * `utils/shared/npm-exec.ts` because `core/` may not import `utils/` — not
 * even type-only (see tests/unit/layering-import-boundary.test.ts). The real
 * implementation is checked against this contract where it is injected, at
 * the composition root.
 */
export interface NpmRunner {
	(options: NpmRunOptionsWithOutput): { stdout: string };
	(options: NpmRunOptionsWithoutOutput): undefined;
}

/**
 * Functions injected into the runtime via init() to break circular imports.
 * client.ts, config.ts, and logger.ts all import c8ctl from this module,
 * so this module cannot import runtime values from them at the top level
 * (type-only imports are OK). `npm` is injected for a different reason: it
 * lives in `utils/`, which `core/` may not import from at all.
 */
export interface C8ctlDeps {
	createClient(
		profileFlag?: string,
		additionalSdkConfig?: Partial<CamundaOptions>,
	): CamundaClient;
	resolveTenantId(profileFlag?: string): string;
	getLogger(mode?: OutputMode): Logger;
	getUserDataDir(): string;
	npm: NpmRunner;
}

export interface C8ctlPluginRuntime {
	readonly env: C8ctlEnv;
	readonly version: string;
	readonly nodeVersion: string;
	readonly platform: string;
	readonly arch: string;
	readonly cwd: string;
	activeProfile?: string;
	activeTenant?: string;
	outputMode: OutputMode;
	/** Agent flag: comma-separated list of fields to include in output (applied at logger level) */
	fields?: string[];
	/** Agent flag: when true, commands emit the would-be API request as JSON without executing it */
	dryRun?: boolean;
	/** When true, enables SDK trace logging and surfaces raw errors instead of user-friendly messages */
	verbose?: boolean;
	createClient(
		profileFlag?: string,
		additionalSdkConfig?: Partial<CamundaOptions>,
	): CamundaClient;
	resolveTenantId(profileFlag?: string): string;
	getLogger(mode?: OutputMode): Logger;
	/**
	 * Cross-platform user data directory:
	 *   - macOS:  ~/Library/Application Support/c8ctl
	 *   - Linux:  $XDG_CONFIG_HOME/c8ctl (default ~/.config/c8ctl)
	 *   - Win32:  %APPDATA%/c8ctl
	 * Overridable via C8CTL_DATA_DIR.
	 */
	getUserDataDir(): string;
	/**
	 * Run npm the way c8ctl itself does, portably.
	 *
	 * Spawning npm directly is not portable: on Windows npm is a `npm.cmd`
	 * shim, bare `"npm"` fails with ENOENT and `"npm.cmd"` fails with EINVAL
	 * under the CVE-2024-27980 hardening, so the invocation has to go through
	 * cmd.exe with every argument quoted. Use this instead of hand-rolling a
	 * spawn.
	 *
	 *   const { stdout } = c8ctl.npm({ args: ["view", pkg, "version"], stdout: true });
	 *   c8ctl.npm({ args: ["install", pkg], stdio: "inherit" });
	 *
	 * Throws if an argument cannot be passed safely to cmd.exe (embedded
	 * quote, line break, or a `%VAR%` reference).
	 */
	npm: NpmRunner;
}

declare global {
	// c8ctl runtime exposed to plugins via globalThis
	// eslint-disable-next-line no-var
	var c8ctl: C8ctlPluginRuntime | undefined;
}

/**
 * The version in the repo's `package.json` — semantic-release replaces it at
 * publish time, so seeing it means c8ctl is running from an unpublished source
 * checkout.
 */
export const UNVERSIONED_DEV_BUILD = "0.0.0-semantically-released";

/**
 * Whether `version` identifies an unpublished development build.
 *
 * Such a version carries no information about the API surface it exposes, so
 * anything that reasons about "which c8ctl is this" has to opt out rather than
 * draw a conclusion: the self-update check skips notifying, and the plugin host
 * requirement (`engines.c8ctl`, #523) skips enforcing.
 */
export function isUnversionedDevBuild(version: string): boolean {
	return version === UNVERSIONED_DEV_BUILD;
}

/**
 * Get c8ctl version from package.json
 *
 * An unreadable or version-less `package.json` falls back to
 * {@link UNVERSIONED_DEV_BUILD} rather than `0.0.0`. `0.0.0` is a real,
 * parseable version that happens to satisfy no requirement, so anything
 * comparing against it would draw a confident *wrong* conclusion — a plugin
 * declaring `engines.c8ctl: ">=3.0.0"` would be reported as unsupported. The
 * sentinel says "unknown", which every consumer already treats as "do not
 * conclude anything from this".
 */
function getVersion(): string {
	try {
		const packageJsonPath = join(__dirname, "..", "..", "package.json");
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
		return packageJson.version || UNVERSIONED_DEV_BUILD;
	} catch {
		return UNVERSIONED_DEV_BUILD;
	}
}

/**
 * c8ctl runtime class with session state management.
 * Implements C8ctlPluginRuntime directly — no monkey-patching required.
 */
class C8ctl implements C8ctlPluginRuntime {
	private _activeProfile?: string;
	private _activeTenant?: string;
	private _outputMode: OutputMode = "text";
	private _fields?: string[];
	private _dryRun?: boolean;
	private _verbose?: boolean;
	private _resolvedBaseUrl?: string;
	private _deps?: C8ctlDeps;

	readonly env: C8ctlEnv = {
		version: getVersion(),
		nodeVersion: process.version,
		platform: process.platform,
		arch: process.arch,
		cwd: process.cwd(),
		rootDir: join(__dirname, "..", ".."),
	};

	/**
	 * Inject dependencies that cannot be imported at module level
	 * due to circular imports. Must be called once during startup,
	 * before any plugin or command accesses createClient/resolveTenantId/getLogger.
	 */
	init(deps: C8ctlDeps): void {
		if (this._deps) {
			throw new Error("c8ctl.init() must only be called once");
		}
		this._deps = deps;
	}

	createClient(
		profileFlag?: string,
		additionalSdkConfig?: Partial<CamundaOptions>,
	): CamundaClient {
		if (!this._deps) {
			throw new Error("c8ctl.init() must be called before createClient()");
		}
		return this._deps.createClient(profileFlag, additionalSdkConfig);
	}

	resolveTenantId(profileFlag?: string): string {
		if (!this._deps) {
			throw new Error("c8ctl.init() must be called before resolveTenantId()");
		}
		return this._deps.resolveTenantId(profileFlag);
	}

	getLogger(mode?: OutputMode): Logger {
		if (!this._deps) {
			throw new Error("c8ctl.init() must be called before getLogger()");
		}
		return this._deps.getLogger(mode);
	}

	getUserDataDir(): string {
		if (!this._deps) {
			throw new Error("c8ctl.init() must be called before getUserDataDir()");
		}
		return this._deps.getUserDataDir();
	}

	npm(options: NpmRunOptionsWithOutput): { stdout: string };
	npm(options: NpmRunOptionsWithoutOutput): undefined;
	npm(
		options: NpmRunOptionsWithOutput | NpmRunOptionsWithoutOutput,
	): { stdout: string } | undefined {
		if (!this._deps) {
			throw new Error("c8ctl.init() must be called before npm()");
		}
		// Narrow on the discriminant so each branch resolves a single overload
		// of the injected runner.
		return options.stdout === true
			? this._deps.npm(options)
			: this._deps.npm(options);
	}

	// Expose env properties directly for plugin compatibility
	get version(): string {
		return this.env.version;
	}

	get nodeVersion(): string {
		return this.env.nodeVersion;
	}

	get platform(): string {
		return this.env.platform;
	}

	get arch(): string {
		return this.env.arch;
	}

	get cwd(): string {
		return this.env.cwd;
	}

	get activeProfile(): string | undefined {
		return this._activeProfile;
	}

	set activeProfile(value: string | undefined) {
		this._activeProfile = value;
	}

	get activeTenant(): string | undefined {
		return this._activeTenant;
	}

	set activeTenant(value: string | undefined) {
		this._activeTenant = value;
	}

	get outputMode(): OutputMode {
		return this._outputMode;
	}

	set outputMode(value: OutputMode) {
		this._outputMode = value;
	}

	get fields(): string[] | undefined {
		return this._fields;
	}

	set fields(value: string[] | undefined) {
		this._fields = value;
	}

	get dryRun(): boolean | undefined {
		return this._dryRun;
	}

	set dryRun(value: boolean | undefined) {
		this._dryRun = value;
	}

	get verbose(): boolean | undefined {
		return this._verbose;
	}

	set verbose(value: boolean | undefined) {
		this._verbose = value;
	}

	get resolvedBaseUrl(): string | undefined {
		return this._resolvedBaseUrl;
	}

	set resolvedBaseUrl(value: string | undefined) {
		this._resolvedBaseUrl = value;
	}
}

/**
 * Global c8ctl runtime instance
 */
// biome-ignore lint/suspicious/noRedeclare: intentional — module export shadows the globalThis declaration
export const c8ctl = new C8ctl();
