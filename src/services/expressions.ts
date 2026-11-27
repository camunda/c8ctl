/**
 * FEEL expression evaluation on the cluster.
 *
 * The `feel` plugin's `evaluate` command calls this for its cluster engine;
 * its local engine (feelin) stays in the plugin.
 */

import type { C8ctlContext, ClusterInput } from "../core/index.ts";
import {
	C8ctlError,
	callCluster,
	connect,
	isC8ctlError,
} from "../core/index.ts";

export interface EvaluateExpressionInput {
	/** A FEEL expression. The leading `=` is optional. */
	expression: string;
	/** The variables the expression reads. */
	variables?: Record<string, unknown>;
}

export interface EvaluationResult {
	/** The expression as given. */
	expression: string;
	result: unknown;
	warnings: { message: string }[];
}

/**
 * Camunda treats an expression without a leading `=` as a static string,
 * so add it when the caller left it out.
 */
export function normalizeExpression(expression: string): string {
	const trimmed = expression.trimStart();
	return trimmed.startsWith("=") ? trimmed : `= ${trimmed}`;
}

/** The request `evaluateExpression` sends. */
export function evaluateExpressionRequest(
	input: EvaluateExpressionInput,
	tenantId: string | undefined,
) {
	return {
		method: "POST",
		endpoint: "/expression/evaluation",
		body: {
			expression: normalizeExpression(input.expression),
			...(input.variables !== undefined ? { variables: input.variables } : {}),
			...(tenantId ? { tenantId } : {}),
		},
	};
}

/**
 * Evaluate a FEEL expression on the cluster (Camunda 8.9+).
 *
 * @throws {C8ctlError} `invalid-input` for `expression` when the cluster
 *   rejects it (with the cluster's `problem`); `not-found` when the cluster
 *   has no evaluation endpoint; the codes of `callCluster` otherwise.
 */
export async function evaluateExpression(
	input: EvaluateExpressionInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<EvaluationResult> {
	const { client, defaultTenantId } = connect(input.target, ctx);
	const { body } = evaluateExpressionRequest(
		input,
		input.tenantId ?? defaultTenantId,
	);
	try {
		const response = await callCluster(
			() => client.evaluateExpression(body),
			ctx,
		);
		return {
			expression: input.expression,
			result: response.result ?? null,
			warnings: response.warnings.map(({ message }) => ({ message })),
		};
	} catch (error) {
		if (isC8ctlError(error) && error.problem?.status === 400) {
			throw new C8ctlError("invalid-input", error.message, {
				field: "expression",
				cause: error.cause,
				problem: error.problem,
			});
		}
		throw error;
	}
}
