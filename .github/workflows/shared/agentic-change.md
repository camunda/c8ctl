---
---

## Bounded implementation

Implement in the sandbox workspace, using failing regression tests first. Run
build, typecheck and unit tests there as described in the shared validation
scope; report the exact commands and outcomes. Existing required Test CI runs
live integration and cross-platform checks after the trusted commit is created.
Do not claim checks ran when they did not. Preserve behavior outside the issue,
update directly relevant docs, and never remove, skip or weaken tests or checks
to obtain a green result.

Only propose regular UTF-8 text files under `src/**` except `src/templates/**`,
`tests/**`, `docs/**`, `default-plugins/**`, or the root `README.md`, `EXAMPLES.md`,
`PLUGIN-HELP.md`. Instructions (including AGENTS.md and CLAUDE.md), security
policies, scripts, .github, manifests, lockfiles and configuration are protected
even inside an allowed directory. No symlinks, binaries, executable mode changes,
traversal, secrets or workflow modifications. If the request requires protected
changes, submit a blocked report instead of bypassing the boundary.

Call `report_change` exactly once using the shared byte-preserving transport.
The decoded report must be JSON with complete
full UTF-8 contents of each touched file, not a patch, shell script, archive or
external path. A deletion uses `content:null`. At most 20 files, 200000 UTF-8 bytes
per file and 750000 bytes per report; paths are repository-relative. Do not
include unchanged files. The trusted coordinator validates the allowlist, mode,
size, current state and exact head SHA again before writing anything.

Keep `summary` ordinary change prose: no git trailers, `Co-authored-by`,
`BREAKING CHANGE` or `BREAKING-CHANGE` markers. Commit identity and release
metadata belong to the trusted writer, not model-supplied text.

```json
{"schema_version":1,"status":"complete","title":"fix: concise imperative summary","summary":"What changed and why.","evidence":"Exact test commands and results.","blockers":[],"files":[{"path":"src/example.ts","content":"complete file contents\n"}]}
```

Use `status:"blocked"`, nonempty `blockers`, and `files:[]` when checks fail,
scope is unsupported, no safe change is possible, or evidence is incomplete.
Do not commit, push, open a PR or merge. Your report is a proposal, not authority.
