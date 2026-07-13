# Cocktail (c8ctl) - Camunda 8 CLI

c8ctl (_pronounced: "cocktail"_) — a minimal-dependency CLI for Camunda 8 operations built on top of [`@camunda8/orchestration-cluster-api`](https://www.npmjs.com/package/@camunda8/orchestration-cluster-api).

## Features

- **Multi-Tenant Support**: Full support for multi-tenancy across all operations
- **Profile Management**: Store and manage multiple cluster configurations
- **Camunda Modeler Integration**: Automatically import and use profiles from Camunda Modeler
- **Identity Management**: Manage users, roles, groups, tenants, authorizations, and mapping rules
- **Plugin System**: Extend c8ctl with custom commands via npm packages
- **Local Cluster**: Run a local Camunda 8 instance directly — no Docker required
- **MCP Proxy**: Bridge local MCP clients to remote Camunda 8 for AI agent integration
- **Building Block Deployment**: Automatic prioritization of `*_bb-*` folders during deployment, marked with 🧱 in results
- **Process Application Support**: Resources in folders with `.process-application` file marked with 📦 in results
- **Enhanced Deployment Results**: Table view showing file paths, visual indicators, resource details, and versions
- **Watch Mode**: Monitors a folder for file changes and auto-redeploys (configurable extensions via `--extensions`)
- **`.c8ignore` Support**: Filter deploy/watch file scanning with `.gitignore`-style patterns; `node_modules/`, `target/`, `.git/` ignored by default
- **Open Applications**: Open Camunda web applications (Operate, Tasklist, Modeler, Optimize) in the browser directly from the CLI
- **Search**: Powerful search across process definitions, process instances, user tasks, incidents, jobs, and variables with filter, wildcard, and case-insensitive support
- **Flexible Output**: Switch between human-readable text and JSON output modes
- **Shell Completion**: Auto-install completions for bash, zsh, and fish with automatic refresh on upgrade
- **Agent Flags**: `--dry-run` to preview API requests and `--fields` to filter output columns for AI agents and scripts
- **Debug Mode**: Enable detailed logging to stderr with `DEBUG=1` or `C8CTL_DEBUG=true`

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

## Documentation

The full documentation is maintained in this repository under [`docs/`](docs/) and is published — and kept in sync — on [docs.camunda.io](https://docs.camunda.io/docs/next/apis-tools/c8ctl/getting-started/):

- [Getting started](docs/getting-started.md) — install, spin up a local cluster, credentials, profiles, output modes, and shell completion.
- [Cluster inspection and process management](docs/cluster-inspection.md) — list, search, get, and manage process instances, user tasks, incidents, jobs, variables, messages, and forms.
- [Identity management](docs/identity-management.md) — users, roles, groups, tenants, authorizations, and mapping rules.
- [Development workflows](docs/development-workflows.md) — deploy, run, watch, profiles, sessions, and the MCP proxy.
- [Plugins](docs/plugins.md) — scaffold, install, and manage custom commands.
- [Command reference](docs/command-reference.md) — every command, flag, resource, and alias.

The `docs/` pages are the single source of truth. When you change CLI behavior, update the relevant page here; a workflow syncs them to camunda-docs.

## Quick start

```bash
# Install
npm install @camunda8/cli -g

# Start a local Camunda 8 cluster (no Docker required)
c8ctl cluster start

# Deploy a process and start an instance
c8ctl deploy ./my-process.bpmn
c8ctl run my-process

# Inspect running instances
c8ctl list process-instances

# Show help for any command
c8ctl help
c8ctl help <command>
```

For everything else, see the [documentation](#documentation) above.

## AI agents and scripting

c8ctl ships flags built for AI agents and scripts — `--fields` (filter output columns), `--dry-run` (preview the API request without executing it), and machine-readable JSON help. They appear in their own section in `c8ctl help`.

See [Development workflows → AI agents and scripting](docs/development-workflows.md#ai-agents-and-scripting) for details and examples. For a full machine-readable reference intended for agents, see [CONTEXT.md](CONTEXT.md).

## Command Structure

```shell
c8ctl <verb> <resource> [arguments] [flags]
```

<!-- verb-resource-list:start -->
<!-- Auto-generated from COMMAND_REGISTRY. Do not edit manually.
     Run: node --experimental-strip-types scripts/sync-readme-commands.ts -->

**Verbs**:

- `list` - List resources (process, identity)
- `search` - Search resources with filters
- `get` - Get resource by key
- `create` - Create resource
- `delete` - Delete resource
- `cancel` - Cancel resource
- `await` - Create and await completion (alias for create --awaitCompletion)
- `complete` - Complete resource
- `fail` - Fail a job
- `update` - Update a job
- `activate` - Activate jobs by type
- `resolve` - Resolve incident
- `publish` - Publish message
- `correlate` - Correlate message
- `set` - Set variables on an element instance
- `deploy` - Deploy resources
- `run` - Deploy and start process
- `assign` - Assign resource to target
- `unassign` - Unassign resource from target
- `watch` (alias: `w`) - Watch files for changes and auto-deploy
- `open` - Open Camunda web application in browser
- `add` - Add a profile
- `remove` (alias: `rm`) - Remove a profile
- `load` - Load a c8ctl plugin
- `unload` (alias: `rm`) - Unload a c8ctl plugin
- `upgrade` - Upgrade a plugin
- `downgrade` - Downgrade a plugin to a specific version
- `sync` - Synchronize plugins
- `init` - Create a new plugin from TypeScript template
- `doctor` - Diagnose plugin loading state and collisions
- `use` - Set active profile or tenant
- `output` - Show or set output format
- `completion` - Generate shell completion script
- `mcp-proxy` - Start a STDIO to remote HTTP MCP proxy server
- `feedback` - Open the feedback page to report issues or request features
- `help` (alias: `menu`) - Show help
- `which` - Show active profile or output mode

**Resources**: authorization (auth), form, group, incident (inc), job, jobs, mapping-rule (mr), message (msg), plugin, process-definition (pd), process-instance (pi), profile, role, tenant, topology, user, user-task (ut), variable (var, vars), wait-state (ws)
<!-- verb-resource-list:end -->

**Tip**: Run `c8ctl help <command>` to see detailed help for specific commands with all available flags.

## Environment Variables

- `CAMUNDA_BASE_URL`: Cluster base URL
- `CAMUNDA_CLIENT_ID`: OAuth client ID
- `CAMUNDA_CLIENT_SECRET`: OAuth client secret
- `CAMUNDA_TOKEN_AUDIENCE`: OAuth token audience
- `CAMUNDA_OAUTH_URL`: OAuth token endpoint
- `CAMUNDA_DEFAULT_TENANT_ID`: Default tenant ID
- `C8CTL_OUTPUT_MODE`: Per-invocation output mode override (`json` or `text`); does not persist. Lower precedence than `--json`.
- `C8CTL_DATA_DIR`: Override the OS-default data directory for plugins and session state.
- `C8CTL_DEBUG` / `DEBUG`: Enable debug logging to stderr.

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

<!-- Auto-generated pointer. Do not edit manually.
     Run: node --experimental-strip-types scripts/sync-readme-commands.ts -->

A compact list of every verb and resource is in [Command Structure](#command-structure) above.

For the complete reference of every command, flag, resource, and alias, see:

- [`docs/command-reference.md`](docs/command-reference.md) in this repository, or
- the [c8ctl command reference](https://docs.camunda.io/docs/next/apis-tools/c8ctl/command-reference/) on docs.camunda.io.

<!-- command-reference:end -->

## License

Apache 2.0 - see LICENSE.md

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing, project structure, and how to add new commands. See [AGENTS.md](AGENTS.md) for commit conventions and coding standards.
