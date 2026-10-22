# AGENTS.md — `element-template` plugin

Read [docs/design.md](./docs/design.md) before changing this plugin. It
covers the **why**: vendor bundle, npm package source choice, cache
strategy (`id@version`-keyed dedup), explicit bootstrap, and semver-based
version resolution.

## Where things live

| File | Purpose |
| --- | --- |
| `c8ctl-plugin.ts` | Plugin API (metadata + commands export), subcommand dispatch table |
| `commands/<name>.ts` | One file per subcommand: `apply`, `edit`, `get`, `get-properties`, `info`, `search`, `sync`, `update`. `update` is a thin wrapper over `commands/migrate.ts` |
| `migration/` | The migration engine behind `update`: recipe parser (`recipe.ts`, schema in `migrates-from.schema.json`), step resolution (`steps.ts`), value resolution (`plan.ts`), applying to a headless modeler (`apply.ts`) and the report model (`report.ts`). **Self-contained: nothing in this folder may import from c8ctl or from the rest of the plugin**, so it can be lifted out into a library. `migration-output.ts` (outside it) renders the report. |
| `template-ref.ts` | `parseTemplateRef`, `readBpmnInput`, `getExecutionPlatformVersion`, `findLocalTemplates` (Modeler-aligned `.camunda/element-templates/` + Modeler user-data lookup), `resolveOotbTemplate`, `resolveTemplateId` (local first, then OOTB — every subcommand's id path), `loadTemplate` |
| `cache.ts` | Cache I/O, sync, search, version resolution |
| `helpers.ts` | `--set` parsing, file/URL fetch, glob → regex, multi-binding lookup, condition warnings, `atomicOverwriteFile` |
| `vendor.ts` | `resolveVendorBundle()` + the minimal bpmn-js `Modeler`/`modeling` type surface shared by `apply`/`edit` |
| `vendor-src/bundle-entry.js` | esbuild entry — re-exports `Modeler`, `CloudElementTemplatesCoreModule`, `ZeebeModdleExtension` |

## Things to know before editing

- **Touching anything bpmn-js related requires `npm run build:vendor`.**
  The plugin loads `dist/vendor/bpmn-element-templates.cjs`, not the
  source. `vendor-src/bundle-entry.js` is the only entry point that
  esbuild bundles.
- **Cache file shape mirrors Desktop Modeler's
  `.camunda-connector-templates.json`.** Don't change the format
  without reason — current package templates replace cached entries
  by `id@version`; `metadata.upstreamRef` records their origin.
- **No subcommand auto-bootstraps the cache.** OOTB-id resolution
  is guarded by `requireCachePresent()` in `cache.ts`, which
  throws the shared `CACHE_NOT_FOUND_MESSAGE` when the cache is
  absent. The reason auto-bootstrap is forbidden: bootstrap progress
  goes through `logger.info`, which writes to stdout in text mode —
  it would corrupt `apply | bpmn lint` and `get <id> > template.json`
  pipelines, and racing cold-cache invocations would both install the
  same package. Don't re-add a bootstrap call to any subcommand
  without changing the logger story first.
- **Path/URL refs and local id hits must not trigger the cache check.**
  Detection happens in `parseTemplateRef()` in `template-ref.ts`
  before any cache call. An id found locally (`.camunda/element-templates/`
  or the Modeler user-data dir, see `resolveTemplateId`) never reaches
  `requireCachePresent()`; only the OOTB fallback does. `update` reads the
  cache only on a local gap (see `templatePool` in `commands/migrate.ts`).
- **`saveCache` and `apply --in-place` writes are atomic.** Both
  use a sibling temp file + `renameSync`. Anything else that
  overwrites a user-owned file (cache or BPMN) must follow the same
  pattern — a kill mid-write must not leave a truncated file.
  `atomicOverwriteFile` resolves the target with `realpathSync` first,
  so a symlinked BPMN keeps its link; locks on a BPMN path must use the
  resolved path too.
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
  `applyTemplate()` — it only writes the `--set` properties via the
  library's `elementTemplates.setPropertyValue` (gated by
  `isConditionMet`), so it can't reset anything the template doesn't
  explicitly touch. `edit` must also never register the template via
  `elementTemplates.set()`: the library's ConditionalBehavior would then
  re-run template application whenever a write changes the active
  property set. Don't collapse these back into one code path without
  re-solving that tension.
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
- **Templates come from `@camunda/connectors-element-templates` via
  `c8ctl.npm`**. Sync installs into a temporary directory under the locked
  cache, then reads `src/element-templates/*.json`;
  `C8CTL_ELEMENT_TEMPLATES_PACKAGE` allows package specs, URLs, and local
  paths. Failed installs or malformed template files retain the old cache
  and skip `--prune`.

## Testing

```bash
npm run build:vendor && node --experimental-strip-types --test tests/unit/element-template.test.ts
```

Test fixtures in `tests/fixtures/element-templates/` are synthetic. Never
commit upstream connector templates (see its `SOURCES.md`). To check the AI
Agent v1 to v2 migration against the real templates, fetched at a pinned
`camunda/connectors` commit:

```bash
C8CTL_FIDELITY=1 node --experimental-strip-types --test tests/unit/element-template-migration-upstream-fidelity.test.ts
```

Smoke-test against the live npm package (writes to a throwaway
dir):

```bash
C8CTL_DATA_DIR=/tmp/c8ctl-smoke node --experimental-strip-types src/index.ts \
  element-template sync
```
