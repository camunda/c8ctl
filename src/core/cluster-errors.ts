/**
 * Map errors of cluster requests to the error contract (`C8ctlError`).
 * Shared by every service that talks to a cluster.
 */

import {
	C8ctlError,
	type C8ctlErrorCode,
	isC8ctlError,
	type ProblemDetail,
} from "./c8ctl-error.ts";
import { withAbort } from "./client.ts";
import { type C8ctlContext, cancelledError } from "./context.ts";
import { normalizeToError } from "./errors.ts";
import { isRecord } from "./logger.ts";

const NETWORK_ERROR_CODES = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EHOSTUNREACH",
	"ECONNRESET",
	"ETIMEDOUT",
]);

/** The first Node.js error code in the error's `cause` chain. */
function networkCodeOf(error: unknown): string | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 5 && isRecord(current); depth++) {
		if (typeof current.code === "string") return current.code;
		current = current.cause;
	}
	return undefined;
}

/** Whether the cluster could not be reached (the SDK wraps this deeply). */
export function isClusterUnreachable(error: unknown): boolean {
	const code = networkCodeOf(error);
	if (code !== undefined) return NETWORK_ERROR_CODES.has(code);
	return isRecord(error) && error.name === "NetworkSdkError";
}

/** The RFC 9457 problem detail of a failed request, if it has one. */
export function problemOf(error: unknown): ProblemDetail | undefined {
	if (!isRecord(error)) return undefined;
	const status = typeof error.status === "number" ? error.status : undefined;
	const title = typeof error.title === "string" ? error.title : undefined;
	if (status === undefined && title === undefined) return undefined;
	return {
		...(typeof error.type === "string" ? { type: error.type } : {}),
		...(title === undefined ? {} : { title }),
		...(status === undefined ? {} : { status }),
		...(typeof error.detail === "string" ? { detail: error.detail } : {}),
		...(typeof error.instance === "string" ? { instance: error.instance } : {}),
	};
}

/**
 * The contract code of a failed cluster request. `rejected` is the code
 * for a request the cluster answered with a problem detail (e.g.
 * `deployment-rejected`).
 */
export function clusterErrorCode(
	error: unknown,
	rejected: C8ctlErrorCode = "request-rejected",
): C8ctlErrorCode {
	if (isClusterUnreachable(error)) return "connection-failed";
	const problem = problemOf(error);
	const status = problem?.status;
	const title = problem?.title;
	if (status === 401 || title === "UNAUTHENTICATED") return "unauthorized";
	if (status === 403 || title === "PERMISSION_DENIED") return "forbidden";
	if (status === 404 || title === "NOT_FOUND") return "not-found";
	if (status === 413) return "payload-too-large";
	if (problem) return rejected;
	return "unknown";
}

/**
 * A `C8ctlError` for a failed cluster request. The message is the one the
 * CLI showed before (`normalizeToError`); the original error is the
 * `cause`.
 */
export function classifyClusterError(error: unknown): C8ctlError {
	if (isC8ctlError(error)) return error;
	const problem = problemOf(error);
	return new C8ctlError(
		clusterErrorCode(error),
		normalizeToError(error, "Request to the cluster failed").message,
		{ cause: error, ...(problem ? { problem } : {}) },
	);
}

/**
 * Run a cluster request; a failure becomes a `C8ctlError`. `ctx.signal`
 * cancels the request (code `cancelled`); a request that pages passes the
 * signal it gets on to `fetchAllPages`.
 */
export async function callCluster<T>(
	request: (signal: AbortSignal | undefined) => Promise<T>,
	ctx: Pick<C8ctlContext, "signal">,
): Promise<T> {
	const { signal } = ctx;
	try {
		return await withAbort(() => request(signal), signal);
	} catch (error) {
		if (signal?.aborted) throw cancelledError(signal.reason);
		throw classifyClusterError(error);
	}
}
