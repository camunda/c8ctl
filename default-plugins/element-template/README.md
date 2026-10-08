# c8ctl-plugin-element-template

A default [c8ctl](https://github.com/camunda/c8ctl) plugin for applying
Camunda element templates to BPMN diagrams, inspecting their properties,
and exporting raw template JSON. Supports out-of-the-box (OOTB)
connector templates by id (downloaded on demand from the Camunda
marketplace), plus arbitrary local paths and URLs.

## Subcommands

The verb is organized as a workflow: discover → inspect → act → export → maintain.

| Subcommand | Purpose |
|------------|---------|
| `search <query>` | Find OOTB templates by keyword (deprecated entries hidden). `--engine-version` narrows to compatible versions. |
| `info <template>` | Show the template metadata card (id, version, applies-to, engines, docs). `--engine-version` resolves the latest compatible version. |
| `get-properties <template> [<name>...]` | List settable properties — condensed by default, `--detailed` for full cards. `--engine-version` resolves the latest compatible version. |
| `apply <template> <element-id> [<file.bpmn>]` | Apply a template to a BPMN element (in place, or to stdout). |
| `update <element-id> [<file.bpmn>]` | Move an element to a newer version of its template, migrating its values. |
| `change <template> <element-id> [<file.bpmn>]` | Move an element to another template, migrating its values. `--successor` picks the template that supersedes the applied one. |
| `get <template>` | Print the raw template JSON to stdout (pipe-friendly). |
| `sync` | Populate / refresh the local OOTB template cache. **Run this once before any other OOTB subcommand.** |

`<template>` is a local path, an `https://` URL, or an OOTB template id
(optionally pinned: `<id>@<version>`). GitHub blob URLs are
auto-rewritten to raw content URLs — paste straight from the address bar.

> **First-run setup:** OOTB-id subcommands (`search`, `info`,
> `get-properties`, `apply <id>`, `get <id>`) need a populated cache.
> Run `c8ctl element-template sync` once per machine; subsequent commands
> read from it. A missing cache surfaces a one-line error pointing back
> at `sync`.

## Usage

```bash
# Search OOTB templates
c8ctl element-template search "AWS S3"
c8ctl element-template search "http"
c8ctl element-template search "AWS" --limit 5      # cap results (default 20)
c8ctl element-template search "http" --engine-version 8.8.0

# Show the template metadata card
c8ctl element-template info io.camunda.connectors.HttpJson.v2
c8ctl element-template info io.camunda.connectors.HttpJson.v2 --engine-version 8.8

# List every settable property as a condensed name + description row
c8ctl element-template get-properties io.camunda.connectors.HttpJson.v2
c8ctl element-template get-properties io.camunda.connectors.HttpJson.v2 --engine-version 8.8.0

# Filter by name (positional, supports shell-style globs — quote them)
c8ctl element-template get-properties io.camunda.connectors.HttpJson.v2 url method
c8ctl element-template get-properties io.camunda.connectors.HttpJson.v2 'authentication.*'

# Filter by group id (repeatable; ids come from `get-properties` group headings)
c8ctl element-template get-properties io.camunda.connectors.HttpJson.v2 \
  --group authentication --group endpoint

# Drill into specific properties as full detail cards
c8ctl element-template get-properties io.camunda.connectors.HttpJson.v2 \
  --detailed authentication.token url

# Apply by OOTB id — version is auto-resolved against the BPMN's
# modeler:executionPlatformVersion (highest compatible version wins)
c8ctl element-template apply io.camunda.connectors.HttpJson.v2 \
  ServiceTask_1 process.bpmn

# Pin a specific version
c8ctl element-template apply io.camunda.connectors.HttpJson.v2@13 \
  ServiceTask_1 process.bpmn

# Apply from a local file or URL
c8ctl element-template apply ./templates/my-task.json ServiceTask_1 process.bpmn
c8ctl element-template apply https://example.com/template.json ServiceTask_1 process.bpmn

# GitHub blob URLs are auto-rewritten to the raw content URL
c8ctl element-template apply \
  https://github.com/camunda/connectors/blob/main/connectors/http/rest/element-templates/http-json-connector.json \
  ServiceTask_1 process.bpmn

# Modify the BPMN file in place (default writes the result to stdout)
c8ctl element-template apply -i io.camunda.connectors.HttpJson.v2 \
  ServiceTask_1 process.bpmn

# Stream BPMN through stdin, get the modified BPMN on stdout. Works
# with slow upstream producers (lint, apply chained together, etc.) —
# stdin is consumed asynchronously and waits for the writer to finish.
cat process.bpmn | c8ctl element-template apply io.camunda.connectors.HttpJson.v2 ServiceTask_1 \
  > out.bpmn

# Chain with bpmn lint
c8ctl element-template apply io.camunda.connectors.HttpJson.v2 ServiceTask_1 process.bpmn \
  | c8ctl bpmn lint

# Save a template's raw JSON to a file (works for ids, URLs, and local paths)
c8ctl element-template get io.camunda.connectors.HttpJson.v2 > template.json
c8ctl element-template get https://example.com/template.json > template.json
c8ctl element-template get ./template.json > copy.json    # passthrough — bytes preserved
c8ctl element-template get io.camunda.connectors.HttpJson.v2 --no-icon  # drop the base64 icon blob

# Refresh the local OOTB template cache
c8ctl element-template sync
c8ctl element-template sync --prune    # also drop entries no longer in a selected release
```

## Migrating to a newer template

`update` and `change` move an element that already has a template to a newer
version of it, or to a different template. Values the new template binds under
another key are moved along instead of being dropped, and a report lists what
happened.

```bash
# Preview moving an element to the latest compatible version of its template
c8ctl element-template update Task_1 process.bpmn --dry-run

# Move an element from a deprecated template to the one that supersedes it
c8ctl element-template change --successor Agent_1 process.bpmn --in-place

# Move to a specific template, with a recipe from a file
c8ctl element-template change new-template.json Task_1 process.bpmn --recipe recipe.json

# The report as data (needs --in-place or --dry-run, because stdout carries the BPMN otherwise)
c8ctl element-template update Task_1 process.bpmn --dry-run --json
```

- `update` resolves the newest version of the applied template compatible with
  the BPMN's `modeler:executionPlatformVersion`; `--to-version <n>` pins one.
  It only works for templates in the local cache.
- `change` takes a template like `apply` does. `--successor` picks the one
  non-deprecated compatible template that declares a migration from the applied
  one, and fails when there are none or several.
- Without `--in-place` the BPMN goes to stdout and the report to stderr.
- Lossy in-place writes and refused embedded-recipe fallbacks require `--allow-lossy`.
  Preview with `--dry-run` first. Unusable explicit `--recipe` files always fail,
  even with authorization; correct the source entry or source-version floor.
- In-place migrations take a sibling `.migration.lock` and check original input
  contents before temporary-file preparation and again immediately before rename.
  Changes observed during preparation are rejected. Replacement uses a sibling
  temporary file and rename; rename failures, including EXDEV, fail without a
  direct overwrite.
  A killed writer can leave a stale lock and temporary file; confirm no writer is
  active before inspecting and removing them. Recovery is manual. External edits
  between the final comparison and rename and symlink aliases are not covered by
  the cooperative lock; this design has no atomic compare-and-swap. Tests cover
  injected ENOSPC/EIO before and after actual partial bytes and real SIGINT/SIGTERM
  termination during paused split writes, preserving original bytes. Physical
  disk exhaustion and interruption of an executing kernel syscall are not proven.
  Windows was not run; POSIX signal tests skip Windows. Cleanup attempts preserve
  the primary operation error; failed cleanup can leave artifacts for manual recovery.
- Migration requires `executionPlatform="Camunda Cloud"` and
  `executionPlatformVersion` in the Modeler namespace
  `http://camunda.org/schema/modeler/1.0` (the usual prefix is `modeler`; aliases
  are accepted). Exactly one of each attribute is required. Versions accept strict
  `major.minor` or full semantic versions, including standard prerelease/build
  syntax; arbitrary coercible strings are rejected. Standard semver prerelease
  matching applies. Incompatible explicit targets and malformed declared engine
  constraints are rejected; automatic selection uses compatible source versions.
  Missing template engine constraints retain legacy eligibility. Every required
  intermediate version must also be compatible and available.
- No-op XML output preserves the original BPMN bytes and sends its message to
  stderr. JSON emits the migration-report envelope with `noop: true` and empty
  change collections. In-place no-ops do not rewrite the BPMN, and dry-run emits
  no XML and writes no BPMN files. Supplied recipes are still validated.
- Colour and emoji markers are used in text mode. Colour follows the terminal
  and honours `NO_COLOR` and `FORCE_COLOR`.
- Report values with credential-like keys, labels or template property/group
  metadata are redacted in text and JSON, including dry-run. Known sensitive
  values are also scrubbed from notes and CLI diagnostics. This does not change
  migration decisions or BPMN values. Custom secrets without recognizable identity,
  unknown secret text and alternate encodings cannot be identified reliably.
  **Raw BPMN XML retains secrets**, including no-op stdout; avoid logging it.

### Migration recipes

A recipe describes how values of older templates map onto the template that
carries it. It lives in the target template as `metadata.migratesFrom`, or in
a file passed with `--recipe`, which replaces the embedded one. Without a recipe,
values are carried over by binding identity and the rest is dropped; the report
lists each drop with its old value, subject to sensitivity redaction. Unusable
explicit recipes fail even with `--allow-lossy`; refused embedded recipes require
authorization except when previewing. Diagnostics distinguish malformed recipes,
coverage refusal, wrong source IDs and unmet reached-version floors. An empty
`--recipe` value is an error, not a request for ordinary carry-over.

```json
{
  "schemaVersion": 1,
  "sources": [
    {
      "kind": "change",
      "sourceTemplateId": "io.example.connector.v1",
      "minSourceVersion": 3,
      "paths": [
        { "from": "provider", "to": "backend.provider",
          "valueMap": { "rules": [{ "match": "azure", "value": "openai" }] } },
        { "to": "backend.type", "set": "foundry",
          "when": { "path": "provider", "equals": "azure" },
          "note": { "level": "warning", "message": "Azure now runs on the Foundry backend." } }
      ]
    }
  ]
}
```

| Entry | Effect |
|-------|--------|
| `{ from, to, valueMap? }` | Moves a value to another key, optionally translating it (`*` globs, first match wins, optional `default`). |
| `{ to, set }` | Writes a static value, for example a new discriminator. |
| `{ to, template }` | Composes a value from source values with `${path}`. |
| `{ when, rules: [...] }` | Applies the nested entries only when the guard holds. |

Any entry can carry `when` (`equals`, `matches`, `in`, `exists`, optionally negated with `not`) and
`note`: a message shown in the report when the entry took effect, either a string or
`{ "level": "info" | "warning", "message": "..." }`. Paths are binding keys; prefix one with
`input:`, `output:`, `header:`, `property:`, `taskDefinition:`, `agentDefinition:` or `adHoc:` when the
same key is bound by several binding types.
Unqualified rename sources, guards and interpolation references reject ambiguous
binding types. Duplicate backing entries/containers also fail rather than choosing
an arbitrary value. Simultaneously active writes to the same resolved destination
fail even when one uses a qualified alias; mutually exclusive guarded writes and
qualified writes to distinct binding types remain valid.

Migration validates resolved writes and populated non-Hidden carry-over against
active destination properties, including conditional duplicates. Supported checks
are choices, `notEmpty` and patterns. Optional/required FEEL expressions bypass
literal choices/patterns, but empty required expressions fail. Unsupported active
constraints or unsupported/cyclic conditions fail closed. This does not validate
FEEL expression syntax. Reports reconcile surviving writes with actual stored
values, including FEEL normalization, rather than claiming planner intent as success.

A source with `kind: "upgrade"` requires `toVersion` and the recipe owner's ID: an element climbs
each destination above its applied version in ascending order. A `kind: "change"` source must name
a different ID and may require `minSourceVersion`, a floor on the version actually reached by
source upgrades. Merely loading a newer template does not satisfy that floor. The highest reachable
floor wins; an omitted floor is the fallback. File recipes replace only the target recipe.
This revised dialect keeps `schemaVersion: 1` but rejects legacy `minVersion` recipes and requires
`kind` on every source. Older strict readers reject the new fields. See
[`migration/migrates-from.schema.json`](./migration/migrates-from.schema.json) for the full format.
Recipes are validated strictly: an unknown key or an unsupported `schemaVersion` fails the command
instead of being ignored. `metadata.migratesFrom` is not part of the official element template schema.
Draft07 validation alone is insufficient: the parser also rejects duplicate source markers/floors,
and owner validation checks source IDs and upgrade destinations against the template carrying the recipe.
An optional `$schema` accepts any string, including blank strings. Paths, IDs, notes, templates,
and match patterns require a non-whitespace character; surrounding whitespace is preserved.
Scalar values accept strings (including blank strings), finite numbers, and booleans. An omitted
note level defaults to `info`; explicit `null` is invalid. Empty `paths` and guard `in` lists are valid,
but sources, groups, guard lists, and value-map rules must be non-empty.

### Review status

Implementation and independent adversarial review have been performed for
MIG-001 through MIG-014. MIG-004's catalog-authority and MIG-006's shell-completion
fixes have reported passing verification. MIG-012 implementation/testing is
complete: 48 passing CLI cases (two recipe suites plus 46 filesystem cases),
expanded from 18 to 32 during implementation and to 48 during independent review.
Engineer acceptance of the documented environment and atomic-CAS limits remains
pending. The final Node 22 build/typecheck/test invocation exited 0 according to
the coordinator: 3,896 unit passes, 191 integration passes, two integration skips
and zero failures. MIG-014 current PR verification acceptance is closed.
Historical failures are not shown attributable to this PR and impose no diagnosis
obligation here. Two occurrences of the external `typed-env` build warning are
recorded separately in `.github/SDK_GAPS.md` under general repository policy,
without reopening MIG-014 or adding an upstream root-cause gate to this PR.
No warning-free repository release baseline is claimed. See
[Migration Review PRD](docs/migration-review-prd.md)
and [Migration Test Coverage](docs/migration-test-coverage.md) for scoped evidence
and remaining gates.

## Inspecting a template

`info` and `get-properties` separate the two questions an agent or human
typically asks of a template — *what is this thing?* (metadata) and
*what knobs can I turn?* (properties).

### `info` — metadata card

```bash
c8ctl element-template info io.camunda.connectors.HttpJson.v2
```

```
REST Outbound Connector
  ID           io.camunda.connectors.HttpJson.v2
  Version      13  (latest; @<n> to pin)
  Applies to   bpmn:Task → bpmn:ServiceTask
  Engines      ^8.9
  Description  Invoke REST API
  Docs         https://docs.camunda.io/docs/components/connectors/protocol/rest/

For settable properties, run:
  c8ctl element-template get-properties io.camunda.connectors.HttpJson.v2
```

When you give an OOTB id without `@<version>`, the auto-resolved version
is annotated with a dim `(latest; @<n> to pin)` parenthetical so you
know what was picked.

### `get-properties` — condensed listing

The default density is one row per property: name + description, grouped
by template group. Group headings include the `id` for use with `--group`.

```bash
c8ctl element-template get-properties io.camunda.connectors.HttpJson.v2
```

```
Showing 28 of 28 properties.

Authentication (authentication)
  authentication.type                  Choose the authentication type. Select 'None' if no authentication is necessary
  authentication.token                 Bearer token
  ...

HTTP endpoint (endpoint)
  method                               Method
  url                                  URL
  ...

Filter by name (supports globs):
  c8ctl element-template get-properties io.camunda.connectors.HttpJson.v2 'auth*' url
For full details on each property:
  c8ctl element-template get-properties io.camunda.connectors.HttpJson.v2 --detailed
```

Positional names filter the listing — pass one or more names, with
optional shell-style globs. `--group <id>` (repeatable) intersects with
the name filter. Both filters error on no-match instead of silently
empty so typos surface.

### `get-properties --detailed` — full cards

Same filter semantics, but every property is rendered as a keyed card
with its full descriptor:

```bash
c8ctl element-template get-properties io.camunda.connectors.HttpJson.v2 \
  --detailed authentication.token
```

```
Showing 1 of 28 properties.

authentication.token (Authentication)
  Id           authentication.token
  Type         String
  Required     yes
  FEEL         optional
  Binding      zeebe:input
  Description  Bearer token
  Active when  authentication.type = "bearer"
```

Cards surface everything `--set` needs to pick a value — type, required,
FEEL support, binding, full active-when expression, pattern + error
message, and the choice list for dropdowns.

### Machine-readable output

Switch the session into JSON mode and the same commands emit shapes
that mirror the text output (and use upstream
[element-templates JSON schema](https://unpkg.com/@camunda/zeebe-element-templates-json-schema)
field names verbatim — no invented names like `bindingType` or
`required`):

```bash
c8ctl output json
c8ctl element-template info io.camunda.connectors.HttpJson.v2
# → {"name":"REST Outbound Connector","id":"io.camunda.connectors.HttpJson.v2",
#    "version":13,"description":"Invoke REST API",
#    "documentationRef":"https://docs.camunda.io/...",
#    "appliesTo":["bpmn:Task"],"elementType":{"value":"bpmn:ServiceTask"},
#    "engines":{"camunda":"^8.9"}}

c8ctl element-template get-properties io.camunda.connectors.HttpJson.v2 url
# → {"count":1,"total":28,"groups":[{"id":"authentication","label":"Authentication"}, ...],
#    "properties":[{"id":"url","binding":{"name":"url","type":"zeebe:input"},
#      "label":"URL","group":"endpoint"}]}

c8ctl element-template get-properties io.camunda.connectors.HttpJson.v2 \
  --detailed authentication.token
# → {"count":1,"total":28,"groups":[...],
#    "properties":[{"id":"authentication.token",
#      "binding":{"name":"authentication.token","type":"zeebe:input"},
#      "type":"String","optional":false,"feel":"optional","group":"authentication",
#      "condition":{"property":"authentication.type","equals":"bearer","type":"simple"},
#      "label":"Bearer token","constraints":{"notEmpty":true}}]}
```

`get-properties` JSON keeps the same `{ count, total, groups, properties }`
envelope across both density modes — `count` is rendered properties,
`total` is the unfiltered count, `groups` is the full group table so
consumers can resolve any group id (not just those of rendered properties).

## Setting input mappings with `--set`

`apply` supports repeatable `--set key=value` flags to populate
template properties at apply time — input mappings, output mappings,
task headers, task definitions, and arbitrary template properties.
Use it to wire up a connector in one shot from the CLI:

```bash
# Apply the HTTP JSON connector and configure the request inline
c8ctl element-template apply -i io.camunda.connectors.HttpJson.v2 \
  ServiceTask_1 process.bpmn \
  --set authentication.type=noAuth \
  --set method=POST \
  --set url=https://api.example.com/v1/orders \
  --set body='={ "orderId": orderId, "amount": 42 }' \
  --set resultExpression='={ "status": response.statusCode }'
```

### How `--set` resolves a name

`key` is matched against the template's settable property
**binding names** (the field a template property writes to in the
resulting BPMN). Discover them with `get-properties`, then pick a value
using the badges on the detail card (Required, FEEL, Default, Active when).

### Disambiguation prefixes

When the same name lives on multiple binding types (e.g. an `input` and
a `header` both called `correlationKey`), prefix the key with the
binding type:

| Prefix              | Binding type           |
|---------------------|------------------------|
| `input:`            | `zeebe:input`          |
| `output:`           | `zeebe:output`         |
| `header:`           | `zeebe:taskHeader`     |
| `property:`         | `zeebe:property`       |
| `taskDefinition:`   | `zeebe:taskDefinition` |

```bash
--set input:correlationKey='=order.id'
--set header:correlationKey=staticHeaderValue
```

The plugin errors with the list of qualified names when a bare key is
ambiguous, and with the list of available property names when the key
is unknown.

When two settable properties share the same binding name **and** binding
type but differ by `condition` (template authors use this for
operation-conditional duplicates), `--set` writes to all of them — the
engine drops the inactive duplicates at runtime.

### Conditional properties

Templates often hide properties behind a "show this only when X" rule
(e.g. `authentication.username` is conditional on
`authentication.type=basic`). `--set` first sets the dependency, then
follow-up properties:

```bash
c8ctl element-template apply io.camunda.connectors.HttpJson.v2 \
  ServiceTask_1 process.bpmn \
  --set authentication.type=basic \
  --set authentication.username=alice \
  --set authentication.password=secret \
  --set method=GET \
  --set url=https://api.example.com/me
```

If a `--set` targets a property whose condition is unmet, you'll get a
warning at the end (the property won't be applied).

## How OOTB templates are resolved

1. **Source**: the `camunda/connectors` GitHub releases. `sync` lists
   the releases, keeps the newest release of each of the 4 newest minor
   lines (8.8.x, 8.9.x, ... — alphas count, release candidates don't),
   and downloads
   each one's `connectors-bundle-templates-<tag>.tar.gz` asset from
   `github.com`. `raw.githubusercontent.com` is deliberately not used:
   it is blocked in many enterprise networks. Override the release
   listing endpoint via `C8CTL_CONNECTORS_RELEASES_URL` for testing.
2. **Populate the cache once** via `c8ctl element-template sync`.
   Subcommands that resolve OOTB ids (`search`, `info`, `get-properties`,
   `apply`, `get`) exit non-zero with a hint to run `sync` when the
   cache is missing — no auto-download. This keeps pipelines clean:
   bootstrap progress would otherwise land on stdout and corrupt
   `apply | bpmn lint` or `get <id> > template.json`.
3. **Local file or URL** template args (paths containing `/` or `\`,
   starting with `.`, ending in `.json`, or starting with `http(s)://`)
   skip the cache entirely.
4. **Version selection** uses `semver.satisfies` against the BPMN's
   `modeler:executionPlatformVersion` and each template's
   `engines.camunda` constraint. Without `@<version>`, the highest
   compatible version wins.
5. **Stale cache** (>7 days) prints a hint to run `sync`. No automatic
   refresh — `sync` only downloads bundles not already cached (release
   assets are tag-pinned, so incremental sync is free).
6. **Concurrent syncs** are serialised by an advisory lock at
   `<cache-dir>/.sync.lock`. A second `sync` started while one is
   already running exits non-zero rather than racing.

### Cache locations

| Platform | Path |
|----------|------|
| macOS    | `~/Library/Application Support/c8ctl/element-templates/` |
| Linux    | `${XDG_CONFIG_HOME:-~/.config}/c8ctl/element-templates/` |
| Windows  | `%APPDATA%\c8ctl\element-templates\` |

Set `C8CTL_DATA_DIR` to override.

## Design

See [`docs/design.md`](./docs/design.md) for the full reasoning behind
the release-bundle source choice, the vendor bundle, the cache strategy
(mirrored from Desktop Modeler), and version resolution.
