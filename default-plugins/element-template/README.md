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
| `search <query>` | Find OOTB templates by keyword (deprecated entries hidden). |
| `info <template>` | Show the template metadata card (id, version, applies-to, engines, docs). |
| `get-properties <template> [<name>...]` | List settable properties — condensed by default, `--detailed` for full cards. |
| `apply <template> <element-id> [<file.bpmn>]` | Apply a template to a BPMN element (in place, or to stdout). |
| `get <template>` | Print the raw template JSON to stdout (pipe-friendly). |
| `sync` | Refresh the local OOTB template cache. |

`<template>` is a local path, an `https://` URL, or an OOTB template id
(optionally pinned: `<id>@<version>`). GitHub blob URLs are
auto-rewritten to raw content URLs — paste straight from the address bar.

## Usage

```bash
# Search OOTB templates
c8ctl element-template search "AWS S3"
c8ctl element-template search "http"
c8ctl element-template search "AWS" --limit 5      # cap results (default 20)

# Show the template metadata card
c8ctl element-template info io.camunda.connectors.HttpJson.v2

# List every settable property as a condensed name + description row
c8ctl element-template get-properties io.camunda.connectors.HttpJson.v2

# Filter by name (positional, supports shell-style globs — quote them)
c8ctl element-template get-properties io.camunda.connectors.HttpJson.v2 url method
c8ctl element-template get-properties io.camunda.connectors.HttpJson.v2 'authentication.*'

# Filter by group id (repeatable; ids come from the `info` card / group headings)
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
c8ctl element-template sync --prune    # also drop entries no longer in the index
```

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

1. **Index**: fetched from the Camunda marketplace
   (`https://marketplace.cloud.camunda.io/api/v1/ootb-connectors`) — the
   same source Desktop Modeler uses. Override via
   `C8CTL_OOTB_ELEMENT_TEMPLATES_URL` for testing.
2. **First use** of `search`, `info`, `get-properties`, `apply`, or
   `sync`: a one-shot bootstrap downloads ~459 templates with visible
   progress; per-template failures are logged but don't abort the run.
3. **`get` does NOT auto-bootstrap.** It exits with a hint to run
   `sync` first if the cache is missing — bootstrap progress would
   otherwise corrupt redirected stdout (`get <id> > template.json`).
4. **Local file or URL** template args (paths containing `/` or `\`,
   starting with `.`, ending in `.json`, or starting with `http(s)://`)
   skip the index entirely.
5. **Version selection** uses `semver.satisfies` against the BPMN's
   `modeler:executionPlatformVersion` and each template's
   `engines.camunda` constraint. Without `@<version>`, the highest
   compatible version wins.
6. **Stale cache** (>7 days) prints a hint to run `sync`. No automatic
   refresh — `sync` only fetches refs not already cached (commit-pinned
   URLs make incremental sync free).

### Cache locations

| Platform | Path |
|----------|------|
| macOS    | `~/Library/Application Support/c8ctl/element-templates/` |
| Linux    | `${XDG_CONFIG_HOME:-~/.config}/c8ctl/element-templates/` |
| Windows  | `%APPDATA%\c8ctl\element-templates\` |

Set `C8CTL_DATA_DIR` to override.

## Design

See [`docs/design.md`](./docs/design.md) for the full reasoning behind
the marketplace endpoint choice, the vendor bundle, the cache strategy
(mirrored from Desktop Modeler), and version resolution.
