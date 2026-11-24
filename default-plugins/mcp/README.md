# c8ctl-plugin-mcp

Default c8ctl plugin that installs or uninstalls Camunda MCP (Model Context
Protocol) connections in AI coding harnesses.

## Commands

- `c8ctl mcp install [harness...] [--docs] [--orchestration] [--alias <name>]` —
  write MCP server entries into the detected (or named) harnesses' config
  files. The orchestration entry points at `c8ctl mcp-proxy` for the selected
  profile; the docs entry connects to the hosted Camunda docs MCP server.
- `c8ctl mcp uninstall [harness...] [--docs] [--orchestration] [--preserve-conflicts]` —
  remove the c8ctl-managed entries, leaving unrelated servers untouched. A
  foreign entry under the same name fails the uninstall unless
  `--preserve-conflicts` leaves it in place instead.

Supported harnesses: Claude Code, GitHub Copilot, Cursor, VS Code, and Claude
Desktop (macOS/Windows). Omit harness names to configure all detected
harnesses; aliases `claude`, `copilot`, and `code` map to `claude-code`,
`github-copilot`, and `vscode`.

Orchestration references `--profile`, the active saved profile, or the default
`local` profile; credentials are not copied. The docs server needs no cluster
profile and requires sign-in on first use.

Re-running install updates drifted c8ctl-managed entries in place while
preserving client-added keys (tool allowlists, extra env vars) and JSONC
comments. A foreign entry under the same name is never clobbered — choose
another `--alias`.

Supports the global `--dry-run`, `--json`, `--quiet`, and `--verbose` flags.
`--dry-run` previews the selected entries without writing or exposing
unrelated config values.
