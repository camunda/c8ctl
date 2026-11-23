/**
 * The host-side half of the service contract: what every service
 * receives besides its input, and how it reports back.
 */

import type { CamundaOptions } from "@camunda8/orchestration-cluster-api";
import { C8ctlError } from "./c8ctl-error.ts";
import type { SdkLogLevel } from "./client.ts";
import type { ClusterConfig, DataDirs } from "./config.ts";

/** A `fetch` implementation, as the cluster client accepts it. */
export type FetchFn = NonNullable<CamundaOptions["fetch"]>;

/**
 * Reported by a service while it runs. All events are plain,
 * serializable objects, so a host can forward them unchanged (CLI output,
 * IPC to a host's UI).
 */
export type C8ctlEvent =
	/** A message for the user. */
	| { type: "notice"; message: string }
	/** Something the user should know, but the service continues. */
	| { type: "warning"; message: string }
	/** A step of the service started or finished. `data` is step-specific. */
	| {
			type: "progress";
			phase: string;
			current?: number;
			total?: number;
			data?: Record<string, unknown>;
	  };

/**
 * Passed by the host to every service. Services read nothing else:
 * no session, no `CAMUNDA_*` env, no global runtime state.
 */
export interface C8ctlContext extends DataDirs {
	/** Cancels the service; it then rejects with code `cancelled`. */
	signal?: AbortSignal;
	onProgress?: (event: C8ctlEvent) => void;
	/** Used for all cluster requests, e.g. with the host's proxy and CAs. */
	fetch?: FetchFn;
	/**
	 * Environment the cluster client may read `CAMUNDA_*` settings from.
	 * Default: none, so a host's environment never leaks in. The CLI
	 * passes `process.env`.
	 */
	env?: Record<string, string | undefined>;
	/** Cluster client log level. Default: `silent` without `env`; with
	 *  `env`, the SDK reads `CAMUNDA_SDK_LOG_LEVEL` from it. */
	sdkLogLevel?: SdkLogLevel;
}

/**
 * The cluster a service talks to: a saved profile (c8ctl profile or
 * `modeler:<id>`, credentials stay in c8ctl) or a configuration the host
 * resolved itself, e.g. an unsaved connection.
 */
export type Target = { profile: string } | { cluster: ClusterConfig };

export function emit(ctx: C8ctlContext, event: C8ctlEvent): void {
	ctx.onProgress?.(event);
}

export function cancelledError(cause?: unknown): C8ctlError {
	return new C8ctlError("cancelled", "The call was cancelled.", {
		cause,
	});
}

export function throwIfCancelled(ctx: C8ctlContext): void {
	if (ctx.signal?.aborted) {
		throw cancelledError(ctx.signal.reason);
	}
}
