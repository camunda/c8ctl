/**
 * `@camunda8/cli/internal` — the c8ctl embedding API for Camunda tools
 * (hosts such as Desktop Modeler).
 *
 * @internal No compatibility promise: versions follow the CLI, so
 * consumers pin an exact version. Every export is a service or a type
 * of the service contract:
 *
 * - A service is `fn(input, ctx)`. Inputs and results are plain,
 *   serializable objects.
 * - `ctx` (`C8ctlContext`) carries everything host-specific:
 *   cancellation, progress, data directories, `fetch`, env. Services
 *   read no global state, print nothing, never exit the process.
 * - Failures are `C8ctlError`s with a stable `code` from
 *   `C8CTL_ERROR_CODES`.
 */

export type {
	C8ctlContext,
	C8ctlEvent,
	FetchFn,
	Target,
} from "../core/index.ts";
export {
	C8CTL_ERROR_CODES,
	C8ctlError,
	type C8ctlErrorCode,
	type C8ctlErrorData,
	type ClusterConfig,
	isC8ctlError,
	type ProblemDetail,
} from "../core/index.ts";
export {
	type DeployedResource,
	type DeployedResourceType,
	type DeployFile,
	type DeployInput,
	type DeployResult,
	deploy,
	type ResolveDeploymentInput,
	type ResolveDeploymentResult,
	resolveDeployment,
} from "../services/index.ts";
