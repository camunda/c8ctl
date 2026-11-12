/**
 * Read claims from a JWT payload. No signature check: the result only picks
 * an org id; the backends verify the token.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

export const ORG_CLAIM = "https://camunda.com/orgs";

export function decodeJwtPayload(token: string): Record<string, unknown> {
	const segment = token.split(".")[1];
	if (!segment) throw new Error("Malformed token");
	const payload: unknown = JSON.parse(
		Buffer.from(segment, "base64url").toString("utf8"),
	);
	if (!isRecord(payload)) throw new Error("Malformed token payload");
	return payload;
}

export function tokenOrgs(token: string): { id: string; roles: string[] }[] {
	const claim = decodeJwtPayload(token)[ORG_CLAIM];
	if (!Array.isArray(claim)) return [];
	return claim.flatMap((entry) =>
		isRecord(entry) && typeof entry.id === "string"
			? [
					{
						id: entry.id,
						roles: Array.isArray(entry.roles)
							? entry.roles.filter((r: unknown) => typeof r === "string")
							: [],
					},
				]
			: [],
	);
}

export function defaultOrgId(token: string): string | undefined {
	return tokenOrgs(token)[0]?.id;
}
