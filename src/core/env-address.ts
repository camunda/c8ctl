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
export function resolveEnvBaseUrl(): string | undefined {
	return (
		process.env.CAMUNDA_BASE_URL?.trim() ||
		process.env.CAMUNDA_REST_ADDRESS?.trim() ||
		undefined
	);
}
