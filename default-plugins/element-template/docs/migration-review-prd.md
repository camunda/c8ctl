# Element Template Migration Review PRD

## Status And Scope

Local issue backlog for the element-template migration PR. No GitHub sync.
This document defines requirements; it does not implement fixes.

Sources:

- The adversarial review of `main...HEAD` in this workspace.
- [Migration Version Semantics Proposal](migration-version-semantics-proposal.md), Option B and its selection rules.

Priorities:

| Priority | Meaning |
| --- | --- |
| P0 | Critical. Stop all release work. |
| P1 | Must fix before this feature merges. |
| P2 | Should fix before release. Any deferral requires an explicit decision. |
| P3 | Nice to have. Keep separate from correctness fixes. |

No P0 issue was identified. Implementation progress and remaining acceptance
gaps are recorded below. A green test suite does not imply every issue is closed.

## Execution Record

Implementation and adversarial passes were performed directly, with the user's
approval, because this session prohibited subagent execution. No independent
subagent review occurred. Commits are local; nothing was pushed or synced.

| Issue | Local Commit | Status And Remaining Work |
| --- | --- | --- |
| MIG-003 | `5c4d9bd` | Option B version 1 implemented, owner validation and reached-floor guards pass. Additional equality/mixed-entry variants remain desirable. |
| MIG-007 | `552e6b3` plus scoped review follow-up | Closed for the acceptance criteria below: 737 schema/parity tests pass, including semantic owner/uniqueness checks. Null note levels and non-finite scalars were proven red before the parser fix. Whole-worktree release verification remains blocked separately. |
| MIG-004 | `6530f09` | Explicit target precedence implemented and CLI regression passes. HTTPS conflict fixture remains untested. |
| MIG-005 | `b61bc4e` | Engine eligibility enforced; missing metadata and incompatible steps tested. Strict validation of malformed engine strings needs further review. |
| MIG-001 | `7169022` | Missing final destinations and intermediate removals reported as loss. Full reconciliation of composed writes and mismatched resolved values remains open. |
| MIG-002 | `ae73528` | Canonical alias write conflicts rejected in either order. Broader guarded-binding variants remain desirable. |
| MIG-008 | `ca31dc1` | Ambiguous reads and duplicate backing values rejected; move chaining retains binding type. Additional cross-type chain variants remain desirable. |
| MIG-009 | `b2332c2` | Resolved required/choice/pattern constraints validated. Condition-aware duplicate-property validation and carry-over value constraints need further work. |
| MIG-010 | `fb2cc01` | XML/JSON no-op contracts fixed. Later guard validates recipe syntax before no-op return. |
| MIG-006 | `ad377e8` | Lossy overwrite authorization and explicit recipe refusal implemented. Wrong-source versus unmet-floor diagnostics are not yet distinct. |
| MIG-011 | `6d80f84` | Credential-like keys/labels redacted in text/JSON without mutation. Metadata-driven sensitivity and arbitrary secret text in notes/diagnostics remain outside the heuristic. |
| MIG-013 | `521f6eb` | Typed vendor surface and applied-context guard implemented. No broad behavior-preserving refactor performed. |
| MIG-012 | `74e99a6` | Simple/complex real CLI integration added; discovered carry-over reset fixed. Cooperative writer lock and no-op recipe validation added. Full interruption/concurrency/failure matrix remains open. |
| MIG-014 | Verification record | Complete final Node 22 build, lint, typecheck, and tests passed. Earlier plugin-load failure and one build timeout were not root-caused; diagnosis remains open. |

### Verification Evidence

- Initial baseline: 2,630 unit tests passed; 142 integration tests passed; two integration tests skipped.
- Option B full pipeline: 2,634 unit tests passed; 142 integration tests passed; two integration tests skipped.
- Final build and typecheck completed successfully. One combined invocation timed out during a second distribution clean; process inspection found no surviving build process. The cause was not determined.
- A subsequent complete `npm test` under Node 22.23.3 passed: 2,661 unit tests, 144 integration tests, two skipped integration tests, zero failures.
- Tests were shown red before the principal parser, target precedence, compatibility, loss reporting, write-conflict, source-ambiguity, destination-constraint, no-op, authorization, redaction, and context fixes.
- The complex integration suite initially failed, exposing source defaults reset across repeated template application. It passed after retaining populated non-Hidden same-binding values.
- Lock and no-op follow-up guards were added during the direct adversarial pass. Their pre-fix red runs were not recorded, so they are weaker evidence than the principal regression tests.

### MIG-007 Independent Review Follow-Up

- Runtime: Node 22.23.3 using `npx --yes --package=node@22 -c`.
- Pre-fix schema matrix: 716 tests, 698 passed, 18 failed. Three null note-level cases and 15 non-finite scalar cases (set, map value/default, equals, and in) all failed because the parser accepted them while Draft07 rejected them.
- Minimal parser fix: default only undefined note levels; require finite numeric scalars before stringification. Retained the field matrix and added finite numeric extremes and non-finite version boundaries. The expanded matrix still had exactly the same 18 reds before the fix.
- Post-fix schema and parser suites: 757 tests passed (737 schema tests and 20 parser tests), zero failures or skips. Owned-file Biome checks and final `npm run typecheck` passed.
- All MIG-007 acceptance criteria were inspected: both Option B branches, missing/null/type boundaries, whitespace and empty patterns, version bounds, unknown keys, empty collections, duplicate markers/floors, and owner-relative checks. No additional structural discrepancy was identified. README, design, and schema descriptions explicitly separate structural validation from semantic validation.
- Final full unit invocation: 3,525 tests, 3,518 passed, seven failed in the concurrent source-read suite (nested interpolation ambiguity and duplicate input/header backing entries). These are active unresolved failures, not a green baseline. Integration was run separately: 147 tests, 145 passed, two skipped (fish unavailable and physical-tenant suite), zero failures.
- `npm run build` stopped at two lint diagnostics in the concurrent `element-template-migration-source-reads.test.ts`. Test distribution builds emitted the unsuppressed `typed-env@2.0.0` warning caused by its string-valued `sideEffects`, through `@camunda8/orchestration-cluster-api@10.0.0-alpha.52`. The upstream dependency MUST be corrected; no local workaround was added. MIG-014 and the overall release gate remain open.
- Local generated README/docs sync commands completed. No GitHub sync, push, or remote issue closure occurred.

See [Migration Test Coverage](migration-test-coverage.md) for the feature matrix
and residual coverage limits. The release gate below remains in force; unresolved
acceptance gaps require additional implementation or an explicit deferral decision.

## Product Decisions

1. Adopt Option B: each source entry MUST declare `kind: "upgrade"` or `kind: "change"`.
2. Keep `schemaVersion: 1`. Do not increment the schema version.
3. Replace `minVersion` with `toVersion` for upgrades and `minSourceVersion` for changes. Reject `minVersion`; do not add aliases or a dual reader.
4. This revises the version 1 dialect in place. Existing strict readers will reject the new fields, and the revised reader will reject old `minVersion` recipes. Documentation MUST state this limitation. Compatibility with shipped recipes is not a goal of this task; evidence of published consumers MUST be escalated before release.
5. Preserve the path-rule vocabulary: rename, set, template composition, nested rules, guards, notes, and value maps.
6. The engine MUST remain independent of c8ctl. CLI output, engine-version extraction, file I/O, and rendering belong outside `migration/`.
7. At most one cross-ID change is allowed per invocation.

The proposal retains coverage refusal and carry-over. This PRD retains ordinary
carry-over when no recipe is supplied or applicable, but requires explicit
recipe refusal and lossy in-place writes to fail closed unless authorized.
Issue MIG-006 defines that intentional safety-policy change.

## Recipe Contract

An upgrade entry MUST have `toVersion` and MUST NOT have `minSourceVersion`.
Its source ID MUST equal the recipe owner's ID. A change entry MUST NOT have
`toVersion`; it MAY have `minSourceVersion`. Its source ID MUST differ from
the recipe owner's ID. Both version fields MUST be non-negative safe integers.
The owner is the template carrying the recipe, including a file override's target.

Example recipe on `mail@3`:

```json
{
  "schemaVersion": 1,
  "sources": [
    {
      "kind": "upgrade",
      "sourceTemplateId": "mail",
      "toVersion": 2,
      "paths": [{ "from": "a", "to": "b" }]
    },
    {
      "kind": "upgrade",
      "sourceTemplateId": "mail",
      "toVersion": 3,
      "paths": [{ "from": "b", "to": "c" }]
    }
  ]
}
```

Example recipe on `send@1`:

```json
{
  "schemaVersion": 1,
  "sources": [
    {
      "kind": "change",
      "sourceTemplateId": "mail",
      "minSourceVersion": 3,
      "paths": [{ "from": "c", "to": "message" }]
    }
  ]
}
```

## Migration Safety And Correctness

### MIG-001: Verify Writes Against The Final Result

**Priority:** P1. **Review finding:** 1.

**Occurrence:** `migration/apply.ts:128-149`; `migration/report.ts:190-228`.

**Problem:** An inactive conditional destination causes a write to be skipped.
Planner facts still claim a successful move and suppress the source drop. A later
application can also remove an intermediate destination without correcting the report.

**Requirements and acceptance criteria:**

- Successful moves MUST be supported by the final element state, not only planner intent.
- An inactive or missing destination MUST produce a failed/skipped write or a drop. It MUST NOT yield `lossless: true` when the source value was lost.
- A destination with a value different from the resolved write MUST be reported accurately.
- Static writes and composed values MUST also reflect the final state. Intermediate `set` facts MUST NOT appear as surviving final additions when their fields were removed.
- Test `a="secret"` mapped to `b` conditional on `kind="on"` while `kind="off"`. Neither XML nor report may claim successful preservation.
- Test a successful `a -> b` upgrade followed by a template that removes `b`, and test successful conditional activation by a discriminator write.

### MIG-002: Reject Writes To The Same Resolved Binding

**Priority:** P1. **Review finding:** 2.

**Occurrence:** `migration/plan.ts:203-214`.

**Problem:** `b` and `input:b` bypass ambiguity detection despite targeting the
same binding. Entry order then determines the winner.

**Requirements and acceptance criteria:**

- Conflict checks MUST use canonical destination binding identity after template resolution.
- An active rename to `b` plus an active set to `input:b` MUST fail before file output or overwrite.
- Reverse entry order MUST produce the same rejection.
- Mutually exclusive guarded writes MAY share a destination; simultaneously active writes MUST fail.
- Distinct binding types with the same key MUST remain independently writable when qualified.

### MIG-003: Implement Option B And Actual Reached-Version Selection

**Priority:** P1. **Review findings:** 3 and 7.

**Occurrence:** `migration/recipe.ts:300-362`; `migration/steps.ts:168-227,249-310`;
`migration/migrates-from.schema.json:53-75`; `README.md:177-181`.

**Problem:** Version markers have two meanings. Loaded source versions qualify
change floors even when no step reaches those versions.

**Requirements and acceptance criteria:**

- Implement the recipe contract above in schema, parser, internal types, examples, and documentation. Keep `schemaVersion: 1`.
- Validate the entire recipe before selection, including entries not selected. Reject unknown keys, invalid kinds, legacy `minVersion`, invalid field combinations, invalid ID relations, and upgrade destinations above the owner's version.
- Reject duplicate `(sourceTemplateId, toVersion)` upgrade markers and duplicate `(sourceTemplateId, minSourceVersion)` change floors, including duplicate omitted floors. Do not merge duplicates.
- For same-ID upgrade `A -> T`, use the target recipe or file override. Select upgrades where `A < toVersion <= T`, sorted ascending.
- For a change, use only the highest loaded eligible source version's recipe for source upgrades. Do not combine older source recipes. A target file override MUST NOT replace the source recipe.
- During a change, ignore source-recipe change entries and target-recipe upgrade entries after validating them.
- Initialize reached source version `R` to `A`. Increase it only after an actual source application completes. Catalog availability and the target's version MUST NOT increase `R`.
- Select one target change entry for the applied source ID: the highest numeric floor at or below `R`, otherwise the omitted floor. Do not combine floors.
- With floors 2 and 5, `R=4` MUST select 2 and `R=5` MUST select 5. An omitted floor accepts any reached source version and does not request an upgrade.
- Missing or empty `paths` MUST represent a template application with no path rules. Recipes MAY mix kinds and source IDs.
- Require all selected step templates before application. Missing unselected versions and gaps in version numbers MUST be allowed.
- Apply the target without path rules if the selected applications do not end there, subject to MIG-006.
- Successor discovery MUST share the reached-version and floor rules. It MUST NOT advertise a candidate with unavailable required step templates.
- Test equality boundaries, unordered markers, omitted fields, duplicate floors, invalid owner relations, missing steps, unavailable source templates, and latest-source recipes with no upgrades.
- Regression: loading `old@2` without an upgrade path MUST NOT qualify a floor of 2 for an element on `old@1`.

### MIG-004: Give Explicit Target Content Precedence

**Priority:** P1. **Review finding:** 4.

**Occurrence:** `commands/migrate.ts:155-160,360-364`; `migration/steps.ts:276-302`.

**Problem:** First-wins catalog deduplication lets cached content replace an
explicit local target with the same `id@version`.

**Requirements and acceptance criteria:**

- An explicitly supplied target MUST be authoritative for its identity throughout validation, application, and reporting.
- Test a cached and local target with identical identity but different bindings, defaults, conditions, and metadata. The local definition MUST win consistently.
- File and URL targets MUST follow the same precedence rule.
- Catalog conflict handling MUST have one authoritative boundary, rather than independent first-wins decisions in the runner and engine.

### MIG-006: Fail Closed On Unusable Explicit Recipes And Lossy Overwrites

**Priority:** P2. **Review finding:** 5.

**Occurrence:** `migration/steps.ts:204-206,300-310`; `commands/migrate.ts:369-428`.

**Problem:** Recipe refusal or non-applicability can still produce a successful
destructive overwrite. The user asked for recipe-based migration but receives carry-over.

**Requirements and acceptance criteria:**

- An explicitly supplied recipe that cannot be used MUST cause a nonzero exit and leave the original file unchanged.
- Diagnostics MUST distinguish invalid syntax, coverage refusal, wrong source ID, and an unmet source floor.
- Intentional empty-path recipe entries MUST remain valid; they MUST NOT be confused with a recipe that has no applicable entry.
- Ordinary no-recipe carry-over MUST remain available and MUST report losses accurately.
- A lossy in-place migration or embedded-recipe fallback MUST require explicit authorization. The exact CLI flag is an implementation decision and MUST be reflected in help, completion, and docs.
- Dry-run MUST report the prospective losses and authorization requirement without writing. Authorized fallback MUST remain visible in text and JSON reports.
- Invalid required source recipes MUST NOT silently grant reachability or be described as successfully used.

## Validation And Schema Boundaries

### MIG-005: Enforce Engine Compatibility For Successors And Steps

**Priority:** P1. **Review finding:** 6.

**Occurrence:** `commands/migrate.ts:187-195,244-250`; `migration/steps.ts:185-202`.

**Problem:** Successor selection calls the modeler without the document's
Camunda engine version. Source-lineage selection also lacks a compatibility boundary.

**Requirements and acceptance criteria:**

- Automatic successor selection MUST use the BPMN execution-platform version.
- Test a successor requiring Camunda `>=99.0.0` against a document declaring an older engine. It MUST NOT be selected.
- Automatic source upgrades MUST use engine-compatible templates and MUST reject required incompatible steps before mutation.
- Document the engine eligibility contract between the CLI and the standalone migration engine.
- Explicitly pinned incompatible targets MUST either fail or require a documented explicit override. Silent application is prohibited.
- Define and test behavior for missing or invalid document engine versions. Do not silently claim compatibility was verified.

### MIG-007: Align Schema And Parser Validation

**Priority:** P2. **Review finding:** 8.

**Occurrence:** `migration/recipe.ts:110-114,331-359`;
`migration/migrates-from.schema.json`; `tests/unit/element-template-migration-schema.test.ts:38-108`.

**Problem:** The schema and parser disagree on non-string `$schema`, blank
strings, empty match patterns, and source uniqueness.

**Requirements and acceptance criteria:**

- Enforce the same structural constraints in Draft07 and the parser for the revised version 1 dialect.
- `$schema`, if present, MUST be a string. Specify consistent blank-string and empty-pattern handling.
- Keep owner-relative checks and keyed source uniqueness in semantic validation where Draft07 cannot express them. Document that schema validation alone is insufficient.
- Extend parity tests with missing/null/wrong-type values, whitespace, zero, negative/fractional/unsafe versions, unknown keys, empty collections, and both Option B branches.
- Add semantic tests for duplicate markers/floors and owner-relative checks rather than claiming full schema/parser equivalence for these constraints.

### MIG-008: Reject Ambiguous Source Reads

**Priority:** P2. **Review finding:** 9.

**Occurrence:** `migration/plan.ts:58-66`; `migration/report.ts:190-195`.

**Problem:** Unqualified source lookup selects the first matching binding.
Unqualified report claims can conceal loss from another binding type.

**Requirements and acceptance criteria:**

- Rename sources, guard paths, and interpolation references MUST reject multiple matching binding types unless qualified.
- Diagnostics MUST list usable qualified paths.
- Report identities and move chaining MUST retain binding type; equal keys across different types MUST NOT be conflated.
- Test input/header collisions with different values for all source-read forms and for multi-step reports.
- Test duplicate backing entries within one binding type. Malformed BPMN MUST NOT silently select an arbitrary value.

### MIG-009: Validate Resolved Destination Values

**Priority:** P2. **Review finding:** 10.

**Occurrence:** `migration/plan.ts:221-244`; `migration/apply.ts:107-149`.

**Problem:** Destination existence is checked, but destination value constraints
are not. Empty required values can be serialized successfully.

**Requirements and acceptance criteria:**

- Resolved values MUST be checked against applicable destination property constraints and choices, respecting the property's FEEL semantics.
- Test empty values against `notEmpty`, invalid choices, applicable patterns, and valid FEEL expressions.
- A validation failure MUST identify the recipe entry, qualified destination, and violated rule without disclosing a secret.
- Invalid values MUST prevent in-place writes and MUST NOT be reported as successful migrations.
- Prefer supported upstream validation facilities. Any unsupported constraint MUST be reported explicitly rather than silently treated as validated.

## CLI And Output Contracts

### MIG-010: Preserve Output Contracts For No-Ops

**Priority:** P1. **Review finding:** 11.

**Occurrence:** `commands/migrate.ts:350-357`;
`tests/unit/element-template-migrate.test.ts:442-451`.

**Problem:** No-op text is prepended to BPMN stdout. JSON no-ops emit no report
on stdout and place an informational object on stderr.

**Requirements and acceptance criteria:**

- In XML output mode, stdout MUST contain only the original BPMN bytes. The no-op message MUST use stderr.
- JSON mode MUST produce the migration-report envelope on stdout for no-ops, with an explicit no-op indicator and empty change collections.
- In-place no-ops MUST NOT rewrite the file. Dry-run no-ops MUST NOT write files or XML output.
- Apply the same contract to `update` and same-identity `change`.
- Test stdout and stderr separately. Repeated migration MUST yield a parseable, lossless no-op result.

### MIG-011: Redact Sensitive Report Values

**Priority:** P2. **Review finding:** 12.

**Occurrence:** `migration-output.ts:89-100,113-131,218-224`.

**Problem:** Removed or changed connector credentials enter terminal and CI logs.
Generic object-key sanitization does not recognize credentials inside field/value records.

**Requirements and acceptance criteria:**

- Sensitive report values MUST be redacted by default in text, JSON, dry-run, and error diagnostics.
- Redaction MUST use field identity and available template metadata. Document limitations for custom fields that cannot be identified as sensitive.
- Raw-value reporting, if offered, MUST require an explicit opt-in with a warning in its documentation.
- Test dropped, added, changed, and transformed authentication tokens/passwords. Known credentials MUST NOT appear on either output stream.
- Redaction MUST NOT alter the BPMN values or migration decisions.

## Test Coverage And Verification

### MIG-012: Add Real Simple And Complex CLI Migration Suites

**Priority:** P1. **Review finding:** 13.

**Occurrence:** `tests/unit/element-template-migrate.test.ts`;
`tests/unit/element-template-migration-apply.test.ts:142-266`.

**Problem:** Isolated parser/planner coverage does not verify complex recipes
through the real modeler, serialization, and CLI. The existing real-modeler
tests cover only a small subset of the schema.

**Requirements and acceptance criteria:**

- Add integration tests driven through CLI commands with the real vendor modeler. Migration itself does not require a live cluster; use deterministic local fixtures.
- The simple recipe suite MUST cover rename, carry-over, deliberate drop, empty values, repeat/no-op, stdin, XML output, JSON, in-place, and dry-run.
- The complex recipe suite MUST traverse multiple upgrades and one change, multiple change floors, mixed source entries, interpolation, nested groups, every guard operator, negation, notes, value-map match/default/no-match, FEEL passthrough, qualified bindings, and conditional activation.
- Add separate variants for branches that cannot all execute in one recipe. Maintain a schema-feature-to-test coverage table.
- Exercise embedded recipes and file overrides, including the rule that a target override does not replace source upgrades.
- Add adversarial cases for inactive destinations, alias conflicts, ambiguous reads, missing/incompatible steps, cache/local conflicts, wrong recipe sources, and malformed inputs.
- Re-read the generated BPMN through the CLI where possible and assert actual final values, template identity, and unrelated-element/extension preservation. Regex assertions alone are insufficient.
- Assert reports against final XML, exact output channels, stable exit codes, unchanged original bytes on failures, and unchanged files during dry-run.
- Test in-place write failure, interrupted writes, and concurrent writers. Atomic replacement MUST NOT be mistaken for protection against lost concurrent edits; any missing concurrency protection MUST be documented and addressed explicitly.
- Validate committed BPMN fixtures with bpmnlint. Deployment/runtime smoke tests, if added, MUST use the CLI and repository polling helper.

### MIG-014: Restore A Verified Green Baseline

**Priority:** P1. **Origin:** Review verification result, not a proven migration defect.

**Occurrence:** `tests/integration/plugin-lifecycle.test.ts:1094`, failing at the
first fixture-plugin load around line 1149.

**Problem:** The Node 22 review run passed 2,630 unit tests and lint/typecheck,
but integration testing recorded a failure and then exceeded the 120-second
execution limit. The cause remains undiagnosed.

**Requirements and acceptance criteria:**

- Capture the failing subprocess's diagnostic output and identify the cause. Do not label it unrelated or intermittent without evidence and engineer confirmation.
- Complete `npm run build` and `npm test` under Node 22 with no errors or suppressed warnings.
- Run `npm run typecheck` as well. Build the vendor bundle before modeler integration tests.
- Record complete test results and any environmental prerequisites. A timeout or partial run MUST NOT be reported as green.

## Maintainability

### MIG-013: Keep A Shallow, Typed Migration Interface

**Priority:** P3. **Review finding:** 14.

**Occurrence:** `migration/apply.ts:163-176`; `migration/types.ts`; `vendor.ts`.

**Problem:** Callers supply several objects that must agree on identities and
versions. Catalog resolution is duplicated, and vendor template inputs were
broadened to `object`.

**Requirements and acceptance criteria:**

- Keep one authoritative template identity/precedence boundary and one shared reachability calculation.
- Use explicit tagged source types for Option B and retain a meaningful typed vendor interface.
- The public migration entry point MUST validate supplied context consistency or derive it from an authoritative input.
- Avoid new abstractions for single-use code. Keep rendering and filesystem policy outside the engine.
- Treat broader behavior-preserving refactors separately. Audit coverage before changing module boundaries.

## Implementation Order And Release Gate

1. MIG-003 and MIG-007 establish the revised version 1 recipe contract and validation boundaries.
2. MIG-004 and MIG-005 establish authoritative templates and compatibility eligibility.
3. MIG-001, MIG-002, MIG-008, and MIG-009 establish write/read correctness and trustworthy reports.
4. MIG-006, MIG-010, and MIG-011 establish overwrite and output safety.
5. MIG-012 provides permanent end-to-end guards throughout the work; it is not a final-only testing task.
6. MIG-014 verifies the complete baseline and final pipeline. MIG-013 is optional unless needed to resolve a correctness issue.

For behavior changes, write a failing regression test before the production fix.
For preserved behavior, prove the guard passes before and after the change.
Update plugin help, shell completion, README, and design documentation when
commands, flags, recipe semantics, or report contracts change.

Release requires all P1 issues closed, explicit decisions for any deferred P2
issues, a complete green Node 22 pipeline, and the simple/complex integration
coverage table. No automatic GitHub issue creation, PR updates, or sync is part
of this PRD.
