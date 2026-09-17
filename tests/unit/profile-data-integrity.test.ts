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
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
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

	test("the backup name is CONTENT-ADDRESSED (concurrent recoveries converge on one file)", () => {
		// The dedup key is the corrupt filename itself: it is a pure function of
		// the corrupt BYTES (their SHA-256). This is what bounds credential
		// copies across PROCESSES — N c8ctl children racing on the same corrupt
		// profiles.json all derive the same canonical name and the exclusive
		// (`wx`) create lets exactly one win, so they converge on a single
		// backup instead of each writing its own (a cross-process readdir scan
		// could not prevent that, since every child can scan-empty before any
		// writes). Pin the name so a future refactor can't silently drop the
		// content-addressing and reopen the race.
		const rawBytes = Buffer.from([0x7b, 0x20, 0xff, 0xfe, 0x00, 0x80]);
		writeFileSync(profilesPath(), rawBytes);
		assert.throws(() => loadProfiles(), /corrupt/i);
		const backups = readdirSync(dataDir).filter((f) =>
			f.startsWith("profiles.json.corrupt-"),
		);
		assert.equal(backups.length, 1);
		const expected = `profiles.json.corrupt-${createHash("sha256").update(rawBytes).digest("hex")}`;
		assert.equal(
			backups[0],
			expected,
			"backup name must be the SHA-256 of the corrupt bytes",
		);
		// Distinct corruption yields its OWN single canonical backup, never a
		// merge and never an unbounded fan-out.
		const otherBytes = Buffer.from([0x7b, 0x21]);
		writeFileSync(profilesPath(), otherBytes);
		assert.throws(() => loadProfiles(), /corrupt/i);
		const after = readdirSync(dataDir)
			.filter((f) => f.startsWith("profiles.json.corrupt-"))
			.sort();
		const expectedOther = `profiles.json.corrupt-${createHash("sha256").update(otherBytes).digest("hex")}`;
		assert.deepEqual([expected, expectedOther].sort(), after);
	});

	test("invalid UTF-8 INSIDE a quoted value is corruption, not a healthy profile", () => {
		// A torn write can leave invalid UTF-8 bytes inside a quoted string. A
		// lenient decode would replace them with U+FFFD, leaving syntactically
		// valid JSON that parses and schema-validates as a healthy profile — so a
		// later save would rewrite the file and lose the original bytes with NO
		// backup. Fatal decoding must route this through the corrupt path instead.
		const rawBytes = Buffer.concat([
			Buffer.from('{"profiles":[{"name":"m","baseUrl":"http://x'),
			Buffer.from([0xff, 0xfe]), // invalid UTF-8 inside the quoted value
			Buffer.from('"}]}'),
		]);
		writeFileSync(profilesPath(), rawBytes);
		assert.throws(() => loadProfiles(), /corrupt/i);
		const backups = readdirSync(dataDir).filter((f) =>
			f.startsWith("profiles.json.corrupt-"),
		);
		assert.equal(backups.length, 1);
		assert.ok(
			readFileSync(join(dataDir, backups[0])).equals(rawBytes),
			"backup must preserve the exact bytes, not a lossy re-encoding",
		);
		// And seeding must NOT clobber it (the wipe regression).
		ensureDefaultProfile();
		assert.ok(readFileSync(profilesPath()).equals(rawBytes));
	});

	test("an UNREADABLE (non-ENOENT) profiles.json throws and cannot be reseeded", () => {
		// `existsSync` cannot tell an absent file from an unstattable one, so
		// loadProfiles keys strictly on ENOENT: any OTHER read error must throw,
		// never return `[]`. Force a deterministic, CROSS-PLATFORM non-ENOENT
		// read error by making `profiles.json` a DIRECTORY — `readFileSync` then
		// fails with EISDIR on POSIX and Windows alike (the older "data dir is a
		// regular file → ENOTDIR" trick surfaced as ENOENT on Windows, wrongly
		// looking absent).
		mkdirSync(profilesPath());
		assert.throws(() => loadProfiles(), /Refusing to treat an unreadable/i);
		// Seeding loads first; on the unreadable path it must warn and leave the
		// path untouched, never reseed a default over it.
		ensureDefaultProfile();
		assert.ok(
			lstatSync(profilesPath()).isDirectory(),
			"the unreadable path must be left untouched, never reseeded over",
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

		test("reusing a stale world-readable backup re-tightens it to the source mode", () => {
			// A backup written by an older version (or before the source was
			// locked down) may be world-readable. Deduplication must not silently
			// keep reusing that leaky credential copy: the reuse path re-applies
			// the source mode.
			const corrupt = "{ torn";
			writeFileSync(profilesPath(), corrupt, "utf-8");
			chmodSync(profilesPath(), 0o600);
			assert.throws(() => loadProfiles(), /corrupt/i);
			const backups = readdirSync(dataDir).filter((f) =>
				f.startsWith("profiles.json.corrupt-"),
			);
			assert.equal(backups.length, 1);
			const backupPath = join(dataDir, backups[0]);
			// Simulate a stale, world-readable backup from an older run.
			chmodSync(backupPath, 0o644);
			// A second corrupt read hits the dedup/reuse path.
			assert.throws(() => loadProfiles(), /corrupt/i);
			assert.equal(
				readdirSync(dataDir).filter((f) =>
					f.startsWith("profiles.json.corrupt-"),
				).length,
				1,
				"identical bytes must reuse, not spawn a second backup",
			);
			assert.equal(
				statSync(backupPath).mode & 0o777,
				0o600,
				"the reused backup must be re-tightened, not left world-readable",
			);
		});

		test("a symlink squatting the canonical backup name is not followed on reuse", () => {
			// The content-addressed reuse path must NOT follow a symlink. If an
			// attacker pre-creates the canonical `profiles.json.corrupt-<sha256>`
			// name as a symlink pointing at a same-byte file elsewhere, a naive
			// readFileSync/chmod would report a "backup" without an independent
			// copy AND could chmod a target outside the profile store. The reuse
			// path opens with O_NOFOLLOW, so the symlink is rejected and the
			// recovered bytes are promoted to a fresh, real backup instead.
			const rawBytes = Buffer.from([0x7b, 0x20, 0xff, 0xfe]);
			const canonical = join(
				dataDir,
				`profiles.json.corrupt-${createHash("sha256").update(rawBytes).digest("hex")}`,
			);
			// A same-byte decoy OUTSIDE the profile store, left world-readable so
			// we can prove it is never chmod'd by the reuse path.
			const decoy = join(dataDir, "decoy-target");
			writeFileSync(decoy, rawBytes);
			chmodSync(decoy, 0o644);
			symlinkSync(decoy, canonical);

			writeFileSync(profilesPath(), rawBytes);
			chmodSync(profilesPath(), 0o600);
			assert.throws(() => loadProfiles(), /corrupt/i);

			// The canonical name is still the untouched symlink (never overwritten).
			assert.ok(
				lstatSync(canonical).isSymbolicLink(),
				"the pre-existing symlink must not be clobbered",
			);
			// The decoy target's mode is untouched — no chmod leaked through the link.
			assert.equal(
				statSync(decoy).mode & 0o777,
				0o644,
				"a symlinked reuse candidate must never be chmod'd",
			);
			// A real, independent regular-file backup was created instead.
			const realBackups = readdirSync(dataDir).filter(
				(f) =>
					f.startsWith("profiles.json.corrupt-") &&
					lstatSync(join(dataDir, f)).isFile(),
			);
			assert.equal(realBackups.length, 1);
			assert.ok(
				readFileSync(join(dataDir, realBackups[0])).equals(rawBytes),
				"the independent backup must hold the exact corrupt bytes",
			);
		});

		test("a HARD-LINK squatting the canonical backup name is not reused (no chmod leak)", () => {
			// O_NOFOLLOW blocks a symlink but NOT a pre-existing hard link. If an
			// attacker hard-links the canonical `profiles.json.corrupt-<sha256>`
			// name to a same-byte file OUTSIDE the store, fstat().isFile() and the
			// byte comparison both pass — a naive reuse would report a foreign
			// inode as our backup AND fchmod that outside inode. The reuse path
			// rejects any candidate with nlink !== 1 (a hard link to an
			// independently referenced inode), so the bytes are promoted to a
			// fresh, real backup instead.
			const rawBytes = Buffer.from([0x7b, 0x20, 0xff, 0xfe]);
			const canonical = join(
				dataDir,
				`profiles.json.corrupt-${createHash("sha256").update(rawBytes).digest("hex")}`,
			);
			// A same-byte file OUTSIDE the store, world-readable, hard-linked in as
			// the canonical name. Its extra link (outside + canonical) makes
			// nlink === 2, and we prove its mode is never touched by the reuse.
			const outside = join(dataDir, "outside-target");
			writeFileSync(outside, rawBytes);
			chmodSync(outside, 0o644);
			linkSync(outside, canonical);

			writeFileSync(profilesPath(), rawBytes);
			chmodSync(profilesPath(), 0o600);
			assert.throws(() => loadProfiles(), /corrupt/i);

			// The outside inode's mode is untouched — no fchmod leaked through the
			// hard link.
			assert.equal(
				statSync(outside).mode & 0o777,
				0o644,
				"a hard-linked reuse candidate must never be chmod'd",
			);
			// A real, independent (nlink === 1) backup was created instead — under
			// the bounded `.dup` fallback name, since the canonical name was
			// squatted.
			const realBackups = readdirSync(dataDir).filter(
				(f) =>
					f.startsWith("profiles.json.corrupt-") &&
					lstatSync(join(dataDir, f)).nlink === 1,
			);
			assert.equal(realBackups.length, 1);
			assert.ok(
				readFileSync(join(dataDir, realBackups[0])).equals(rawBytes),
				"the independent backup must hold the exact corrupt bytes",
			);
		});

		test("a DANGLING profiles.json symlink is not mistaken for an absent file", () => {
			// `readFileSync` on a broken symlink returns ENOENT — identical to a
			// genuinely missing file. Treating it as "no profiles" would let the
			// next save rename over the link and lose the user's intended target.
			// `loadProfiles` uses `lstatSync` to see the link ENTRY itself, so a
			// dangling link is routed to the protected throw path, not `[]`.
			const missingTarget = join(dataDir, "does-not-exist.json");
			symlinkSync(missingTarget, profilesPath());
			assert.throws(() => loadProfiles(), /exists but its contents/i);
			// Seeding must NOT clobber the dangling link (the wipe regression).
			ensureDefaultProfile();
			assert.ok(
				lstatSync(profilesPath()).isSymbolicLink(),
				"the dangling symlink must be left untouched, never reseeded over",
			);
		});

		test("saveProfiles is atomic — it replaces even a read-only target (rename, not truncate)", (t) => {
			// Root bypasses the 0400 read-only bit, so a direct
			// `writeFileSync(target)` implementation would ALSO succeed under
			// root and this test would falsely pass. Skip under root rather than
			// assert an invariant we cannot enforce there — on a normal
			// (non-root) runner the 0400 bit is honoured and the test truly
			// distinguishes the rename path from a direct truncating write.
			if (process.getuid?.() === 0) {
				t.skip("cannot enforce read-only target as root");
				return;
			}
			// A direct `writeFileSync(target)` would open the read-only target for
			// writing and fail with EACCES (leaving it stale); an atomic temp-file
			// + rename replaces it via the writable directory entry regardless. So
			// a successful replace here proves the rename path is actually used —
			// delete `renameSync` and this test fails.
			saveProfiles([MERLIN]);
			chmodSync(profilesPath(), 0o400);
			addProfile({ name: "local", baseUrl: "http://localhost:8080/v2" });
			const names = loadProfiles()
				.map((p) => p.name)
				.sort();
			assert.deepEqual(names, ["local", "merlin"]);
		});
	}
});
