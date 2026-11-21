/**
 * Authenticated GET against the SaaS backends (Accounts, Console, Hub).
 */

import { type FetchFn, NotLoggedInError } from "./auth.ts";
import { defaultOrgId, isRecord } from "./jwt.ts";
import type { Stage } from "./stages.ts";

export async function apiGet(
	url: string,
	token: string,
	stage: Stage,
	fetchFn: FetchFn = fetch,
): Promise<unknown> {
	const res = await fetchFn(url, {
		headers: { authorization: `Bearer ${token}`, accept: "application/json" },
		redirect: "manual",
		signal: AbortSignal.timeout(30_000),
	});
	if (res.status === 401) throw new NotLoggedInError(stage);
	if (!res.ok) {
		const body = (await res.text()).slice(0, 300);
		throw new Error(
			`GET ${new URL(url).pathname} failed: ${res.status} ${body}`,
		);
	}
	const body: unknown = await res.json();
	return isRecord(body) && "data" in body ? body.data : body;
}

export function resolveOrg(flagOrg: unknown, token: string): string {
	if (typeof flagOrg === "string" && flagOrg) return flagOrg;
	const org = defaultOrgId(token);
	if (!org)
		throw new Error(
			"no organisation on this account; create or join one in Console",
		);
	return org;
}
