# SDK Gaps

## How to use this file

This file tracks known gaps and limitations in the SDKs used by c8ctl. **GitHub agentic workflows must check this file before implementing features that interact with the Camunda SDK.** If a gap listed here affects your work:

1. Check whether a newer SDK version resolves the gap - if so, update the entry (mark it resolved, remove workarounds).
2. If the gap is still open, apply the documented remediation/workaround.
3. Create a GitHub Issue for any unresolved gap that blocks or degrades a feature, referencing this file.

When a new SDK limitation is discovered during development, add it here following the entry format below.

---

## Open Gaps

- [ ] **`JobFilter` missing date-range fields**
  - **SDK:** `@camunda8/orchestration-cluster-api` — current version **8.8.4**
  - **Affected type:** `JobFilter`
  - **Missing fields:** `creationTime` (`DateTimeFilterProperty`), `lastUpdateTime` (`DateTimeFilterProperty`)
  - **Available in:** Camunda 8.9 REST API ([jobs.yaml](../assets/c8/rest-api/jobs.yaml))
  - **Impact:** `--between` date-range filtering for `c8 list jobs` / `c8 search jobs` cannot use `creationTime` or `lastUpdateTime` — only `deadline` and `endTime` are available.
  - **Remediation:** Upgrade SDK when 8.9-compatible release ships; alternatively use `as any` type assertion as a temporary workaround.

---

## Resolved Gaps

_None yet._
