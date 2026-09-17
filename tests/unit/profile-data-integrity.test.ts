/**
 * Regression tests for the silent profile-wipe defect.
 *
 * Root cause (pre-fix): `loadProfiles()` returned `[]` on ANY read/parse error,
 * so a corrupt/torn `profiles.json` looked identical to "no profiles". Because
 * `ensureDefaultProfile()` runs on virtually every command and reseeds the
 * `local` default via `addProfile()` (load → append → save), a single corrupt
 * read caused the next command to overwrite the file with ONLY `local`,
 * permanently destroying every real profile (e.g. `merlin`) with no backup. The
 * non-atomic `saveProfiles` write was the corruption SOURCE (a reader could
 * observe a half-written file).
 *
 * These tests pin the fix: corruption is never mistaken for emptiness, seeding
 * never overwrites an unreadable file, writes are atomic, and the absent-file
 * "empty" behaviour is preserved.
 */

import assert from "node:assert";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	addProfile,
	ensureDefaultProfile,
	loadProfiles,
	type Profile,
	saveProfiles,
} from "../../src/core/config.ts";

let dataDir: string;
let previousDataDir: string | undefined;
const profilesPath = () => join(dataDir, "profiles.json");

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "c8ctl-profiles-"));
	previousDataDir = process.env.C8CTL_DATA_DIR;
	process.env.C8CTL_DATA_DIR = dataDir;
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.C8CTL_DATA_DIR;
	else process.env.C8CTL_DATA_DIR = previousDataDir;
	rmSync(dataDir, { recursive: true, force: true });
});

const MERLIN: Profile = {
	name: "merlin",
	baseUrl: "http://merlin.local:8080/v2",
	username: "demo",
	password: "demo",
};

describe("profile data integrity", () => {
	test("a corrupt profiles.json throws (never silently reports zero profiles)", () => {
		writeFileSync(profilesPath(), "{ this is not json", "utf-8");
		assert.throws(() => loadProfiles(), /corrupt/i);
	});

	test("a corrupt read preserves the original bytes in a backup", () => {
		const original = '{ "profiles": [ TORN';
		writeFileSync(profilesPath(), original, "utf-8");
		try {
			loadProfiles();
			assert.fail("expected loadProfiles to throw on a corrupt file");
		} catch {
			/* expected */
		}
		const backups = readdirSync(dataDir).filter((f) =>
			f.startsWith("profiles.json.corrupt-"),
		);
		assert.equal(backups.length, 1, "exactly one backup should be written");
		assert.equal(readFileSync(join(dataDir, backups[0]), "utf-8"), original);
	});

	test("ensureDefaultProfile does NOT overwrite a corrupt file (the wipe regression)", () => {
		// A real user's profiles.json with `merlin`, then corrupted (torn write).
		const corrupt = '{ "profiles": [ {"name":"merlin", TORN';
		writeFileSync(profilesPath(), corrupt, "utf-8");

		// Pre-fix, this reseeded `local` and clobbered the file, destroying merlin.
		ensureDefaultProfile();

		// The corrupt file must be left byte-for-byte intact (recoverable), NOT
		// rewritten to `{ profiles: [local] }`.
		assert.equal(readFileSync(profilesPath(), "utf-8"), corrupt);
	});

	test("adding a profile preserves existing profiles (no wipe on a healthy file)", () => {
		saveProfiles([MERLIN]);
		addProfile({
			name: "local",
			baseUrl: "http://localhost:8080/v2",
			username: "demo",
			password: "demo",
		});
		const names = loadProfiles()
			.map((p) => p.name)
			.sort();
		assert.deepEqual(names, ["local", "merlin"]);
	});

	test("saveProfiles is atomic — no leftover temp files remain", () => {
		saveProfiles([MERLIN]);
		const leftovers = readdirSync(dataDir).filter((f) => f.endsWith(".tmp"));
		assert.equal(leftovers.length, 0, "no .tmp files should be left behind");
		assert.deepEqual(
			loadProfiles().map((p) => p.name),
			["merlin"],
		);
	});

	test("an ABSENT profiles.json legitimately means zero profiles", () => {
		assert.ok(!existsSync(profilesPath()));
		assert.deepEqual(loadProfiles(), []);
	});
});
