/**
 * The cluster address from the environment: `CAMUNDA_BASE_URL` (c8ctl's
 * documented name) with `CAMUNDA_REST_ADDRESS` (the SDK-standard name) as an
 * alias. `CAMUNDA_BASE_URL` wins when both are set.
 *
 * Kept in its own dependency-free module so every "is the environment
 * selecting a cluster?" check (resolution, deploy target selection, the
 * logger's local-cluster hint, `which profile`) shares one definition and
 * cannot drift apart on which variable names count.
 */
export function resolveEnvBaseUrl(
	vars: Record<string, string | undefined> = process.env,
): string | undefined {
	return (
		vars.CAMUNDA_BASE_URL?.trim() ||
		vars.CAMUNDA_REST_ADDRESS?.trim() ||
		undefined
	);
}

/**
 * Basic-auth credentials from the environment: `CAMUNDA_USERNAME` /
 * `CAMUNDA_PASSWORD` (c8ctl's documented names) with the SDK-standard
 * `CAMUNDA_BASIC_AUTH_USERNAME` / `CAMUNDA_BASIC_AUTH_PASSWORD` as aliases.
 * The c8ctl names win when both are set.
 */
export function resolveEnvBasicAuth(
	vars: Record<string, string | undefined> = process.env,
): { username?: string; password?: string } {
	return {
		username:
			vars.CAMUNDA_USERNAME?.trim() ||
			vars.CAMUNDA_BASIC_AUTH_USERNAME?.trim() ||
			undefined,
		password:
			vars.CAMUNDA_PASSWORD || vars.CAMUNDA_BASIC_AUTH_PASSWORD || undefined,
	};
}
