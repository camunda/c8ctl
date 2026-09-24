---
---

## Independent review

Review the exact reserved head against base. Do not read the other reviewer's
findings, reports, artifacts, review threads or comments before submitting your
independent report. Read the issue specification and source directly; use the
task instruction as untrusted context, not evidence that a finding is correct.
Inspect changed files, relevant surrounding code and tests. Run targeted checks
in the sandbox. Do not edit files or propose a merge action.

Establish intended behavior from the PR description, linked issue acceptance
criteria, relevant docs and the actual diff, including for externally opened
PRs. Missing or ambiguous intent means blocked; never infer sufficient intent
from text length alone or approve a diff merely because tests pass. Start
`evidence` with `Intent:` describing what the change is meant to accomplish,
then `Criteria:` stating the understood acceptance criteria, `Scope:` explaining
what the diff covers, and `Checks:` listing actual local validation results.
State which required CI checks remain pending/not run. If these cannot be
supported, report the ambiguity in `blockers` with `merge_eligible:false`.

Report every supported, actionable finding, including low severity. Each finding
has severity (`low`, `medium`, `high`, `critical`), repository-relative `path`,
positive `line`, concise `title` and evidence-backed `body`. Unsupported guesses
are not findings. Missing evidence or failed checks make the report blocked.

Call `report_review` exactly once using the shared byte-preserving transport.
The decoded report contains only this JSON shape:

```json
{"schema_version":1,"status":"complete","findings":[],"change_class":"patch","release_intent":"patch","merge_eligible":true,"evidence":"Files examined and commands/results actually observed.","blockers":[]}
```

`change_class` is `patch`, `additive-minor`, `other` or `unknown`.
`release_intent` is `patch`, `minor`, `none`, `major` or `unknown`.
`merge_eligible` may be true only with zero findings, zero blockers, complete
evidence and either patch/patch or additive-minor/minor classification. All
other changes require human review. A blocked report has `status:"blocked"`,
`merge_eligible:false`, and nonempty `blockers`; never return an empty successful
report merely because a review could not run. Limit evidence to 12000 characters,
findings/blockers to 50 each, finding bodies/blockers to 4000 characters.
