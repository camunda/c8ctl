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
- `c8ctl skills uninstall [name...] [--skill-path <path>...] [--harness <agent-id>]`
  — preview and remove installed Camunda skills from the detected harnesses
  or one selected harness (`skills remove` remains a compatibility alias).
  Naming skills removes matching installations; an
  unknown name fails before anything is deleted. To select one installation
  when a name exists at multiple paths, pair each positional name with one
  `--skill-path` value in the same order. Unknown name/path pairs fail before
  anything is deleted.

Requires GitHub CLI 2.90 or later; its skill commands are in preview.
Re-run to update the same skill directories without duplicates when upstream
changes.

Without `--harness`, c8ctl detects Claude Code and GitHub Copilot CLI. Pass
`--yes` to confirm removal in non-interactive use. `--dry-run` prints a removal
preview without deleting files. Removal deletes the full Camunda skill
directories, including local edits, and leaves other skills untouched.
Without `--skill-path`, a name selects every matching installation. When
`--skill-path` is provided, each name is limited to its matching listed path.

Supports the global `--dry-run`, `--json`, `--quiet`, and `--verbose` flags.
