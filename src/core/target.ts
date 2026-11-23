/**
 * Resolve a service's `Target` into a cluster configuration and a
 * client, from the host's context only.
 */

import type { CamundaClient } from "@camunda8/orchestration-cluster-api";
import { C8ctlError } from "./c8ctl-error.ts";
import { createClientFromConfig } from "./client.ts";
import {
	type ClusterConfig,
	getProfileOrModeler,
	profileToClusterConfig,
} from "./config.ts";
import type { C8ctlContext, Target } from "./context.ts";

export interface ResolvedTarget {
	config: ClusterConfig;
	/** The profile's default tenant, if it has one. */
	defaultTenantId?: string;
}

export function resolveTarget(
	target: Target,
	ctx: C8ctlContext,
): ResolvedTarget {
	if ("cluster" in target) {
		return { config: target.cluster };
	}

	const name = target.profile;
	if (name.trim() === "") {
		throw new C8ctlError("invalid-input", "Profile name must not be empty.", {
			field: "target.profile",
		});
	}
	const profile = getProfileOrModeler(name, ctx);
	if (!profile) {
		throw new C8ctlError("profile-not-found", `Profile '${name}' not found.`, {
			field: "target.profile",
			details: { profile: name },
		});
	}
	return {
		config: profileToClusterConfig(profile),
		defaultTenantId: profile.defaultTenantId,
	};
}

/**
 * A cluster client for the service's context. Without `ctx.env` it
 * ignores the host's `CAMUNDA_*` env and logs nothing unless
 * `ctx.sdkLogLevel` is set; with `ctx.env` and no level, the SDK reads
 * `CAMUNDA_SDK_LOG_LEVEL` from that env.
 */
export function createTargetClient(
	config: ClusterConfig,
	ctx: C8ctlContext,
): CamundaClient {
	return createClientFromConfig(config, {
		env: ctx.env ?? {},
		logLevel: ctx.sdkLogLevel ?? (ctx.env ? undefined : "silent"),
		fetch: ctx.fetch,
	});
}
