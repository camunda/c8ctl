# c8ctl-plugin-skills

Default c8ctl plugin that installs Camunda AI coding skills into AI coding
harnesses.

## Commands

- `c8ctl skills install [--harness <agent-id>]` — install or update the
  Camunda skills from
  [`camunda/skills`](https://github.com/camunda/skills) for the detected
  harnesses (Claude Code, GitHub Copilot CLI), or for one harness named by
  GitHub CLI agent ID.

Requires GitHub CLI 2.90 or later; its skill commands are in preview.
Re-run to update the same skill directories without duplicates when upstream
changes.

Supports the global `--dry-run`, `--json`, `--quiet`, and `--verbose` flags.
