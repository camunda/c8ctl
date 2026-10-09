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

Four sources publish the OOTB connector templates:

| | Source-of-truth | Inlines templates? | Has all versions? | Used by |
|---|---|---|---|---|
| `github.com/camunda/connectors` releases (bundle asset) | yes | yes (~1 MB gzip per line) | per minor line | c8ctl |
| `marketplace.cloud.camunda.io/api/v1/ootb-connectors` | mirrors GH | no, URL refs | yes | Desktop Modeler |
| `github.com/camunda/connectors/connector-templates.json` | yes | no, URL refs | yes | (the marketplace) |
| `@camunda/connectors-element-templates` (npm) | derived | yes (~9MB) | yes, may lag | (Web Modeler skill) |

We use the **release bundle assets** — every connectors release ships a
`connectors-bundle-templates-<tag>.tar.gz` with one JSON file per
template:

- The marketplace endpoint (Desktop Modeler's source, and c8ctl's
  original choice) only publishes *refs* into
  `raw.githubusercontent.com`, a host routinely blocked in enterprise
  networks — the reason for the switch, see c8ctl#530. Release
  downloads are served from `github.com`, which those environments
  generally do reach.
- One request per minor line replaces ~650 per-template requests, so a
  cold sync is a few MB and a few seconds instead of ~14 MB and ~30 s.
- npm package was rejected: confirmed lag against the GH source and
  some entries are missing `version`/`engines` (pre-versioned legacy
  templates).

### Which releases

`sync` lists the releases (`api.github.com/repos/camunda/connectors/
releases?per_page=100`, overridable via
`C8CTL_CONNECTORS_RELEASES_URL`) and keeps **the newest release of each
minor line** — 8.8.x, 8.9.x, 8.10.x, ...:

- Bundles are cumulative within a line, so the newest patch of 8.8
  already contains everything 8.8.17 shipped. Across lines they differ,
  which is why one release per line is kept rather than just the newest
  release overall.
- Alphas count (`8.10.0-alpha3` is the only source for a line that has
  no stable release yet); release candidates do not — they are
  superseded within days. Note that semver ranks `8.10.0-alpha5-rc3`
  *above* `8.10.0-alpha5`, so RCs are filtered explicitly rather than
  by ordering.
- Draft releases and releases without a bundle asset (a release that is
  still being built) are skipped, so an in-flight release falls back to
  the previous one on that line.
- Only the **4 newest minor lines** are kept (`MAX_MINOR_LINES` in
  `releases.ts`), roughly Camunda's supported-version window. This keeps
  the selection deterministic: the newest release of each selected line
  is always within the first page of the listing, whereas an EOL line's
  newest release drifts down the listing until it falls off the page and
  would silently vanish from the selection.

Bundles contain a superset of the marketplace index: the `-hybrid`
variants and a few templates the marketplace does not list are cached
too, and templates without a numeric `version` (pre-versioned legacy
entries that version resolution cannot rank) are skipped.

## Cache strategy

We mirror Desktop Modeler's approach
(`camunda-modeler/app/lib/template-updater/`):

- Cache lives in `<userDataDir>/element-templates/`:
  - `templates.json` — flat array of all template objects (matches
    Modeler's `.camunda-connector-templates.json` shape).
  - `fetched-at` — epoch ms of last sync.
- Each cached template gets
  `metadata.upstreamRef = <assetUrl>#<file-in-bundle>` injected. Release
  assets are tag-pinned and therefore immutable, so "asset URL already
  in the cache" ⇒ "bundle already ingested" ⇒ no re-download.
- `id@version` is deduplicated across bundles, newest release wins.
- Per-release fetch failures are logged + counted, and never abort the
  run — unless *every* bundle failed and nothing was reusable from the
  cache, in which case `sync` errors out rather than writing an empty
  cache. A partial sync also leaves `fetched-at` untouched, so the
  staleness nudge keeps asking for a full refresh.

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
- **`sync`** always re-fetches the release listing but only downloads
  bundles that aren't cached yet. **`sync --prune`** drops cached
  entries that no longer belong to a selected release (opt-in: a user
  may keep a legacy line intentionally). Pruning is skipped when any
  bundle failed to download: a bundle URL changes with every patch, so
  the previous patch's cached templates are always "stale", and dropping
  them while their replacement failed would delete a whole minor line
  over one transient HTTP error.
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
means every template has to be read anyway. Bundles make this moot: the
whole line arrives in one request, so eager bulk fetch is both simpler
and faster than any lazy scheme.

## Version resolution

`apply` and `get-properties` accept three template-arg shapes:

| Shape | Detection | Resolution |
|---|---|---|
| `https://...` | starts with `http(s)://` | fetched directly, no cache |
| local path | contains `/`/`\`, starts with `.`, or ends with `.json` | read from disk |
| `<id>` or `<id>@<version>` | otherwise | resolved against cache |

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
the same key. `update` and `change` register the applied template as well, so
the library's own update semantics apply, and add a recipe on top for values
that moved.

- **Recipe location.** A recipe is carried by the template it migrates *to*, in
  `metadata.migratesFrom`, so it travels with the template through the
  marketplace and the cache. `metadata` is the schema's free-form area; it
  needs no change to the element template schema and survives validation.
  `--recipe` supplies the same format from a file for templates that carry none.
- **Versioned and strict.** The recipe has a `schemaVersion`. A reader refuses a
  version it does not know and any unknown key, rather than applying part of a
  recipe or silently ignoring a typo.
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
  `kind: "change"` with an optional `minSourceVersion` floor. Floors use actual
  selected source applications, never the latest catalog version. The revised
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
  a sequential chain. Binding type remains part of field identity.
- **Read/write identity.** Unqualified rename, guard and interpolation reads fail
  when several binding types match. Qualification selects a binding type; duplicate
  backing identities or extension containers are rejected rather than selecting an
  arbitrary value. Active destination aliases resolve to one canonical identity;
  simultaneously active conflicting writes fail regardless of order.
- **Destination validation.** Resolved recipe writes and populated non-Hidden
  carry-over values are checked against active destination properties, including
  conditional duplicates. Supported literal checks are choices, `notEmpty` and
  patterns. FEEL optional/required expressions bypass literal choices/patterns,
  while empty required expressions fail. Unsupported active constraints or
  unsupported/cyclic conditions fail closed. This is not FEEL syntax validation.
- **Context authority.** The supplied source must match the element's applied
  identity and overrides its catalog shadow. The final returned element must carry
  the target identity. Explicit target content is authoritative for its identity.
  Shared `resolveCatalog` resolves catalog authority; MIG-004's catalog-order
  counterexample and cache-target bypass have reported passing verification.
- **Output.** The BPMN goes to stdout (or the file with `--in-place`); the report
  goes to stderr in that case so pipes stay clean. No-op XML output preserves the
  original bytes, with its message on stderr; JSON emits a report envelope with
  `noop: true` and empty change collections. In-place no-ops do not rewrite the
  BPMN; dry-runs write neither BPMN files nor XML stdout. Recipe validation still
  precedes a no-op return.
- **Authorization.** Lossy in-place migrations and refused embedded-recipe fallback
  require `--allow-lossy`. Explicit unusable recipes cannot be authorized. Diagnostics
  distinguish syntax, coverage, source-ID and reached-floor refusal; empty recipe
  flags fail. Preview/authorized reports retain refusal and authorization status.
  MIG-006's shell-completion fixes have reported passing scoped verification.
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
  physical disk exhaustion or interruption of a blocked kernel syscall. Windows
  was not run; POSIX signal cases skip Windows. Confirm no writer is active before
  manually inspecting/removing leftovers.
- **Extraction.** `migration/` has no c8ctl dependencies, so it can be moved
  into a library once the recipe format is settled.

Current implementation and independent-review evidence, MIG-012's completed
48-case matrix and explicit limits, and MIG-014's PR-scoped Node 22 verification are tracked
in [Migration Review PRD](migration-review-prd.md) and
[Migration Test Coverage](migration-test-coverage.md). All 48 migration cases
passed, including CLI `bpmn format` canonical preservation checks for unrelated
elements, custom extensions, sequence flows and geometry. MIG-012 implementation
and testing are complete, awaiting engineer acceptance of the documented limits.
The final Node 22 pipeline passed 3,896 unit and 191 integration tests, with two
integration skips and zero failures; MIG-014 current PR verification acceptance
is closed. Historical failures are not shown attributable to this PR and impose
no diagnosis obligation here. The unsuppressed external `typed-env` warning is
recorded separately under general repository policy, without reopening MIG-014
or adding upstream remediation to this PR. No warning-free release claim is made.

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
