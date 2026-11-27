/**
 * Incident commands — CLI bindings of the incident services.
 */

import { defineServiceCommand } from "../framework/index.ts";
import {
	getIncident,
	getIncidentRequest,
	listIncidents,
	listIncidentsRequest,
	resolveIncident,
	resolveIncidentRequest,
} from "../services/index.ts";

/**
 * List incidents
 */
export const listIncidentsCommand = defineServiceCommand("list", "incident", {
	toInput: (flags, _args, scope) => ({
		state: flags.state,
		processInstanceKey: flags.processInstanceKey,
		between: scope.between,
		limit: scope.limit,
	}),
	dryRun: { command: "list incidents", request: listIncidentsRequest },
	service: listIncidents,
	render: ({ items }) => ({
		kind: "list",
		items: items.map((incident) => ({
			Key: incident.incidentKey,
			Type: incident.errorType,
			Message: incident.errorMessage?.substring(0, 50) || "",
			State: incident.state,
			Created: incident.creationTime || "-",
			"Process Instance": incident.processInstanceKey,
			"Tenant ID": incident.tenantId,
		})),
		emptyMessage: "No incidents found",
	}),
});

/**
 * Get incident by key
 */
export const getIncidentCommand = defineServiceCommand("get", "incident", {
	toInput: (_flags, args) => ({ incidentKey: args.key }),
	dryRun: { command: "get incident", request: getIncidentRequest },
	service: getIncident,
	render: (incident) => ({ kind: "get", data: incident }),
});

/**
 * Resolve incident
 */
export const resolveIncidentCommand = defineServiceCommand(
	"resolve",
	"incident",
	{
		toInput: (_flags, args) => ({ incidentKey: args.key }),
		dryRun: { command: "resolve incident", request: resolveIncidentRequest },
		service: resolveIncident,
		render: ({ incidentKey }) => ({
			kind: "success",
			message: `Incident ${incidentKey} resolved`,
		}),
	},
);
