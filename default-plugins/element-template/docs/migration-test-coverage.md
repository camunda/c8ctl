# Migration Test Coverage

All recipes use the revised version 1 dialect. Tests use the real headless
modeler; the integration suites invoke CLI commands and reparse serialized XML.

| Feature | Guard |
| --- | --- |
| Simple rename, carry-over, drop, empty fields, authorization, repeat/no-op | `tests/integration/element-template-migration.test.ts`, simple recipe suite |
| Chained upgrades and cross-ID change; unordered markers and floor fallback | Same file, complex recipe suite; `element-template-migration-steps.test.ts` |
| Interpolation and missing references | Complex suite; `element-template-migration-plan.test.ts` |
| Nested groups, guard lists, equals/matches/in/exists and negation | Complex suite; planner tests |
| Value-map match, default, no-match, and FEEL bypass | Complex suite; planner tests |
| String/object notes, conditional target activation | Complex suite; recipe and apply tests |
| Target file override keeps source upgrade recipe | Complex suite runs with embedded and file recipes |
| Qualified bindings, destination aliases, ambiguous reads and duplicate backing values | Complex suite; planner tests |
| Inactive destinations and removed intermediate destinations | Apply and report tests |
| Explicit target precedence, incompatible engines and missing steps | CLI migration tests and step tests |
| Schema structural boundaries, semantic owner and duplicate checks | 737 cases in `element-template-migration-schema.test.ts`; recipe and step tests |
| Null note levels and non-finite scalars across every consumer | Schema suite: three note branches and five scalar positions, proven red before parser fix |
| Credential redaction without mutating source values | Output tests |
| XML-only stdout, JSON envelope, dry-run and unchanged files after refusal | CLI and integration suites |

In-place migration uses an exclusive sibling `.migration.lock` and checks the
original contents immediately before replacement. Cooperative migration writers
cannot run concurrently. A killed process can leave a lock, which requires manual
removal after confirming no writer is active. Atomic replacement protects against
truncated writes; it does not provide a filesystem transaction against arbitrary
external editors between the final comparison and rename. Symlink aliases and
non-cooperating writers are outside the lock's guarantee.

Residual coverage gaps: deterministic signal interruption during the write syscall,
arbitrary external-editor races, HTTPS target fixtures, and live deployment/runtime
execution. Local migration does not require a cluster. These gaps MUST NOT be
represented as verified behavior.
