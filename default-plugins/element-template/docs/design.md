# `element-template` plugin design

Lives at `default-plugins/element-template/`. Applies Camunda element
templates to BPMN elements and inspects their settable properties — for
local files, arbitrary URLs, and out-of-the-box (OOTB) connector
templates resolved by id.

## Vendor bundle for `bpmn-js-element-templates`

`apply` runs the same `Modeler` + `CloudElementTemplatesCoreModule` +
`ZeebeModdleExtension` stack as the Web/Desktop Modeler. Those upstream
libraries publish ESM with extensionless internal imports
(`import './foo'`), which Node refuses to resolve without a bundler.

Workaround: `default-plugins/element-template/vendor-src/bundle-entry.js`
re-exports the three modules; `npm run build:vendor` esbuilds it into
`dist/vendor/bpmn-element-templates.cjs`. The plugin loads it via
`createRequire(import.meta.url)`.

`resolveVendorBundle()` checks dev (`../../dist/vendor/...`) and prod
(`../../vendor/...`) paths because `dist/default-plugins/...` is the
shipped layout but during development we run directly from
`default-plugins/...`.

## OOTB template integration

`sync` reads `@camunda/connectors-element-templates` from npm. npm honours
the user's registry, scoped registry, proxy, CA and authentication settings.
The package is published from `camunda/connectors` and includes connector
templates and their metadata in one archive.

The archive contains arrays of versions in
`package/src/element-templates/*.json`. Entries without a numeric `version`
are legacy duplicates that version resolution cannot rank and are skipped;
entries without `engines` remain eligible for version selection. Hybrid
templates are not in the package.

The default sync asks npm for the latest published version, then uses `npm pack`
only if that immutable version is not cached completely. Set
`C8CTL_ELEMENT_TEMPLATES_PACKAGE` to a package spec, tarball URL or local path
to pin or supply the package offline. Local, URL and version-range overrides
are packed every time so mutable sources are not silently treated as immutable
registry versions.

## Cache strategy

We mirror Desktop Modeler's approach
(`camunda-modeler/app/lib/template-updater/`):

- Cache lives in `<userDataDir>/element-templates/`:
  - `templates.json` — flat array of all template objects (matches
    Modeler's `.camunda-connector-templates.json` shape).
  - `fetched-at` — epoch ms of last sync.
  - `package-state.json` — completed registry package version and template
    count, required before reusing it without downloading.
- Each cached template gets
  `metadata.upstreamRef = npm:<package>@<version>#<file-in-archive>` injected.
  This identifies entries from the single current package separately from
  older entries retained when `--prune` is omitted. Together with the
  completion record it lets sync reuse an immutable published version without
  downloading it again. It does not combine multiple configured packages.
  Matching `id@version` entries from the current package replace older copies.
- A pack failure retains the old cache and timestamp, and disables pruning.
  A cold sync fails instead of writing an empty cache.

### Lifecycle

- **Cache must be populated explicitly via `sync`.** Subcommands that
  need to resolve an OOTB id (`search`, `info`, `get-properties`,
  `apply <id>`, `get <id>`) fail fast with a one-line error pointing
  back at `sync` when the cache is absent. We deliberately do not
  auto-bootstrap: bootstrap progress goes through `logger.info`,
  which writes to stdout in text mode, and would corrupt the
  pipelines the README advertises (`apply ... | bpmn lint`,
  `get <id> > template.json`). It also avoids the concurrent-bootstrap
  race when several cold-cache invocations land at once.
- **Local file or URL paths** for `apply`/`get-properties`/`info`:
  never touch the cache at all. The plugin classifies the template
  arg in `parseTemplateRef` before any cache call.
- **Stale cache** (>7 days since `fetched-at`): warn-only, suggesting
  `c8ctl element-template sync`. We don't auto-refresh — surprise
  network activity inside `apply` is undesirable and a manual sync is
  cheap.
- **`sync`** checks npm for the latest version, downloading only when it
  changes. **`sync --prune`** drops cached entries absent from the current
  package; a failed download never prunes the previous cache.
- **Atomicity**: `sync` writes `templates.json` and `fetched-at`
  via a sibling temp file + `renameSync`, so a kill mid-sync leaves
  the previous cache intact. `apply --in-place` uses the same recipe
  for the user's BPMN file.
- **Concurrent syncs** are serialised by an advisory lock
  (`<cacheDir>/.sync.lock`) holding `{pid, startedAt}`. A second
  `sync` exits non-zero with a pointer to the lockfile; stale locks
  (dead PID, or > 60 min old as a backstop against PID-recycle ghost
  locks) are auto-recovered.
- **No cache, no network**: hard-fail with a clear message. No
  bundled fallback — `sync` is the one explicit step.

### Why not lazy per-template fetch on apply?

Earlier draft considered fetching only the requested `(id, version)`
on demand. Rejected because **search needs the template names**, which
means every template has to be read anyway. Package archives make this moot: the
whole package arrives in one request, so eager bulk fetch is both simpler
and faster than any lazy scheme.

## Version resolution

`apply` and `get-properties` accept three template-arg shapes:

| Shape | Detection | Resolution |
|---|---|---|
| `https://...` | starts with `http(s)://` | fetched directly, no cache |
| local path | contains `/`/`\`, starts with `.`, or ends with `.json` | read from disk |
| `<id>` or `<id>@<version>` | otherwise | `.camunda/element-templates/`, then the cache |

For `<id>` (no `@<version>`):

- `apply` parses the BPMN file's `modeler:executionPlatformVersion`
  attribute via bpmn-moddle (the same moddle instance used for the main
  parse), then picks the highest cached version where
  `semver.satisfies(coerce(executionPlatformVersion), engines.camunda)`
  is true. Templates without `engines.camunda` are treated as
  compatible (legacy fallback).
- `get-properties` has no BPMN context, so it picks the latest version
  and warns the user to pin with `id@<n>` if they want a specific one
  (same annotation as `info`).

An id is first looked up locally, the way Desktop Modeler's
[`ElementTemplatesProvider`](https://github.com/camunda/camunda-modeler/blob/main/app/lib/config/providers/ElementTemplatesProvider.js)
finds templates:

- `.camunda/element-templates/**/*.json` in the BPMN file's directory (or
  the current directory when there is no BPMN file) and every ancestor, up
  to and including the filesystem root, nearest first;
- then `resources/element-templates/**/*.json` in the Modeler's user-data
  dir (`camunda-modeler` under `%APPDATA%`, `$XDG_CONFIG_HOME` or
  `~/.config`, `~/Library/Application Support`; overridable via
  `C8CTL_MODELER_DIR`).

A file holds one template or an array; a malformed file is an error
(`template <path> parse error`), as in the Modeler. All templates with the
id are merged into one pool and validated with the
`CloudElementTemplatesCoreModule` loader from `bpmn-js-element-templates`
(schema validation; a duplicate id+version keeps the first, i.e. nearest,
one). Rejected templates are reported as warnings and skipped. The version
is then picked once over the pool with the same rules as for the cache.
Only when no local template matches does resolution fall back to the
cache, so a local hit works with a cold cache.

The validator is reached through the core module's loader rather than the
package-root `CloudElementTemplatesValidator` export: the root entry also
pulls in the properties panel, which touches `document` at load time and
cannot be loaded in Node.

Version picking differs slightly from the Modeler's `getLatest`, which is
tied to a Modeler instance: c8ctl checks only the `camunda` engine (the
Modeler also checks the other engines it knows, e.g. `elementTemplates`),
and a deprecated latest compatible version is still picked, where
`getLatest` returns nothing.

Errors include the available versions to make the next step obvious:

```
Failed to element-template apply: Element template 'io.camunda.connectors.aws.s3.v1' has no version 99. Available: 1, 2.
```

## Search

Substring case-insensitive match on `name`, `description`, `id`, and `keywords`
(matches Modeler's discovery path, plus `id` for CLI users who already know roughly
what they want). Deprecated versions are filtered out before the per-id
latest-version reduction, so the latest non-deprecated version of a connector
surfaces even when its newest version is deprecated. Output is a flat sequence
of template cards (no grouping by category).

## Migrating between template versions

`apply` registers one template, so re-applying a newer version has no old
template to compare against and keeps a value only when the new template binds
the same key. `update` registers the applied template as well, so
the library's own update semantics apply, and add a recipe on top for values
that moved.

- **Template resolution.** The target id resolves like every other id, local
  templates first (see above), with `isEngineCompatible` as the eligibility
  rule; the cache is required only on the fallback. Steps, the applied source
  and redaction read template versions from the cache, with the local versions
  of the involved ids shadowing cached ones of the same id and version. The
  cache is read only on a local gap: the target falls back to it, an involved
  id has neither a local template nor a `--to` file or URL, or an applied
  version or a recipe step version has no local template. A fully local
  update never reads the cache, so a corrupt cache does not stop it.
- **Unavailable source.** When the applied version is found nowhere, the
  engine gets a stub with the applied id and version and no properties. Recipe
  reads against the stub are not checked for coverage. Values it cannot read,
  such as `zeebe:calledElement`, are taken from the element and count as
  unchecked unless the target binds them identically, so a write still needs
  `--allow-lossy`.
- **Recipe location.** A recipe is carried by the template it migrates *to*, in
  `metadata.migratesFrom`, so it travels with the template through the
  marketplace and the cache. `metadata` is the schema's free-form area; it
  needs no change to the element template schema and survives validation.
  `--recipe` supplies the same format from a file for templates that carry none.
- **Versioned and strict.** The recipe has a `schemaVersion`. A reader refuses a
  version it does not know and any unknown key, rather than applying part of a
  recipe or silently ignoring a typo. The version is checked first and selects
  the parser from a version-to-parser map, so a newer recipe always asks for a
  newer c8ctl, whatever keys it adds; a later version can then add fields without
  older readers reporting them as typos.
- **Unusable embedded recipes fail the run.** A run moves one source template to
  one target, so an unusable recipe on the target or on the latest version of the
  source lineage affects every element in it. The run fails up front and names the
  template carrying the recipe, instead of migrating without the author's recipe.
  This also applies when every element is already unchanged or skipped, like any
  other recipe validation. Successor discovery skips such templates instead.
- **Validation boundary.** Draft07 and the parser enforce the same JSON structure.
  Schema validation alone is insufficient: keyed source uniqueness is checked by
  the parser and owner-relative ID/version constraints by `validateRecipeOwner`.
  `$schema` allows blank strings; paths, IDs, notes, templates and match patterns
  require a non-whitespace character without trimming the accepted value. Scalar
  strings may be blank, numbers MUST be finite, and explicit null note levels
  MUST fail rather than default to info.
- **Steps.** An element on an old version climbs the version steps of its own
  template in order, then makes at most one hop onto a different template. A
  source entry declares `kind: "upgrade"` with a destination `toVersion`, or
  `kind: "change"` with an optional `minSourceVersion` floor. A floor above
  the reached version adds one implicit version step (no entries, values carried
  by binding). The best floor is the highest one at most the newest source version
  compatible with the BPMN's `modeler:executionPlatformVersion`; the step lands on
  the lowest compatible version at or above it. An unreachable floor throws
  rather than refusing, so it is never authorizable with `--allow-lossy`. The revised
  dialect keeps schema version 1 and rejects legacy `minVersion` fields.
  Owner-relative ID/version rules and duplicate markers are semantic checks.
  Every selected intermediate template must exist before application; the supplied
  final target does not need a duplicate catalog entry. Coverage checks the applied
  source shape and then each reached selected application, never an unselected
  catalog version or a write removed by a later application. An unusable recipe
  discards its selected steps and reports a refusal. Explicit file recipes fail
  closed; embedded-recipe carry-over requires authorization outside dry-run.
- **The report is a diff.** What was dropped, added and changed comes from the
  element's values before and after, so it describes the result rather than the
  recipe's intent. Moves and notes originate in the recipe, but surviving moves
  and static/composed writes are reconciled against resolved stored values and
  per-step snapshots. Removed lineage cannot be revived by a later default.
  Simultaneous moves read the same pre-step snapshot; they are not collapsed into
  a sequential chain. Binding type remains part of field identity. Binding types
  the engine cannot read are not diffed; an editable source field under one is
  reported as unchecked, and the report is lossy, unless the target binds it
  identically and not as Hidden, which is the case where the Modeler keeps it.
  A field that survives can still lose its value: a Hidden target property
  resetting an editable source value, or a move or set overwriting a different
  populated value, is reported as dropped with a `cause`, and the report is lossy.
  A destination that is itself moved away (a swap or chain) is not displaced.
  A field written in any recipe step counts, also when a later step moves the
  value on. Conditions are not evaluated here: a target counts as Hidden when any
  duplicate for the binding is Hidden, a source only when every duplicate is.
  Each step records the values its Hidden properties reset, so a reset in an
  intermediate version counts, even when the final template binds the field as
  editable again or a later step moves the reset value on.
- **Read/write identity.** Unqualified rename, guard and interpolation reads fail
  when several binding types match. Qualification selects a binding type; duplicate
  backing identities or extension containers are rejected rather than selecting an
  arbitrary value. Active destination aliases resolve to one canonical identity;
  simultaneously active conflicting writes fail regardless of order.
- **Destination validation.** Resolved recipe writes and populated non-Hidden
  carry-over values are checked against active destination properties, including
  conditional duplicates. Supported literal checks are choices, `notEmpty` and
  patterns. FEEL optional/required expressions bypass literal choices/patterns,
  while empty required expressions fail. Unsupported active constraints,
  cyclic conditions and conditions without a known operator fail closed. Extra
  keys are ignored: `allMatch` and the first known operator decide. This is not
  FEEL syntax validation.
- **Context authority.** The supplied source must match the element's applied
  identity and overrides its catalog shadow. The final returned element must carry
  the target identity. Explicit target content is authoritative for its identity.
  Shared `resolveCatalog` resolves catalog authority.
- **Output.** The BPMN goes to stdout (or the file with `--in-place`); the report
  goes to stderr in that case so pipes stay clean. No-op XML output preserves the
  original bytes, with its message on stderr; JSON emits a report envelope with
  `noop: true` and empty change collections. In-place no-ops do not rewrite the
  BPMN; dry-runs write neither BPMN files nor XML stdout. Recipe validation still
  precedes a no-op return.
- **Authorization.** Lossy in-place migrations and refused embedded-recipe fallback
  require `--allow-lossy`. Explicit unusable recipes cannot be authorized. Diagnostics
  distinguish syntax, coverage (version steps, the implicit floor step and the
  change hop) and source-ID refusal; unreachable floors fail the element; empty recipe
  flags fail. Preview/authorized reports retain refusal and authorization status.
- **Sensitivity.** Rendering uses credential-like field identity and template
  property/group metadata to redact report values. Known sensitive before/after,
  default and report values are also scrubbed from notes and CLI diagnostics.
  Rendering does not mutate engine reports or BPMN values. Custom secrets without
  recognizable identity, unknown secret text and alternate encodings cannot be
  inferred reliably. Raw XML deliberately retains secrets and is not safe to log.
- **Engine eligibility.** Migration requires exactly one platform and version
  attribute in the Modeler namespace `http://camunda.org/schema/modeler/1.0`,
  regardless of prefix alias, with platform `Camunda Cloud`. Versions accept strict
  `major.minor` (normalized to patch zero) or full semantic versions, including
  standard prerelease/build syntax; coercible arbitrary strings fail. Standard
  semver prerelease eligibility applies, without blanket prerelease inclusion.
  Missing template engine constraints retain legacy eligibility; malformed declared
  engine objects/ranges fail closed. The CLI rejects incompatible explicit targets
  and supplies only engine-compatible source templates to the standalone engine.
  Required incompatible intermediate versions fail before application. Library
  callers MUST apply the same eligibility policy to their catalog and target.
- **Filesystem boundary.** In-place migration holds an exclusive sibling
  `.migration.lock` and compares original contents before temp preparation and
  again immediately before rename. The post-temp check fixes lost external edits
  during preparation. A sibling temp is renamed; EXDEV and other rename failures
  do not trigger a direct overwrite. Cleanup preserves the primary operation error
  while independently attempting descriptor close and lock unlink; temp cleanup
  is best effort. The cooperative lock does not cover symlink aliases or the final
  non-cooperative comparison-to-rename race; there is no atomic compare-and-swap.
  CLI guards inject ENOSPC/EIO before bytes and after 64 actual sibling bytes.
  SIGINT/SIGTERM guards pause a split write after actual bytes, preserving originals
  and proving the manual stale-lock/temp recovery contract. They do not prove
  physical disk exhaustion or interruption of a blocked kernel syscall. The unit
  suite runs on Windows; POSIX signal, permission and EPIPE cases skip it. Confirm no writer is active before
  manually inspecting/removing leftovers.
- **Extraction.** `migration/` has no c8ctl dependencies, so it can be moved
  into a library once the recipe format is settled.

## Plugin dependencies

`semver` is a root dep (added in this work) imported directly. Walking up from the plugin
file finds the root `node_modules`. Plugin-local deps would also work
but the pattern matches how `bpmn-moddle`/`bpmnlint` are consumed
across plugins.

## Plugin runtime extension

Plugins previously had to duplicate the cross-platform user-data-dir
logic from `src/core/config.ts`. We added `getUserDataDir()` to
`C8ctlPluginRuntime` and wired it through `C8ctlDeps.init()` so the
plugin can ask the runtime for the path (and pick up the
`C8CTL_DATA_DIR` override) without re-implementing the platform
branches.
