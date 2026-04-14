/**
 * Incident commands
 */

import { fetchAllPages } from "../client.ts";
import { defineCommand, dryRun } from "../command-framework.ts";
import { buildDateFilter, parseBetween } from "../date-filter.ts";

/**
 * List incidents
 */
export const listIncidentsCommand = defineCommand(
	"list",
	"incident",
	async (ctx, flags) => {
		const { client, logger, tenantId, profile, limit, between } = ctx;

		const filter: { filter: Record<string, unknown> } = {
			filter: {
				tenantId,
			},
		};

		if (flags.state) {
			filter.filter.state = flags.state;
		}

		if (flags.processInstanceKey) {
			filter.filter.processInstanceKey = flags.processInstanceKey;
		}

		if (between) {
			const parsed = parseBetween(between);
			if (parsed) {
				filter.filter.creationTime = buildDateFilter(parsed.from, parsed.to);
			} else {
				logger.error(
					"Invalid --between value. Expected format: <from>..<to> (e.g. 2024-01-01..2024-12-31, ISO 8601 datetimes, or open-ended: ..2024-12-31 or 2024-01-01..)",
				);
				process.exit(1);
			}
		}

		const dr = dryRun({
			command: "list incidents",
			method: "POST",
			endpoint: "/incidents/search",
			profile,
			body: filter,
		});
		if (dr) return dr;

		const allItems = await fetchAllPages(
			(f, opts) => client.searchIncidents(f, opts),
			filter,
			undefined,
			limit,
		);

		return {
			kind: "list",
			items: allItems.map((incident) => ({
				Key: incident.incidentKey,
				Type: incident.errorType,
				Message: incident.errorMessage?.substring(0, 50) || "",
				State: incident.state,
				Created: incident.creationTime || "-",
				"Process Instance": incident.processInstanceKey,
				"Tenant ID": incident.tenantId,
			})),
			emptyMessage: "No incidents found",
		};
	},
);

/**
 * Get incident by key
 */
export const getIncidentCommand = defineCommand(
	"get",
	"incident",
	async (ctx, _flags, args) => {
		const { client, profile } = ctx;
		const key = args.key;

		const dr = dryRun({
			command: "get incident",
			method: "GET",
			endpoint: `/incidents/${key}`,
			profile,
		});
		if (dr) return dr;

		const result = await client.getIncident(
			{ incidentKey: key },
			{ consistency: { waitUpToMs: 0 } },
		);
		return { kind: "get", data: result };
	},
);

/**
 * Resolve incident
 */
export const resolveIncidentCommand = defineCommand(
	"resolve",
	"incident",
	async (ctx, _flags, args) => {
		const { client, profile } = ctx;
		const key = args.key;

		const dr = dryRun({
			command: "resolve incident",
			method: "POST",
			endpoint: `/incidents/${key}/resolution`,
			profile,
			body: {},
		});
		if (dr) return dr;

		await client.resolveIncident({ incidentKey: key });
		return { kind: "success", message: `Incident ${key} resolved` };
	},
);
