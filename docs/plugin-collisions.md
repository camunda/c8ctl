# Plugin Collision Policy

Status: implemented (current behaviour as of #366 / #367 / #363).
Owner: c8ctl maintainers.
Tracking issue: [#363](https://github.com/camunda/c8ctl/issues/363).

## Problem

Two plugins installed into the same c8ctl can collide in two ways:

1. **Plugin-name collision** — both packages declare the same
   `package.json#name`. Without a guard, the second `loadedPlugins.set(name, …)`
   silently overwrites the first, and *all* of the first plugin's commands
   disappear.
2. **Command-name collision** — two plugins (with different package names)
   each export a command under the same name (e.g. both export `model`).
   Without a guard, `Object.assign(allCommands, plugin.commands)` overwrites
   silently and "who wins" depends on filesystem iteration order
   (`readdirSync`), which varies across machines, npm versions, and
   monorepo hoisting.

Either way, the user has no signal that a handler became unreachable.

## Resolution policy: first-registration-wins, with diagnostics

c8ctl applies first-registration-wins to **both** flavours, with three
visibility affordances:

1. **`logger.warn` at load time.** The loader writes a warning to stderr
   naming both plugins and the affected command (or just both plugins, for
   plugin-name collisions). This is the primary signal.
2. **`c8ctl doctor plugin`** re-renders the same diagnostic on demand, so a
   user who missed the load-time warning can recover it. `--json` makes it
   scriptable.
3. **Deterministic load order.** `loadDefaultPlugins` and
   `loadInstalledPlugins` both `.sort()` their `readdirSync` results.
   "Who wins" is therefore stable for a given set of installed packages
   regardless of OS, filesystem, or install order.

Default plugins always load before user-installed plugins (built-ins
always win). User-vs-user precedence falls back to alphabetical order on
the canonical key (`package.json#name` for plugin-name comparisons,
install-directory entry for command-name comparisons).

### What "first registration wins" means in practice

- For a **command-name** collision, only the colliding command is dropped
  from the loser. The loser's other commands continue to load and
  dispatch normally.
- For a **plugin-name** collision, the entire losing plugin is rejected
  before its module body is imported. Its top-level side effects do not
  run; none of its commands register.

### Why not stricter policies

The issue listed several candidates; we deliberately picked the cheapest
one that fixes the silent-shadow problem. Brief notes on the alternatives:

- **Reject-and-skip both.** Punishes the user for upstream collisions
  they cannot fix. A user who installs two plugins for orthogonal reasons
  loses both because the authors happened to pick the same command name.
- **Plugin namespacing (`c8ctl <plugin> <command>`).** Removes collisions
  by construction but is a breaking change for every existing plugin.
  Could be added as opt-in via `metadata.namespaced: true` in a future
  release; not required to close the silent-failure gap.
- **User-pinned precedence (`~/.c8ctl/plugin-precedence.json`).** Most
  flexible but also most complex. Worth revisiting if the doctor command
  shows real-world collisions are common.

The current policy keeps the door open for any of those — it just
guarantees that, today, no command silently disappears.

## Reproducing a collision (for plugin authors and reviewers)

### Command-name collision

Two installed plugins (different package names, same command):

```sh
mkdir -p /tmp/c8ctl-collision/plugins/node_modules/plugin-a
mkdir -p /tmp/c8ctl-collision/plugins/node_modules/plugin-b
cat > /tmp/c8ctl-collision/plugins/node_modules/plugin-a/package.json <<'JSON'
{ "name": "plugin-a", "version": "0.0.0", "keywords": ["c8ctl-plugin"], "main": "c8ctl-plugin.js", "type": "module" }
JSON
cat > /tmp/c8ctl-collision/plugins/node_modules/plugin-a/c8ctl-plugin.js <<'JS'
export const commands = { 'model': async () => console.log('A wins') };
export const metadata = { name: 'plugin-a' };
JS
cp -R /tmp/c8ctl-collision/plugins/node_modules/plugin-{a,b}
sed -i '' 's/plugin-a/plugin-b/g; s/A wins/B wins/' /tmp/c8ctl-collision/plugins/node_modules/plugin-b/{package.json,c8ctl-plugin.js}

C8CTL_DATA_DIR=/tmp/c8ctl-collision c8ctl doctor plugin
```

Expected output: a `command-name` collision row naming `plugin-a`
(winner) and `plugin-b` (loser) for the `model` command.

### Plugin-name collision

Two installed plugins with the same `package.json#name`:

```sh
mkdir -p /tmp/c8ctl-name-collision/plugins/node_modules/plugin-a-v1
mkdir -p /tmp/c8ctl-name-collision/plugins/node_modules/plugin-a-v2
# Both package.json#name = "plugin-a"
```

Expected output: a `plugin-name` collision row naming `plugin-a` as both
winner and loser; the second copy's module body never executes.

## Naming hygiene (recommendation, not enforcement)

Plugin authors are encouraged to prefix their command names with the
plugin's short name, e.g. `mycorp-model` rather than `model`. This is a
documentation-only mitigation — c8ctl does not enforce it — but it
substantially reduces the collision rate in practice. See PLUGIN-HELP.md
for the full naming-convention guidance.

## Tooling reference

- `c8ctl doctor plugin` — text-mode summary of loaded plugins and any
  detected collisions. Exit code is always 0 (the doctor reports state;
  it does not enforce policy).
- `c8ctl doctor plugin --json` — machine-readable form:

  ```json
  {
    "loaded": [
      { "name": "plugin-a", "commands": ["model"] }
    ],
    "collisions": [
      {
        "kind": "command-name",
        "winner": "plugin-a",
        "loser": "plugin-b",
        "command": "model"
      },
      {
        "kind": "plugin-name",
        "winner": "plugin-x",
        "loser": "plugin-x"
      }
    ]
  }
  ```

The class-scoped guard tests that lock this contract live in
[tests/unit/plugin-doctor.test.ts](../tests/unit/plugin-doctor.test.ts)
and [tests/unit/plugin-passthrough.test.ts](../tests/unit/plugin-passthrough.test.ts)
(the duplicate-name and duplicate-command sections).
