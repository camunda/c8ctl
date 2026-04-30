# c8ctl-plugin-element-template

A default [c8ctl](https://github.com/camunda/c8ctl) plugin for applying
Camunda element templates to BPMN diagrams and inspecting their
properties. Supports out-of-the-box (OOTB) connector templates by id
(downloaded on demand from the Camunda marketplace), plus arbitrary
local paths and URLs.

## Usage

```bash
# Search OOTB templates
c8ctl element-template search "AWS S3"
c8ctl element-template search "http"

# Inspect a template's settable properties (id, local file, or URL)
c8ctl element-template list-properties io.camunda.connectors.HttpJson.v2
c8ctl element-template list-properties ./my-template.json

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

# GitHub blob URLs are auto-rewritten to the raw content URL — paste
# straight from the browser address bar.
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

# Refresh the local OOTB template cache
c8ctl element-template sync
c8ctl element-template sync --prune    # also drop entries no longer in the index
```

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
resulting BPMN). Discover them with `list-properties`:

```bash
c8ctl element-template list-properties io.camunda.connectors.HttpJson.v2
```

```
HTTP REST Connector (io.camunda.connectors.HttpJson.v2) v13

  Authentication:
    authentication.type            Dropdown [noAuth, apiKey, basic, bearer, oauth-client-credentials-flow]  (default: noAuth)
    authentication.apiKeyLocation  Dropdown [headers, query]  (conditional)
    authentication.username        String  (conditional)
    ...

  HTTP Endpoint:
    method                         Dropdown [GET, POST, PATCH, PUT, DELETE]  (default: GET)
    url                            String

  Payload:
    queryParameters                String
    headers                        String
    body                           String

  Output mapping:
    resultVariable                 String  [output]
    resultExpression               String  [output]
```

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
2. **First use** (any subcommand that needs the index): a one-shot
   bootstrap downloads ~459 templates with visible progress; per-template
   failures are logged but don't abort the run.
3. **Local file or URL** template args (paths containing `/` or `\`,
   starting with `.`, ending in `.json`, or starting with `http(s)://`)
   skip the index entirely.
4. **Version selection** uses `semver.satisfies` against the BPMN's
   `modeler:executionPlatformVersion` and each template's
   `engines.camunda` constraint. Without `@<version>`, the highest
   compatible version wins.
5. **Stale cache** (>7 days) prints a hint to run `sync`. No automatic
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
