# Migration Test Coverage

All recipes use the revised version 1 dialect. Coverage includes pure engine
tests, stub-modeler tests, real headless-modeler tests and CLI subprocess tests;
not every guard uses the real modeler. Integration suites invoke CLI commands
and reparse serialized XML. The table maps inspected guards; the final complete
pipeline passed all non-skipped tests. The visible external build warning is
recorded separately under general repository policy. Implementation and independent adversarial
review were performed for every MIG-001 through MIG-014; scoped run evidence and
open gates are recorded in [Migration Review PRD](migration-review-prd.md).

| Feature | Guard |
| --- | --- |
| Simple rename, carry-over, drop, empty fields, authorization, repeat/no-op | `tests/integration/element-template-migration.test.ts`, simple recipe suite |
| Chained upgrades and cross-ID change; unordered markers, equality, floor fallback and reached-shape coverage | Same file, complex recipe suite; `element-template-migration-steps.test.ts` |
| Interpolation and missing references | Complex suite; `element-template-migration-plan.test.ts` |
| Nested groups, guard lists, equals/matches/in/exists and negation | Complex suite; planner tests |
| Value-map match, default, no-match, and FEEL bypass | Complex suite; planner tests |
| String/object notes, conditional target activation | Complex suite; recipe and apply tests |
| Target file override keeps source upgrade recipe | Complex suite runs with embedded and file recipes |
| Qualified bindings, canonical destination aliases and guarded conflicts in either order | Complex suite; planner tests; `element-template-migration-write-conflicts.test.ts` |
| Ambiguous reads across rename/guard/interpolation, nested reads, duplicate backing identities/containers and cross-type chains | `element-template-migration-source-reads.test.ts`; planner, apply and CLI guards |
| Final resolved values, inactive/removed/overwritten/forwarded/reappearing writes, FEEL normalization and simultaneous move lineage | `element-template-migration-apply.test.ts` and `element-template-migration-report.test.ts` |
| Explicit target precedence and supplied source authority | `element-template-migration-target-precedence.test.ts`, `element-template-migration-context.test.ts`, `element-template-migration-catalog-authority.test.ts`; shared `resolveCatalog`, catalog-order counterexample and independent reviewer's cache-target bypass fixed; reported final scoped run: 1,378 passed (MIG-004) |
| Strict Modeler namespace/platform/version semantics, incompatible/malformed engine declarations and missing steps | `element-template-migrate.test.ts` and step tests |
| Schema structural boundaries, semantic owner and duplicate checks | 737 cases in `element-template-migration-schema.test.ts`; recipe and step tests |
| Null note levels and non-finite scalars across every consumer | Schema suite: three note branches and five scalar positions, proven red before parser fix |
| Active duplicate destination constraints, non-Hidden carry-over, choices/patterns/notEmpty and FEEL handling | Planner and real-modeler apply tests; `element-template-migration-constraints-cli.test.ts`. Unsupported active constraints fail closed; no FEEL syntax validation |
| Metadata-driven credential redaction, known values in notes/diagnostics and non-mutation | Output tests; `element-template-migration-redaction-cli.test.ts`. Raw XML is deliberately not redacted |
| XML-only stdout, JSON no-op envelope, exact original bytes, file identity and dry-run | CLI/integration suites; `element-template-migration-noop-contract.test.ts`, expanded from 64 to 90 guards |
| Refusal categories, empty recipe flags, explicit recipe rejection, authorization and unchanged files | `element-template-migration-refusal.test.ts`: reported 32 passes. Completion implementation plus independent review corrected scoped per-plugin metadata: 127 completion passes; shell integration 31 passes and one fish-unavailable skip (MIG-006) |
| Supplied context consistency, typed engine isolation and final returned-element identity | `element-template-migration-context.test.ts`; shared catalog authority and cache-target bypass resolved by MIG-004 |
| Cooperative writers and external edits before/during temp preparation | `tests/integration/element-template-migration.test.ts`: final 48-case run (two recipe suites plus 23 filesystem scenarios per update/change), expanded 18 -> 32 during implementation and 32 -> 48 during independent adversarial review; post-temp expected-content check fixes the lost-edit counterexample |
| ENOSPC/EIO before bytes and after actual partial bytes | Same matrix: four scenarios per command, injected filesystem errors after zero or 64 verified sibling bytes; original preserved and temp/lock cleaned; no physical disk exhaustion claim |
| SIGINT/SIGTERM before write, before rename and during paused split write | Same matrix: six scenarios per command, including actual 64-byte sibling writes followed by real POSIX termination; original preserved, leftovers require manual cleanup; no blocked-kernel-syscall interruption claim; signal cases skip Windows |
| Missing/directory/malformed input; target disappearance/directory replacement during temp preparation; rename/EXDEV failure | Same matrix: unchanged original or moved backup, directory sentinel preserved, nonzero exit and empty stdout; no direct-overwrite fallback |
| Primary write error survives lock/descriptor/temp cleanup failures | Same matrix: three scenarios per command; descriptor close and lock unlink attempted independently, secondary cleanup cannot mask primary EIO; leftovers remain explicit manual-recovery cases |
| Unrelated elements, custom extensions, sequence flows and diagram geometry | Recipe suites and successful cooperative writer cases: CLI `bpmn format` reparse plus canonical before/after comparisons, final identity/values and repeated no-op |
| Plugin-load subprocess failure diagnostics | `tests/integration/plugin-lifecycle.test.ts`: reported 14-pass scoped run; historical failure/timeout causes unknown and require PR attribution before tracking under MIG-014 |
| File/HTTPS target precedence | `element-template-migration-target-precedence.test.ts`: existing fixture has reported evidence of 12 passing cases, including HTTPS; requires OpenSSL on PATH with `req -addext` support |

In-place migration uses an exclusive sibling `.migration.lock` and checks the
original contents both before temp preparation and again immediately before
replacement. Cooperative migration writers
cannot run concurrently. A killed process can leave a lock, which requires manual
removal after confirming no writer is active. A process killed after writing the
sibling temporary file can also leave that file, requiring manual inspection and
cleanup; there is no automatic stale migration-lock/temp recovery. Failed rename,
including EXDEV, fails closed rather than falling back to a direct overwrite.
Sibling-file replacement protects the original from truncation during temporary
file preparation; it does not provide a filesystem transaction against arbitrary
external editors between the final comparison and rename. Symlink aliases and
non-cooperating writers are outside the lock's guarantee.

Verified partial-write/error handling uses injected ENOSPC/EIO, including actual
64-byte sibling writes. Signal tests pause an injected split write after those
bytes and exercise real POSIX termination. Physical disk exhaustion and interruption
of an executing kernel syscall are not proven. Windows was not run, and POSIX
signal tests skip Windows. Non-cooperative edits between the final content check
and rename remain an unavoidable race in this comparison-plus-rename design,
which provides no atomic compare-and-swap. Symlink aliases, manual stale-lock/temp
recovery and live migration deployment/runtime execution remain documented limits;
local migration requires no cluster.

MIG-012 implementation and its tested matrix are complete, awaiting engineer
acceptance of these explicit limits, not further exhaustive syscall proof.
MIG-014 current PR verification acceptance is closed on the complete passing
Node 22 evidence below. Historical failures are not shown attributable to this PR
and impose no diagnosis obligation here. The external warning is separately
recorded under general repository policy, without reopening MIG-014 or imposing
upstream remediation on this PR. This documentation-only integration ran no
build, sync, lint, typecheck or test commands and makes no warning-free repository
release claim.

## Final Pipeline Evidence

Read the complete coordinator output at
`/Users/dmitri.nikonov/.local/share/opencode/tool-output/tool_11ba4cd19001qjFu7rHG7KpCuH`
using targeted searches and bounded reads. The coordinator reports the `npx` Node 22
`npm run build && npm run typecheck && npm test` invocation exited 0; stdout does
not print an exit-code or runtime-version banner. Build, lint (266 files checked,
no fixes applied), generated README/docs sync, vendor bundles and typecheck
completed. Evidence covers the final tested concurrent worktree, not a committed
revision; this subsequent integration changes only four documentation files.

| Run | Tests | Suites | Passed | Failed | Cancelled | Skipped | Todo | Duration (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Unit | 3,896 | 538 | 3,896 | 0 | 0 | 0 | 0 | 96,878.172208 |
| Integration | 193 | 22 | 191 | 0 | 0 | 2 | 0 | 171,907.405667 |
| Combined | 4,089 | 560 | 4,087 | 0 | 0 | 2 | 0 | Separate run durations above |

Unit summary: output lines 27369-27376. Integration summary: lines 28712-28719.
All 48 migration cases passed at lines 27479-27765, with no migration skips.
Separate scoped results above MUST NOT be added to these totals.

- Fish script-load test: `fish not available` (line 27775).
- Physical-tenant setup/authentication/deployment/secrets/restart/removal test: skipped with no reason emitted (line 28008). This output does not establish an environmental reason.
- Two build-warning occurrences (lines 33-37 and 91-95): `The value for "sideEffects" must be a boolean or an array`, at `node_modules/typed-env/package.json:13:17`, containing `"sideEffects": "false"`. The warning occurs during build and the unit suite's distribution rebuild; it was not suppressed or worked around.

Acceptance implementations for MIG-001 through MIG-011 and MIG-013 are guarded
and independently reviewed, with the documented limits retained. MIG-012
implementation/testing is complete, awaiting engineer acceptance. MIG-014 current
PR verification acceptance is closed. The visible upstream `typed-env` warning
is tracked separately in `.github/SDK_GAPS.md` under general repository policy;
it does not reopen MIG-014 or create a PR root-cause gate. Passing tests and
reported exit 0 do not claim a warning-free repository release baseline.
