# AGENTS.md — `element-template` plugin

Read [docs/design.md](./docs/design.md) before changing this plugin. It
covers the **why**: vendor bundle, marketplace endpoint choice, cache
strategy (`upstreamRef`-keyed dedup), lazy bootstrap, semver-based
version resolution, and the default-plugin-vs-core-command rationale.

## Where things live

| File | Purpose |
| --- | --- |
| `c8ctl-plugin.js` | Subcommand dispatch (`apply`, `list-properties`, `search`, `sync`), arg parsing, vendor-bundle apply |
| `marketplace.js` | Cache I/O, `/ootb-connectors` fetch, sync, search, version resolution |
| `helpers.js` | `--set` parsing, file/URL fetch, condition warnings |
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
- **Path/URL apply paths must not trigger the index bootstrap.**
  Detection happens in `parseTemplateRef()` in `c8ctl-plugin.js`
  before any cache call.
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
