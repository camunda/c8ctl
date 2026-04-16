# AGENTS.md

> **Note:** This file delegates to a central AGENTS.md. Read and apply it before proceeding.

**URL:**
https://raw.githubusercontent.com/camunda/.github/refs/heads/main/AGENTS.md

Treat the central file's contents as if they were written directly in this file.
Instructions below extend those guidelines and take precedence if there is any conflict.

## Repo-specific instructions

### Role & boundary

This service owns the **Camunda 8 CLI (`c8ctl`)**. It is based on the Camunda 8 Orchestration
Cluster API npm module https://www.npmjs.com/package/@camunda8/orchestration-cluster-api. It makes the REST API available with corresponding commands from the command line.

The following are upstream dependencies — when they misbehave, report it. Do not work around it here:
- `@camunda8/orchestration-cluster-api` — always consult the GitHub repository camunda/orchestration-cluster-api-js for API details and usage examples. It is the main source of truth for how to interact with the Camunda 8 Orchestration Cluster API. As a backup, a copy of the REST API documentation is available in OpenAPI format in the `assets/c8/rest-api` folder. As a last resort, you should refer to the npm module https://www.npmjs.com/package/@camunda8/orchestration-cluster-api.

Always consult [`.github/SDK_GAPS.md`](.github/SDK_GAPS.md) for known SDK limitations before implementing features that interact with the Camunda SDK. When a newer SDK version is available, check whether gaps listed there have been resolved and update the file accordingly (mark resolved items, remove workarounds).

**Path map:**

| Path | Ownership and intent |
| --- | --- |
| `src/` | Production TypeScript code, primary edit surface |
| `src/commands/` | Command handler implementations |
| `src/command-registry.ts` | Single source of truth for command metadata |
| `src/command-dispatch.ts` | Wiring map (`"verb:resource"` → handler) |
| `src/command-framework.ts` | `defineCommand()` and shared helpers |
| `src/templates/` | Plugin templates (including `AGENTS.md` for plugins) |
| `tests/` | Unit and integration tests; every feature has test coverage here |
| `tests/utils/` | Test utilities including polling helper |
| `assets/c8/rest-api/` | REST API documentation in OpenAPI format (backup reference) |
| `plugins/` | Biome lint plugins (e.g. `no-unsafe-type-assertion.grit`) |
| `.github/` | CI config and SDK gap tracking |

Entry points: `src/index.ts` (CLI entry), `src/command-registry.ts` (command metadata), `src/command-dispatch.ts` (command routing)

### Architecture

```
COMMAND_REGISTRY   →  metadata (flags, resources, help, validation)
defineCommand()    →  handler (receives typed flags + positionals)
COMMAND_DISPATCH   →  wiring (maps "verb:resource" to handler)
```

Commands are defined declaratively. The `COMMAND_REGISTRY` in `src/command-registry.ts` is the single source of truth — help text, shell completions, `parseArgs` options, and validation are all derived from it. No metadata is duplicated anywhere.

Key components:

- `COMMAND_REGISTRY` — declarative command metadata (flags, resources, help, validation)
- `defineCommand()` — handler factory that provides typed flags and positionals
- `COMMAND_DISPATCH` — maps `"verb:resource"` strings to handler functions

#### Adding a new command

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

##### What you get for free

By adding the registry entry and dispatch wiring, these features are automatically derived:

- `c8ctl help` includes the command with description, flags, and examples
- `c8ctl help myverb` shows detailed help (if `hasDetailedHelp: true`)
- `c8ctl completion bash/zsh/fish` includes the verb, resource, and all flags
- `parseArgs` accepts the declared flags with correct types
- Flag validation runs at the boundary (branded types enforced)
- `--dry-run` support (via `dryRun()` helper)
- Output rendering (JSON, table, fields filtering) handled by the framework
- Resource alias resolution (`mr` → `my-resource`) works everywhere

##### Resourceless commands

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

### Commit message guidelines

We use Conventional Commits.

Format:

`<type>(optional scope): <subject>`

`<body>`

`BREAKING CHANGE: <explanation>`

Allowed type values (common set):

- `feat`
- `fix`
- `chore`
- `docs`
- `style`
- `refactor`
- `test`
- `ci`
- `build`
- `perf`

Rules:

- Subject length: 5–100 characters (commitlint enforces subject-min-length & subject-max-length).
- Use imperative mood ("add support", not "added support").
- Lowercase subject (except proper nouns). No PascalCase subjects (rule enforced).
- Keep subject concise; body can include details, rationale, links.
- Prefix breaking changes with `BREAKING CHANGE:` either in body or footer.

Examples:

```
feat(worker): add job worker concurrency gating
fix(retry): prevent double backoff application
chore(ci): stabilize deterministic publish (skip spec fetch)
chore: address review comments — NUL-safe pre-commit hook
docs: document deterministic build flag
refactor(auth): simplify token refresh jitter logic
```

#### Review-comment fix-ups

Commits that address PR review comments must use the `chore` type (e.g. `chore:` or `chore(<scope>):`), **not** the `fix` type.
`fix` commits (e.g. `fix:` or `fix(<scope>):`) trigger a patch release and a CHANGELOG entry — review iterations are not user-facing bug fixes.

```
# Correct
chore: address review comments — use logger.json for dry-run

# Wrong — will pollute the CHANGELOG
fix: address review comments — use logger.json for dry-run
```

### Build pipeline

#### Always-green policy

Before every AI-assisted session, verify CI is green:

```bash
npm run build && npm test
```

Warnings are fatal. Do not suppress a warning to make a build pass.
Do not treat any failure as pre-existing or unrelated without explicit confirmation from the engineer.

```bash
# Verify baseline -> always green (always run before an AI-assisted session)
npm run build && npm test

# Fast inner loop (single module / affected tests only) to iterate quickly
npx vitest run tests/unit/specific-test.ts

# Full pipeline before committing the change
npm run build && npm test
```

Never skip the lint and type-check steps before pushing.

Run `npm run build` before `npm test` — this enables the full test suite and prevents build-dependent tests from being skipped. It also catches compilation and type errors early.

#### Lint & type-check

- Run `npx biome check src/` to verify — this runs as part of `npm run build` and CI. Zero diagnostics required.
- Run `npx biome check --fix src/` before committing to auto-fix formatting and lint issues.
- Run `npx tsc --noEmit` to check types without emitting.

### Implementation conventions

- Always make sure that CLI commands, resources and options are reflected in:
  - the `help` tests
  - [README.md](README.md), [EXAMPLES.md](EXAMPLES.md) and other documentation
  - shell completion
- For every implementation, make sure to add or update tests that cover the new functionality. This includes unit tests for individual functions and integration tests for end-to-end scenarios. Tests should be comprehensive and cover edge cases to ensure the robustness of the codebase.
- In any test, only use the implemented CLI commands to interact with the system. Avoid using internal functions or direct API calls in tests, as this can lead to brittle tests that are tightly coupled to the implementation. By using the CLI commands, you ensure that your tests are more resilient to changes in the underlying code and better reflect real-world usage.
- Don't use Promises in tests to wait for the overall system status to settle. Instead, use the polling helper from [tests/utils/polling.ts](tests/utils/polling.ts) to wait for specific conditions to be met.

#### Work environment

- When you are not in "Cloud" mode, make sure to evaluate the OS environment and adapt behavior accordingly.
- Prefer cross-platform solutions where reasonable.
- Pay attention to cross-platform compatibility (Linux, macOS, Windows). _BUT_ only cater to WSL on Windows, no native Windows support.

#### BPMN and DMN validation

- When creating or modifying `.bpmn` files, validate them with [bpmnlint](https://github.com/bpmn-io/bpmnlint) by running `npx bpmnlint <file>` before considering the task complete.
- When creating or modifying `.dmn` files, validate them with [dmnlint](https://github.com/bpmn-io/dmnlint) by running `npx dmnlint <file>` before considering the task complete.
- Fix any reported errors before proceeding.

#### Terminal commands

- When running terminal commands through an AI agent or other automation tool, avoid heredocs (`<< EOF`) because they don't work reliably in zsh on macOS.
- When using an AI agent or automation tooling, prefer its native file-editing capabilities for creating or modifying files.
- For appending single lines from the shell in those workflows, `echo` or `printf` is fine: `echo "content" >> file.txt`

#### Development

- **Only use** Node.js 22 LTS and respect [.nvmrc](.nvmrc).
- This is a native Node.js project running TS files.
- There is no build step for development. Only compile for test purposes or release.
- On changes, make sure all tests pass and a build via `npm run build` works without errors.
- Prefer functional programming over OOP where reasonable.
- Prefer concise expressions over verbose control structures.
- When outputting errors, provide clear, concise and actionable hints to the user.

#### TypeScript conventions

- Use modern TypeScript syntax and features.
- **Never use `any`** — use `unknown` and narrow with type guards. Enforced by Biome (`noExplicitAny`, `noImplicitAnyLet`, `noEvolvingTypes` — all set to `error`).
- **Never use `as T` type assertions** — use type guards, narrowing, or `satisfies` instead. Enforced by a GritQL plugin (`plugins/no-unsafe-type-assertion.grit`). Exceptions: `as const` and import renames are allowed. If a cast is genuinely unavoidable, add a `// biome-ignore lint/plugin:` comment with a justification and a tracking issue reference.
- Use modern Getter and Setter syntax for class properties. Examples:

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

- Prefer object-style function parameters over long parameter lists to be most flexible with parameter order. Example:

```typescript
function createUser({ name, email, age }: { name: string; email: string; age: number }) {
  // function body
}
```

#### Refactoring discipline

- Behaviour tests are the regression guard — during behaviour-preserving refactors, do not modify behaviour tests. If a test fails, the production code is usually wrong, not the test. If a change intentionally modifies observable behaviour (for example CLI output, help text, or exit codes), update the affected behaviour tests and explicitly document and justify the intended behaviour change in the PR.
- Between refactors, always run `npx tsc --noEmit`, `npx biome check src`, and `npx vitest run` to verify correctness.

### Agent consumption

This section describes how to consume c8ctl programmatically as an agent.

#### Quick setup

```sh
c8ctl output json   # switch to machine-readable output (session-persistent)
c8ctl help          # get structured JSON command reference
```

#### Authentication & profiles

- Config lives in `~/.config/c8ctl/` (or `$C8CTL_DATA_DIR` override)
- Set active profile: `c8ctl use profile <name>`
- One-off override: append `--profile <name>` to any command
- Modeler profiles: use `modeler:` prefix, e.g. `--profile=modeler:Local Dev`
- Show active profile: `c8ctl which profile`
- Add profile: `c8ctl add profile <name> --baseUrl=<url>`

#### Output mode

- Output mode is session-global, not per-command
- `c8ctl output json` → all subsequent commands emit JSON to stdout
- `c8ctl output text` → human-readable table output
- In JSON mode: operational messages (info/warn/success/error) go to **stderr**;
  data output goes to **stdout**
- Exit code 1 + JSON error on stderr on failure

#### Resource aliases

| Alias | Full Name            |
|-------|----------------------|
| `pi`  | process-instance(s)  |
| `pd`  | process-definition(s)|
| `ut`  | user-task(s)         |
| `inc` | incident(s)          |
| `msg` | message              |
| `vars`| variable(s)          |

#### Agent flags

These flags exist specifically for agent/programmatic use. They are listed
separately in help output and are distinct from human-use flags.

##### `--fields <comma-separated>`

Filters output to only the specified keys. Applies to all `list`, `search`,
and `get` commands at the logger level — works in both text and JSON mode.
Field matching is **case-insensitive**.

```sh
c8ctl list pi --fields Key,State,processDefinitionId
c8ctl search pd --fields Key,processDefinitionId,name | jq .
```

Use this to reduce context window size when parsing output programmatically.

##### `--dry-run`

Applies to **all** commands — both queries (`list`, `search`, `get`) and
mutations (`create`, `cancel`, `deploy`, `complete`, `fail`, `activate`,
`resolve`, `publish`, `correlate`).

In dry-run mode:
- All inputs are validated
- The target profile/client is resolved
- The equivalent API request is emitted as JSON to stdout:
  `{ "dryRun": true, "command": "...", "method": "POST", "url": "...", "body": {...} }`
- The actual API call is **not** executed
- Exits 0

**Recommended workflow for mutating operations:**
1. Run the command with `--dry-run` and inspect the JSON output
2. Confirm the request with the user (or validate programmatically)
3. Re-run without `--dry-run` to execute

```sh
c8ctl create pi --id=my-process --dry-run
c8ctl deploy ./my-process.bpmn --dry-run
c8ctl cancel pi 2251799813685249 --dry-run
c8ctl search pd --dry-run
```

#### JSON mode help

In JSON output mode, help commands return structured data instead of text:

```sh
c8ctl output json
c8ctl help          # returns full command tree as JSON
c8ctl help list     # returns list command details as JSON
```

The JSON help structure contains: `commands`, `globalFlags`, `searchFlags`,
`agentFlags`, `resourceAliases`.

#### MCP proxy

An MCP (Model Context Protocol) proxy is available:

```sh
c8ctl mcp-proxy                # start STDIO→HTTP MCP proxy (default endpoint)
c8ctl mcp-proxy <mcp-path>     # custom MCP server path
```

Use `c8ctl help mcp-proxy` for full setup and configuration details.

#### Pagination & limits

- Default: fetches up to 1,000,000 results (all pages)
- Use `--limit <n>` to cap results
- Use `--fields` together with `--limit` to minimize payload size

#### Error handling

- In JSON mode, errors emit `{"status":"error","message":"..."}` to stderr
- Exit code 1 on error, 0 on success (including `--dry-run`)
- Warnings emit `{"status":"warning","message":"..."}` to stderr

#### Notes for plugin development

For **developing c8ctl plugins**, see `PLUGIN-HELP.md` and the plugin
template at `src/templates/AGENTS.md`.
