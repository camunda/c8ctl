# AGENTS.md — `element-template` plugin

Read [docs/design.md](./docs/design.md) before changing this plugin. It
covers the **why**: vendor bundle, marketplace endpoint choice, cache
strategy (`upstreamRef`-keyed dedup), lazy bootstrap, and semver-based
version resolution.

## Where things live

| File | Purpose |
| --- | --- |
| `c8ctl-plugin.ts` | Plugin API (metadata + commands export), subcommand dispatch table |
| `commands/<name>.ts` | One file per subcommand: `apply`, `get`, `get-properties`, `info`, `search`, `sync` |
| `template-ref.ts` | `parseTemplateRef`, `readBpmnInput`, `getExecutionPlatformVersion`, `resolveOotbTemplate`, `loadTemplate` |
| `marketplace.ts` | Cache I/O, `/ootb-connectors` fetch, sync, search, version resolution |
| `helpers.ts` | `--set` parsing, file/URL fetch, glob → regex, multi-binding lookup, condition warnings |
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
- **No subcommand auto-bootstraps the cache.** OOTB-id resolution
  is guarded by `requireCachePresent()` in `marketplace.ts`, which
  throws the shared `CACHE_NOT_FOUND_MESSAGE` when the cache is
  absent. The reason auto-bootstrap is forbidden: bootstrap progress
  goes through `logger.info`, which writes to stdout in text mode —
  it would corrupt `apply | bpmn lint` and `get <id> > template.json`
  pipelines, and racing cold-cache invocations would both fetch the
  same ~14 MB index. Don't re-add a bootstrap call to any subcommand
  without changing the logger story first.
- **Path/URL apply paths must not trigger the cache check.**
  Detection happens in `parseTemplateRef()` in `template-ref.ts`
  before any cache call.
- **`saveCache` and `apply --in-place` writes are atomic.** Both
  use a sibling temp file + `renameSync`. Anything else that
  overwrites a user-owned file (cache or BPMN) must follow the same
  pattern — a kill mid-write must not leave a truncated file.
- **`syncTemplates` is serialised by an advisory lockfile.** The
  helper `withSyncLock` in `marketplace.ts` holds
  `<cacheDir>/.sync.lock` while the body runs, with stale-lock
  recovery (dead PID or > 60 min old) and signal handlers
  (SIGINT/SIGTERM/SIGHUP) that release before re-raising. Don't
  bypass it from new code paths.
- **`apply` and `get` install an EPIPE handler before writing to
  stdout** (`installStdoutEpipeHandler()` in `helpers.ts`). New
  subcommands that write to stdout must do the same — otherwise
  `... | head -c N` closing the pipe early crashes the process.
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
npm run build:vendor && node --experimental-strip-types --test tests/unit/element-template.test.ts
```

Smoke-test against the live marketplace (writes to a throwaway dir):

```bash
C8CTL_DATA_DIR=/tmp/c8ctl-smoke node --experimental-strip-types src/index.ts \
  element-template search "AWS S3"
```
