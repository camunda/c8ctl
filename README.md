# c8ctl - Camunda 8 CLI

A minimal-dependency CLI for Camunda 8 operations built on top of `@camunda8/orchestration-cluster-api`.

## Features

- **Minimal Dependencies**: Only one runtime dependency (`@camunda8/orchestration-cluster-api`)
- **Native TypeScript**: Runs directly with Node.js 22.18+ (no compilation needed)
- **Multi-Tenant Support**: Full support for multi-tenancy across all operations
- **Profile Management**: Store and manage multiple cluster configurations
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

1. `--profile` flag (one-off override)
2. Active profile from session state
3. Environment variables (`CAMUNDA_*`)
4. Localhost fallback (`http://localhost:8080`)

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

```bash
# Add a profile
c8 add profile prod --baseUrl=https://camunda.example.com --clientId=xxx --clientSecret=yyy

# List profiles
c8 list profiles

# Set active profile
c8 use profile prod

# Remove profile
c8 remove profile prod
```

### Session Management

```bash
# Set active tenant
c8 use tenant my-tenant-id

# Switch to JSON output
c8 output json

# Switch back to text output
c8 output text
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
