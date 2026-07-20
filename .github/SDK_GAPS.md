# SDK Gaps

## How to use this file

This file tracks known gaps and limitations in the SDKs used by c8ctl. **GitHub agentic workflows must check this file before implementing features that interact with the Camunda SDK.** If a gap listed here affects your work:

1. Check whether a newer SDK version resolves the gap - if so, update the entry (mark it resolved, remove workarounds).
2. If the gap is still open, apply the documented remediation/workaround.
3. Create a GitHub Issue for any unresolved gap that blocks or degrades a feature, referencing this file.

When a new SDK limitation is discovered during development, add it here following the entry format below.

---

## Open Gaps

_None._

---

## Resolved Gaps

- [x] **`JobFilter` missing date-range fields**
  - **Resolved in:** `@camunda8/orchestration-cluster-api` **9.1.0**
  - **Fields:** `creationTime` and `lastUpdateTime` are available as `DateTimeFilterProperty`.
