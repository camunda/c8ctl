/**
 * Variable commands — CLI bindings of the variable services.
 */

import { defineServiceCommand } from "../framework/index.ts";
import { setVariable, setVariableRequest } from "../services/index.ts";
import { parseVariablesFlag } from "../utils/index.ts";

/**
 * Set variables on an element instance (process instance or flow element).
 *
 * Maps to: PUT /v2/element-instances/{elementInstanceKey}/variables
 */
export const setVariableCommand = defineServiceCommand("set", "variable", {
	toInput: (flags, args) => ({
		elementInstanceKey: args.key,
		// `--variables` is declared `required: true` in the registry and
		// enforced by validateFlags, so the raw value is never empty here.
		variables: parseVariablesFlag({
			raw: flags.variables,
			label: "--variables",
		}),
		local: flags.local === true,
	}),
	dryRun: { command: "set variable", request: setVariableRequest },
	service: setVariable,
	render: ({ elementInstanceKey }) => ({
		kind: "success",
		message: `Variables set on element instance ${elementInstanceKey}`,
	}),
});
