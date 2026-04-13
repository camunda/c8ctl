/**
 * c8ctl runtime object with environment information and session state
 */

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

/**
 * Functions injected into the runtime via init() to break circular imports.
 * client.ts, config.ts, and logger.ts all import c8ctl from this module,
 * so this module cannot import runtime values from them at the top level
 * (type-only imports are OK).
 */
export interface C8ctlDeps {
	createClient(
		profileFlag?: string,
		additionalSdkConfig?: Partial<CamundaOptions>,
	): CamundaClient;
	resolveTenantId(profileFlag?: string): string;
	getLogger(mode?: OutputMode): Logger;
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
}

declare global {
	// c8ctl runtime exposed to plugins via globalThis
	// eslint-disable-next-line no-var
	var c8ctl: C8ctlPluginRuntime | undefined;
}

/**
 * Get c8ctl version from package.json
 */
function getVersion(): string {
	try {
		const packageJsonPath = join(__dirname, "..", "package.json");
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
		return packageJson.version || "0.0.0";
	} catch {
		return "0.0.0";
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
		rootDir: join(__dirname, ".."),
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
