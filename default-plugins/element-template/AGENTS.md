# AGENTS.md — `element-template` plugin

Read [docs/design.md](./docs/design.md) before changing this plugin. It
covers the **why**: vendor bundle, marketplace endpoint choice, cache
strategy (`upstreamRef`-keyed dedup), lazy bootstrap, semver-based
version resolution, and the default-plugin-vs-core-command rationale.

## Where things live

| File | Purpose |
| --- | --- |
| `c8ctl-plugin.js` | Subcommand dispatch (`search`, `info`, `get-properties`, `apply`, `get`, `sync`), arg parsing, vendor-bundle apply |
| `marketplace.js` | Cache I/O, `/ootb-connectors` fetch, sync, search, version resolution |
| `helpers.js` | `--set` parsing, file/URL fetch, glob → regex, multi-binding lookup, condition warnings |
| `vendor-src/bundle-entry.js` | esbuild entry — re-exports `Modeler`, `CloudElementTemplatesCoreModule`, `ZeebeModdleExtension` |

## Things to know before editing

- **Touching anything bpmn-js related requires `npm run build:vendor`.**
  The plugin loads `dist/vendor/bpmn-element-templates.cjs`, not the
  source. `vendor-src/bundle-entry.js` is the only entry point that
  esbuild bundles.
- **Cache file shape mirrors Desktop Modeler's
  `.camunda-connector-templates.json`.** Don't change the format
  without reason — `metadata.upstreamRef` is the dedup key for
  incremental sync.
- **`get` deliberately does NOT auto-bootstrap.** Bootstrap progress
  goes through `logger.info`, which writes to stdout in text mode —
  that would corrupt `get <id> > template.json` redirects. Cache miss
  surfaces as an explicit error pointing at `sync`. Don't add a
  bootstrap call to `getSubcommand` without changing the logger story
  first.
- **Path/URL apply paths must not trigger the index bootstrap.**
  Detection happens in `parseTemplateRef()` in `c8ctl-plugin.js`
  before any cache call.
- **JSON output uses element-templates schema field names verbatim.**
  No invented derivations — `binding`, `optional`, `value`, `condition`,
  `group` (id), `elementType: { value }`, `engines: { camunda }`. The
  only c8ctl-internal extension is `metadata.upstreamRef`, which `get`
  strips before serializing.
- **Property dedup is by object reference, not by `binding.name|type`.**
  Template authors sometimes attach two properties with the same binding
  name + type but different `condition` clauses (operation-conditional
  duplicates); the engine drops inactive ones at apply time. The
  WeakMap-based `sourceByDetail` side table in `loadTemplate` preserves
  this identity so `get-properties` doesn't collapse them and `--set`
  writes to all matching duplicates.
- **Marketplace endpoint URL is overridable via
  `C8CTL_OOTB_ELEMENT_TEMPLATES_URL`** — useful for tests against a
  local fixture server.

## Testing

```bash
node --experimental-strip-types --test tests/unit/element-template.test.ts
```

Smoke-test against the live marketplace (writes to a throwaway dir):

```bash
C8CTL_DATA_DIR=/tmp/c8ctl-smoke node --experimental-strip-types src/index.ts \
  element-template search "AWS S3"
```
