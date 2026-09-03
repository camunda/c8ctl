# AGENTS.md — `element-template` plugin

Read [docs/design.md](./docs/design.md) before changing this plugin. It
covers the **why**: vendor bundle, release-bundle source choice, cache
strategy (`upstreamRef`-keyed dedup), lazy bootstrap, and semver-based
version resolution.

## Where things live

| File | Purpose |
| --- | --- |
| `c8ctl-plugin.ts` | Plugin API (metadata + commands export), subcommand dispatch table |
| `commands/<name>.ts` | One file per subcommand: `apply`, `edit`, `get`, `get-properties`, `info`, `search`, `sync` |
| `template-ref.ts` | `parseTemplateRef`, `readBpmnInput`, `getExecutionPlatformVersion`, `resolveOotbTemplate`, `loadTemplate` |
| `cache.ts` | Cache I/O, sync, search, version resolution |
| `releases.ts` | `camunda/connectors` GitHub releases: listing, newest-release-per-minor selection, bundle download, tar.gz reader |
| `helpers.ts` | `--set` parsing, file/URL fetch, glob → regex, multi-binding lookup, condition warnings, `atomicOverwriteFile` |
| `binding.ts` | Binding-target resolution shared by `apply`/`edit` — which moddle child + property a `zeebe:input`/etc. binding writes to. Hand-rolled stand-in for bpmn-js-element-templates' internal `setPropertyValue`; see the note at the top of the file about replacing it once bpmn-io/bpmn-js-element-templates#236 ships. |
| `vendor.ts` | `resolveVendorBundle()` + the minimal bpmn-js `Modeler`/`modeling` type surface shared by `apply`/`edit` |
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
  is guarded by `requireCachePresent()` in `cache.ts`, which
  throws the shared `CACHE_NOT_FOUND_MESSAGE` when the cache is
  absent. The reason auto-bootstrap is forbidden: bootstrap progress
  goes through `logger.info`, which writes to stdout in text mode —
  it would corrupt `apply | bpmn lint` and `get <id> > template.json`
  pipelines, and racing cold-cache invocations would both download the
  same bundles. Don't re-add a bootstrap call to any subcommand
  without changing the logger story first.
- **Path/URL apply paths must not trigger the cache check.**
  Detection happens in `parseTemplateRef()` in `template-ref.ts`
  before any cache call.
- **`saveCache` and `apply --in-place` writes are atomic.** Both
  use a sibling temp file + `renameSync`. Anything else that
  overwrites a user-owned file (cache or BPMN) must follow the same
  pattern — a kill mid-write must not leave a truncated file.
- **`syncTemplates` is serialised by an advisory lockfile.** The
  helper `withSyncLock` in `cache.ts` holds
  `<cacheDir>/.sync.lock` while the body runs, with stale-lock
  recovery (dead PID or > 60 min old) and signal handlers
  (SIGINT/SIGTERM/SIGHUP) that release before re-raising. Don't
  bypass it from new code paths.
- **`apply`, `edit`, and `get` install an EPIPE handler before writing
  to stdout** (`installStdoutEpipeHandler()` in `helpers.ts`). New
  subcommands that write to stdout must do the same — otherwise
  `... | head -c N` closing the pipe early crashes the process.
- **`apply` vs `edit`: applying a template is not the same operation as
  editing one property on an already-applied element.** `apply` calls
  `elementTemplates.applyTemplate()`, which unconditionally resets every
  `Hidden`-typed template property to its template default on *every*
  call — correct for first-time application or a version upgrade, but
  it silently clobbers any hand-authored customization layered into a
  Hidden-owned extension attribute (see c8ctl#466). `edit` never calls
  `applyTemplate()` — it only writes into moddle children that already
  exist via `modeling.updateModdleProperties`, so it can't create a
  property whose gating condition wasn't previously met, but it also
  can't reset anything the template doesn't explicitly touch. Don't
  collapse these back into one code path without re-solving that
  tension.
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
- **Templates come from the `camunda/connectors` GitHub releases, not
  `raw.githubusercontent.com`** (blocked in many enterprise networks —
  c8ctl#530). `sync` keeps the newest release per minor line, skipping
  drafts, release candidates and releases whose bundle asset isn't
  published yet. The release listing endpoint is overridable via
  `C8CTL_CONNECTORS_RELEASES_URL` — useful for tests against a local
  fixture server.

## Testing

```bash
npm run build:vendor && node --experimental-strip-types --test tests/unit/element-template.test.ts
```

Smoke-test against the live connectors releases (writes to a throwaway
dir):

```bash
C8CTL_DATA_DIR=/tmp/c8ctl-smoke node --experimental-strip-types src/index.ts \
  element-template search "AWS S3"
```
