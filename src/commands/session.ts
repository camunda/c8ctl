/**
 * Session management commands (use profile, use tenant, output mode)
 */

import { defineCommand } from "../command-framework.ts";
import {
	clearActiveProfile,
	getProfileOrModeler,
	setActiveProfile,
	setActiveTenant,
	setOutputMode,
} from "../config.ts";
import { getLogger, type Logger } from "../logger.ts";
import { c8ctl } from "../runtime.ts";

/**
 * Set active profile
 */
export function useProfile(name: string): void {
	const logger = getLogger();

	// Handle --none to clear profile
	if (name === "--none") {
		clearActiveProfile();
		logger.success("Session profile cleared");
		return;
	}

	// Verify profile exists (checks both c8ctl and Modeler profiles)
	const profile = getProfileOrModeler(name);
	if (!profile) {
		throw new Error(`Profile '${name}' not found`);
	}

	setActiveProfile(name);
	logger.success(`Now using profile: ${name}`);
}

/**
 * Set active tenant
 */
export function useTenant(tenantId: string): void {
	const logger = getLogger();
	setActiveTenant(tenantId);
	logger.success(`Now using tenant: ${tenantId}`);
}

/**
 * Set output mode
 */
export function setOutputFormat(mode: string): void {
	const logger = getLogger();

	if (mode !== "json" && mode !== "text") {
		throw new Error(`Invalid output mode: ${mode}. Must be 'json' or 'text'`);
	}

	setOutputMode(mode);

	// Update logger immediately
	logger.mode = mode;

	logger.success(`Output mode set to: ${mode}`);
}

/**
 * Show current session state
 */
export function showSessionState(): void {
	const logger = getLogger();

	logger.info("\nCurrent Session State:");
	logger.info(`  Active Profile: ${c8ctl.activeProfile || "(none)"}`);
	logger.info(`  Active Tenant: ${c8ctl.activeTenant || "(none)"}`);
	logger.info(`  Output Mode: ${c8ctl.outputMode}`);
	logger.info("");
}

// ─── defineCommand wrappers ──────────────────────────────────────────────────

/**
 * Display the current output mode. Shared by `output` (no args) and `which output`.
 */
function showOutputMode(logger: Logger): void {
	logger.info(`Current output mode: ${c8ctl.outputMode}`);
	// In text mode, add a blank line for readability before the available modes line.
	// JSON mode omits it because consumers parse the structured output, not visual spacing.
	if (c8ctl.outputMode === "text") {
		logger.info("");
	}
	logger.info("Available modes: json|text");
}

export const outputCommand = defineCommand("output", "", async (ctx) => {
	if (!ctx.resource) {
		showOutputMode(ctx.logger);
		return { kind: "none" };
	}
	setOutputFormat(ctx.resource);
	return { kind: "none" };
});

export const useProfileCommand = defineCommand(
	"use",
	"profile",
	async (_ctx, flags, args) => {
		if (flags.none) {
			useProfile("--none");
			return { kind: "none" };
		}
		if (!args.name) {
			throw new Error("Profile name required. Usage: c8 use profile <name>");
		}
		useProfile(args.name);
		return { kind: "none" };
	},
);

export const useTenantCommand = defineCommand(
	"use",
	"tenant",
	async (_ctx, _flags, args) => {
		useTenant(args.tenantId);
		return { kind: "none" };
	},
);

export const whichOutputCommand = defineCommand(
	"which",
	"output",
	async (ctx) => {
		showOutputMode(ctx.logger);
		return { kind: "none" };
	},
);
