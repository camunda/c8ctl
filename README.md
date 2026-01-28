# c8ctl - Camunda 8 CLI

A minimal-dependency CLI for Camunda 8 operations built on top of `@camunda8/orchestration-cluster-api`.

## Features

- **Minimal Dependencies**: Only one runtime dependency (`@camunda8/orchestration-cluster-api`)
- **Native TypeScript**: Runs directly with Node.js 22.18+ (no compilation needed)
- **Multi-Tenant Support**: Full support for multi-tenancy across all operations
- **Profile Management**: Store and manage multiple cluster configurations
- **Camunda Modeler Integration**: Automatically import and use profiles from Camunda Modeler
- **Plugin System**: Extend c8ctl with custom commands via npm packages
- **Session State**: Maintain active profile, tenant, and output preferences
- **Building Block Deployment**: Automatic prioritization of `_bb-` folders during deployment
- **Flexible Output**: Switch between human-readable text and JSON output modes

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

### Install Dependencies

```bash
npm install
```

### Make CLI Executable

The CLI runs directly with Node.js 22.18+ which has native TypeScript support:

```bash
# Run directly with Node.js
node src/index.ts <command>

# Or add an alias to your shell (recommended)
alias c8='node src/index.ts'
```

## Usage

### Basic Commands

```bash
# Show help
c8 help

# Show version
c8 --version

# List process instances
c8 list pi

# Get process instance by key
c8 get pi 123456

# Create process instance
c8 create pi --bpmnProcessId=myProcess

# Deploy BPMN file
c8 deploy ./my-process.bpmn

# Deploy current directory
c8 deploy

# Deploy and start process (run)
c8 run ./my-process.bpmn
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
# Set active tenant
c8 use tenant my-tenant-id

# Switch to JSON output
c8 output json

# Switch back to text output
c8 output text
```

### Plugin Management

c8ctl supports a plugin system that allows extending the CLI with custom commands via npm packages.

```bash
# Load a plugin (wraps npm install)
c8 load plugin <package-name>

# Unload a plugin (wraps npm uninstall)
c8 unload plugin <package-name>

# List installed plugins
c8 list plugins
```

**Plugin Requirements:**
- Plugin packages must include a `c8ctl-plugin.js` or `c8ctl-plugin.ts` file
- The plugin file should export custom commands
- Plugins are installed in `node_modules` like regular npm packages
- The runtime object `c8ctl` provides environment information to plugins

**Example Plugin Structure:**
```typescript
// c8ctl-plugin.ts
export const commands = {
  analyze: async (args: string[]) => {
    console.log('Analyzing...', args);
  }
};
```

### Resource Aliases

- `pi` = process-instance(s)
- `ut` = user-task(s)
- `inc` = incident(s)
- `msg` = message

### Command Structure

```
c8 <verb> <resource> [arguments] [flags]
```

**Verbs**: list, get, create, cancel, complete, fail, activate, resolve, publish, correlate, deploy, run, add, remove, use, output

**Resources**: process-instance, user-task, incident, job, message, topology, profile, tenant

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

Integration tests are skipped by default as they require a running Camunda 8 instance at `http://localhost:8080`. To run them:

1. Start a local Camunda 8 instance (e.g., using c8run)
2. Update the test files to remove `.skip` from the tests
3. Run: `npm run test:integration`

## Development

### Project Structure

```
c8ctl/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── logger.ts             # Output handling
│   ├── config.ts             # Configuration management
│   ├── client.ts             # SDK client factory
│   └── commands/             # Command handlers
│       ├── help.ts
│       ├── session.ts
│       ├── profiles.ts
│       ├── process-instances.ts
│       ├── user-tasks.ts
│       ├── incidents.ts
│       ├── jobs.ts
│       ├── messages.ts
│       ├── topology.ts
│       ├── deployments.ts
│       └── run.ts
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
# With Node.js 22.18+ (native TypeScript)
node src/index.ts <command>

# Or using the alias
c8 <command>
```

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

- **Linux**: `~/.local/share/c8ctl/`
- **macOS**: `~/Library/Application Support/c8ctl/`
- **Windows**: `%APPDATA%\c8ctl\`

Files:
- `profiles.json`: Saved cluster configurations
- `session.json`: Active profile, tenant, and output mode

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

MIT

## Contributing

See `COMMIT-MESSAGE-GUIDELINE.md` for commit message conventions.
