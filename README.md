# c8ctl - Camunda 8 CLI

A minimal-dependency CLI for Camunda 8 operations built on top of `@camunda8/orchestration-cluster-api`.

## Features

- **Minimal Dependencies**: Only one runtime dependency (`@camunda8/orchestration-cluster-api`)
- **Native TypeScript**: Runs directly with Node.js 22.18+ (no compilation needed)
- **Multi-Tenant Support**: Full support for multi-tenancy across all operations
- **Profile Management**: Store and manage multiple cluster configurations
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



## Installation

### Requirements

- Node.js >= 22.18.0 (for native TypeScript support)

### Global Installation (Recommended)

```bash
npm install @camunda8/cli -g
```

After installation, the CLI is available as `c8ctl` (or its alias `c8`).

**Note**: The `c8` alias provides typing ergonomics for common keyboard layouts - the `c` key (left index finger) followed by `8` (right middle finger) makes for a comfortable typing experience on both QWERTY and QWERTZ keyboards.

### Local Development

```bash
npm install
```

## Usage

### Basic Commands

```bash
# Show help
c8ctl help

# Show version
c8ctl --version

# List process instances (using alias 'pi')
c8ctl list pi
# Or using full command name
c8ctl list process-instances

# Get process instance by key
c8ctl get pi 123456
c8ctl get process-instance 123456

# Create process instance
c8ctl create pi --bpmnProcessId=myProcess
c8ctl create process-instance --bpmnProcessId=myProcess

# Deploy BPMN file
c8ctl deploy ./my-process.bpmn

# Deploy current directory
c8ctl deploy

# Deploy and start process (run)
c8ctl run ./my-process.bpmn
```

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

```bash
# Add a profile
c8ctl add profile prod --baseUrl=https://camunda.example.com --clientId=xxx --clientSecret=yyy

# List profiles
c8ctl list profiles

# Set active profile
c8ctl use profile prod

# Remove profile
c8ctl remove profile prod
```

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

c8ctl supports a plugin system that allows extending the CLI with custom commands via npm packages.

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

# List installed plugins
c8ctl list plugins
```

**Plugin Requirements:**
- Plugin packages must be regular Node.js modules
- They must include a `c8ctl-plugin.js` or `c8ctl-plugin.ts` file in the root directory
- The plugin file must export a `commands` object
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
c8ctl <verb> <resource> [arguments] [flags]
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

Integration tests require a running Camunda 8 instance at `http://localhost:8080`.

1. Start a local Camunda 8 instance (e.g., using c8run)
2. Run: `npm run test:integration`

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
# If installed globally
c8ctl <command>
# Or using the alias
c8 <command>

# For local development with Node.js 22.18+ (native TypeScript)
node src/index.ts <command>
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

Configuration is stored in platform-specific user data directories:

- **Linux**: `~/.local/share/c8ctl/`
- **macOS**: `~/Library/Application Support/c8ctl/`
- **Windows**: `%APPDATA%\c8ctl\`

Files:
- `profiles.json`: Saved cluster configurations
- `session.json`: Active profile, tenant, and output mode

## License

MIT

## Contributing

See `COMMIT-MESSAGE-GUIDELINE.md` for commit message conventions.
