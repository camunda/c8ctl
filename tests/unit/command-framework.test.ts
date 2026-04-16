/**
 * Unit tests for src/command-framework.ts
 *
 * Tests the command definition framework:
 * - deserializeFlags: runtime deserialization of raw CLI values
 * - deserializePositionals: runtime deserialization of positional args
 * - InferFlags / InferPositionals: type-level inference (compile-time)
 * - ResolvedFlags / ResolvedPositionals: registry-derived type resolution
 * - defineCommand: registry-derived type inference
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import {
	ProcessDefinitionKey,
	ProcessInstanceKey,
} from "@camunda8/orchestration-cluster-api";
import {
	type CommandContext,
	type CommandResult,
	defineCommand,
	deserializeFlags,
	deserializePositionals,
	type InferFlags,
	type InferPositionals,
	type PositionalDef,
	type ResolvedFlags,
	type ResolvedPositionals,
} from "../../src/command-framework.ts";
import type { FlagDef } from "../../src/command-registry.ts";

// ─── Test flag schemas ───────────────────────────────────────────────────────

const STRING_FLAGS = {
	name: { type: "string", description: "A name" },
	email: { type: "string", description: "An email" },
} as const satisfies Record<string, FlagDef>;

const BOOLEAN_FLAGS = {
	verbose: { type: "boolean", description: "Verbose output" },
	force: { type: "boolean", description: "Force action" },
} as const satisfies Record<string, FlagDef>;

const VALIDATED_FLAGS = {
	processDefinitionKey: {
		type: "string",
		description: "PD key",
		validate: ProcessDefinitionKey.assumeExists,
	},
	processInstanceKey: {
		type: "string",
		description: "PI key",
		validate: ProcessInstanceKey.assumeExists,
	},
} as const satisfies Record<string, FlagDef>;

const MIXED_FLAGS = {
	name: { type: "string", description: "Name" },
	verbose: { type: "boolean", description: "Verbose" },
	processDefinitionKey: {
		type: "string",
		description: "PD key",
		validate: ProcessDefinitionKey.assumeExists,
	},
} as const satisfies Record<string, FlagDef>;

// ═══════════════════════════════════════════════════════════════════════════════
//  deserializeFlags — runtime behaviour
// ═══════════════════════════════════════════════════════════════════════════════

describe("deserializeFlags", () => {
	// ─── String flags ────────────────────────────────────────────────────────

	test("extracts string values", () => {
		const result = deserializeFlags(
			{ name: "Alice", email: "a@b.com" },
			STRING_FLAGS,
		);
		assert.strictEqual(result.name, "Alice");
		assert.strictEqual(result.email, "a@b.com");
	});

	test("undefined for missing string flags", () => {
		const result = deserializeFlags({}, STRING_FLAGS);
		assert.strictEqual(result.name, undefined);
		assert.strictEqual(result.email, undefined);
	});

	test("undefined for non-string values in string flags", () => {
		const result = deserializeFlags({ name: 42, email: true }, STRING_FLAGS);
		assert.strictEqual(result.name, undefined);
		assert.strictEqual(result.email, undefined);
	});

	// ─── Boolean flags ───────────────────────────────────────────────────────

	test("extracts boolean values", () => {
		const result = deserializeFlags(
			{ verbose: true, force: false },
			BOOLEAN_FLAGS,
		);
		assert.strictEqual(result.verbose, true);
		// false is treated as "not set" (same as CLI convention)
		assert.strictEqual(result.force, undefined);
	});

	test("undefined for missing boolean flags", () => {
		const result = deserializeFlags({}, BOOLEAN_FLAGS);
		assert.strictEqual(result.verbose, undefined);
		assert.strictEqual(result.force, undefined);
	});

	// ─── Validated flags ─────────────────────────────────────────────────────

	test("calls validator for string values", () => {
		const result = deserializeFlags(
			{ processDefinitionKey: "12345", processInstanceKey: "67890" },
			VALIDATED_FLAGS,
		);
		assert.strictEqual(result.processDefinitionKey, "12345");
		assert.strictEqual(result.processInstanceKey, "67890");
	});

	test("undefined for missing validated flags", () => {
		const result = deserializeFlags({}, VALIDATED_FLAGS);
		assert.strictEqual(result.processDefinitionKey, undefined);
		assert.strictEqual(result.processInstanceKey, undefined);
	});

	test("skips validator for empty string", () => {
		const result = deserializeFlags(
			{ processDefinitionKey: "" },
			VALIDATED_FLAGS,
		);
		assert.strictEqual(result.processDefinitionKey, undefined);
	});

	test("skips validator for undefined", () => {
		const result = deserializeFlags(
			{ processDefinitionKey: undefined },
			VALIDATED_FLAGS,
		);
		assert.strictEqual(result.processDefinitionKey, undefined);
	});

	// ─── Mixed flags ─────────────────────────────────────────────────────────

	test("handles mixed flag types in one schema", () => {
		const result = deserializeFlags(
			{ name: "Alice", verbose: true, processDefinitionKey: "999" },
			MIXED_FLAGS,
		);
		assert.strictEqual(result.name, "Alice");
		assert.strictEqual(result.verbose, true);
		assert.strictEqual(result.processDefinitionKey, "999");
	});

	test("ignores values not in schema", () => {
		const result = deserializeFlags(
			{ name: "Alice", bogus: "ignored" },
			STRING_FLAGS,
		);
		assert.strictEqual(result.name, "Alice");
		// bogus is not in the result because it's not in the schema
		assert.ok(!Object.hasOwn(result, "bogus"));
	});

	test("only includes keys from schema", () => {
		const result = deserializeFlags(
			{ name: "Alice", extra1: "x", extra2: "y" },
			STRING_FLAGS,
		);
		const keys = Object.keys(result);
		assert.deepStrictEqual(keys.sort(), ["email", "name"]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  InferFlags — compile-time type verification
// ═══════════════════════════════════════════════════════════════════════════════

describe("InferFlags — type inference (compile-time)", () => {
	test("string flags infer to string | undefined", () => {
		// This test verifies at compile time that the types are correct.
		// If InferFlags is wrong, this file won't compile.
		type Result = InferFlags<typeof STRING_FLAGS>;
		const _check: Result = { name: "Alice", email: undefined };
		assert.ok(true, "compiles");
	});

	test("boolean flags infer to boolean | undefined", () => {
		type Result = InferFlags<typeof BOOLEAN_FLAGS>;
		const _check: Result = { verbose: true, force: undefined };
		assert.ok(true, "compiles");
	});

	test("validated flags infer to branded type | undefined", () => {
		type Result = InferFlags<typeof VALIDATED_FLAGS>;
		// ProcessDefinitionKey.assumeExists returns ProcessDefinitionKey
		const pdKey = ProcessDefinitionKey.assumeExists("123");
		const piKey = ProcessInstanceKey.assumeExists("456");
		const _check: Result = {
			processDefinitionKey: pdKey,
			processInstanceKey: piKey,
		};
		assert.ok(true, "compiles");
	});

	test("mixed flags preserve distinct types per key", () => {
		type Result = InferFlags<typeof MIXED_FLAGS>;
		const pdKey = ProcessDefinitionKey.assumeExists("999");
		const _check: Result = {
			name: "Alice",
			verbose: true,
			processDefinitionKey: pdKey,
		};
		assert.ok(true, "compiles");
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  defineCommand — registry-derived type inference
// ═══════════════════════════════════════════════════════════════════════════════

describe("defineCommand", () => {
	test("returns verb and resource", () => {
		const cmd = defineCommand(
			"get",
			"process-definition",
			async () => ({ kind: "get", data: {} }) satisfies CommandResult,
		);
		assert.strictEqual(cmd.verb, "get");
		assert.strictEqual(cmd.resource, "process-definition");
	});

	test("handler receives typed flags from registry (compile-time)", () => {
		// get pd has resourceFlags including xml (boolean)
		defineCommand("get", "process-definition", async (_ctx, flags) => {
			const _xml: boolean | undefined = flags.xml;
			void _xml;
			return { kind: "get", data: {} } satisfies CommandResult;
		});
		assert.ok(true, "compiles — flags.xml is boolean | undefined");
	});

	test("handler receives typed positionals from registry (compile-time)", () => {
		// get pd has resourcePositionals with key (required, ProcessDefinitionKey)
		defineCommand("get", "process-definition", async (_ctx, _flags, args) => {
			const _key: ReturnType<typeof ProcessDefinitionKey.assumeExists> =
				args.key;
			void _key;
			return { kind: "get", data: {} } satisfies CommandResult;
		});
		assert.ok(true, "compiles — args.key is ProcessDefinitionKey");
	});

	test("verb without resourceFlags gets verb-level flags (compile-time)", () => {
		// delete has no resourceFlags — uses verb-level flags (empty object)
		defineCommand("delete", "user", async (_ctx, flags) => {
			// flags should be an empty record — no keys
			void flags;
			return { kind: "get", data: {} } satisfies CommandResult;
		});
		assert.ok(true, "compiles — verb-level flags used as fallback");
	});

	test("verb without resourcePositionals gets empty args (compile-time)", () => {
		// search has no resourcePositionals
		defineCommand("search", "process-instance", async (_ctx, _flags, args) => {
			// args should be Record<string, never> — empty
			void args;
			return { kind: "get", data: {} } satisfies CommandResult;
		});
		assert.ok(true, "compiles — no positionals");
	});

	test("execute deserializes and calls handler", async () => {
		let receivedKey: unknown;
		let receivedXml: unknown;

		const cmd = defineCommand(
			"get",
			"process-definition",
			async (_ctx, flags, args) => {
				receivedXml = flags.xml;
				receivedKey = args.key;
				return { kind: "get", data: {} } satisfies CommandResult;
			},
		);

		// Simulate dispatch. The handler under test does not touch ctx.client, and
		// it does not log directly, but cmd.execute() may still use ctx.logger
		// when rendering a non-undefined CommandResult. The two casts below are
		// the unavoidable boundary where we stub external SDK and internal class
		// types that cannot be satisfied structurally.
		const mockLogger: CommandContext["logger"] =
			// biome-ignore lint/plugin: test-only stub for Logger class; structural satisfaction impractical
			{
				json: () => {},
				table: () => {},
				output: () => {},
				info: () => {},
			} as unknown as CommandContext["logger"];
		// biome-ignore lint/plugin: test-only stub for CamundaClient class; structural satisfaction impractical
		const mockClient = {} as CommandContext["client"];
		const mockCtx: CommandContext = {
			client: mockClient,
			logger: mockLogger,
			tenantId: undefined,
			resource: "process-definition",
			positionals: ["12345"],
			sortOrder: "asc",
			sortBy: undefined,
			limit: undefined,
			all: undefined,
			between: undefined,
			dateField: undefined,
			dryRun: undefined,
			profile: undefined,
		};

		await cmd.execute(mockCtx, { xml: true }, ["12345"]);
		assert.strictEqual(receivedXml, true);
		assert.strictEqual(receivedKey, "12345");
	});

	test("handler receives CommandContext", () => {
		defineCommand("get", "process-definition", async (ctx) => {
			const _logger = ctx.logger;
			const _resource: string = ctx.resource;
			const _positionals: string[] = ctx.positionals;
			void _logger;
			void _resource;
			void _positionals;
			return { kind: "get", data: {} } satisfies CommandResult;
		});
		assert.ok(true, "compiles with CommandContext");
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ResolvedFlags / ResolvedPositionals — compile-time type resolution
// ═══════════════════════════════════════════════════════════════════════════════

describe("ResolvedFlags / ResolvedPositionals (compile-time)", () => {
	test("ResolvedFlags for get pd is resource-scoped", () => {
		type Flags = ResolvedFlags<"get", "process-definition">;
		// Should have xml (from GET_PD_FLAGS), not userTask (from GET_FORM_FLAGS)
		const _check: InferFlags<Flags> = { xml: true };
		assert.ok(true, "compiles — scoped to pd flags");
	});

	test("ResolvedFlags for get form is resource-scoped", () => {
		type Flags = ResolvedFlags<"get", "form">;
		// Should have userTask and processDefinition (plus ut/pd aliases) from GET_FORM_FLAGS
		const _check: InferFlags<Flags> = {
			userTask: true,
			ut: undefined,
			processDefinition: undefined,
			pd: undefined,
		};
		assert.ok(true, "compiles — scoped to form flags");
	});

	test("ResolvedFlags for verb without resourceFlags falls back to verb-level", () => {
		type Flags = ResolvedFlags<"delete", "user">;
		// delete has flags: {} — so InferFlags should be empty record
		const _check: InferFlags<Flags> = {};
		assert.ok(true, "compiles — falls back to verb-level flags");
	});

	test("ResolvedPositionals for get pd has key", () => {
		type Pos = ResolvedPositionals<"get", "process-definition">;
		type Args = InferPositionals<Pos>;
		const pdKey = ProcessDefinitionKey.assumeExists("123");
		const _check: Args = { key: pdKey };
		assert.ok(true, "compiles — key is ProcessDefinitionKey");
	});

	test("ResolvedPositionals for verb without resourcePositionals is empty", () => {
		type Pos = ResolvedPositionals<"search", "process-instance">;
		type Args = InferPositionals<Pos>;
		const _check: Args = {};
		void _check;
		assert.ok(true, "compiles — empty positionals");
	});
});
