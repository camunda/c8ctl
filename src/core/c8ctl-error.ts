/**
 * The error contract shared by every c8ctl host (the CLI and embedders such as Desktop Modeler).
 *
 * Hosts branch on `code`, never on `message`: the message is for people
 * and may change between versions. `field` names the input that caused
 * the error, `problem` carries an RFC 9457 problem detail from the
 * cluster unchanged, and `details` holds structured data for the code
 * (see `C8CTL_ERROR_CODES`).
 */

/** RFC 9457 problem detail, as returned by the Camunda REST API. */
export interface ProblemDetail {
	type?: string;
	title?: string;
	status?: number;
	detail?: string;
	instance?: string;
	[key: string]: unknown;
}

/**
 * The error code catalog. One entry per code, with the condition it
 * describes. Codes are stable; adding a code is not a breaking change,
 * removing or renaming one is.
 */
export const C8CTL_ERROR_CODES = {
	"invalid-input": "An input is missing or invalid (see `field`).",
	"invalid-config":
		"camunda.json or its deployResources field is invalid or unreadable.",
	"empty-selection": "deployResources selects no files.",
	"read-error": "A file selected for deployment cannot be read.",
	"no-deployable-files": "The given paths contain no deployable files.",
	"duplicate-definition-ids":
		"Several resources in one deployment share a process or decision ID.",
	"profile-not-found": "The target profile does not exist.",
	"invalid-connection":
		"The cluster configuration is incomplete or invalid, e.g. BASIC auth without a password (see details.issues).",
	"connection-failed": "The cluster cannot be reached.",
	unauthorized: "The cluster rejected the credentials (HTTP 401).",
	forbidden: "The credentials lack the permission (HTTP 403).",
	"payload-too-large": "The request exceeds the cluster's size limit (413).",
	"not-found": "The requested resource does not exist (HTTP 404).",
	"request-rejected": "The cluster rejected the request (see problem).",
	"deployment-rejected": "The cluster rejected the deployment (see problem).",
	cancelled: "The call was cancelled through its AbortSignal.",
	unknown: "An unexpected error.",
} as const;

export type C8ctlErrorCode = keyof typeof C8CTL_ERROR_CODES;

export interface C8ctlErrorOptions {
	field?: string;
	problem?: ProblemDetail;
	details?: Record<string, unknown>;
	cause?: unknown;
}

/** Serializable form of a `C8ctlError`, e.g. for `--json` or a host's IPC. */
export interface C8ctlErrorData {
	code: C8ctlErrorCode;
	message: string;
	field?: string;
	problem?: ProblemDetail;
	details?: Record<string, unknown>;
}

export class C8ctlError extends Error {
	readonly code: C8ctlErrorCode;
	readonly field?: string;
	readonly problem?: ProblemDetail;
	readonly details?: Record<string, unknown>;

	constructor(
		code: C8ctlErrorCode,
		message: string,
		options: C8ctlErrorOptions = {},
	) {
		super(message, options.cause === undefined ? {} : { cause: options.cause });
		this.name = "C8ctlError";
		this.code = code;
		this.field = options.field;
		this.problem = options.problem;
		this.details = options.details;
	}

	toJSON(): C8ctlErrorData {
		return {
			code: this.code,
			message: this.message,
			...(this.field === undefined ? {} : { field: this.field }),
			...(this.problem === undefined ? {} : { problem: this.problem }),
			...(this.details === undefined ? {} : { details: this.details }),
		};
	}
}

export function isC8ctlError(error: unknown): error is C8ctlError {
	return error instanceof C8ctlError;
}
