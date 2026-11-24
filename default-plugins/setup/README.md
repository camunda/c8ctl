# c8ctl-plugin-setup

Default c8ctl plugin providing the guided first-run setup for local Camunda 8
development.

## Commands

- `c8ctl setup` — the guided wizard: start a local cluster (downloading
  Camunda 8 Run on first run), install Desktop Modeler, create a starter
  project from a blueprint, deploy and run it, and set up AI assistant
  tooling (skills, MCP servers). Nothing is installed without a selection or
  `--yes`.
- `c8ctl setup --yes` — set up the defaults without prompting (Rocket Launch
  blueprint).
- `c8ctl setup --remove` — preview and remove setup-managed MCP entries,
  Camunda skills, a c8ctl-managed Desktop Modeler installation, blueprint
  files, and the local cluster: the cluster is stopped, and its runtime
  data and downloaded Camunda 8 Run binaries are deleted.

## Architecture

The wizard orchestrates the commands that own each capability instead of
reimplementing them: `c8ctl cluster start`/`stop` (cluster plugin),
`c8ctl modeler install` (modeler plugin), `c8ctl skills install` (skills
plugin), `c8ctl mcp install` (mcp plugin) and `c8ctl deploy` (core).
Children run pinned to text output; their progress is buffered and surfaces
only when a step fails.

Removal orchestrates the same owners: the unified preview is built from
shared inspection helpers and a `modeler uninstall --dry-run` probe, and after
one confirmation the actual teardown runs as child commands —
`c8ctl cluster stop` followed by `c8ctl cluster purge`/`delete` per installed
version, `c8ctl mcp uninstall` per harness,
`c8ctl skills uninstall --harness <harness> --yes`, and `c8ctl modeler uninstall`.

## Flags

`--modeler`, `--no-modeler`, `--docs-mcp`, `--remove`, plus
the global `--yes`, `--json`, `--dry-run`, `--quiet`, and `--verbose` flags.

**Exit codes:** `0` when every selected step succeeded or nothing was
installed for lack of a go-ahead; `1` when arguments failed validation or any
step or removal action failed (remaining eligible steps still ran).
