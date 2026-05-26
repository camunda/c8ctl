# Contributing to c8ctl

This guide covers development setup, testing, project structure, and how to add new commands. For the full architectural reference and coding conventions, see [AGENTS.md](AGENTS.md).

## Development

- **Native TypeScript**: Runs directly with Node.js 22.18+ (no compilation needed)

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

### Project structure

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

### Core components

- **Logger** (`src/logger.ts`): Handles output in text or JSON mode
- **Config** (`src/config.ts`): Manages profiles, session state, and credential resolution
- **Client** (`src/client.ts`): Factory for creating Camunda 8 SDK clients
- **Commands** (`src/commands/`): Domain-specific command handlers

## Testing

### Run all tests

```bash
npm test
```

### Run unit tests only

```bash
npm run test:unit
```

### Run integration tests

Integration tests require a running Camunda 8 instance at `http://localhost:8080`.

1. Start a local Camunda 8 instance (for example, using `c8ctl cluster start`)
2. Run: `npm run test:integration`

## Adding new commands

1. Declare the command in `COMMAND_REGISTRY` in `src/command-registry.ts` (flags, resources, help text)
2. Write the handler with `defineCommand()` in `src/commands/`
3. Register it in `COMMAND_DISPATCH` in `src/command-dispatch.ts`
4. Add tests in `tests/unit/` and `tests/integration/`
5. Document in `EXAMPLES.md`

Help text and shell completions are auto-derived from `COMMAND_REGISTRY` — no manual help updates needed.

For detailed architecture, handler shape, TypeScript conventions, and refactoring discipline, see [AGENTS.md](AGENTS.md).
