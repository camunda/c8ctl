/**
 * Behavioural guards for Round 2a of the `process.exit` migration (issue #300,
 * follow-on to #288). Five files migrated, each with two `process.exit(1)`
 * sites in mechanical validation guards (required-flag checks for the four
 * `create` identity commands; non-negative integer check for `--timeToLive`
 * on the two message commands):
 *
 *   - `src/commands/identity-groups.ts`  — `--groupId`, `--name` required
 *   - `src/commands/identity-roles.ts`   — `--roleId`, `--name` required
 *   - `src/commands/identity-tenants.ts` — `--tenantId`, `--name` required
 *   - `src/commands/identity-users.ts`   — `--username`, `--password` required
 *   - `src/commands/messages.ts`         — `--timeToLive` non-negative
 *
 * After migration each path must `throw` so the framework's `handleCommandError`
 * pipeline owns process termination. The cross-handler architectural guard
 * (`tests/unit/no-process-exit-in-handlers.test.ts`) is the durable
 * class-of-defect catch — these behavioural tests prove each individual
 * migration is actually wired through the framework by asserting the
 * framework's `Failed to ${verb} ${resource}` prefix appears in stderr.
 *
 * One assertion per migrated file is sufficient: the architectural guard
 * already proves the OTHER throw site in each file is exit-free, and both
 * sites in each file route through the same handler wrapper, so one
 * end-to-end behavioural confirmation per file pins the wiring.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { c8 } from "../utils/cli.ts";

describe("identity-groups: behavioural — required-flag error flows through the framework", () => {
	test("create group without --groupId: framework prefix appears", async () => {
		const result = await c8("create", "group");

		assert.strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("--groupId is required"),
			`expected original error message in stderr. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("Failed to create group"),
			`expected framework prefix 'Failed to create group' in stderr, proving the error flowed through handleCommandError instead of process.exit(1). stderr:\n${result.stderr}`,
		);
	});
});

describe("identity-roles: behavioural — required-flag error flows through the framework", () => {
	test("create role without --roleId: framework prefix appears", async () => {
		const result = await c8("create", "role");

		assert.strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("--roleId is required"),
			`expected original error message in stderr. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("Failed to create role"),
			`expected framework prefix 'Failed to create role' in stderr, proving the error flowed through handleCommandError instead of process.exit(1). stderr:\n${result.stderr}`,
		);
	});
});

describe("identity-tenants: behavioural — required-flag error flows through the framework", () => {
	test("create tenant without --tenantId: framework prefix appears", async () => {
		const result = await c8("create", "tenant");

		assert.strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("--tenantId is required"),
			`expected original error message in stderr. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("Failed to create tenant"),
			`expected framework prefix 'Failed to create tenant' in stderr, proving the error flowed through handleCommandError instead of process.exit(1). stderr:\n${result.stderr}`,
		);
	});
});

describe("identity-users: behavioural — required-flag error flows through the framework", () => {
	test("create user without --username: framework prefix appears", async () => {
		const result = await c8("create", "user");

		assert.strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("--username is required"),
			`expected original error message in stderr. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("Failed to create user"),
			`expected framework prefix 'Failed to create user' in stderr, proving the error flowed through handleCommandError instead of process.exit(1). stderr:\n${result.stderr}`,
		);
	});
});

describe("messages: behavioural — invalid --timeToLive flows through the framework", () => {
	test("publish message with negative --timeToLive: framework prefix appears", async () => {
		const result = await c8(
			"publish",
			"message",
			"some-name",
			"--timeToLive=-5",
		);

		assert.strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("--timeToLive must be a non-negative integer"),
			`expected original error message in stderr. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("Failed to publish message"),
			`expected framework prefix 'Failed to publish message' in stderr, proving the error flowed through handleCommandError instead of process.exit(1). stderr:\n${result.stderr}`,
		);
	});

	test("correlate message with negative --timeToLive: framework prefix appears", async () => {
		const result = await c8(
			"correlate",
			"message",
			"some-name",
			"--timeToLive=-5",
		);

		assert.strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("--timeToLive must be a non-negative integer"),
			`expected original error message in stderr. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("Failed to correlate message"),
			`expected framework prefix 'Failed to correlate message' in stderr, proving the error flowed through handleCommandError instead of process.exit(1). stderr:\n${result.stderr}`,
		);
	});
});
