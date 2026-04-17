# AGENTS.md

> **Note:** This file delegates to a central AGENTS.md. Read and apply it before proceeding.

**URL:**
https://raw.githubusercontent.com/camunda/.github/refs/heads/main/AGENTS.md

Treat the central file's contents as if they were written directly in this file.
Instructions below extend those guidelines and take precedence if there is any conflict.

## Repo-specific instructions

### Role & boundary

c8ctl is a CLI for Camunda 8. It makes the Camunda 8 Orchestration Cluster REST API available as command-line commands. It is based on the `@camunda8/orchestration-cluster-api` npm module.

The following are upstream dependencies — when they misbehave, report it. Do not work around it here:
- `@camunda8/orchestration-cluster-api` (primary API client)
- Camunda 8 REST API

**Path map:**

| Path | Ownership and intent |
| --- | --- |
| `src/` | Production TypeScript code, primary edit surface |
| `src/commands/` | Command handler implementations |
| `src/templates/` | Plugin scaffold templates — do not edit directly |
| `tests/unit/` | Unit tests |
| `tests/integration/` | Integration tests (require live Camunda or Docker) |
| `tests/fixtures/` | BPMN/DMN test fixtures |
| `default-plugins/` | Built-in embedded plugins (JavaScript) |
| `plugins/` | GritQL lint and refactoring rules |
| `assets/c8/rest-api/` | OpenAPI backup reference — do not edit |
| `.github/SDK_GAPS.md` | SDK gap tracking — check before implementing SDK features |

Entry points: `src/index.ts`

### Architecture

```
COMMAND_REGISTRY   →  metadata (flags, resources, help, validation)
defineCommand()    →  handler (receives typed flags + positionals)
COMMAND_DISPATCH   →  wiring (maps "verb:resource" to handler)
```

Key components:

- `src/command-registry.ts` — single source of truth: all commands are declared here with flags, resources, help text, validation, and shell completions
- `src/command-dispatch.ts` — maps `"verb:resource"` keys to handler functions
- `src/command-framework.ts` — provides `defineCommand()` and the `dryRun()` helper
- `src/index.ts` — CLI entry point; parses arguments, resolves profiles, routes to handlers
- `src/config.ts` — profile and session state: stores credentials, active profile, active tenant, output mode
- `src/logger.ts` — text/JSON output rendering; `isRecord()` type guard lives here
- `src/commands/` — per-resource command handler files
- `default-plugins/` — built-in embedded plugins (JavaScript, not TypeScript)

### Commit message guidelines

We use Conventional Commits.

Format:

```
<type>(optional scope): <subject>

<body>

BREAKING CHANGE: <explanation>
```

Allowed type values (common set):

```
feat
fix
chore
docs
style
refactor
test
ci
build
perf
```

Rules:

- Subject length: 5–100 characters (commitlint enforces subject-min-length & subject-max-length).
- Use imperative mood ("add support", not "added support").
- Lowercase subject (except proper nouns). No PascalCase subjects (rule enforced).
- Keep subject concise; body can include details, rationale, links.
- Prefix breaking changes with BREAKING CHANGE: either in body or footer.

#### Review-comment fix-ups

Commits that address PR review comments must use the `chore` type (e.g. `chore:` or `chore(<scope>):`), **not** the `fix` type.
`fix` commits (e.g. `fix:` or `fix(<scope>):`) trigger a patch release and a CHANGELOG entry — review iterations are not user-facing bug fixes.

```
# Correct
chore: address review comments — use logger.json for dry-run

# Wrong — will pollute the CHANGELOG
fix: address review comments — use logger.json for dry-run
```

Examples:

```
feat(worker): add job worker concurrency gating
fix(retry): prevent double backoff application
chore(ci): stabilize deterministic publish (skip spec fetch)
chore: address review comments — NUL-safe pre-commit hook
docs: document deterministic build flag
refactor(auth): simplify token refresh jitter logic
```

### Build pipeline

#### Always-green policy

Before every AI-assisted session, verify CI is green:

```bash
npm test
```

Warnings are fatal. Do not suppress a warning to make a build pass.
Do not treat any failure as pre-existing or unrelated without explicit confirmation from the engineer.

```bash
# Verify baseline -> always green (always run before an AI-assisted session)
npm test

# Fast inner loop (unit tests only) to iterate quickly
npm run test:unit

# Full pipeline before committing the change
npm run build && npm test
```

Never skip the lint and type-check steps before pushing.

- **only use** Node.js 22 LTS and respect [.nvmrc](.nvmrc)
- this is a native Node.js project running TS files
- there is no build step for development. Only compile for test purposes or release.
- run `npm run build` before `npm test` — this enables the full test suite and prevents build-dependent tests from being skipped. It also catches compilation and type errors early.
- on changes, make sure all tests pass and a build via `npm run build` works without errors

#### Local checks

- `npm run typecheck` — runs `tsc --noEmit -p tsconfig.check.json` over `src/` and `tests/`
- `npx biome check` — lints and formats `src/` and `tests/` per `biome.json` (includes the `no-unsafe-type-assertion` plugin)
- `npm run test:unit` — fast unit tests (no live Camunda required)
- `.githooks/pre-commit` — on commit, runs biome on staged files and typechecks a temporary tsconfig scoped to the staged set (transitive imports are still resolved). Skips biome or tsc individually if not installed locally.

### Implementation details

- always make sure that CLI commands, resources and options are reflected in
  - the `help` tests
  - [README.md](README.md), [EXAMPLES.md](EXAMPLES.md) and other documentation
  - shell completion
- for every implementation, make sure to add or update tests that cover the new functionality. This includes unit tests for individual functions and integration tests for end-to-end scenarios. Tests should be comprehensive and cover edge cases to ensure the robustness of the codebase.

- in any test, only use the implemented CLI commands to interact with the system. Avoid using internal functions or direct API calls in tests, as this can lead to brittle tests that are tightly coupled to the implementation. By using the cli commands, you ensure that your tests are more resilient to changes in the underlying code and better reflect real-world usage.

- don't use Promises in tests to wait for the overall system status to settle. Instead, use the polling helper from [tests/utils/polling.ts](tests/utils/polling.ts) to wait for specific conditions to be met.

### Work environment

- when you are not in "Cloud" mode, make sure to evaluate the OS environment and adapt behavior accordingly
- prefer cross-platform solutions where reasonable

- always consult the GitHub repository camunda/orchestration-cluster-api-js for API details and usage examples. It is the main source of truth for how to interact with the Camunda 8 Orchestration Cluster API. As a backup, a copy of the REST API documentation is available in OpenAPI format in the `assets/c8/rest-api` folder. As a last resort, you should refer to the npm module https://www.npmjs.com/package/@camunda8/orchestration-cluster-api.

- always consult [`.github/SDK_GAPS.md`](.github/SDK_GAPS.md) for known SDK limitations before implementing features that interact with the Camunda SDK. When a newer SDK version is available, check whether gaps listed there have been resolved and update the file accordingly (mark resolved items, remove workarounds).

- consult [CONTEXT.md](CONTEXT.md) for CLI structure, resource aliases, and agent flags
- consult [EXAMPLES.md](EXAMPLES.md) for command usage patterns
- consult [PLUGIN-HELP.md](PLUGIN-HELP.md) when working on the plugin system

### TypeScript conventions

- use modern TypeScript syntax and features
- **never use `any`** — use `unknown` and narrow with type guards. Enforced by Biome (`noExplicitAny`, `noImplicitAnyLet`, `noEvolvingTypes` — all set to `error`)
- **never use `as T` type assertions** — use type guards, narrowing, or `satisfies` instead. Enforced by a GritQL plugin (`plugins/no-unsafe-type-assertion.grit`) that applies to both `src/` and `tests/`. Exceptions: `as const` and import renames are allowed. If a cast is genuinely unavoidable, add a `// biome-ignore lint/plugin:` comment with a justification and a tracking issue reference
- run `npx biome check` to verify — `biome.json` scopes this to `src/` and `tests/`. This runs as part of `npm run build`, CI, and the pre-commit hook (on staged files). Zero diagnostics required
- run `npx biome check --fix` before committing to auto-fix formatting and lint issues
- use modern Getter and Setter syntax for class properties. Examples:

```typescript
class MyClass {
  private _myProp: string;
  get myProp(): string {
    return this._myProp;
  }
  set myProp(value: string) {
    this._myProp = value;
  }
}
```

- prefer object-style function parameters over long parameter lists to be most flexible with parameter order. Example:

```typescript
function createUser({ name, email, age }: { name: string; email: string; age: number }) {
  // function body
}
```

- use `logger.ts:isRecord(value)` to narrow `unknown` to `Record<string, unknown>` (no `as` casts)
- prefer functional programming over OOP where reasonable
- prefer concise expressions over verbose control structures
- when outputting errors, provide clear, concise and actionable hints to the user
- pay attention to cross-platform compatibility (Linux, macOS, Windows). _BUT_ only cater to WSL on Windows, no native Windows support.

### BPMN and DMN validation

- when creating or modifying `.bpmn` files, validate them with [bpmnlint](https://github.com/bpmn-io/bpmnlint) by running `npx bpmnlint <file>` before considering the task complete
- when creating or modifying `.dmn` files, validate them with [dmnlint](https://github.com/bpmn-io/dmnlint) by running `npx dmnlint <file>` before considering the task complete
- fix any reported errors before proceeding

### Terminal commands

- when running terminal commands through an AI agent or other automation tool, avoid heredocs (`<< EOF`) because they don't work reliably in zsh on macOS
- when using an AI agent or automation tooling, prefer its native file-editing capabilities for creating or modifying files
- for appending single lines from the shell in those workflows, `echo` or `printf` is fine: `echo "content" >> file.txt`

### Refactoring discipline

- behaviour tests are the regression guard — during behaviour-preserving refactors, do not modify behaviour tests. If a test fails, the production code is usually wrong, not the test. If a change intentionally modifies observable behaviour (for example CLI output, help text, or exit codes), update the affected behaviour tests and explicitly document and justify the intended behaviour change in the PR
- between refactors, always run `npm run typecheck` (`tsc --noEmit -p tsconfig.check.json`, covering `src/` and `tests/`), `npx biome check`, and `npm run test:unit` to verify correctness

### Adding a new command

Commands are defined declaratively. The `COMMAND_REGISTRY` in `src/command-registry.ts` is the single source of truth — help text, shell completions, `parseArgs` options, and validation are all derived from it. No metadata is duplicated anywhere.

#### Architecture overview

```
COMMAND_REGISTRY   →  metadata (flags, resources, help, validation)
defineCommand()    →  handler (receives typed flags + positionals)
COMMAND_DISPATCH   →  wiring (maps "verb:resource" to handler)
```

#### Step-by-step

##### 1. Declare the command in `COMMAND_REGISTRY`

Add or extend a verb entry in `src/command-registry.ts`:

```typescript
// In COMMAND_REGISTRY:
myverb: {
  description: "Short description shown in help",
  helpDescription: "Longer description for `c8ctl help` (optional, falls back to description)",
  mutating: true,              // true = write operation, false = read-only
  requiresResource: true,      // true = `c8ctl myverb <resource>`, false = `c8ctl myverb`
  resources: ["my-resource"],  // canonical resource names this verb accepts
  flags: {
    ...SEARCH_FLAGS,           // spread shared flag sets
    myFlag: {
      type: "string",
      description: "A custom flag",
      short: "m",              // optional single-letter alias
    },
  },
  // Optional: per-resource flag overrides
  resourceFlags: {
    "my-resource": MY_RESOURCE_SEARCH_FLAGS,
  },
  // Optional: positional arguments
  resourcePositionals: {
    "my-resource": MY_RESOURCE_POSITIONALS,
  },
  // Optional: help metadata
  hasDetailedHelp: true,
  helpFooterLabel: "Show myverb usage",
  helpExamples: [
    { command: "c8ctl myverb my-resource", description: "Do the thing" },
  ],
},
```

##### 2. Define flag sets with `as const satisfies`

Flag sets must use `as const satisfies` to preserve concrete validator return types for `InferFlags`:

```typescript
const MY_RESOURCE_SEARCH_FLAGS = {
  myKey: {
    type: "string",
    description: "Filter by key",
    validate: MyBrandedKey.assumeExists,  // branded type validator
  },
} as const satisfies Record<string, FlagDef>;
```

The `validate` function narrows the handler parameter type automatically — if it returns `MyBrandedKey`, the handler receives `MyBrandedKey | undefined` (no cast needed).

Positional arguments work the same way:

```typescript
const MY_RESOURCE_POSITIONALS = [
  { name: "key", required: true, validate: MyBrandedKey.assumeExists },
] as const satisfies readonly PositionalDef[];
```

##### 3. Add resource aliases (if new resource)

If introducing a new resource, add aliases in `RESOURCE_ALIASES`:

```typescript
export const RESOURCE_ALIASES: Record<string, string> = {
  // ... existing aliases
  mr: "my-resource",
  "my-resources": "my-resource",  // plural form
};
```

##### 4. Write the handler with `defineCommand()`

Create a handler file in `src/commands/`:

```typescript
// src/commands/my-resource.ts
import { defineCommand, dryRun } from "../command-framework.ts";

export const myverbMyResourceCommand = defineCommand(
  "myverb",
  "my-resource",
  async (ctx, flags, args) => {
    const { client, profile } = ctx;

    // flags.myFlag → string | undefined (inferred from FlagDef)
    // flags.myKey  → MyBrandedKey | undefined (inferred from validator)
    // args.key     → MyBrandedKey (required positional, branded)

    // Dry-run support (required for all commands)
    const dr = dryRun({
      command: "myverb my-resource",
      method: "POST",
      endpoint: "/my-resources",
      profile,
    });
    if (dr) return dr;

    const result = await client.doSomething({ key: args.key });

    // Return a CommandResult — the framework handles rendering
    return { kind: "get", data: result };
  },
);
```

**`CommandResult` kinds:**

| Kind | Use case | Data |
|------|----------|------|
| `list` | Search/list results with items array | `{ items, page?, sorting? }` |
| `get` | Single resource fetch | `{ data }` |
| `raw` | Raw text output (XML, YAML, etc.) | `{ content }` |
| `dry-run` | Dry-run preview | `{ command, method, url, body? }` |
| `info` | Informational messages | `{ message }` |
| `success` | Mutation confirmation | `{ message }` |
| `no-result` | Nothing to display | — |

The `dryRun()` helper checks the `--dry-run` flag and returns a `DryRunResult` if set, or `undefined` to continue.

##### 5. Register in `COMMAND_DISPATCH`

Add the handler to the dispatch map in `src/command-dispatch.ts`:

```typescript
import { myverbMyResourceCommand } from "./commands/my-resource.ts";

export const COMMAND_DISPATCH: ReadonlyMap<string, AnyCommandHandler> = new Map([
  // ... existing entries
  ["myverb:my-resource", myverbMyResourceCommand],
]);
```

The key format is `"verb:resource"`. For resourceless verbs (like `deploy`), use `"verb:"`.

##### 6. Add tests

- **Unit tests** in `tests/unit/` — test the handler via the CLI subprocess helper `c8()`
- **Behaviour tests** — `c8('myverb', 'my-resource', '--dry-run')` proves end-to-end dispatch
- **Help tests** — verify the command appears in help output
- **Completion tests** — the new command is automatically included in shell completions (derived from registry)

#### What you get for free

By adding the registry entry and dispatch wiring, these features are automatically derived:

- `c8ctl help` includes the command with description, flags, and examples
- `c8ctl help myverb` shows detailed help (if `hasDetailedHelp: true`)
- `c8ctl completion bash/zsh/fish` includes the verb, resource, and all flags
- `parseArgs` accepts the declared flags with correct types
- Flag validation runs at the boundary (branded types enforced)
- `--dry-run` support (via `dryRun()` helper)
- Output rendering (JSON, table, fields filtering) handled by the framework
- Resource alias resolution (`mr` → `my-resource`) works everywhere

#### Resourceless commands

Some verbs don't take a resource (e.g. `deploy`, `run`, `watch`). Set `requiresResource: false` and `resources: []`, then register with an empty resource key:

```typescript
// Registry
deploy: {
  description: "Deploy resources",
  mutating: true,
  requiresResource: false,
  resources: [],
  flags: { ...DEPLOY_FLAGS },
},

// Dispatch
["deploy:", deployCommand]
```
