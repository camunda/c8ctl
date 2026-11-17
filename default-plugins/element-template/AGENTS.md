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
| `commands/migrate.ts` | `update` CLI orchestration; consumes the migration API bundled into the vendor module. |
| `migration-types.ts` | c8ctl's typed boundary for the package's public migration API; no engine implementation. |
| `migration-values.ts` | c8ctl's BPMN value reader used to redact diagnostics. |
| `migration-output.ts` | c8ctl report rendering and diagnostic redaction. |
| `recipe-schema.ts` | Host-owned compatibility gate for the provisional recipe format. |
| `template-ref.ts` | `parseTemplateRef`, `readBpmnInput`, `getExecutionPlatformVersion`, `findLocalTemplates` (Modeler-aligned `.camunda/element-templates/` + Modeler user-data lookup), `resolveOotbTemplate`, `resolveTemplateId` (local first, then OOTB — every subcommand's id path), `loadTemplate` |
| `cache.ts` | Cache I/O, sync, search, version resolution |
| `helpers.ts` | `--set` parsing, file/URL fetch, glob → regex, multi-binding lookup, condition warnings, `atomicOverwriteFile` |
| `vendor.ts` | `resolveVendorBundle()` + the minimal bpmn-js `Modeler`/`modeling` type surface shared by `apply`/`edit` |
| `vendor-src/bundle-entry.js` | esbuild entry — bundles the migration API alongside `Modeler`, `CloudElementTemplatesCoreModule`, and `ZeebeModdleExtension` |

## Things to know before editing

- **Touching anything bpmn-js related requires `npm run build:vendor`.**
  The plugin loads `dist/vendor/bpmn-element-templates.cjs`, not the
  source. `vendor-src/bundle-entry.js` is the only entry point that
  esbuild bundles.
- **Migration must work without the development package installed.**
  Load the migration API through the vendor bundle, never a runtime
  import or dynamic require of `bpmn-js-element-templates/migration`.
  The installed-layout test guards this production boundary.
- **Recipe schema policy belongs to c8ctl, not the shared engine.**
  Metadata-based migration instructions remain accepted but unsupported.
  Remove the provisional compatibility code when the formal schema replaces
  it; do not add host-specific upgrade guidance to the shared engine.
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
npm run build:vendor && node --experimental-strip-types --import ./tests/utils/isolate-user-data-dir.ts --test tests/unit/element-template.test.ts
```

Test fixtures in `tests/fixtures/element-templates/` are synthetic. Never
commit upstream connector templates (see its `SOURCES.md`). The shared
package owns engine unit tests. Verify the host integration and the
production layout after building against an API-bearing package:

```bash
npm run build:dist
node --experimental-strip-types --import ./tests/utils/isolate-user-data-dir.ts --test tests/unit/element-template-update-scenarios.test.ts tests/unit/element-template-update-selection.test.ts tests/unit/element-template-production-package.test.ts
```

Smoke-test against the live npm package (writes to a throwaway
dir):

```bash
export C8CTL_DATA_DIR=/tmp/c8ctl-smoke
node --experimental-strip-types src/index.ts element-template sync
node --experimental-strip-types src/index.ts element-template search "AWS S3"
```
