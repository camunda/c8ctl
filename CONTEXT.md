# c8ctl Agent Context

This file encodes invariants and conventions for AI agents consuming c8ctl
programmatically. See README.md for general usage.

## Quick Setup

```sh
c8ctl output json   # switch to machine-readable output (session-persistent)
c8ctl help          # get structured JSON command reference
```

## Authentication & Profiles

- Config lives in `~/.config/c8ctl/` (or `$C8CTL_DATA_DIR` override)
- Set active profile: `c8ctl use profile <name>`
- One-off override: append `--profile <name>` to any command
- Modeler profiles: use `modeler:` prefix, e.g. `--profile=modeler:Local Dev`
- Show active profile: `c8ctl which profile`
- Add profile: `c8ctl add profile <name> --baseUrl=<url>`

## Output Mode

- Output mode is session-global, not per-command
- `c8ctl output json` → all subsequent commands emit JSON to stdout
- `c8ctl output text` → human-readable table output
- In JSON mode: operational messages (info/warn/success/error) go to **stderr**;
  data output goes to **stdout**
- Exit code 1 + JSON error on stderr on failure

## Resource Aliases

| Alias | Full Name            |
|-------|----------------------|
| `pi`  | process-instance(s)  |
| `pd`  | process-definition(s)|
| `ut`  | user-task(s)         |
| `inc` | incident(s)          |
| `msg` | message              |
| `vars`| variable(s)          |

## Agent Flags

These flags exist specifically for agent/programmatic use. They are listed
separately in help output and are distinct from human-use flags.

### `--fields <comma-separated>`

Filters output to only the specified keys. Applies to all `list`, `search`,
and `get` commands at the logger level — works in both text and JSON mode.
Field matching is **case-insensitive**.

```sh
c8ctl list pi --fields Key,State,processDefinitionId
c8ctl search pd --fields Key,processDefinitionId,name | jq .
```

Use this to reduce context window size when parsing output programmatically.

### `--dry-run`

Applies to all **mutating** commands: `create`, `cancel`, `deploy`,
`complete`, `fail`, `activate`, `resolve`, `publish`, `correlate`.

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
```

## JSON Mode Help

In JSON output mode, help commands return structured data instead of text:

```sh
c8ctl output json
c8ctl help          # returns full command tree as JSON
c8ctl help list     # returns list command details as JSON
```

The JSON help structure contains: `commands`, `globalFlags`, `searchFlags`,
`agentFlags`, `resourceAliases`.

## MCP Proxy

An MCP (Model Context Protocol) proxy is available:

```sh
c8ctl mcp-proxy                # start STDIO→HTTP MCP proxy (default endpoint)
c8ctl mcp-proxy <mcp-path>     # custom MCP server path
```

Use `c8ctl help mcp-proxy` for full setup and configuration details.

## Pagination & Limits

- Default: fetches up to 1,000,000 results (all pages)
- Use `--limit <n>` to cap results
- Use `--fields` together with `--limit` to minimize payload size

## Error Handling

- In JSON mode, errors emit `{"status":"error","message":"..."}` to stderr
- Exit code 1 on error, 0 on success (including `--dry-run`)
- Warnings emit `{"status":"warning","message":"..."}` to stderr

## Notes for Plugin Development

This file is for **agent consumption of c8ctl** as a CLI tool.
For **developing c8ctl plugins**, see `PLUGIN-HELP.md` and the plugin
template at `src/templates/AGENTS.md`.
