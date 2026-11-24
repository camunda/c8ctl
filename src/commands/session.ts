/**
 * Session management commands (use profile, use tenant, output mode)
 */

import {
	c8ctl,
	clearActiveProfile,
	getAllProfiles,
	getLogger,
	getProfileOrModeler,
	MODELER_PREFIX,
	setActiveProfile,
	setActiveTenant,
	setOutputMode,
} from "../core/index.ts";
import { defineCommand, select } from "../framework/index.ts";

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
	const say = (message: string) => logger.info(message, { essential: true });

	say("\nCurrent Session State:");
	say(`  Active Profile: ${c8ctl.activeProfile || "(none)"}`);
	say(`  Active Tenant: ${c8ctl.activeTenant || "(none)"}`);
	say(`  Output Mode: ${c8ctl.outputMode}`);
	say("");
}

// ─── defineCommand wrappers ──────────────────────────────────────────────────

export const outputCommand = defineCommand("output", "", async (ctx) => {
	if (!ctx.resource) {
		const say = (message: string) =>
			ctx.logger.info(message, { essential: true });
		say(`Current output mode: ${c8ctl.outputMode}`);
		if (c8ctl.outputMode === "text") {
			say("");
		}
		say("Available modes: json|text");
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
			// No name provided — show interactive picker
			const profiles = getAllProfiles();
			if (profiles.length === 0) {
				throw new Error(
					"No profiles configured. Add one with: c8 add profile <name> --url <cluster-url>",
				);
			}

			const activeProfile = c8ctl.activeProfile;
			const defaultIndex = Math.max(
				0,
				profiles.findIndex((p) => p.name === activeProfile),
			);

			const result = await select({
				message: "Which profile do you want to use?",
				options: profiles.map((p) => ({
					label: p.name,
					description: `${p.baseUrl || "(no URL)"}${p.name.startsWith(MODELER_PREFIX) ? " (Modeler)" : ""}`,
					value: p.name,
				})),
				initialIndex: defaultIndex,
			});

			if (result.cancelled) {
				return { kind: "none" };
			}
			if (!result.interactive) {
				throw new Error("Profile name required. Usage: c8 use profile <name>");
			}
			useProfile(result.value);
			return { kind: "none" };
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

export const whichOutputCommand = defineCommand("which", "output", async () => {
	const logger = getLogger();
	logger.info(c8ctl.outputMode, { essential: true });
	return { kind: "none" };
});
