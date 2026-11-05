/**
 * Token store of the saas plugin: one JSON file per stage, plus a lock file
 * that serialises refreshes across c8ctl processes. Auth0 rotates refresh
 * tokens and revokes the whole family when an old one is reused, so two
 * processes must never refresh with the same refresh token.
 */

import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord } from "./jwt.ts";
import type { Stage } from "./stages.ts";

export interface StoredToken {
	access_token: string;
	refresh_token: string;
	/** Epoch seconds. */
	expires_at: number;
	sub: string;
	email?: string;
}

/** Refresh when fewer seconds than this are left. */
const REFRESH_MARGIN_SEC = 60;

export function tokenDir(userDataDir: string): string {
	return join(userDataDir, "saas");
}

const tokenFile = (dir: string, stage: Stage) => join(dir, `${stage}.json`);

export function readToken(dir: string, stage: Stage): StoredToken | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(tokenFile(dir, stage), "utf8"));
	} catch {
		return undefined;
	}
	if (
		!isRecord(raw) ||
		typeof raw.access_token !== "string" ||
		typeof raw.refresh_token !== "string" ||
		typeof raw.expires_at !== "number"
	)
		return undefined;
	return {
		access_token: raw.access_token,
		refresh_token: raw.refresh_token,
		expires_at: raw.expires_at,
		sub: typeof raw.sub === "string" ? raw.sub : "",
		...(typeof raw.email === "string" && { email: raw.email }),
	};
}

export function writeToken(
	dir: string,
	stage: Stage,
	token: StoredToken,
): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = tokenFile(dir, stage);
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(token), { mode: 0o600 });
	renameSync(tmp, file);
}

export function deleteToken(dir: string, stage: Stage): boolean {
	try {
		unlinkSync(tokenFile(dir, stage));
		return true;
	} catch {
		return false;
	}
}

export function needsRefresh(token: StoredToken, nowSec: number): boolean {
	return token.expires_at - nowSec < REFRESH_MARGIN_SEC;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withLock<T>(
	dir: string,
	stage: Stage,
	fn: () => Promise<T>,
	opts: { staleMs?: number; retryMs?: number; timeoutMs?: number } = {},
): Promise<T> {
	const { staleMs = 30_000, retryMs = 100, timeoutMs = 15_000 } = opts;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lock = join(dir, `${stage}.lock`);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			closeSync(openSync(lock, "wx", 0o600));
			break;
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") throw error;
		}
		// ponytail: mtime-based staleness; a holder slower than staleMs loses its lock
		try {
			if (Date.now() - statSync(lock).mtimeMs > staleMs) {
				rmSync(lock, { force: true });
				continue;
			}
		} catch {
			continue; // lock vanished between open and stat
		}
		if (Date.now() > deadline)
			throw new Error(`Timed out waiting for SaaS token lock ${lock}`);
		await sleep(retryMs);
	}
	try {
		return await fn();
	} finally {
		rmSync(lock, { force: true });
	}
}
