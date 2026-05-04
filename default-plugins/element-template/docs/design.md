# `element-template` plugin design

Lives at `default-plugins/element-template/`. Applies Camunda element
templates to BPMN elements and inspects their settable properties — for
local files, arbitrary URLs, and out-of-the-box (OOTB) connector
templates resolved by id.

## Why a default plugin (not a core command)

The `element-template` and `bpmn` verbs were originally core commands
in `src/commands/`. We migrated them to default plugins because:

- **Faster iteration without core framework churn.** Earlier work added
  a `multiple: true` flag to the framework's `FlagDef` so a core
  command could accept repeatable `--set` flags. Plugins parse their
  own flags, so the framework doesn't need to grow that surface for
  every plugin's needs. The `multiple: true` change was reverted as
  part of the migration.
- **Looser coupling.** Plugin-specific deps (`bpmnlint`, the bpmn-js
  vendor bundle) don't bleed into the core dispatch.
- **Showcases the plugin model.** `element-template` and `bpmn` are
  realistic examples — a third party could ship the same shape.

The known limitation is that plugin deps and prebuilt vendor bundles
have to be shipped via the c8ctl install. Acceptable for now; we'll
revisit when we have third-party plugins that need the same.

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

Three sources publish the OOTB connector templates:

| | Source-of-truth | Inlines templates? | Has all versions? | Used by |
|---|---|---|---|---|
| `marketplace.cloud.camunda.io/api/v1/ootb-connectors` | mirrors GH | no, URL refs | yes | Desktop Modeler |
| `github.com/camunda/connectors/connector-templates.json` | yes | no, URL refs | yes | (the marketplace) |
| `@camunda/connectors-element-templates` (npm) | derived | yes (~9MB) | yes, may lag | (Web Modeler skill) |

We chose the **marketplace endpoint** for parity with Desktop Modeler:

- Desktop Modeler is released and deployed widely; the endpoint contract
  is effectively stable.
- The endpoint already proxies the GH source-of-truth; using it means
  we benefit from any future server-side filtering/versioning the
  marketplace adds.
- npm package was rejected: confirmed lag against the GH source and
  some entries are missing `version`/`engines` (pre-versioned legacy
  templates).
- GH directly was rejected because the marketplace gives us the same
  content with one less reason to drift from Modeler's behavior.

The endpoint is overridable via `C8CTL_OOTB_ELEMENT_TEMPLATES_URL`
(useful for testing).

## Cache strategy

We mirror Desktop Modeler's approach
(`camunda-modeler/app/lib/template-updater/`):

- Cache lives in `<userDataDir>/element-templates/`:
  - `templates.json` — flat array of all template objects (matches
    Modeler's `.camunda-connector-templates.json` shape).
  - `fetched-at` — epoch ms of last index sync.
- Each cached template gets `metadata.upstreamRef = <ref-url>` injected.
  Since each `ref` is a commit-pinned `raw.githubusercontent.com` URL,
  "upstreamRef unchanged" ⇒ "content unchanged" ⇒ no re-fetch needed.
  Subsequent syncs only fetch refs that aren't already in the cache.
- Per-template fetch failures are logged + counted, never abort the run.

### Lifecycle

- **First time the index is needed** (search, sync, or `apply`/`list-properties`
  with an `<id>` arg): bootstrap auto-runs — full fetch, ~459 templates,
  visible per-template progress.
- **Local file or URL paths** for `apply`/`list-properties`: never
  trigger bootstrap. The plugin classifies the template arg before
  touching the cache.
- **Stale cache** (>7 days since `fetched-at`): warn-only, suggesting
  `c8ctl element-template sync`. We don't auto-refresh — surprise
  network activity inside `apply` is undesirable and the index is
  small enough that manual sync is cheap.
- **`sync`** always re-fetches the index but skips already-cached
  refs. **`sync --prune`** drops cached entries no longer in the
  fresh index (opt-in: a user may keep a legacy version intentionally).
- **First-run + offline**: hard-fail with a clear message. No bundled
  fallback.

### Why not lazy per-template fetch on apply?

Earlier draft considered fetching only the requested `(id, version)`
on demand. Rejected because **search needs the template names**, which
live inside the template files (the index has only `id`/`version`/`ref`).
Eager bulk fetch makes search instant; the ~14 MB / ~30 s first-run
cost is acceptable, and incremental syncs are cheap.

## Version resolution

`apply` and `list-properties` accept three template-arg shapes:

| Shape | Detection | Resolution |
|---|---|---|
| `https://...` | starts with `http(s)://` | fetched directly, no cache |
| local path | contains `/`/`\`, starts with `.`, or ends with `.json` | read from disk |
| `<id>` or `<id>@<version>` | otherwise | resolved against cache |

For `<id>` (no `@<version>`):

- `apply` parses the BPMN file's `modeler:executionPlatformVersion`
  attribute (regex; cheap and we don't need the full moddle parse for
  this), then picks the highest cached version where
  `semver.satisfies(coerce(executionPlatformVersion), engines.camunda)`
  is true. Templates without `engines.camunda` are treated as
  compatible (legacy fallback).
- `list-properties` has no BPMN context, so it picks the latest version
  and warns the user to pin with `id@<n>` if they want a specific one.

Errors include the available versions to make the next step obvious:

```
Failed to element-template apply: Template 'io.camunda.connectors.aws.s3.v1' has no version 99. Available: 1, 2.
```

## Search

Substring case-insensitive match on `name`, `description`, and `id`
(matches Modeler, plus `id` for CLI users who already know roughly
what they want). Returns the latest cached version per matched id.
Output groups by `category.name` to mirror Modeler's UI layout.

## Plugin dependencies

`semver` is a root dep (added in this work) so the plugin can
`require('semver')` via `createRequire`. Walking up from the plugin
file finds the root `node_modules`. Plugin-local deps would also work
but the pattern matches how `bpmn-moddle`/`bpmnlint` are consumed
across plugins.

## Plugin runtime extension

Plugins previously had to duplicate the cross-platform user-data-dir
logic from `src/config.ts`. We added `getUserDataDir()` to
`C8ctlPluginRuntime` and wired it through `C8ctlDeps.init()` so the
plugin can ask the runtime for the path (and pick up the
`C8CTL_DATA_DIR` override) without re-implementing the platform
branches.
