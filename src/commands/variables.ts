/**
 * Variable commands
 */

import { defineCommand, dryRun } from "../command-framework.ts";
import { isRecord } from "../logger.ts";

/**
 * Set variables on an element instance (process instance or flow element).
 *
 * Maps to: PUT /v2/element-instances/{elementInstanceKey}/variables
 */
export const setVariableCommand = defineCommand(
	"set",
	"variable",
	async (ctx, flags, args) => {
		const { client, profile } = ctx;
		const key = args.key;

		// Parse variables JSON
		const rawVariables = flags.variables;
		if (!rawVariables) {
			throw new Error(
				"--variables is required. Provide a JSON object, e.g. --variables='{\"myVar\":42}'",
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(rawVariables);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Invalid JSON for --variables: ${msg}`);
		}

		if (!isRecord(parsed)) {
			throw new Error(
				Array.isArray(parsed)
					? "--variables must be a JSON object (not an array)"
					: "--variables must be a JSON object",
			);
		}
		const variables: Record<string, unknown> = parsed;

		const local = flags.local === true;

		const dr = dryRun({
			command: "set variable",
			method: "PUT",
			endpoint: `/element-instances/${key}/variables`,
			profile,
			body: { variables, ...(local && { local: true }) },
		});
		if (dr) return dr;

		await client.createElementInstanceVariables({
			elementInstanceKey: key,
			variables,
			...(local && { local: true }),
		});

		return {
			kind: "success",
			message: `Variables set on element instance ${key}`,
		};
	},
);
