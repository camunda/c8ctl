## Plan: Create c8ctl CLI with TypeScript

Build a minimal-dependency CLI on top of `@camunda8/orchestration-cluster-api` that exposes commands for process instances, user tasks, incidents, jobs, messages, deployments, and topology. Uses env vars or profiles for auth, defaulting to `http://localhost:8080` with no authentication. Profiles and session state stored in platform-specific user data directory. Full multi-tenant support.

### Steps

1. **Initialize project structure** — Create [package.json](package.json) with `"type": "module"`, `"engines": { "node": ">=22.18.0" }`, and `"bin": { "c8ctl": "./src/index.ts", "c8": "./src/index.ts" }`, [tsconfig.json](tsconfig.json) for type-checking only. Add `@camunda8/orchestration-cluster-api` as sole runtime dependency. Entry point [src/index.ts](src/index.ts) runs natively via `node` (TypeScript stripping unflagged since Node 22.18.0).

2. **Create logger component** — In [src/logger.ts](src/logger.ts), implement a `Logger` class with `info()`, `success()`, `error()`, `table()`, `json()` methods. Constructor reads output mode from session state. Always surface process instance keys prominently via `success()`.

3. **Implement config and session state** — In [src/config.ts](src/config.ts):
   - Profile storage: `{userData}/profiles.json` — named cluster configs
   - Session state: `{userData}/session.json` — stores active profile, active tenant, output mode
   - Credential resolution: session profile → `--profile` flag → `CAMUNDA_*` env vars → localhost fallback
   - Tenant resolution: session tenant → `CAMUNDA_DEFAULT_TENANT_ID` → `<default>`

4. **Add help and version commands** — In [src/commands/help.ts](src/commands/help.ts):
   - `c8 help` / `c8 --help` / `c8 -h` — display full usage with all commands, aliases, and flags
   - `c8 --version` / `c8 -v` — read and output `version` from [package.json](package.json) using `import.meta` or `fs.readFileSync`
   - `c8 <verb>` without resource — show available resources for that verb:
     - `c8 list` → "Available: process-instances (pi), user-tasks (ut), incidents (inc), jobs, profiles"
     - `c8 get` → "Available: process-instance (pi), topology"
     - `c8 create` → "Available: process-instance (pi)"
     - `c8 complete` → "Available: user-task (ut), job"
     - `c8 cancel` → "Available: process-instance (pi)"
     - `c8 resolve` → "Available: incident (inc)"
     - `c8 activate` → "Available: jobs"
     - `c8 fail` → "Available: job"
     - `c8 publish` → "Available: message (msg)"
     - `c8 correlate` → "Available: message (msg)"
     - `c8 add` → "Available: profile"
     - `c8 remove` / `c8 rm` → "Available: profile"
     - `c8 use` → "Available: profile, tenant"
     - `c8 output` → "Available: json, text"

5. **Add `use` and `output` commands for session state** — In [src/commands/session.ts](src/commands/session.ts):
   - `c8 use profile <name>` — set active profile for subsequent commands
   - `c8 use tenant <id>` — set active tenant for subsequent commands
   - `c8 output json` — switch output to JSON mode
   - `c8 output text` — switch output to human-readable mode (default)
   - Keep `--profile <name>` flag as exception for one-off profile override

6. **Create command handlers** — In [src/commands/](src/commands/), implement per-domain files. All list/search commands include tenant in filter; create/mutate commands pass tenant to SDK:
   - [process-instances.ts](src/commands/process-instances.ts): `list`, `get`, `create`, `cancel`
   - [user-tasks.ts](src/commands/user-tasks.ts): `list`, `complete`
   - [incidents.ts](src/commands/incidents.ts): `list`, `resolve`
   - [jobs.ts](src/commands/jobs.ts): `list`, `activate`, `complete`, `fail`
   - [messages.ts](src/commands/messages.ts): `publish`, `correlate`
   - [topology.ts](src/commands/topology.ts): `get`

7. **Implement deploy with building-block traversal** — In [src/commands/deployments.ts](src/commands/deployments.ts), accept `[path...]` args or `--all` flag. Pass active tenant to deployment. Walk directories recursively, prioritize folders containing `_bb-` in name (deploy first), then deploy remaining `.bpmn`, `.dmn`, `.form` files up the hierarchy.

8. **Add `run` convenience command** — In [src/commands/run.ts](src/commands/run.ts), deploy the BPMN file with tenant, extract process ID via regex `/process[^>]+id="([^"]+)"/`, create process instance with that ID and tenant, log created instance key.

9. **Add profile management commands** — In [src/commands/profiles.ts](src/commands/profiles.ts):
   - `c8 list profiles` — list all saved profiles showing name, address, auth strategy, default tenant
   - `c8 add profile <name>` — add profile via flags or interactive prompts
   - `c8 remove profile <name>` (alias `rm`) — delete a saved profile

10. **Wire CLI entry point** — In [src/index.ts](src/index.ts), use `parseArgs` to handle:
    - Global flags: `--profile <name>`, `--version`/`-v`, `--help`/`-h`
    - Session commands: `use`, `output`
    - CRUD commands: `list`, `get`, `create`, `cancel`, `complete`, `fail`, `activate`, `resolve`, `publish`, `correlate`, `deploy`, `run`, `add`, `remove`/`rm`
    - Resource aliases: `process-instance|pi`, `user-task|ut`, `incident|inc`, `message|msg`, `topology`, `profile`/`profiles`, `tenant`
    - Verb-only invocations route to help showing available resources

11. **Add tests** — Use Node.js built-in test runner (`node:test`) with `node --test`. Tests in [tests/](tests/) directory:

    **Unit tests** (mock filesystem/SDK, test CLI logic only):
    - [tests/unit/config.test.ts](tests/unit/config.test.ts): Profile loading, session state persistence, credential resolution order, user data dir detection per platform
    - [tests/unit/logger.test.ts](tests/unit/logger.test.ts): Output mode switching, table formatting, JSON serialization, key highlighting
    - [tests/unit/parser.test.ts](tests/unit/parser.test.ts): Command parsing, alias resolution (`pi`→`process-instance`), flag extraction, `--profile` override
    - [tests/unit/deploy-traversal.test.ts](tests/unit/deploy-traversal.test.ts): `_bb-` folder prioritization, file extension filtering, directory hierarchy ordering
    - [tests/unit/bpmn-parser.test.ts](tests/unit/bpmn-parser.test.ts): Process ID extraction regex against various BPMN samples
    - [tests/unit/help.test.ts](tests/unit/help.test.ts): `--version` outputs package version, `help` output includes all commands, verb-only shows available resources

    **Integration tests** (against local c8run at `http://localhost:8080`):
    - [tests/integration/topology.test.ts](tests/integration/topology.test.ts): `get topology` returns broker info
    - [tests/integration/deploy.test.ts](tests/integration/deploy.test.ts): Deploy sample BPMN, verify resource created
    - [tests/integration/process-instances.test.ts](tests/integration/process-instances.test.ts): Create PI, list includes it, get by key, cancel
    - [tests/integration/run.test.ts](tests/integration/run.test.ts): `run` deploys and creates PI in one command, key is output
    - [tests/integration/profiles.test.ts](tests/integration/profiles.test.ts): Add/list/remove profile persists to temp user data dir
    - [tests/integration/session.test.ts](tests/integration/session.test.ts): `use profile`, `use tenant`, `output json` persist and affect subsequent commands

    **Test fixtures**:
    - [tests/fixtures/simple.bpmn](tests/fixtures/simple.bpmn): Minimal BPMN with known process ID
    - [tests/fixtures/_bb-building-block/](tests/fixtures/_bb-building-block/): Sample building block folder with BPMN/DMN
    - [tests/fixtures/sample-project/](tests/fixtures/sample-project/): Nested folder structure for traversal testing

12. **Create documentation** — 
    - [README.md](README.md): Architecture overview, installation (requires Node ≥22.18.0), quick start, testing instructions
    - [EXAMPLES.md](EXAMPLES.md): Sample commands for all operations grouped by resource

### Summary

| File | Purpose |
|------|---------|
| [package.json](package.json) | Project config, `engines: >=22.18.0`, bin entries, test script |
| [tsconfig.json](tsconfig.json) | Type-checking only (no compilation) |
| [README.md](README.md) | Architecture, installation, quick start, testing |
| [EXAMPLES.md](EXAMPLES.md) | Sample commands for all CLI operations |
| [src/index.ts](src/index.ts) | CLI entry, command routing, alias handling, version/help |
| [src/logger.ts](src/logger.ts) | Output component respecting session output mode |
| [src/config.ts](src/config.ts) | Profile storage, session state, credential + tenant resolution |
| [src/client.ts](src/client.ts) | SDK client factory using resolved config |
| [src/commands/help.ts](src/commands/help.ts) | Help output, version, verb-only resource hints |
| [src/commands/session.ts](src/commands/session.ts) | `use profile`, `use tenant`, `output json/text` |
| [src/commands/process-instances.ts](src/commands/process-instances.ts) | PI operations (tenant-aware) |
| [src/commands/user-tasks.ts](src/commands/user-tasks.ts) | User task operations (tenant-aware) |
| [src/commands/incidents.ts](src/commands/incidents.ts) | Incident operations (tenant-aware) |
| [src/commands/jobs.ts](src/commands/jobs.ts) | Job operations (tenant-aware) |
| [src/commands/messages.ts](src/commands/messages.ts) | Message operations (tenant-aware) |
| [src/commands/deployments.ts](src/commands/deployments.ts) | Deploy with `_bb-` prioritization (tenant-aware) |
| [src/commands/run.ts](src/commands/run.ts) | Deploy + create PI convenience (tenant-aware) |
| [src/commands/topology.ts](src/commands/topology.ts) | Cluster topology |
| [src/commands/profiles.ts](src/commands/profiles.ts) | Profile CRUD with default tenant |
| [tests/unit/*.test.ts](tests/unit/) | Unit tests for CLI-specific logic |
| [tests/integration/*.test.ts](tests/integration/) | Integration tests against local c8run |
| [tests/fixtures/](tests/fixtures/) | Test BPMN files and folder structures |

### Testing Strategy

| What to test | What NOT to test |
|--------------|------------------|
| Credential resolution order | SDK's OAuth token handling |
| Profile persistence to disk | SDK's HTTP retry logic |
| Alias resolution (`pi` → `process-instance`) | SDK's request/response serialization |
| `_bb-` folder prioritization | SDK's job worker internals |
| BPMN process ID regex extraction | SDK's API endpoint mapping |
| Session state persistence | SDK's backpressure management |
| Logger output formatting | SDK's type branding |
| CLI argument parsing | SDK's validation |
| Command→handler routing | Actual API behavior (covered by SDK) |

### Help Output Example

```
$ c8 help

c8ctl - Camunda 8 CLI v1.0.0

Usage: c8 <command> [resource] [options]

Commands:
  list      <resource>       List resources (pi, ut, inc, jobs, profiles)
  get       <resource> <key> Get resource by key (pi, topology)
  create    <resource>       Create resource (pi)
  cancel    <resource> <key> Cancel resource (pi)
  complete  <resource> <key> Complete resource (ut, job)
  fail      job <key>        Fail a job
  activate  jobs <type>      Activate jobs by type
  resolve   inc <key>        Resolve incident
  publish   msg <name>       Publish message
  correlate msg <name>       Correlate message
  deploy    [path...]        Deploy BPMN/DMN/forms
  run       <path>           Deploy and start process
  add       profile <name>   Add a profile
  remove    profile <name>   Remove a profile (alias: rm)
  use       profile|tenant   Set active profile or tenant
  output    json|text        Set output format
  help                       Show this help

Flags:
  --profile <name>  Use specific profile for this command
  --version, -v     Show version
  --help, -h        Show help

$ c8 list

Usage: c8 list <resource>

Available resources:
  process-instances  (alias: pi)
  user-tasks         (alias: ut)
  incidents          (alias: inc)
  jobs
  profiles
```
