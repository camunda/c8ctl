/**
 * Variable commands
 */

import { defineCommand } from "../framework/index.ts";
import { parseVariablesFlag } from "../utils/index.ts";

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

		// `--variables` is declared `required: true` in the registry and enforced
		// by validateFlags (#308), so rawVariables is guaranteed non-empty here.
		const rawVariables = flags.variables;

		const variables = parseVariablesFlag({
			raw: rawVariables,
			label: "--variables",
		});

		const local = flags.local === true;

		const dr = ctx.dryRun({
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
