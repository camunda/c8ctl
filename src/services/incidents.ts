/**
 * Incident services: list, get, resolve.
 */

import type { CamundaClient } from "@camunda8/orchestration-cluster-api";
import type { C8ctlContext, ClusterInput } from "../core/index.ts";
import {
	C8ctlError,
	callCluster,
	connect,
	fetchAllPages,
} from "../core/index.ts";
import { buildDateFilter, parseBetween } from "../utils/index.ts";

type Incident = Awaited<ReturnType<CamundaClient["getIncident"]>>;

export interface ListIncidentsInput {
	/** Incident state, e.g. `ACTIVE`. */
	state?: string;
	processInstanceKey?: string;
	/** Creation time range `<from>..<to>`, e.g. `7d` or `2024-01-01..`. */
	between?: string;
	/** Maximum number of incidents. Default: all. */
	limit?: number;
}

/** The search request `listIncidents` sends. */
export function listIncidentsRequest(
	input: ListIncidentsInput,
	tenantId: string | undefined,
) {
	const filter: Record<string, unknown> = { tenantId };
	if (input.state) filter.state = input.state;
	if (input.processInstanceKey) {
		filter.processInstanceKey = input.processInstanceKey;
	}
	if (input.between) {
		const parsed = parseBetween(input.between);
		if (!parsed) {
			throw new C8ctlError(
				"invalid-input",
				"Invalid --between value. Expected format: <from>..<to> (e.g. 2024-01-01..2024-12-31, ISO 8601 datetimes, or open-ended: ..2024-12-31 or 2024-01-01..)",
				{ field: "between" },
			);
		}
		filter.creationTime = buildDateFilter(parsed.from, parsed.to);
	}
	return {
		method: "POST",
		endpoint: "/incidents/search",
		body: { filter },
	};
}

export async function listIncidents(
	input: ListIncidentsInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: Incident[] }> {
	const { client, defaultTenantId } = connect(input.target, ctx);
	const { body } = listIncidentsRequest(
		input,
		input.tenantId ?? defaultTenantId,
	);
	const items = await callCluster(
		(signal) =>
			fetchAllPages(
				(filter, options) => client.searchIncidents(filter, options),
				body,
				undefined,
				input.limit,
				signal,
			),
		ctx,
	);
	return { items };
}

export interface IncidentKeyInput {
	incidentKey: string;
}

export function getIncidentRequest(input: IncidentKeyInput) {
	return { method: "GET", endpoint: `/incidents/${input.incidentKey}` };
}

export async function getIncident(
	input: IncidentKeyInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<Incident> {
	const { client } = connect(input.target, ctx);
	return callCluster(
		() =>
			client.getIncident(
				{ incidentKey: input.incidentKey },
				{ consistency: { waitUpToMs: 0 } },
			),
		ctx,
	);
}

export function resolveIncidentRequest(input: IncidentKeyInput) {
	return {
		method: "POST",
		endpoint: `/incidents/${input.incidentKey}/resolution`,
		body: {},
	};
}

export async function resolveIncident(
	input: IncidentKeyInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ incidentKey: string }> {
	const { client } = connect(input.target, ctx);
	await callCluster(
		() => client.resolveIncident({ incidentKey: input.incidentKey }),
		ctx,
	);
	return { incidentKey: input.incidentKey };
}
