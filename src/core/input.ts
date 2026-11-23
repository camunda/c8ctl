/**
 * Input checks shared by services.
 */

import { C8ctlError } from "./c8ctl-error.ts";
import { normalizeToError } from "./errors.ts";

/**
 * Brand an input value with its SDK type (e.g. `ProcessDefinitionKey`).
 * A value the SDK rejects is an `invalid-input` error for `field`.
 */
export function brandInput<T>(
	field: string,
	value: string,
	brand: (value: string) => T,
): T {
	try {
		return brand(value);
	} catch (error) {
		throw new C8ctlError("invalid-input", normalizeToError(error).message, {
			field,
			cause: error,
		});
	}
}
