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
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
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
		assert.throws(() => loadProfiles(), /corrupt/i);
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

	// A syntactically valid JSON file can still be schema-corrupt. Pre-fix,
	// `profilesFile.profiles || []` treated all of these as an empty store,
	// reopening the wipe path. They must be rejected like unparseable files.
	for (const malformed of [
		"{}",
		'{"profiles": null}',
		"[]",
		'{"profiles": [ { "baseUrl": "http://x" } ]}', // entry missing `name`
		'{"profiles": [ { "name": "merlin" } ]}', // entry missing `baseUrl`
		'{"profiles": "merlin"}',
		// Optional fields with the wrong runtime type are schema corruption too:
		// accepting them would feed bad auth/headers/URL data to the request layer.
		'{"profiles": [ { "name": "m", "baseUrl": "http://x", "clientId": 123 } ]}',
		'{"profiles": [ { "name": "m", "baseUrl": "http://x", "exactBaseUrl": "yes" } ]}',
		'{"profiles": [ { "name": "m", "baseUrl": "http://x", "headers": "nope" } ]}',
		'{"profiles": [ { "name": "m", "baseUrl": "http://x", "headers": { "k": 1 } } ]}',
	]) {
		test(`schema-corrupt profiles.json is rejected, not treated as empty: ${malformed}`, () => {
			writeFileSync(profilesPath(), malformed, "utf-8");
			assert.throws(() => loadProfiles(), /corrupt/i);
			// And seeding must NOT clobber it (the wipe regression).
			ensureDefaultProfile();
			assert.equal(readFileSync(profilesPath(), "utf-8"), malformed);
		});
	}

	test("an empty-but-valid profiles.json is zero profiles (not corrupt)", () => {
		writeFileSync(profilesPath(), '{ "profiles": [] }', "utf-8");
		assert.deepEqual(loadProfiles(), []);
	});

	test("a valid profile with well-typed optional fields loads (not over-rejected)", () => {
		writeFileSync(
			profilesPath(),
			JSON.stringify({
				profiles: [
					{
						name: "gw",
						baseUrl: "http://gw",
						clientId: "id",
						exactBaseUrl: true,
						headers: { "x-api-key": "secret" },
					},
				],
			}),
			"utf-8",
		);
		assert.deepEqual(loadProfiles(), [
			{
				name: "gw",
				baseUrl: "http://gw",
				clientId: "id",
				exactBaseUrl: true,
				headers: { "x-api-key": "secret" },
			},
		]);
	});

	test("a torn write with invalid UTF-8 bytes is backed up byte-for-byte", () => {
		// A crash mid-multibyte-sequence leaves bytes that are not valid UTF-8.
		// The backup must preserve the exact bytes on disk, not a lossily
		// re-encoded copy full of U+FFFD replacement characters.
		const rawBytes = Buffer.from([0x7b, 0x20, 0xff, 0xfe, 0x00, 0x80]);
		writeFileSync(profilesPath(), rawBytes);
		assert.throws(() => loadProfiles(), /corrupt/i);
		const backups = readdirSync(dataDir).filter((f) =>
			f.startsWith("profiles.json.corrupt-"),
		);
		assert.equal(backups.length, 1);
		assert.ok(
			readFileSync(join(dataDir, backups[0])).equals(rawBytes),
			"backup must be byte-identical to the torn file",
		);
	});

	test("repeated corrupt reads deduplicate backups (no unbounded copies)", () => {
		const corrupt = "{ this is not json";
		writeFileSync(profilesPath(), corrupt, "utf-8");
		for (let i = 0; i < 5; i++) {
			assert.throws(() => loadProfiles(), /corrupt/i);
		}
		const backups = readdirSync(dataDir).filter((f) =>
			f.startsWith("profiles.json.corrupt-"),
		);
		assert.equal(
			backups.length,
			1,
			"identical corrupt bytes must not spawn multiple backups",
		);
	});

	// POSIX-only: permission bits are not meaningfully enforced on Windows.
	if (platform() !== "win32") {
		test("saveProfiles preserves a restrictive 0600 mode (no credential widening)", () => {
			saveProfiles([MERLIN]);
			chmodSync(profilesPath(), 0o600);
			addProfile({
				name: "local",
				baseUrl: "http://localhost:8080/v2",
			});
			assert.equal(statSync(profilesPath()).mode & 0o777, 0o600);
		});

		test("a corrupt backup inherits the source file's restrictive mode", () => {
			const corrupt = "{ torn";
			writeFileSync(profilesPath(), corrupt, "utf-8");
			chmodSync(profilesPath(), 0o600);
			assert.throws(() => loadProfiles(), /corrupt/i);
			const backups = readdirSync(dataDir).filter((f) =>
				f.startsWith("profiles.json.corrupt-"),
			);
			assert.equal(backups.length, 1);
			assert.equal(
				statSync(join(dataDir, backups[0])).mode & 0o777,
				0o600,
				"backup holds credentials — it must not be world-readable",
			);
		});
	}
});
