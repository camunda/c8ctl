# AGENTS.md

This file describes how to efficiently implement and iterate on this c8ctl plugin as an autonomous coding agent.

## Goal

Build and maintain a plugin that exposes useful commands through `export const commands` in `src/c8ctl-plugin.ts`.

## Plugin Contract

- Plugin entry point: `c8ctl-plugin.js` (root re-export to `dist/c8ctl-plugin.js`)
- Source file: `src/c8ctl-plugin.ts`
- Build output: `dist/c8ctl-plugin.js`
- Required export: `commands` object mapping command name -> async handler
- Optional export: `metadata` object for help descriptions
- Package keywords must include `c8ctl` or `c8ctl-plugin`

## Runtime API (available as global `c8ctl`)

Runtime environment object:

- `c8ctl.env.version`
- `c8ctl.env.nodeVersion`
- `c8ctl.env.platform`
- `c8ctl.env.arch`
- `c8ctl.env.cwd`
- `c8ctl.env.rootDir`

Direct compatibility fields:

- `c8ctl.version`
- `c8ctl.nodeVersion`
- `c8ctl.platform`
- `c8ctl.arch`
- `c8ctl.cwd`
- `c8ctl.outputMode`
- `c8ctl.activeProfile`
- `c8ctl.activeTenant`

Methods:

- `c8ctl.createClient(profileFlag?, sdkConfig?)`
- `c8ctl.resolveTenantId(profileFlag?)`
- `c8ctl.getLogger(mode?)`

## Development Loop

1. Install dependencies: `npm install`
2. Build plugin: `npm run build`
3. Load from local folder: `c8ctl load plugin --from file://${PWD}`
4. Verify command is available: `c8ctl <plugin>`
5. Execute plugin command: `c8ctl <plugin> <commands>`

## Implementation Guidance

- Keep command handlers focused and composable.
- Use `c8ctl.getLogger()` for output-mode-aware logs.
- Use `c8ctl.createClient()` for Camunda API interactions.
- Use `c8ctl.resolveTenantId()` instead of duplicating tenant fallback logic.
- Prefer clear, actionable error messages.
- Avoid command names that conflict with built-in c8ctl commands.
- For any non-trivial implementation or behavior change, always cross-check against upstream `c8ctl` repository: <https://github.com/camunda/c8ctl> before finalizing

## Quality Checks

Before considering a change complete:

1. Build succeeds: `npm run build`
2. Plugin loads: `c8ctl load plugin --from file://${PWD}`
3. Command appears in help: `c8ctl help`
4. Command executes with expected output

## Minimal Change Policy

- Make the smallest change required for each task.
- Do not add unrelated commands or refactors.
- Keep `metadata.commands` descriptions concise and user-facing.
