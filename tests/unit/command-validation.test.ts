/**
 * Unit tests for src/command-validation.ts
 *
 * Tests the validation utilities directly to catch regressions in
 * the shared boundary-validation layer that all commands depend on.
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	detectUnknownFlags,
	requireCsvEnum,
	requireEnum,
	requireOneOf,
	requireOption,
	requirePositional,
} from "../../src/command-validation.ts";
import { mockProcessExit } from "../utils/mocks.ts";

// A minimal enum-like object matching the SDK pattern
const ColorEnum = { RED: "RED", GREEN: "GREEN", BLUE: "BLUE" } as const;

let errorSpy: string[];
let originalError: typeof console.error;
let restoreExit: () => void;

function setup() {
	errorSpy = [];
	originalError = console.error;
	console.error = (...args: unknown[]) => errorSpy.push(args.join(" "));
	restoreExit = mockProcessExit((code) => {
		throw new Error(`process.exit(${code})`);
	});
}

function teardown() {
	console.error = originalError;
	restoreExit();
}

// ─── requireOption ───────────────────────────────────────────────────────────

describe("requireOption", () => {
	beforeEach(setup);
	afterEach(teardown);

	test("returns the value when present", () => {
		assert.strictEqual(requireOption("hello", "name"), "hello");
	});

	test("exits when value is undefined", () => {
		assert.throws(() => requireOption(undefined, "name"), /process\.exit\(1\)/);
		assert.ok(errorSpy.some((l) => l.includes("--name is required")));
	});

	test("exits when value is empty string", () => {
		assert.throws(() => requireOption("", "name"), /process\.exit\(1\)/);
		assert.ok(errorSpy.some((l) => l.includes("--name is required")));
	});
});

// ─── requireEnum ─────────────────────────────────────────────────────────────

describe("requireEnum", () => {
	beforeEach(setup);
	afterEach(teardown);

	test("returns the matched value for a valid enum member", () => {
		const result = requireEnum("RED", ColorEnum, "color");
		assert.strictEqual(result, "RED");
	});

	test("returns correctly typed value for each member", () => {
		assert.strictEqual(requireEnum("GREEN", ColorEnum, "color"), "GREEN");
		assert.strictEqual(requireEnum("BLUE", ColorEnum, "color"), "BLUE");
	});

	test("exits on invalid value with error listing valid values", () => {
		assert.throws(
			() => requireEnum("PURPLE", ColorEnum, "color"),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes('Invalid --color "PURPLE"')));
		assert.ok(errorSpy.some((l) => l.includes("RED")));
		assert.ok(errorSpy.some((l) => l.includes("GREEN")));
		assert.ok(errorSpy.some((l) => l.includes("BLUE")));
	});

	test("is case-sensitive", () => {
		assert.throws(
			() => requireEnum("red", ColorEnum, "color"),
			/process\.exit\(1\)/,
		);
	});
});

// ─── requireCsvEnum ──────────────────────────────────────────────────────────

describe("requireCsvEnum", () => {
	beforeEach(setup);
	afterEach(teardown);

	test("returns array of matched values for valid CSV", () => {
		const result = requireCsvEnum("RED,GREEN", ColorEnum, "colors");
		assert.deepStrictEqual(result, ["RED", "GREEN"]);
	});

	test("handles single value (no commas)", () => {
		const result = requireCsvEnum("BLUE", ColorEnum, "colors");
		assert.deepStrictEqual(result, ["BLUE"]);
	});

	test("trims whitespace around values", () => {
		const result = requireCsvEnum("RED , GREEN , BLUE", ColorEnum, "colors");
		assert.deepStrictEqual(result, ["RED", "GREEN", "BLUE"]);
	});

	test("filters empty strings from trailing commas", () => {
		const result = requireCsvEnum("RED,GREEN,", ColorEnum, "colors");
		assert.deepStrictEqual(result, ["RED", "GREEN"]);
	});

	test("filters empty strings from leading commas", () => {
		const result = requireCsvEnum(",RED,GREEN", ColorEnum, "colors");
		assert.deepStrictEqual(result, ["RED", "GREEN"]);
	});

	test("filters whitespace-only items", () => {
		const result = requireCsvEnum("RED, ,GREEN", ColorEnum, "colors");
		assert.deepStrictEqual(result, ["RED", "GREEN"]);
	});

	test("exits when input is only commas and whitespace", () => {
		assert.throws(
			() => requireCsvEnum(" , , ", ColorEnum, "colors"),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes("--colors is required")));
	});

	test("exits on invalid value listing all invalid items", () => {
		assert.throws(
			() => requireCsvEnum("RED,PURPLE,YELLOW", ColorEnum, "colors"),
			/process\.exit\(1\)/,
		);
		assert.ok(
			errorSpy.some((l) => l.includes("Invalid --colors: PURPLE, YELLOW")),
		);
		assert.ok(errorSpy.some((l) => l.includes("Valid values:")));
	});

	test("exits when all values are invalid", () => {
		assert.throws(
			() => requireCsvEnum("PURPLE,YELLOW", ColorEnum, "colors"),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes("PURPLE")));
		assert.ok(errorSpy.some((l) => l.includes("YELLOW")));
	});
});

// ─── requirePositional ──────────────────────────────────────────────────────

describe("requirePositional", () => {
	beforeEach(setup);
	afterEach(teardown);

	test("returns the value when present", () => {
		assert.strictEqual(requirePositional("operate", "Application"), "operate");
	});

	test("exits when value is undefined", () => {
		assert.throws(
			() => requirePositional(undefined, "Application"),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes("Application is required")));
	});

	test("exits when value is empty string", () => {
		assert.throws(
			() => requirePositional("", "Application"),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes("Application is required")));
	});

	test("prints hint when provided", () => {
		const logSpy: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			logSpy.push(args.join(" "));
		};
		try {
			requirePositional(undefined, "Application", "Usage: c8 open <app>");
		} catch {
			/* expected */
		}
		console.log = origLog;
		assert.ok(logSpy.some((l) => l.includes("Usage: c8 open <app>")));
	});
});

// ─── requireOneOf ────────────────────────────────────────────────────────────

const FRUITS = ["apple", "banana", "cherry"] as const;

describe("requireOneOf", () => {
	beforeEach(setup);
	afterEach(teardown);

	test("returns matched value for a valid item", () => {
		assert.strictEqual(requireOneOf("apple", FRUITS, "fruit"), "apple");
		assert.strictEqual(requireOneOf("banana", FRUITS, "fruit"), "banana");
		assert.strictEqual(requireOneOf("cherry", FRUITS, "fruit"), "cherry");
	});

	test("exits on invalid value listing valid options", () => {
		assert.throws(
			() => requireOneOf("mango", FRUITS, "fruit"),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes("Unknown fruit 'mango'")));
		assert.ok(errorSpy.some((l) => l.includes("apple")));
		assert.ok(errorSpy.some((l) => l.includes("banana")));
		assert.ok(errorSpy.some((l) => l.includes("cherry")));
	});

	test("is case-sensitive", () => {
		assert.throws(
			() => requireOneOf("Apple", FRUITS, "fruit"),
			/process\.exit\(1\)/,
		);
	});

	test("prints hint when provided", () => {
		const logSpy: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			logSpy.push(args.join(" "));
		};
		try {
			requireOneOf("mango", FRUITS, "fruit", "Usage: pick a fruit");
		} catch {
			/* expected */
		}
		console.log = origLog;
		assert.ok(logSpy.some((l) => l.includes("Usage: pick a fruit")));
	});
});

// ─── validateFlags ───────────────────────────────────────────────────────────

import type { CommandDef } from "../../src/command-registry.ts";
import { COMMAND_REGISTRY, GLOBAL_FLAGS } from "../../src/command-registry.ts";
import { validateFlags } from "../../src/command-validation.ts";

/** Widened read-only view of COMMAND_REGISTRY for iterating with index signatures. */
const REGISTRY: Readonly<Record<string, CommandDef>> = COMMAND_REGISTRY;

/**
 * Flag names that are known to map to branded SDK types.
 * Context-dependent: 'username' only maps to the branded Username type
 * in verbs that operate on 'users' resources (not in profile management
 * where it means a basic auth credential).
 */
const BRANDED_FLAG_NAMES = new Set([
	"processDefinitionKey",
	"processInstanceKey",
	"processDefinitionId",
	"parentProcessInstanceKey",
	"tenantId",
	"username",
]);

/** Flags whose branded semantics only apply to certain resource contexts. */
const CONTEXT_DEPENDENT_FLAGS: Record<string, string[]> = {
	username: ["user"],
	tenantId: ["tenant"],
};

function isBrandedInContext(
	flagName: string,
	def: { resources?: string[] },
): boolean {
	const requiredResources = CONTEXT_DEPENDENT_FLAGS[flagName];
	if (!requiredResources) return true; // unconditionally branded
	return requiredResources.some((r) => def.resources?.includes(r));
}

describe("validateFlags structural invariants", () => {
	test("every branded-type flag in the registry has a validate function", () => {
		const missing: string[] = [];

		for (const [verb, def] of Object.entries(REGISTRY)) {
			for (const [flagName, flagDef] of Object.entries(def.flags)) {
				if (
					BRANDED_FLAG_NAMES.has(flagName) &&
					isBrandedInContext(flagName, def) &&
					!flagDef.validate
				) {
					missing.push(`${verb}.flags.${flagName}`);
				}
			}
		}

		assert.strictEqual(
			missing.length,
			0,
			`Flags that map to branded SDK types must have a validate function:\n  ${missing.join("\n  ")}`,
		);
	});

	test("validate functions throw on invalid input for key-type flags", () => {
		for (const [verb, def] of Object.entries(REGISTRY)) {
			for (const [flagName, flagDef] of Object.entries(def.flags)) {
				if (!flagDef.validate) continue;

				// Key-type fields (numeric pattern) reject non-numeric strings
				if (flagName.endsWith("Key")) {
					assert.throws(
						() => flagDef.validate?.("not-a-number"),
						`${verb}.flags.${flagName}.validate should throw on invalid input`,
					);
				}
			}
		}
	});

	test("validate functions return the input for valid values", () => {
		for (const [verb, def] of Object.entries(REGISTRY)) {
			for (const [flagName, flagDef] of Object.entries(def.flags)) {
				if (!flagDef.validate) continue;

				// Key-type fields accept numeric strings
				if (flagName.endsWith("Key")) {
					const result = flagDef.validate("12345");
					assert.strictEqual(
						String(result),
						"12345",
						`${verb}.flags.${flagName}.validate("12345") should return "12345"`,
					);
				}

				// ID/name fields accept arbitrary strings
				if (
					["processDefinitionId", "tenantId", "username"].includes(flagName)
				) {
					const result = flagDef.validate("test-value");
					assert.strictEqual(
						String(result),
						"test-value",
						`${verb}.flags.${flagName}.validate("test-value") should return "test-value"`,
					);
				}
			}
		}
	});
});

describe("validateFlags behaviour", () => {
	beforeEach(setup);
	afterEach(teardown);

	test("exits on invalid flag value", () => {
		const searchDef = COMMAND_REGISTRY.search;
		assert.throws(
			() =>
				validateFlags(
					{ processDefinitionKey: "not-a-number" },
					searchDef.flags,
				),
			/process\.exit\(1\)/,
		);
	});

	test("passes valid values through", () => {
		const searchDef = COMMAND_REGISTRY.search;
		const result = validateFlags(
			{ processDefinitionKey: "12345" },
			searchDef.flags,
		);
		assert.ok(result.has("processDefinitionKey"));
		assert.strictEqual(String(result.get("processDefinitionKey")), "12345");
	});

	test("skips flags without validators", () => {
		const searchDef = COMMAND_REGISTRY.search;
		const result = validateFlags(
			{ sortBy: "key", state: "ACTIVE" },
			searchDef.flags,
		);
		assert.strictEqual(result.size, 0);
	});

	test("skips flags not present in values", () => {
		const searchDef = COMMAND_REGISTRY.search;
		const result = validateFlags({}, searchDef.flags);
		assert.strictEqual(result.size, 0);
	});

	test("skips boolean flag values", () => {
		const searchDef = COMMAND_REGISTRY.search;
		// processDefinitionKey as boolean should be skipped (not validated)
		const result = validateFlags(
			{ processDefinitionKey: true },
			searchDef.flags,
		);
		assert.strictEqual(result.size, 0);
	});
});

// ─── validateFlags — required-flag enforcement (#308) ────────────────────────

/**
 * Resolve the effective flag set for a (verb, resource) dispatch, mirroring
 * the resolution used by the command framework:
 *   effective = resourceFlags?.[resource] ?? flags
 */
function effectiveFlags(
	def: CommandDef,
	resource: string | undefined,
): Record<string, import("../../src/command-registry.ts").FlagDef> {
	if (def.resourceFlags && resource && def.resourceFlags[resource]) {
		return def.resourceFlags[resource];
	}
	return def.flags;
}

/**
 * Class-scoped regression guard (#308): every flag declared `required: true`
 * in the COMMAND_REGISTRY must be enforced by validateFlags. The framework
 * boundary — not the handler — is the canonical place to reject missing
 * required input. Without this guard, a `required: true` in the registry is
 * pure metadata and handlers have to duplicate the check (or forget to, as
 * `correlate:message`'s `correlationKey` did pre-#308).
 */
describe("validateFlags enforces FlagDef.required (#308)", () => {
	beforeEach(setup);
	afterEach(teardown);

	/**
	 * Enumerate every (verb, resource, requiredFlagName) triple in the
	 * registry's effective flag sets.
	 */
	function collectRequiredFlags(): Array<{
		verb: string;
		resource: string;
		flagName: string;
	}> {
		const triples: Array<{
			verb: string;
			resource: string;
			flagName: string;
		}> = [];
		for (const [verb, def] of Object.entries(REGISTRY)) {
			const resources =
				def.resources && def.resources.length > 0 ? def.resources : [""];
			for (const resource of resources) {
				const flags = effectiveFlags(def, resource);
				for (const [flagName, fd] of Object.entries(flags)) {
					if (fd.required === true) {
						triples.push({ verb, resource, flagName });
					}
				}
			}
		}
		return triples;
	}

	test("registry has at least one required flag (sanity — detector is non-vacuous)", () => {
		assert.ok(
			collectRequiredFlags().length > 0,
			"expected at least one required flag in COMMAND_REGISTRY",
		);
	});

	test("every required flag is rejected by validateFlags when missing", () => {
		const failures: string[] = [];

		for (const { verb, resource, flagName } of collectRequiredFlags()) {
			const def = REGISTRY[verb];
			if (!def) continue;
			const flags = effectiveFlags(def, resource);

			// Build values with every OTHER required flag in the effective set
			// populated with a dummy, so the only missing required flag is `flagName`.
			const values: Record<string, string> = {};
			for (const [otherName, otherDef] of Object.entries(flags)) {
				if (otherName === flagName) continue;
				if (otherDef.required === true) {
					values[otherName] = "dummy";
				}
			}

			let threw = false;
			try {
				validateFlags(values, flags);
			} catch {
				threw = true;
			}

			if (!threw) {
				failures.push(
					`${verb}${resource ? ` ${resource}` : ""}: missing --${flagName} was silently accepted`,
				);
			}
		}

		assert.strictEqual(
			failures.length,
			0,
			`required flags not enforced by validateFlags:\n  ${failures.join("\n  ")}`,
		);
	});

	test("error message cites the specific missing flag", () => {
		const triples = collectRequiredFlags();
		assert.ok(triples.length > 0);

		// Pick a deterministic representative.
		const sample = triples[0];
		if (!sample) return;
		const def = REGISTRY[sample.verb];
		if (!def) return;
		const flags = effectiveFlags(def, sample.resource);

		errorSpy = [];
		try {
			validateFlags({}, flags);
		} catch {
			/* expected process.exit */
		}

		const combined = errorSpy.join("\n");
		assert.ok(
			combined.includes(`--${sample.flagName} is required`),
			`expected '--${sample.flagName} is required' in stderr; got:\n${combined}`,
		);
	});

	test("validateFlags passes when all required flags are present", () => {
		for (const [verb, def] of Object.entries(REGISTRY)) {
			const resources =
				def.resources && def.resources.length > 0 ? def.resources : [""];
			for (const resource of resources) {
				const flags = effectiveFlags(def, resource);
				const values: Record<string, string> = {};
				for (const [flagName, fd] of Object.entries(flags)) {
					if (fd.required === true) values[flagName] = "dummy";
				}
				// Should not throw — all required present, no validators invoked for "dummy"
				// values on non-validated flags.
				assert.doesNotThrow(
					() => validateFlags(values, flags),
					`${verb} ${resource}: validateFlags threw with all required flags populated`,
				);
			}
		}
	});
});

// ─── detectUnknownFlags ─────────────────────────────────────────────────────

describe("detectUnknownFlags — non-search verbs", () => {
	test("get: valid flags are not flagged", () => {
		const unknown = detectUnknownFlags("get", "process-definition", {
			xml: true,
			profile: "dev",
		});
		assert.deepStrictEqual(unknown, []);
	});

	test("get: unknown flag is detected", () => {
		const unknown = detectUnknownFlags("get", "process-definition", {
			bogus: "yes",
		});
		assert.deepStrictEqual(unknown, ["bogus"]);
	});

	test("create: valid flags are not flagged", () => {
		const unknown = detectUnknownFlags("create", "pi", {
			processDefinitionId: "my-proc",
			variables: "{}",
		});
		assert.deepStrictEqual(unknown, []);
	});

	test("create: unknown flag is detected", () => {
		const unknown = detectUnknownFlags("create", "pi", { assignee: "john" });
		assert.deepStrictEqual(unknown, ["assignee"]);
	});

	test("delete: has no verb-specific flags, only global flags are valid", () => {
		const unknown = detectUnknownFlags("delete", "user", { name: "test" });
		assert.deepStrictEqual(unknown, ["name"]);
	});

	test("delete: global flags are accepted", () => {
		const unknown = detectUnknownFlags("delete", "user", { profile: "dev" });
		assert.deepStrictEqual(unknown, []);
	});

	test("cancel: unknown flag detected", () => {
		const unknown = detectUnknownFlags("cancel", "pi", { reason: "test" });
		assert.deepStrictEqual(unknown, ["reason"]);
	});

	test("cancel: global flags accepted", () => {
		const unknown = detectUnknownFlags("cancel", "pi", { profile: "prod" });
		assert.deepStrictEqual(unknown, []);
	});

	test("complete: valid flag variables accepted", () => {
		const unknown = detectUnknownFlags("complete", "ut", { variables: "{}" });
		assert.deepStrictEqual(unknown, []);
	});

	test("complete: unknown flag detected", () => {
		const unknown = detectUnknownFlags("complete", "ut", { assignee: "john" });
		assert.deepStrictEqual(unknown, ["assignee"]);
	});

	test("fail: valid flags accepted", () => {
		const unknown = detectUnknownFlags("fail", "job", {
			retries: "3",
			errorMessage: "boom",
		});
		assert.deepStrictEqual(unknown, []);
	});

	test("fail: unknown flag detected", () => {
		const unknown = detectUnknownFlags("fail", "job", { timeout: "5000" });
		assert.deepStrictEqual(unknown, ["timeout"]);
	});

	test("publish: valid flags accepted", () => {
		const unknown = detectUnknownFlags("publish", "msg", {
			correlationKey: "k1",
			variables: "{}",
		});
		assert.deepStrictEqual(unknown, []);
	});

	test("publish: unknown flag detected", () => {
		const unknown = detectUnknownFlags("publish", "msg", {
			processDefinitionId: "pd",
		});
		assert.deepStrictEqual(unknown, ["processDefinitionId"]);
	});

	test("activate: valid flags accepted", () => {
		const unknown = detectUnknownFlags("activate", "jobs", {
			maxJobsToActivate: "10",
			worker: "w1",
		});
		assert.deepStrictEqual(unknown, []);
	});

	test("resolve: no verb-specific flags, only global accepted", () => {
		const unknown = detectUnknownFlags("resolve", "inc", {
			errorMessage: "test",
		});
		assert.deepStrictEqual(unknown, ["errorMessage"]);
	});

	test("ignores undefined and false values", () => {
		const unknown = detectUnknownFlags("get", "process-definition", {
			bogus: undefined,
			fake: false,
			xml: true,
		});
		assert.deepStrictEqual(unknown, []);
	});

	test("unknown verb returns empty (no false positives for unregistered verbs)", () => {
		const unknown = detectUnknownFlags("nonexistent-verb", "any", {
			profile: "dev",
		});
		assert.deepStrictEqual(unknown, []);
	});

	test("unknown verb returns empty even with non-global flags", () => {
		const unknown = detectUnknownFlags("nonexistent-verb", "any", {
			weirdFlag: "xyz",
		});
		assert.deepStrictEqual(unknown, []);
	});
});

// ─── Structural invariant: every registry verb gets detection coverage ───────

describe("detectUnknownFlags — structural coverage", () => {
	test("every verb in COMMAND_REGISTRY gets unknown-flag detection that rejects invented flags", () => {
		for (const verb of Object.keys(REGISTRY)) {
			const def = REGISTRY[verb];
			const resource = def.resources?.[0] ?? "any";
			const unknown = detectUnknownFlags(verb, resource, {
				zzz_invented_flag: "value",
			});
			assert.ok(
				unknown.includes("zzz_invented_flag"),
				`detectUnknownFlags('${verb}', '${resource}', ...) failed to detect invented flag`,
			);
		}
	});

	test("every verb accepts all global flags without flagging them", () => {
		for (const verb of Object.keys(REGISTRY)) {
			const def = REGISTRY[verb];
			const resource = def.resources?.[0] ?? "any";
			const globalValues = Object.fromEntries(
				Object.keys(GLOBAL_FLAGS).map((k) => [k, "test-value"]),
			);
			const unknown = detectUnknownFlags(verb, resource, globalValues);
			assert.deepStrictEqual(
				unknown,
				[],
				`detectUnknownFlags('${verb}', '${resource}', ...) incorrectly flagged global flags: ${unknown.join(", ")}`,
			);
		}
	});

	test("every verb accepts its own registered flags without flagging them", () => {
		// Verbs with resourceFlags scope flags per-resource — test each resource separately.
		// Verbs without resourceFlags use the full verb-level flag set.
		for (const verb of Object.keys(REGISTRY)) {
			const def = REGISTRY[verb];
			if (def.resourceFlags) {
				// Test each resource entry in resourceFlags
				for (const [resource, resFlags] of Object.entries(def.resourceFlags)) {
					const verbValues = Object.fromEntries(
						Object.keys(resFlags).map((k) => [k, "test-value"]),
					);
					const unknown = detectUnknownFlags(verb, resource, verbValues);
					assert.deepStrictEqual(
						unknown,
						[],
						`detectUnknownFlags('${verb}', '${resource}', ...) incorrectly flagged resource flags: ${unknown.join(", ")}`,
					);
				}
			} else {
				const resource = def.resources?.[0] ?? "any";
				const verbValues = Object.fromEntries(
					Object.keys(def.flags).map((k) => [k, "test-value"]),
				);
				const unknown = detectUnknownFlags(verb, resource, verbValues);
				assert.deepStrictEqual(
					unknown,
					[],
					`detectUnknownFlags('${verb}', '${resource}', ...) incorrectly flagged verb flags: ${unknown.join(", ")}`,
				);
			}
		}
	});
});
