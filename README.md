# Cocktail (c8ctl) - Camunda 8 CLI

c8ctl (_pronounced: "cocktail"_) — a minimal-dependency CLI for Camunda 8 operations built on top of [`@camunda8/orchestration-cluster-api`](https://www.npmjs.com/package/@camunda8/orchestration-cluster-api).

## Features

- **Minimal Dependencies**: Only one runtime dependency (`@camunda8/orchestration-cluster-api`)
- **Multi-Tenant Support**: Full support for multi-tenancy across all operations
- **Profile Management**: Store and manage multiple cluster configurations
- **Camunda Modeler Integration**: Automatically import and use profiles from Camunda Modeler
- **Plugin System**: Extend c8ctl with custom commands via npm packages
- **Building Block Deployment**: Automatic prioritization of `*_bb-*` folders during deployment, marked with 🧱 in results
- **Process Application Support**: Resources in folders with `.process-application` file marked with 📦 in results
- **Enhanced Deployment Results**: Table view showing file paths, visual indicators, resource details, and versions
- **Watch Mode**: Monitors a folder for file changes and auto-redeploys (configurable extensions via `--extensions`)
- **`.c8ignore` Support**: Filter deploy/watch file scanning with `.gitignore`-style patterns; `node_modules/`, `target/`, `.git/` ignored by default
- **Open Applications**: Open Camunda web applications (Operate, Tasklist, Modeler, Optimize) in the browser directly from the CLI
- **Search**: Powerful search across process definitions, process instances, user tasks, incidents, jobs, and variables with filter, wildcard, and case-insensitive support
- **Flexible Output**: Switch between human-readable text and JSON output modes

## Beware the 🤖

_Full transparency_:  
this cli is also a pilot-coding experiment, practicing [Agentic Engineering](https://addyosmani.com/blog/agentic-engineering/).  
Guided by humans, the codebase is (mostly) built by your friendly neighborhood LLM, fully dogfooding the Human-in-the-Loop pattern.

## Installation

### Requirements

- Node.js >= 22.18.0 (for native TypeScript support)

### Global Installation (Recommended)

```bash
npm install @camunda8/cli -g
```

After installation, the CLI is available as `c8ctl` (or its alias `c8`).

**Note**: The `c8` alias provides typing ergonomics for common keyboard layouts - the `c` key (left index finger) followed by `8` (right middle finger) makes for a comfortable typing experience on both QWERTY and QWERTZ keyboards.

## Usage

### Getting Help

```bash
# Show general help
c8ctl help

# Show detailed help for specific commands with all flags
c8ctl help list       # Shows all list resources and their flags
c8ctl help get        # Shows all get resources and their flags
c8ctl help create     # Shows all create resources and their flags
c8ctl help complete   # Shows all complete resources and their flags
c8ctl help await      # Shows await command with all flags
c8ctl help search     # Shows all search resources and their flags
c8ctl help deploy     # Shows deploy command with all flags
c8ctl help run        # Shows run command with all flags
c8ctl help watch      # Shows watch command with all flags
c8ctl help open       # Shows open command with all apps
c8ctl help cancel     # Shows cancel command with all flags
c8ctl help resolve    # Shows resolve command with all flags
c8ctl help fail       # Shows fail command with all flags
c8ctl help activate   # Shows activate command with all flags
c8ctl help publish    # Shows publish command with all flags
c8ctl help correlate  # Shows correlate command with all flags
c8ctl help cluster    # Shows local cluster management help
c8ctl help profiles   # Shows profile management help
c8ctl help plugin     # Shows plugin management help

# Show version
c8ctl --version
```

### Default Extensions

When scanning directories, `deploy`, `run`, and `watch` only include files with these extensions:

`.bpmn`, `.dmn`, `.form`, `.md`, `.txt`, `.xml`, `.rpa`, `.json`, `.config`, `.yml`, `.yaml`

Use `--extensions` to override (e.g. `--extensions=.bpmn,.dmn`).

### Ignoring Files (`.c8ignore`)

When scanning directories for deployment artifacts, c8ctl automatically ignores:

- `node_modules/`
- `target/`
- `.git/`

Create a `.c8ignore` file in your project root to add custom patterns (`.gitignore` syntax):

```gitignore
# Ignore build output
dist/
build/

# Ignore draft processes
**/draft-*.bpmn

# But keep this specific one
!draft-approved.bpmn
```

`.c8ignore` rules apply to both `deploy` (directory scan) and `watch` (file monitoring).

For comprehensive examples of all commands and their flags, see [EXAMPLES.md](EXAMPLES.md).

### Shell Completion

c8ctl supports shell completion for `bash`, `zsh`, and `fish`.

#### Quick Install (recommended)

```bash
# Auto-detect your shell and install completions
c8ctl completion install

# Or specify a shell explicitly
c8ctl completion install --shell zsh
```

This writes a completion script to the c8ctl data directory and wires it into your shell config (RC file for bash/zsh; completions directory for fish). Completions are **automatically refreshed** when c8ctl is upgraded — no manual re-install needed.

#### Manual Setup

If you prefer to manage the completion script yourself:

#### Bash

```bash
# Generate and source completion script
c8ctl completion bash > ~/.c8ctl-completion.bash
echo 'source ~/.c8ctl-completion.bash' >> ~/.bashrc
source ~/.bashrc
```

Or for immediate use in the current session:

```bash
source <(c8ctl completion bash)
```

#### Zsh

```bash
# Generate and source completion script
c8ctl completion zsh > ~/.c8ctl-completion.zsh
echo 'source ~/.c8ctl-completion.zsh' >> ~/.zshrc
source ~/.zshrc
```

Or for immediate use in the current session:

```bash
source <(c8ctl completion zsh)
```

#### Fish

```bash
# Generate and install completion script
c8ctl completion fish > ~/.config/fish/completions/c8ctl.fish
```

Fish will automatically load the completion on next shell start.

### Credential Resolution

Credentials are resolved in the following order:

1. `--profile` flag (one-off override)
2. Active profile from session state (⚠ warns if `CAMUNDA_*` env vars are also present)
3. Environment variables (`CAMUNDA_*`)
4. Default `local` profile (`http://localhost:8080/v2`)

**Note**: Credential configuration via environment variables follows the same conventions as the `@camunda8/orchestration-cluster-api` module.

```bash
# Using environment variables
export CAMUNDA_BASE_URL=https://camunda.example.com
export CAMUNDA_CLIENT_ID=your-client-id
export CAMUNDA_CLIENT_SECRET=your-client-secret
c8ctl list process-instances

# Create a profile from a .env file
c8ctl add profile staging --from-file .env.staging

# Create a profile from current environment variables
source .env.prod
c8ctl add profile prod --from-env

# Clear the active session profile (so env vars take effect)
c8ctl use profile --none

# Using profile override
c8ctl list process-instances --profile prod
```

### Tenant Resolution

Tenants are resolved in the following order:

1. Active tenant from session state
2. Default tenant from active profile
3. `CAMUNDA_DEFAULT_TENANT_ID` environment variable
4. `<default>` tenant

```bash
# Set active tenant for the session
c8ctl use tenant my-tenant-id

# Now all commands use this tenant
c8ctl list process-instances
```

### Profile Management

c8ctl supports two types of profiles:

1. **c8ctl profiles**: Managed directly by c8ctl
2. **Camunda Modeler profiles**: Automatically imported from Camunda Modeler (with `modeler:` prefix)

For profile-related commands and flags, run:

```bash
c8ctl help profiles
```

```bash
# Add a c8ctl profile
c8 add profile prod --baseUrl=https://camunda.example.com --clientId=xxx --clientSecret=yyy

# List all profiles (includes both c8ctl and modeler profiles)
c8 list profiles

# Set active profile (works with both types)
c8 use profile prod
c8 use profile "modeler:Local Dev"

# Remove c8ctl profile (modeler profiles are read-only)
c8 remove profile prod
```

#### Camunda Modeler Integration

c8ctl automatically reads profiles from Camunda Modeler's `profiles.json` file. These profiles are:

- **Read-only**: Cannot be modified or deleted via c8ctl
- **Prefixed**: Always displayed with `modeler:` prefix (e.g., `modeler:Local Dev`)
- **Dynamic**: Loaded fresh on each command execution (no caching)
- **Platform-specific locations**:
  - Linux: `~/.config/camunda-modeler/profiles.json`
  - macOS: `~/Library/Application Support/camunda-modeler/profiles.json`
  - Windows: `%APPDATA%\camunda-modeler\profiles.json`

**Using modeler profiles:**

```bash
# List includes modeler profiles with 'modeler:' prefix
c8 list profiles

# Use a modeler profile by name
c8 use profile modeler:Local Dev

# Use a modeler profile by cluster ID
c8 use profile modeler:abc123-def456

# One-off command with modeler profile
c8 list pi --profile=modeler:Cloud Cluster
```

**URL Construction:**

- **Self-managed** (localhost): Appends `/v2` to the URL (e.g., `http://localhost:8080/v2`)
- **Cloud**: Uses the cluster URL as-is (e.g., `https://abc123.region.zeebe.camunda.io`)
- **Any port**: Supports any port number in the URL

### Session Management

```bash
# Show current output mode
c8ctl output

# Switch to JSON output
c8ctl output json

# Switch back to text output
c8ctl output text
```

### Debug Mode

Enable debug logging to see detailed information about plugin loading and other internal operations:

```bash
# Enable debug mode with environment variable
DEBUG=1 c8 <command>

# Or use C8CTL_DEBUG
C8CTL_DEBUG=true c8 <command>

# Example: See plugin loading details
DEBUG=1 c8 list plugins
```

Debug output is written to stderr with timestamps and won't interfere with normal command output.

### Plugin Management

c8ctl supports a global plugin system that allows extending the CLI with custom commands via npm packages. Plugins are installed globally to a user-specific directory and tracked in a registry file.

**Plugin Storage Locations:**

The plugin system uses OS-specific directories:

| OS | Plugins Directory | Registry File |
|----|-------------------|---------------|
| **Linux** | `~/.config/c8ctl/plugins/node_modules` | `~/.config/c8ctl/plugins.json` |
| **macOS** | `~/Library/Application Support/c8ctl/plugins/node_modules` | `~/Library/Application Support/c8ctl/plugins.json` |
| **Windows** | `%APPDATA%\c8ctl\plugins\node_modules` | `%APPDATA%\c8ctl\plugins.json` |

> **Note:** You can override the data directory with the `C8CTL_DATA_DIR` environment variable.

```bash
# Create a new plugin from template
c8ctl init plugin my-plugin

# Load a plugin from npm registry
c8ctl load plugin <package-name>

# Load a plugin from a URL (including file URLs)
c8ctl load plugin --from <url>
c8ctl load plugin --from file:///path/to/plugin
c8ctl load plugin --from https://github.com/user/repo
c8ctl load plugin --from git://github.com/user/repo.git

# Upgrade a plugin to latest or specific version
c8ctl upgrade plugin <package-name>
c8ctl upgrade plugin <package-name> 1.2.3

# Downgrade a plugin to a specific version
c8ctl downgrade plugin <package-name> 1.0.0

# Unload a plugin
c8ctl unload plugin <package-name>

# List installed plugins (shows version and sync status)
c8ctl list plugins

# Synchronize plugins from registry
# - First tries npm rebuild for installed plugins
# - Falls back to fresh npm install if rebuild fails
c8ctl sync plugins

# View help including plugin commands
c8ctl help
```

**Global Plugin System:**

- Plugins are installed to a global directory (OS-specific, see table above)
- Plugin registry file (`plugins.json`) tracks all installed plugins
- No local `package.json` is required in your working directory
- Plugins are available globally from any directory
- The registry serves as the source of truth for installed plugins
- Default plugins are bundled with c8ctl and loaded automatically
- **Plugin commands cannot override built-in commands** - built-in commands always take precedence
- `c8ctl list plugins` shows plugin versions and sync status:
  - `✓ Installed` - Plugin is in registry and installed
  - `⚠ Not installed` - Plugin is in registry but not in global directory (run `sync`)
  - `⚠ Not in registry` - Plugin is installed but not tracked in registry
- `c8ctl sync plugins` synchronizes plugins from the registry, rebuilding or reinstalling as needed
- `c8ctl upgrade plugin <name> [version]` respects the plugin source from the registry:
  - without `version`: reinstalls the registered source as-is
  - npm package source with `version`: installs `<name>@<version>`
  - URL/git source with `version`: installs `<source>#<version>`
  - file source (`file://`) with `version`: version upgrade is not supported; use `load plugin --from` with the desired local plugin checkout
- `c8ctl downgrade plugin <name> <version>` respects the plugin source from the registry:
  - npm package source: installs `<name>@<version>`
  - URL/git source: installs `<source>#<version>`
  - file source (`file://`): version downgrade is not supported; use `load plugin --from` with the desired local plugin checkout

**Plugin Development:**

- Use `c8ctl init plugin <name>` to scaffold a new plugin with TypeScript template
- Convention over configuration: the directory is always prefixed with `c8ctl-plugin-`, and the plugin is registered by the suffix after the prefix (e.g., `c8ctl init plugin c8ctl-plugin-foo` creates directory `c8ctl-plugin-foo` and registers plugin name `foo`)
- Generated scaffold includes all necessary files, build configuration, and an `AGENTS.md` guide for autonomous plugin implementation
- Plugins have access to the c8ctl runtime via `globalThis.c8ctl`
- Plugins can create SDK clients via `globalThis.c8ctl.createClient(profile?, sdkConfig?)`
- Plugins can resolve tenant IDs via `globalThis.c8ctl.resolveTenantId(profile?)`
- Plugins can access c8ctl output-aware logging via `globalThis.c8ctl.getLogger()`
- See the bundled `hello-world` plugin in `default-plugins/` for a complete example

**Plugin Requirements:**

- Plugin packages must be regular Node.js modules
- They must include a `c8ctl-plugin.js` or `c8ctl-plugin.ts` file in the root directory
- The plugin file must export a `commands` object
- Optionally export a `metadata` object to provide help text
- Plugins are installed globally and work from any directory
- The runtime object `c8ctl` provides environment information to plugins
- The runtime object `c8ctl` exposes `createClient(profile?, sdkConfig?)` for creating Camunda SDK clients from plugins
- The runtime object `c8ctl` exposes `resolveTenantId(profile?)` using the same fallback logic as built-in commands
- The runtime object `c8ctl` exposes `getLogger()` returning the c8ctl logger instance (respects current output mode)
- **Important**: `c8ctl-plugin.js` must be JavaScript. Node.js doesn't support type stripping in `node_modules`. If writing in TypeScript, transpile to JS before publishing.

**TypeScript Plugin Autocomplete:**

```typescript
import type { C8ctlPluginRuntime } from '@camunda8/cli/runtime';

const c8ctl = globalThis.c8ctl as C8ctlPluginRuntime;
const tenantId = c8ctl.resolveTenantId();
const logger = c8ctl.getLogger();
logger.info(`Tenant: ${tenantId}`);
```

**Example Plugin Structure:**

```typescript
// c8ctl-plugin.ts
export const metadata = {
  name: 'my-plugin',
  description: 'My custom c8ctl plugin',
  commands: {
    analyze: {
      description: 'Analyze BPMN processes'
    }
  }
};

export const commands = {
  analyze: async (args: string[]) => {
    console.log('Analyzing...', args);
  }
};
```

When plugins are loaded, their commands automatically appear in `c8ctl help` output. See [PLUGIN-HELP.md](PLUGIN-HELP.md) for detailed documentation on plugin help integration.

---

## Agent Usage (AI / Programmatic Consumption)

c8ctl ships two flags designed specifically for AI agents and programmatic consumers.
They appear in their own clearly labelled section in `c8ctl help`.

> For a full machine-readable reference, see [`CONTEXT.md`](./CONTEXT.md).

### `--fields <comma-separated>`

Filters output to only the specified field names. Applies to all `list`, `search`,
and `get` commands. Field matching is **case-insensitive**.

```bash
# Only return Key and State columns — reduces context window size
c8ctl list pi --fields Key,State
c8ctl search pd --fields Key,processDefinitionId,name

# Works in both text and JSON modes
c8ctl output json
c8ctl list pi --fields Key,State,processDefinitionId | jq .
```

### `--dry-run`

Previews the API request that **would** be sent without executing it.
Works on **all commands**: queries (`list`, `search`, `get`) and mutations
(`create`, `cancel`, `deploy`, `complete`, `fail`, `activate`, `resolve`,
`publish`, `correlate`).

Emits a JSON object to stdout and exits 0:
```json
{
  "dryRun": true,
  "command": "create process-instance",
  "method": "POST",
  "url": "http://localhost:8080/v2/process-instances",
  "body": { "processDefinitionId": "my-process", "tenantId": "<default>" }
}
```

**Recommended agent workflow for mutations:**
1. Run with `--dry-run` and show the user the would-be API call
2. Wait for user confirmation
3. Re-run without `--dry-run` to execute

```bash
# Preview before creating
c8ctl create pi --id=my-process --dry-run

# Preview a deployment
c8ctl deploy ./my-process.bpmn --dry-run

# Preview cancelling a process instance
c8ctl cancel pi 2251799813685249 --dry-run

# Debug a search query — see the filter body that would be sent
c8ctl search pi --state ACTIVE --between 2024-01-01..2024-12-31 --dry-run

# Inspect a list operation
c8ctl list pd --dry-run

# Preview a get request
c8ctl get pi 12345 --dry-run
```

### Machine-Readable Help (JSON Mode)

In JSON output mode, `c8ctl help` emits structured JSON containing the full
command tree, flags (with types), and agent flags:

```bash
c8ctl output json
c8ctl help          # → JSON with commands[], globalFlags[], agentFlags[], resourceAliases
c8ctl help list     # → JSON for specific command
```

---

### Local Cluster

c8ctl includes a built-in `cluster` command for managing a local Camunda 8 instance (powered by a default plugin). No Docker or docker-compose required — it downloads and runs Camunda directly.

```bash
# Start the latest stable version
c8ctl cluster start

# Start a specific version
c8ctl cluster start 8.9
c8ctl cluster start 8.9.0-alpha5

# Stop the running cluster
c8ctl cluster stop

# Check cluster status
c8ctl cluster status

# Stream cluster logs
c8ctl cluster logs

# List locally cached versions
c8ctl cluster list

# List available remote versions
c8ctl cluster list-remote

# Pre-download a version without starting it
c8ctl cluster install 8.9

# Remove a cached version
c8ctl cluster delete 8.9
```

#### Version Aliases

Instead of an exact version number, you can use:

- **`stable`** — the latest GA release (highest minor version that has shipped a `.0` release)
- **`alpha`** — the latest alpha-train release (highest minor version overall, which may only have alpha builds)
- **A major.minor pattern** like `8.9` — resolves to the latest patch/alpha within that minor

`c8ctl cluster start` with no version argument defaults to `stable`.

```bash
c8ctl cluster start stable
c8ctl cluster start alpha
c8ctl cluster start 8.9     # latest 8.9.x
```

#### Online vs Offline Behaviour

- **`cluster start`** prefers locally cached versions. If the requested version is already installed, it starts immediately without going online. A non-blocking background check runs to hint if a newer build is available, but never delays startup.
- **`cluster install`** always checks the remote download server for the latest build. If a newer ETag is detected for an already-installed version, it re-downloads.
- **`cluster list-remote`** fetches the full list of available versions from the download server.
- **Offline fallback**: if the network is unavailable, alias resolution falls back to a locally cached mapping, then to a hardcoded default.

Run `c8ctl help cluster` for full details. See [EXAMPLES.md](EXAMPLES.md#local-cluster) for a complete local development workflow.

---

### Core Components

- **Logger** (`src/logger.ts`): Handles output in text or JSON mode
- **Config** (`src/config.ts`): Manages profiles, session state, and credential resolution
- **Client** (`src/client.ts`): Factory for creating Camunda 8 SDK clients
- **Commands** (`src/commands/`): Domain-specific command handlers

### Command Structure

```shell
c8ctl <verb> <resource> [arguments] [flags]
```

**Verbs**:

- `list` - List resources
- `search` - Search resources with filters
- `get` - Get resource by key
- `create` - Create resource
- `cancel` - Cancel resource
- `complete` - Complete resource
- `fail` - Fail a job
- `activate` - Activate jobs
- `resolve` - Resolve incident
- `publish` - Publish message
- `correlate` - Correlate message
- `deploy` - Deploy resources
- `run` - Deploy and start process
- `watch` (alias: `w`) - Watch for changes and auto-deploy
- `add` - Add a profile
- `remove` (alias: `rm`) - Remove a profile
- `load` - Load a plugin
- `unload` - Unload a plugin
- `sync` - Synchronize plugins
- `use` - Set active profile or tenant
- `output` - Show or set output format
- `cluster` - Manage local Camunda 8 cluster (start, stop, status, logs, install, delete, list, list-remote)
- `completion` - Generate shell completion script
- `feedback` - Open the feedback page to report issues or request features

**Resources**: process-instance (pi), process-definition (pd), user-task (ut), incident (inc), job, jobs, variables (vars), message (msg), topology, profile, tenant, plugin

**Tip**: Run `c8ctl help <command>` to see detailed help for specific commands with all available flags.

## Testing

### Run All Tests

```bash
npm test
```

### Run Unit Tests Only

```bash
npm run test:unit
```

### Run Integration Tests

Integration tests require a running Camunda 8 instance at `http://localhost:8080`.

1. Start a local Camunda 8 instance (e.g., using `c8ctl cluster start`)
2. Run: `npm run test:integration`

## Development

- **Native TypeScript**: Runs directly with Node.js 22.18+ (no compilation needed)

### Project Structure

```shell
c8ctl/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── logger.ts             # Output handling
│   ├── config.ts             # Configuration management
│   ├── client.ts             # SDK client factory
│   └── commands/             # Command handlers
│       └── ...
├── tests/
│   ├── unit/                 # Unit tests
│   ├── integration/          # Integration tests
│   └── fixtures/             # Test fixtures
├── package.json
├── tsconfig.json
└── README.md
```

### Running the CLI

```bash
# If installed globally
c8ctl <command>
# Or using the alias
c8 <command>

# For local development with Node.js 22.18+ (native TypeScript)
node src/index.ts <command>

# Testing with npm link (requires build first)
npm run build
npm link
c8ctl <command>
```

**Note**: The build step is only required for publishing or using `npm link`. Development uses native TypeScript execution via `node src/index.ts`.

### Adding New Commands

1. Create command handler in `src/commands/`
2. Wire into `src/index.ts` command routing
3. Add tests in `tests/unit/` and `tests/integration/`
4. Update help text in `src/commands/help.ts`
5. Document in `EXAMPLES.md`

## Environment Variables

- `CAMUNDA_BASE_URL`: Cluster base URL
- `CAMUNDA_CLIENT_ID`: OAuth client ID
- `CAMUNDA_CLIENT_SECRET`: OAuth client secret
- `CAMUNDA_TOKEN_AUDIENCE`: OAuth token audience
- `CAMUNDA_OAUTH_URL`: OAuth token endpoint
- `CAMUNDA_DEFAULT_TENANT_ID`: Default tenant ID

## Configuration Files

### c8ctl Configuration

Configuration is stored in platform-specific user data directories:

- **Linux**: `~/.config/c8ctl/`
- **macOS**: `~/Library/Application Support/c8ctl/`
- **Windows**: `%APPDATA%\c8ctl\`

Files:

- `profiles.json`: Saved cluster configurations
- `session.json`: Active profile, tenant, and output mode
- `plugins.json`: Plugin registry tracking installed plugins

### Camunda Modeler Configuration

c8ctl automatically reads profiles from Camunda Modeler (if installed):

- **Linux**: `~/.config/camunda-modeler/profiles.json`
- **macOS**: `~/Library/Application Support/camunda-modeler/profiles.json`
- **Windows**: `%APPDATA%\camunda-modeler\profiles.json`

Modeler profiles are:

- Read-only in c8ctl (managed via Camunda Modeler)
- Automatically loaded on each command execution
- Prefixed with `modeler:` when used in c8ctl
- Support both cloud and self-managed clusters

<!-- command-reference:start -->

## Command Reference

<!-- Auto-generated from COMMAND_REGISTRY. Do not edit manually.
     Run: node --experimental-strip-types scripts/sync-readme-commands.ts -->

### Global Flags

These flags are accepted by every command.

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--help` / `-h` | boolean |  | Show help |
| `--version` / `-v` | string |  | Show CLI version, or filter by process definition version on supported commands |
| `--profile` | string |  | Use a specific profile |
| `--dry-run` | boolean |  | Preview the API request without executing |
| `--verbose` | boolean |  | Show verbose output |
| `--fields` | string |  | Comma-separated list of fields to display |

### Resource Aliases

| Alias | Resource |
|-------|----------|
| `auth` | `authorization` |
| `inc` | `incident` |
| `mr` | `mapping-rule` |
| `msg` | `message` |
| `pd` | `process-definition` |
| `pi` | `process-instance` |
| `ut` | `user-task` |
| `vars` | `variable` |
| `var` | `variable` |

### Search Flags

These flags are available on `list` and `search` commands.

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--sortBy` | string |  | Sort results by field |
| `--asc` | boolean |  | Sort ascending |
| `--desc` | boolean |  | Sort descending |
| `--limit` | string |  | Maximum number of results |
| `--between` | string |  | Date range filter (e.g. 7d, 30d, 2024-01-01..2024-12-31) |
| `--dateField` | string |  | Date field for --between filter |

### Commands

#### `list`

List resources

**Resources:** pi (process-instance), pd (process-definition), ut (user-task), inc (incident), jobs, profiles (profile), plugins (plugin), users (user), roles (role), groups (group), tenants (tenant), auth (authorization), mapping-rules (mapping-rule)

**Verb-level flags:**

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--all` | boolean |  | List all (disable pagination limit) |

**Resource-specific flags:**

<details>
<summary><code>process-definition</code> (<code>pd</code>)</summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--bpmnProcessId` | string |  | Filter by BPMN process ID |
| `--id` | string |  | Filter by BPMN process ID (alias) |
| `--processDefinitionId` | string |  | Filter by process definition ID |
| `--name` | string |  | Filter by name |
| `--key` | string |  | Filter by key |
| `--iid` | string |  | Case-insensitive filter by BPMN process ID |
| `--iname` | string |  | Case-insensitive filter by name |

</details>

<details>
<summary><code>process-instance</code> (<code>pi</code>)</summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--bpmnProcessId` | string |  | Filter by BPMN process ID |
| `--id` | string |  | Filter by BPMN process ID (alias) |
| `--processDefinitionId` | string |  | Filter by process definition ID |
| `--processDefinitionKey` | string |  | Filter by process definition key |
| `--state` | string |  | Filter by state (ACTIVE, COMPLETED, etc) |
| `--key` | string |  | Filter by key |
| `--parentProcessInstanceKey` | string |  | Filter by parent process instance key |
| `--iid` | string |  | Case-insensitive filter by BPMN process ID |

</details>

<details>
<summary><code>user-task</code> (<code>ut</code>)</summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--state` | string |  | Filter by state |
| `--assignee` | string |  | Filter by assignee |
| `--processInstanceKey` | string |  | Filter by process instance key |
| `--processDefinitionKey` | string |  | Filter by process definition key |
| `--elementId` | string |  | Filter by element ID |
| `--iassignee` | string |  | Case-insensitive filter by assignee |

</details>

<details>
<summary><code>incident</code> (<code>inc</code>)</summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--state` | string |  | Filter by state |
| `--processInstanceKey` | string |  | Filter by process instance key |
| `--processDefinitionKey` | string |  | Filter by process definition key |
| `--bpmnProcessId` | string |  | Filter by BPMN process ID |
| `--id` | string |  | Filter by BPMN process ID (alias) |
| `--processDefinitionId` | string |  | Filter by process definition ID |
| `--errorType` | string |  | Filter by error type |
| `--errorMessage` | string |  | Filter by error message |
| `--ierrorMessage` | string |  | Case-insensitive filter by error message |
| `--iid` | string |  | Case-insensitive filter by BPMN process ID |

</details>

<details>
<summary><code>jobs</code></summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--state` | string |  | Filter by state |
| `--type` | string |  | Filter by job type |
| `--processInstanceKey` | string |  | Filter by process instance key |
| `--processDefinitionKey` | string |  | Filter by process definition key |
| `--itype` | string |  | Case-insensitive filter by job type |

</details>

<details>
<summary><code>user</code></summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--username` | string |  | Filter by username |
| `--name` | string |  | Filter by name |
| `--email` | string |  | Filter by email |

</details>

<details>
<summary><code>role</code></summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--roleId` | string |  | Filter by role ID |
| `--name` | string |  | Filter by name |

</details>

<details>
<summary><code>group</code></summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--groupId` | string |  | Filter by group ID |
| `--name` | string |  | Filter by name |

</details>

<details>
<summary><code>tenant</code></summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--tenantId` | string |  | Filter by tenant ID |
| `--name` | string |  | Filter by name |

</details>

<details>
<summary><code>authorization</code> (<code>auth</code>)</summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--ownerId` | string |  | Filter by owner ID |
| `--ownerType` | string |  | Filter by owner type |
| `--resourceType` | string |  | Filter by resource type |
| `--resourceId` | string |  | Filter by resource ID |

</details>

<details>
<summary><code>mapping-rule</code> (<code>mr</code>)</summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--mappingRuleId` | string |  | Filter by mapping rule ID |
| `--name` | string |  | Filter by name |
| `--claimName` | string |  | Filter by claim name |
| `--claimValue` | string |  | Filter by claim value |

</details>

**Examples:**

```bash
c8ctl list pi                                               # List process instances
c8ctl list pd                                               # List process definitions
c8ctl list users                                            # List users
```

---

#### `search`

Search resources with filters (wildcards, date ranges, case-insensitive)

**Resources:** pi (process-instance), pd (process-definition), ut (user-task), inc (incident), jobs, vars (variable), users (user), roles (role), groups (group), tenants (tenant), auth (authorization), mapping-rules (mapping-rule)

**Resource-specific flags:**

<details>
<summary><code>process-definition</code> (<code>pd</code>)</summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--bpmnProcessId` | string |  | Filter by BPMN process ID |
| `--id` | string |  | Filter by BPMN process ID (alias) |
| `--processDefinitionId` | string |  | Filter by process definition ID |
| `--name` | string |  | Filter by name |
| `--key` | string |  | Filter by key |
| `--iid` | string |  | Case-insensitive filter by BPMN process ID |
| `--iname` | string |  | Case-insensitive filter by name |

</details>

<details>
<summary><code>process-instance</code> (<code>pi</code>)</summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--bpmnProcessId` | string |  | Filter by BPMN process ID |
| `--id` | string |  | Filter by BPMN process ID (alias) |
| `--processDefinitionId` | string |  | Filter by process definition ID |
| `--processDefinitionKey` | string |  | Filter by process definition key |
| `--state` | string |  | Filter by state (ACTIVE, COMPLETED, etc) |
| `--key` | string |  | Filter by key |
| `--parentProcessInstanceKey` | string |  | Filter by parent process instance key |
| `--iid` | string |  | Case-insensitive filter by BPMN process ID |

</details>

<details>
<summary><code>user-task</code> (<code>ut</code>)</summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--state` | string |  | Filter by state |
| `--assignee` | string |  | Filter by assignee |
| `--processInstanceKey` | string |  | Filter by process instance key |
| `--processDefinitionKey` | string |  | Filter by process definition key |
| `--elementId` | string |  | Filter by element ID |
| `--iassignee` | string |  | Case-insensitive filter by assignee |

</details>

<details>
<summary><code>incident</code> (<code>inc</code>)</summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--state` | string |  | Filter by state |
| `--processInstanceKey` | string |  | Filter by process instance key |
| `--processDefinitionKey` | string |  | Filter by process definition key |
| `--bpmnProcessId` | string |  | Filter by BPMN process ID |
| `--id` | string |  | Filter by BPMN process ID (alias) |
| `--processDefinitionId` | string |  | Filter by process definition ID |
| `--errorType` | string |  | Filter by error type |
| `--errorMessage` | string |  | Filter by error message |
| `--ierrorMessage` | string |  | Case-insensitive filter by error message |
| `--iid` | string |  | Case-insensitive filter by BPMN process ID |

</details>

<details>
<summary><code>jobs</code></summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--state` | string |  | Filter by state |
| `--type` | string |  | Filter by job type |
| `--processInstanceKey` | string |  | Filter by process instance key |
| `--processDefinitionKey` | string |  | Filter by process definition key |
| `--itype` | string |  | Case-insensitive filter by job type |

</details>

<details>
<summary><code>variable</code> (<code>var</code>, <code>vars</code>)</summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--name` | string |  | Filter by variable name |
| `--value` | string |  | Filter by value |
| `--processInstanceKey` | string |  | Filter by process instance key |
| `--scopeKey` | string |  | Filter by scope key |
| `--fullValue` | boolean |  | Return full variable values (not truncated) |
| `--iname` | string |  | Case-insensitive filter by name |
| `--ivalue` | string |  | Case-insensitive filter by value |

</details>

<details>
<summary><code>user</code></summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--username` | string |  | Filter by username |
| `--name` | string |  | Filter by name |
| `--email` | string |  | Filter by email |

</details>

<details>
<summary><code>role</code></summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--roleId` | string |  | Filter by role ID |
| `--name` | string |  | Filter by name |

</details>

<details>
<summary><code>group</code></summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--groupId` | string |  | Filter by group ID |
| `--name` | string |  | Filter by name |

</details>

<details>
<summary><code>tenant</code></summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--tenantId` | string |  | Filter by tenant ID |
| `--name` | string |  | Filter by name |

</details>

<details>
<summary><code>authorization</code> (<code>auth</code>)</summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--ownerId` | string |  | Filter by owner ID |
| `--ownerType` | string |  | Filter by owner type |
| `--resourceType` | string |  | Filter by resource type |
| `--resourceId` | string |  | Filter by resource ID |

</details>

<details>
<summary><code>mapping-rule</code> (<code>mr</code>)</summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--mappingRuleId` | string |  | Filter by mapping rule ID |
| `--name` | string |  | Filter by name |
| `--claimName` | string |  | Filter by claim name |
| `--claimValue` | string |  | Filter by claim value |

</details>

**Examples:**

```bash
c8ctl search pi --state=ACTIVE                              # Search for active process instances
c8ctl search pd --bpmnProcessId=myProcess                   # Search process definitions by ID
c8ctl search pd --name='*main*'                             # Search process definitions with wildcard
c8ctl search ut --assignee=john                             # Search user tasks assigned to john
c8ctl search inc --state=ACTIVE                             # Search for active incidents
c8ctl search jobs --type=myJobType                          # Search jobs by type
c8ctl search jobs --type='*service*'                        # Search jobs with type containing "service"
c8ctl search variables --name=myVar                         # Search for variables by name
c8ctl search variables --value=foo                          # Search for variables by value
c8ctl search variables --processInstanceKey=123 --fullValue  # Search variables with full values
c8ctl search pd --iname='*order*'                           # Case-insensitive search by name
c8ctl search ut --iassignee=John                            # Case-insensitive search by assignee
```

---

#### `get`

Get a resource by key

**Resources:** pi (process-instance), pd (process-definition), inc (incident), topology, form, user, role, group, tenant, auth (authorization), mapping-rule

**Positional arguments:**

- **process-definition:** `<key>` (required)
- **process-instance:** `<key>` (required)
- **incident:** `<key>` (required)
- **user:** `<username>` (required)
- **role:** `<roleId>` (required)
- **group:** `<groupId>` (required)
- **tenant:** `<tenantId>` (required)
- **authorization:** `<authorizationKey>` (required)
- **mapping-rule:** `<mappingRuleId>` (required)
- **form:** `<key>` (required)

**Resource-specific flags:**

<details>
<summary><code>process-definition</code> (<code>pd</code>)</summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--xml` | boolean |  | Get BPMN XML (process definitions) |

</details>

<details>
<summary><code>form</code></summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--userTask` | boolean |  | Get form for user task |
| `--ut` | boolean |  | Alias for --userTask |
| `--processDefinition` | boolean |  | Get form for process definition |
| `--pd` | boolean |  | Alias for --processDefinition |

</details>

<details>
<summary><code>process-instance</code> (<code>pi</code>)</summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--variables` | boolean |  | Include variables in output |

</details>

**Examples:**

```bash
c8ctl get pi 123456                                         # Get process instance by key
c8ctl get pi 123456 --variables                             # Get process instance with variables
c8ctl get pd 123456                                         # Get process definition by key
c8ctl get pd 123456 --xml                                   # Get process definition XML
c8ctl get form 123456                                       # Get form (searches both user task and process definition)
c8ctl get form 123456 --ut                                  # Get form for user task only
c8ctl get form 123456 --pd                                  # Get start form for process definition only
c8ctl get user john                                         # Get user by username
```

---

#### `create`

Create a resource (process instance, identity)

**Resources:** pi (process-instance), user, role, group, tenant, auth (authorization), mapping-rule

**Verb-level flags:**

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--processDefinitionId` | string |  | Process definition ID (BPMN process ID) |
| `--id` | string |  | Process definition ID (alias for --processDefinitionId) |
| `--bpmnProcessId` | string |  | BPMN process ID (alias for --processDefinitionId) |
| `--variables` | string |  | JSON variables |
| `--awaitCompletion` | boolean |  | Wait for process to complete |
| `--fetchVariables` | boolean |  | Fetch result variables on completion |
| `--requestTimeout` | string |  | Await timeout in milliseconds |
| `--username` | string |  | Username |
| `--name` | string |  | Display name |
| `--email` | string |  | Email address |
| `--password` | string |  | Password |
| `--roleId` | string |  | Role ID |
| `--groupId` | string |  | Group ID |
| `--tenantId` | string |  | Tenant ID |
| `--mappingRuleId` | string |  | Mapping rule ID |
| `--claimName` | string |  | Claim name |
| `--claimValue` | string |  | Claim value |

**Resource-specific flags:**

<details>
<summary><code>authorization</code> (<code>auth</code>)</summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--ownerId` | string | Yes | Authorization owner ID |
| `--ownerType` | string | Yes | Authorization owner type |
| `--resourceType` | string | Yes | Authorization resource type |
| `--resourceId` | string | Yes | Authorization resource ID |
| `--permissions` | string | Yes | Comma-separated permissions |

</details>

**Examples:**

```bash
c8ctl create pi --id=myProcess                              # Create a process instance
c8ctl create pi --id=myProcess --awaitCompletion            # Create and await completion
c8ctl create user --username=john --name='John Doe' --email=john@example.com --password=secret  # Create a user
```

---

#### `delete`

Delete a resource by key

**Usage:** `c8ctl delete <resource> <key>`

**Resources:** user, role, group, tenant, auth (authorization), mapping-rule

**Positional arguments:**

- **user:** `<username>` (required)
- **role:** `<roleId>` (required)
- **group:** `<groupId>` (required)
- **tenant:** `<tenantId>` (required)
- **authorization:** `<authorizationKey>` (required)
- **mapping-rule:** `<mappingRuleId>` (required)

**Examples:**

```bash
c8ctl delete user john                                      # Delete user
```

---

#### `cancel`

Cancel a process instance

**Usage:** `c8ctl cancel <resource> <key>`

**Resources:** pi (process-instance)

**Positional arguments:**

- **process-instance:** `<key>` (required)

---

#### `await`

Create and await process instance completion (server-side waiting)

**Usage:** `c8ctl await <resource>`

**Resources:** pi (process-instance)

**Flags:**

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--processDefinitionId` | string |  | Process definition ID (BPMN process ID) |
| `--id` | string |  | Process definition ID (alias for --processDefinitionId) |
| `--bpmnProcessId` | string |  | BPMN process ID (alias for --processDefinitionId) |
| `--variables` | string |  | JSON variables |
| `--fetchVariables` | boolean |  | Fetch result variables on completion |
| `--requestTimeout` | string |  | Await timeout in milliseconds |

**Examples:**

```bash
c8ctl await pi --id=myProcess                               # Create and wait for completion
```

---

#### `complete`

Complete a user task or job

**Usage:** `c8ctl complete <resource> <key>`

**Resources:** ut (user-task), job

**Positional arguments:**

- **user-task:** `<key>` (required)
- **job:** `<key>` (required)

**Flags:**

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--variables` | string |  | JSON variables |

---

#### `fail`

Mark a job as failed with optional error message and retry count

**Resources:** job

**Positional arguments:**

- **job:** `<key>` (required)

**Flags:**

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--retries` | string |  | Remaining retries |
| `--errorMessage` | string |  | Error message |

---

#### `activate`

Activate jobs of a specific type for processing

**Resources:** jobs

**Positional arguments:**

- **jobs:** `<type>` (required)

**Flags:**

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--maxJobsToActivate` | string |  | Maximum number of jobs to activate |
| `--timeout` | string |  | Job timeout in milliseconds |
| `--worker` | string |  | Worker name |

---

#### `resolve`

Resolve an incident (marks resolved, allows process to continue)

**Resources:** inc (incident)

**Positional arguments:**

- **incident:** `<key>` (required)

---

#### `publish`

Publish a message for message correlation

**Resources:** msg (message)

**Positional arguments:**

- **message:** `<name>` (required)

**Flags:**

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--correlationKey` | string |  | Correlation key |
| `--variables` | string |  | JSON variables |
| `--timeToLive` | string |  | Time to live in milliseconds |

---

#### `correlate`

Correlate a message to a specific process instance

**Resources:** msg (message)

**Positional arguments:**

- **message:** `<name>` (required)

**Flags:**

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--correlationKey` | string | Yes | Correlation key |
| `--variables` | string |  | JSON variables |
| `--timeToLive` | string |  | Time to live in milliseconds |

---

#### `set`

Set variables on an element instance (process instance or flow element scope). Variables are propagated to the outermost scope by default; use --local to restrict to the specified scope.

**Usage:** `c8ctl set variable <key>`

**Resources:** variable

**Positional arguments:**

- **variable:** `<key>` (required)

**Flags:**

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--variables` | string | Yes | JSON object of variables to set (required) |
| `--local` | boolean |  | Set variables in local scope only (default: propagate to outermost scope) |

**Examples:**

```bash
c8ctl set variable 2251799813685249 --variables='{"status":"approved"}'  # Set variables on a process instance
c8ctl set variable 2251799813685249 --variables='{"x":1}' --local  # Set variables in local scope only
```

---

#### `deploy`

Deploy files to Camunda (auto-discovers deployable files in directories)

**Usage:** `c8ctl deploy [path...]`

**Flags:**

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--force` | boolean |  | Deploy any file type, ignoring the default extension allow-list |

**Examples:**

```bash
c8ctl deploy ./my-process.bpmn                              # Deploy a BPMN file
```

---

#### `run`

Deploy and start a process instance from a BPMN file

**Usage:** `c8ctl run <path>`

**Flags:**

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--variables` | string |  | JSON variables |
| `--force` | boolean |  | Deploy any file type, ignoring the default extension allow-list |

**Examples:**

```bash
c8ctl run ./my-process.bpmn                                 # Deploy and start process
```

---

#### `assign`

Assign a resource to a target (--to-user, --to-group, etc.)

**Usage:** `c8ctl assign <resource> <id>`

**Resources:** role, user, group, mapping-rule

**Positional arguments:**

- **role:** `<roleId>` (required)
- **user:** `<username>` (required)
- **group:** `<groupId>` (required)
- **mapping-rule:** `<mappingRuleId>` (required)

**Flags:**

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--to-user` | string |  | Target user ID |
| `--to-group` | string |  | Target group ID |
| `--to-tenant` | string |  | Target tenant ID |
| `--to-mapping-rule` | string |  | Target mapping rule ID |

**Examples:**

```bash
c8ctl assign role admin --to-user=john                      # Assign role to user
```

---

#### `unassign`

Unassign a resource from a target (--from-user, --from-group, etc.)

**Usage:** `c8ctl unassign <resource> <id>`

**Resources:** role, user, group, mapping-rule

**Positional arguments:**

- **role:** `<roleId>` (required)
- **user:** `<username>` (required)
- **group:** `<groupId>` (required)
- **mapping-rule:** `<mappingRuleId>` (required)

**Flags:**

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--from-user` | string |  | Source user ID |
| `--from-group` | string |  | Source group ID |
| `--from-tenant` | string |  | Source tenant ID |
| `--from-mapping-rule` | string |  | Source mapping rule ID |

**Examples:**

```bash
c8ctl unassign role admin --from-user=john                  # Unassign role from user
```

---

#### `watch`

Watch files for changes and auto-deploy

**Usage:** `c8ctl watch [path...]`

**Aliases:** `w`

**Flags:**

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--force` | boolean |  | Continue watching after all deployment errors |
| `--extensions` | string |  | Comma-separated list of file extensions to watch (e.g. .bpmn,.dmn,.form) |

**Examples:**

```bash
c8ctl watch ./src                                           # Watch directory for changes
```

---

#### `open`

Open Camunda web app in browser

**Usage:** `c8ctl open <app>`

**Resources:** operate, tasklist, modeler, optimize

**Examples:**

```bash
c8ctl open operate                                          # Open Camunda Operate in browser
c8ctl open tasklist                                         # Open Camunda Tasklist in browser
c8ctl open operate --profile=prod                           # Open Operate using a specific profile
```

---

#### `add`

Add a profile

**Resources:** profile

**Positional arguments:**

- **profile:** `<name>` (required)

**Flags:**

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--baseUrl` | string |  | Cluster base URL |
| `--clientId` | string |  | OAuth client ID |
| `--clientSecret` | string |  | OAuth client secret |
| `--audience` | string |  | OAuth audience |
| `--oAuthUrl` | string |  | OAuth token URL |
| `--defaultTenantId` | string |  | Default tenant ID |
| `--username` | string |  | Basic auth username |
| `--password` | string |  | Basic auth password |
| `--from-file` | string |  | Import from .env file |
| `--from-env` | boolean |  | Import from environment variables |

---

#### `remove`

Remove a profile (alias: rm)

**Usage:** `c8ctl remove profile <name>`

**Aliases:** `rm`

**Resources:** profile, plugin

**Positional arguments:**

- **profile:** `<name>` (required)
- **plugin:** `<package>` (required)

**Flags:**

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--none` | boolean |  | Clear active profile |

---

#### `load`

Load a c8ctl plugin (npm registry or URL)

**Usage:** `c8ctl load plugin [name|--from url]`

**Resources:** plugin

**Positional arguments:**

- **plugin:** `<package>` (optional)

**Flags:**

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--from` | string |  | Load plugin from URL |

**Examples:**

```bash
c8ctl load plugin my-plugin                                 # Load plugin from npm registry
c8ctl load plugin --from https://github.com/org/plugin      # Load plugin from URL
```

---

#### `unload`

Unload a c8ctl plugin (npm uninstall wrapper)

**Usage:** `c8ctl unload plugin <name>`

**Aliases:** `rm`

**Resources:** plugin

**Positional arguments:**

- **plugin:** `<package>` (required)

**Flags:**

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--force` | boolean |  | Force unload without confirmation |

---

#### `upgrade`

Upgrade a plugin (respects source type)

**Usage:** `c8ctl upgrade plugin <name> [version]`

**Resources:** plugin

**Positional arguments:**

- **plugin:** `<package>` (required), `<version>` (optional)

**Examples:**

```bash
c8ctl upgrade plugin my-plugin                              # Upgrade plugin to latest version
c8ctl upgrade plugin my-plugin 1.2.3                        # Upgrade plugin to a specific version (source-aware)
```

---

#### `downgrade`

Downgrade a plugin to a specific version

**Usage:** `c8ctl downgrade plugin <name> <version>`

**Resources:** plugin

**Positional arguments:**

- **plugin:** `<package>` (required), `<version>` (required)

---

#### `sync`

Synchronize plugins from registry (rebuild/reinstall)

**Resources:** plugin

**Examples:**

```bash
c8ctl sync plugin                                           # Synchronize plugins
```

---

#### `init`

Create a new plugin from TypeScript template

**Resources:** plugin

**Positional arguments:**

- **plugin:** `<name>` (optional)

**Examples:**

```bash
c8ctl init plugin my-plugin                                 # Create new plugin from template (c8ctl-plugin-my-plugin)
```

---

#### `use`

Set active profile or tenant

**Usage:** `c8ctl use profile|tenant`

**Resources:** profile, tenant

**Positional arguments:**

- **profile:** `<name>` (optional)
- **tenant:** `<tenantId>` (required)

**Flags:**

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--none` | boolean |  | Clear active profile/tenant |

**Examples:**

```bash
c8ctl use profile prod                                      # Set active profile
```

---

#### `output`

Show or set output format

**Usage:** `c8ctl output [json|text]`

**Resources:** json, text

**Examples:**

```bash
c8ctl output json                                           # Switch to JSON output
```

---

#### `completion`

Generate shell completion script

**Usage:** `c8ctl completion bash|zsh|fish|install`

**Resources:** bash, zsh, fish, install

**Resource-specific flags:**

<details>
<summary><code>install</code></summary>

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--shell` | string |  | Shell to install completions for (bash, zsh, fish) |

</details>

**Examples:**

```bash
c8ctl completion bash                                       # Generate bash completion script
c8ctl completion install                                    # Auto-detect shell and install completions (auto-refreshes on upgrade)
c8ctl completion install --shell zsh                        # Install completions for a specific shell
```

---

#### `mcp-proxy`

Start a STDIO MCP proxy (bridges local MCP clients to remote Camunda 8)

**Usage:** `c8ctl mcp-proxy [mcp-path]`

---

#### `feedback`

Open the feedback page to report issues or request features

---

#### `help`

Show help (run 'c8ctl help \<command>' for details)

**Usage:** `c8ctl help [command]`

**Aliases:** `menu`

---

#### `which`

Show active profile or output mode

**Resources:** profile, output

**Examples:**

```bash
c8ctl which profile                                         # Show currently active profile
c8ctl which output                                          # Show current output mode
```


<!-- command-reference:end -->

## License

Apache 2.0 - see LICENSE.md

## Contributing

See `AGENTS.md` for commit message conventions.
