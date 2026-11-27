/**
 * Profile services: list, get, add, remove.
 *
 * c8ctl profiles live in `profiles.json` in `ctx.dataDir`; Desktop
 * Modeler connections are read from `settings.json` in `ctx.modelerDir`
 * and are read-only. Results never contain secrets.
 */

import type { C8ctlContext } from "../core/index.ts";
import {
	addProfile as addStoredProfile,
	C8ctlError,
	CAMUNDA_AUTH_STRATEGIES,
	type CamundaAuthStrategy,
	type Connection,
	connectionToProfile,
	effectiveAuthStrategy,
	getProfile as getStoredProfile,
	isRecord,
	loadModelerConnections,
	loadProfiles,
	MODELER_PREFIX,
	type Profile,
	removeStoredProfile,
	throwIfCancelled,
} from "../core/index.ts";

/** A profile without its secrets (client secret, password, headers). */
export interface ProfileSummary {
	/** Display name; `modeler:<name>` for a Modeler connection. */
	name: string;
	/** What a host passes as `target.profile`: the c8ctl profile name,
	 *  or `modeler:<connection id>`. */
	ref: string;
	source: "c8ctl" | "modeler";
	baseUrl: string;
	/** The profile's default tenant. */
	tenantId?: string;
	/** The auth strategy the cluster client uses for this profile. */
	authStrategy: CamundaAuthStrategy;
	clientId?: string;
	oAuthUrl?: string;
	audience?: string;
	scope?: string;
	username?: string;
}

/** A c8ctl profile to save, including its secrets. */
export interface ProfileInput {
	name: string;
	baseUrl: string;
	/** The profile's default tenant. */
	tenantId?: string;
	clientId?: string;
	clientSecret?: string;
	audience?: string;
	oAuthUrl?: string;
	scope?: string;
	username?: string;
	password?: string;
	/** HTTP headers sent with every request, e.g. a gateway API key. */
	headers?: Record<string, string>;
	/** Use `baseUrl` exactly as given; c8ctl appends no `/v2`. */
	exactBaseUrl?: boolean;
	/** Wins over the strategy derived from the credentials. */
	authStrategy?: CamundaAuthStrategy;
}

export type ListProfilesInput = Record<string, never>;

export interface ProfileNameInput {
	/** A c8ctl profile name, or a Modeler connection as `modeler:<name or id>`. */
	name: string;
}

export interface AddProfileInput {
	profile: ProfileInput;
	/** Replace a profile with the same name. Default: `false`, an
	 *  existing name is a `profile-exists` error. */
	replace?: boolean;
}

/** `fields` without its undefined entries. */
function defined<T extends object>(fields: T): Partial<T> {
	const result: Partial<T> = {};
	for (const key in fields) {
		if (fields[key] !== undefined) result[key] = fields[key];
	}
	return result;
}

function summarize(
	profile: Profile,
	identity: Pick<ProfileSummary, "name" | "ref" | "source">,
): ProfileSummary {
	return {
		...identity,
		baseUrl: profile.baseUrl,
		authStrategy: effectiveAuthStrategy(profile),
		...defined({
			tenantId: profile.defaultTenantId,
			clientId: profile.clientId,
			oAuthUrl: profile.oAuthUrl,
			audience: profile.audience,
			scope: profile.scope,
			username: profile.username,
		}),
	};
}

function c8ctlSummary(profile: Profile): ProfileSummary {
	return summarize(profile, {
		name: profile.name,
		ref: profile.name,
		source: "c8ctl",
	});
}

function modelerSummary(connection: Connection): ProfileSummary {
	const profile = connectionToProfile(connection);
	return summarize(profile, {
		name: `${MODELER_PREFIX}${profile.name}`,
		ref: `${MODELER_PREFIX}${connection.id}`,
		source: "modeler",
	});
}

function requireName(name: string, field: string): void {
	if (typeof name !== "string" || name.trim() === "") {
		throw new C8ctlError("invalid-input", "Profile name must not be empty.", {
			field,
		});
	}
}

/**
 * Check the name of a c8ctl profile to add: not empty, and not in the
 * namespace reserved for Modeler connections.
 */
export function validateProfileName(
	name: string,
	field = "profile.name",
): void {
	requireName(name, field);
	if (name.startsWith(MODELER_PREFIX)) {
		throw new C8ctlError(
			"invalid-input",
			`Profile names cannot start with "${MODELER_PREFIX}" - this prefix is reserved for Camunda Modeler connections`,
			{ field },
		);
	}
}

function profileNotFound(name: string): C8ctlError {
	return new C8ctlError("profile-not-found", `Profile '${name}' not found`, {
		field: "name",
		details: { profile: name },
	});
}

/** All c8ctl profiles, then all Modeler connections. */
export async function listProfiles(
	_input: ListProfilesInput = {},
	ctx: C8ctlContext = {},
): Promise<{ items: ProfileSummary[] }> {
	return {
		items: [
			...loadProfiles(ctx.dataDir).map(c8ctlSummary),
			...loadModelerConnections(ctx.modelerDir).map(modelerSummary),
		],
	};
}

/**
 * A profile by the name a `target.profile` accepts: a c8ctl profile name,
 * or a Modeler connection's name or id, with or without `modeler:`.
 */
export async function getProfile(
	input: ProfileNameInput,
	ctx: C8ctlContext = {},
): Promise<ProfileSummary> {
	requireName(input.name, "name");
	const profile = getStoredProfile(input.name, ctx.dataDir);
	if (profile) {
		return c8ctlSummary(profile);
	}
	const modelerName = input.name.startsWith(MODELER_PREFIX)
		? input.name.slice(MODELER_PREFIX.length)
		: input.name;
	const connection = loadModelerConnections(ctx.modelerDir).find(
		(c) => c.name === modelerName || c.id === modelerName,
	);
	if (connection) {
		return modelerSummary(connection);
	}
	throw profileNotFound(input.name);
}

const STRING_FIELDS = [
	"tenantId",
	"clientId",
	"clientSecret",
	"audience",
	"oAuthUrl",
	"scope",
	"username",
	"password",
] as const;

/** The fields `ProfileInput` stores; other properties are dropped. */
const STORED_FIELDS = new Set<string>([
	"name",
	"baseUrl",
	...STRING_FIELDS,
	"headers",
	"exactBaseUrl",
	"authStrategy",
]);

function invalidField(field: string, message: string): C8ctlError {
	return new C8ctlError("invalid-input", message, {
		field: `profile.${field}`,
	});
}

/**
 * Reject values that would make profiles.json unreadable: a file with a
 * malformed profile is treated as corrupt.
 */
function validateProfileFields(profile: ProfileInput): void {
	if (typeof profile.baseUrl !== "string" || profile.baseUrl.trim() === "") {
		throw invalidField("baseUrl", "Base URL must not be empty.");
	}
	for (const field of STRING_FIELDS) {
		const value = profile[field];
		if (value !== undefined && typeof value !== "string") {
			throw invalidField(field, `'${field}' must be a string.`);
		}
	}
	if (
		profile.exactBaseUrl !== undefined &&
		typeof profile.exactBaseUrl !== "boolean"
	) {
		throw invalidField("exactBaseUrl", "'exactBaseUrl' must be a boolean.");
	}
	if (
		profile.headers !== undefined &&
		!(
			isRecord(profile.headers) &&
			Object.values(profile.headers).every((v) => typeof v === "string")
		)
	) {
		throw invalidField(
			"headers",
			"'headers' must map header names to string values.",
		);
	}
	if (
		profile.authStrategy !== undefined &&
		!CAMUNDA_AUTH_STRATEGIES.some((s) => s === profile.authStrategy)
	) {
		throw invalidField(
			"authStrategy",
			`'authStrategy' must be one of ${CAMUNDA_AUTH_STRATEGIES.join(", ")}.`,
		);
	}
}

/** Save a c8ctl profile. */
export async function addProfile(
	input: AddProfileInput,
	ctx: C8ctlContext = {},
): Promise<{ name: string }> {
	throwIfCancelled(ctx);
	const { profile } = input;
	validateProfileName(profile.name);
	validateProfileFields(profile);
	if (!input.replace && getStoredProfile(profile.name, ctx.dataDir)) {
		throw new C8ctlError(
			"profile-exists",
			`Profile '${profile.name}' already exists`,
			{ field: "profile.name", details: { profile: profile.name } },
		);
	}
	// Built in the input's field order, which profiles.json keeps.
	const stored: Profile = { name: profile.name, baseUrl: profile.baseUrl };
	for (const [key, value] of Object.entries(profile)) {
		if (!STORED_FIELDS.has(key) || value === undefined) continue;
		if (key === "tenantId") {
			stored.defaultTenantId = profile.tenantId;
		} else if (key !== "name" && key !== "baseUrl") {
			Object.assign(stored, { [key]: value });
		}
	}
	addStoredProfile(stored, ctx.dataDir);
	return { name: profile.name };
}

/** Remove a c8ctl profile. Modeler connections are read-only. */
export async function removeProfile(
	input: ProfileNameInput,
	ctx: C8ctlContext = {},
): Promise<{ name: string }> {
	throwIfCancelled(ctx);
	requireName(input.name, "name");
	if (input.name.startsWith(MODELER_PREFIX)) {
		throw new C8ctlError(
			"invalid-input",
			"Cannot remove Modeler profiles via c8ctl",
			{ field: "name" },
		);
	}
	if (!removeStoredProfile(input.name, ctx.dataDir)) {
		throw profileNotFound(input.name);
	}
	return { name: input.name };
}
