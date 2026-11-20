# c8ctl-plugin-skills

Default c8ctl plugin that manages Camunda AI coding skills in AI coding
harnesses.

## Commands

- `c8ctl skills install [--harness <agent-id>]` — install or update the
  Camunda skills from
  [`camunda/skills`](https://github.com/camunda/skills) for the detected
  harnesses (Claude Code, GitHub Copilot CLI), or for one harness named by
  GitHub CLI agent ID.
- `c8ctl skills list [--harness <agent-id>]` — list installed Camunda skills
  and their harnesses and paths.
- `c8ctl skills remove [name...] [--harness <agent-id>]` — preview and remove
  installed Camunda skills from the detected harnesses or one selected
  harness. Naming skills removes only those; an unknown name fails before
  anything is deleted.

Requires GitHub CLI 2.90 or later; its skill commands are in preview.
Re-run to update the same skill directories without duplicates when upstream
changes.

Without `--harness`, c8ctl detects Claude Code and GitHub Copilot CLI. Pass
`--yes` to confirm removal in non-interactive use. `--dry-run` prints a removal
preview without deleting files. Removal deletes the full Camunda skill
directories, including local edits, and leaves other skills untouched.

Supports the global `--dry-run`, `--json`, `--quiet`, and `--verbose` flags.
