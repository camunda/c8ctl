/**
 * SaaS stages: Auth0 tenant and backend hosts per stage.
 * Values from ccmacli `src/registry.rs` (camunda-cloud-management-apps).
 */

export type Stage = "prod" | "int" | "dev";

export interface StageConfig {
	auth0Domain: string;
	audience: string;
	accounts: string;
	console: string;
	hub: string;
	/** Auth0 Native app client id. Empty until the customer apps exist. */
	clientId: string;
}

export const STAGES: Record<Stage, StageConfig> = {
	prod: {
		auth0Domain: "weblogin.cloud.camunda.io",
		audience: "cloud.camunda.io",
		accounts: "https://accounts.cloud.camunda.io",
		console: "https://console.cloud.camunda.io",
		hub: "https://hub.camunda.io",
		clientId: "",
	},
	int: {
		auth0Domain: "weblogin.cloud.ultrawombat.com",
		audience: "cloud.ultrawombat.com",
		accounts: "https://accounts.cloud.ultrawombat.com",
		console: "https://console.cloud.ultrawombat.com",
		hub: "https://hub.ultrawombat.com",
		clientId: "",
	},
	dev: {
		auth0Domain: "weblogin.cloud.dev.ultrawombat.com",
		audience: "cloud.dev.ultrawombat.com",
		accounts: "https://accounts.cloud.dev.ultrawombat.com",
		console: "https://console.cloud.dev.ultrawombat.com",
		hub: "https://hub.dev.ultrawombat.com",
		// Auth0 tenant camunda-excitingdev: "c8ctl (saas login prototype)"
		clientId: "MAYPSkgA88vsd4g4ymkoPy8l04LqoFIH",
	},
};

const STAGE_NAMES: Stage[] = ["prod", "int", "dev"];

function isStage(value: unknown): value is Stage {
	return STAGE_NAMES.some((name) => name === value);
}

export function parseStage(value: unknown): Stage {
	if (value === undefined) return "prod";
	if (isStage(value)) return value;
	throw new Error(
		`Unknown stage '${String(value)}'. Use one of: ${STAGE_NAMES.join(", ")}`,
	);
}

export function clientIdFor(
	stage: Stage,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const id = env.C8CTL_SAAS_CLIENT_ID || STAGES[stage].clientId;
	if (!id) {
		throw new Error(
			`No Auth0 client id for stage '${stage}'. Set C8CTL_SAAS_CLIENT_ID.`,
		);
	}
	return id;
}
