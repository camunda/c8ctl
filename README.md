# c8ctl - Camunda 8 CLI

A minimal-dependency CLI for Camunda 8 operations built on top of `@camunda8/orchestration-cluster-api`.

## Features

- **Minimal Dependencies**: Only one runtime dependency (`@camunda8/orchestration-cluster-api`)
- **Multi-Tenant Support**: Full support for multi-tenancy across all operations
- **Profile Management**: Store and manage multiple cluster configurations
- **Camunda Modeler Integration**: Automatically import and use profiles from Camunda Modeler
- **Plugin System**: Extend c8ctl with custom commands via npm packages
- **Building Block Deployment**: Automatic prioritization of `*_bb-*` folders during deployment, marked with 🧱 in results
- **Process Application Support**: Resources in folders with `.process-application` file marked with 📦 in results
- **Enhanced Deployment Results**: Table view showing file paths, visual indicators, resource details, and versions
- **Watch Mode**: Monitors a folder for changes to `*.{bpmn,dmn,form}` and auto-redeploys 
- **Flexible Output**: Switch between human-readable text and JSON output modes

## Beware the 🤖

*Full transparency*:  
this cli is also a pilot-coding experiment.  
Guided by humans, the codebase is (mostly) built by your friendly neighborhood LLM, fully dogfooding the Human-in-the-Loop pattern.

## Architecture

### Core Components

- **Logger** (`src/logger.ts`): Handles output in text or JSON mode
- **Config** (`src/config.ts`): Manages profiles, session state, and credential resolution
- **Client** (`src/client.ts`): Factory for creating Camunda 8 SDK clients
- **Commands** (`src/commands/`): Domain-specific command handlers

### Credential Resolution Order

1. `--profile` flag (one-off override, supports both c8ctl and modeler profiles)
2. Active profile from session state
3. Environment variables (`CAMUNDA_*`)
4. Localhost fallback (`http://localhost:8080/v2`)

**Note**: Modeler profiles can be used anywhere a c8ctl profile is expected by using the `modeler:` prefix (e.g., `--profile=modeler:Local Dev` or `c8 use profile modeler:Cloud Cluster`).

### Tenant Resolution Order

1. Active tenant from session state
2. Default tenant from active profile
3. `CAMUNDA_DEFAULT_TENANT_ID` environment variable
4. `<default>` tenant

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
c8ctl help list      # Shows all list resources and their flags
c8ctl help get       # Shows all get resources and their flags
c8ctl help create    # Shows all create resources and their flags
c8ctl help complete  # Shows all complete resources and their flags

# Show version
c8ctl --version
```

### Basic Commands

```bash
# List and get resources (use aliases pi, pd, ut, inc for convenience)
c8ctl list pi                          # List process instances
c8ctl list pd                          # List process definitions
c8ctl get pi 123456                    # Get process instance by key
c8ctl get pi 123456 --variables        # Get process instance with variables
c8ctl get pd 123456 --xml              # Get process definition as XML

# Create process instance
c8ctl create pi --id=myProcess
c8ctl create process-instance --id=myProcess

# Create process instance and wait for completion
c8ctl create pi --id=myProcess --awaitCompletion

# Await process instance completion (alias for create with --awaitCompletion)
c8ctl await pi --id=myProcess
c8ctl await process-instance --id=myProcess

# Cancel process instance
c8ctl cancel pi 123456

# Deploy and run
c8ctl deploy ./my-process.bpmn         # Deploy a single file
c8ctl deploy                           # Deploy current directory
c8ctl run ./my-process.bpmn            # Deploy and start process
c8ctl run ./my-process.bpmn --variables='{"key":"value"}'  # Deploy and start with variables
c8ctl watch                            # Watch for changes and auto-deploy
```

For comprehensive examples of all commands and their flags, see [EXAMPLES.md](EXAMPLES.md).

### Shell Completion

c8ctl supports shell completion for `bash`, `zsh`, and `fish`. To enable completion:

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
2. Active profile from session state
3. Environment variables (`CAMUNDA_*`)
4. Localhost fallback (`http://localhost:8080`)

**Note**: Credential configuration via environment variables follows the same conventions as the `@camunda8/orchestration-cluster-api` module.

```bash
# Using environment variables
export CAMUNDA_BASE_URL=https://camunda.example.com
export CAMUNDA_CLIENT_ID=your-client-id
export CAMUNDA_CLIENT_SECRET=your-client-secret
c8ctl list process-instances

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

```bash
# Add a c8ctl profile
c8 add profile prod --baseUrl=https://camunda.example.com --clientId=xxx --clientSecret=yyy

# List all profiles (includes both c8ctl and modeler profiles)
c8 list profiles

# Set active profile (works with both types)
c8 use profile prod
c8 use profile modeler:Local Dev

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

c8ctl supports a plugin system that allows extending the CLI with custom commands via npm packages. Plugins are tracked in a registry file (`~/.config/c8ctl/plugins.json` on Linux, similar locations on other platforms) for persistence across npm operations.

```bash
# Load a plugin from npm registry
c8ctl load plugin <package-name>

# Load a plugin from a URL (including file URLs)
c8ctl load plugin --from <url>
c8ctl load plugin --from file:///path/to/plugin
c8ctl load plugin --from https://github.com/user/repo
c8ctl load plugin --from git://github.com/user/repo.git

# Unload a plugin (wraps npm uninstall)
c8ctl unload plugin <package-name>

# List installed plugins (shows sync status)
c8ctl list plugins

# Synchronize plugins from registry
# - First tries npm rebuild for installed plugins
# - Falls back to fresh npm install if rebuild fails
c8ctl sync plugins

# View help including plugin commands
c8ctl help
```

**Plugin Registry:**
- Plugins are tracked independently of `package.json` in a registry file
- The registry serves as the source of truth (local precedence)
- `c8ctl list plugins` shows sync status:
  - `✓ Installed` - Plugin is in registry and installed
  - `⚠ Not installed` - Plugin is in registry but not in node_modules (run `sync`)
  - `⚠ Not in registry` - Plugin is in package.json but not tracked in registry
- `c8ctl sync plugins` synchronizes plugins from the registry, rebuilding or reinstalling as needed

**Plugin Requirements:**
- Plugin packages must be regular Node.js modules
- They must include a `c8ctl-plugin.js` or `c8ctl-plugin.ts` file in the root directory
- The plugin file must export a `commands` object
- Optionally export a `metadata` object to provide help text
- Plugins are installed in `node_modules` like regular npm packages
- The runtime object `c8ctl` provides environment information to plugins
- **Important**: `c8ctl-plugin.js` must be JavaScript. Node.js doesn't support type stripping in `node_modules`. If writing in TypeScript, transpile to JS before publishing.

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

### Resource Aliases

- `pi` = process-instance(s)
- `pd` = process-definition(s)
- `ut` = user-task(s)
- `inc` = incident(s)
- `msg` = message

### Command Structure

```
c8ctl <verb> <resource> [arguments] [flags]
```

**Verbs**: 
- `list` - List resources
- `get` - Get resource by key
- `create` - Create resource
- `cancel` - Cancel resource
- `complete` - Complete resource
- `fail` - Fail a job
- `activate` - Activate jobs
- `resolve` - Resolve incident
- `publish` - Publish message
- `correlate` - Correlate message
- `deploy` - Deploy BPMN/DMN/forms
- `run` - Deploy and start process
- `watch` (alias: `w`) - Watch for changes and auto-deploy
- `add` - Add a profile
- `remove` (alias: `rm`) - Remove a profile
- `load` - Load a plugin
- `unload` - Unload a plugin
- `sync` - Synchronize plugins
- `use` - Set active profile or tenant
- `output` - Set output format
- `completion` - Generate shell completion script

**Resources**: process-instance (pi), process-definition (pd), user-task (ut), incident (inc), job, jobs, message (msg), topology, profile, tenant, plugin

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

1. Start a local Camunda 8 instance (e.g., using c8run)
2. Run: `npm run test:integration`

## Development

- **Native TypeScript**: Runs directly with Node.js 22.18+ (no compilation needed)


### Project Structure

```
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
- `CAMUNDA_AUDIENCE`: OAuth audience
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

## License

Apache 2.0 - see LICENSE.md 

## Contributing

See `COMMIT-MESSAGE-GUIDELINE.md` for commit message conventions.
