# SDK Gaps

## How to use this file

This file tracks known gaps and limitations in the SDKs used by c8ctl. **GitHub agentic workflows must check this file before implementing features that interact with the Camunda SDK.** If a gap listed here affects your work:

1. Check whether a newer SDK version resolves the gap - if so, update the entry (mark it resolved, remove workarounds).
2. If the gap is still open, apply the documented remediation/workaround.
3. Create a GitHub Issue for any unresolved gap that blocks or degrades a feature, referencing this file.

When a new SDK limitation is discovered during development, add it here following the entry format below.

---

## Open Gaps

- [ ] **No config flag to disable the automatic `/v2` suffix on `CAMUNDA_REST_ADDRESS`**
  - **SDK:** `@camunda8/orchestration-cluster-api` — current version **10.0.0-alpha.43**
  - **Behavior:** `hydrateConfig()` always appends `/v2` to `CAMUNDA_REST_ADDRESS` unless the value already ends with `/v2` or `/v2/`; there is no override.
  - **Affected:** gateway/proxy-fronted profiles whose base path doesn't match this convention (`c8ctl add profile --exactBaseUrl`, #547).
  - **Impact:** `createClient()` (`src/core/client.ts`) works around this by passing a custom `fetch` (`buildGatewayFetch`) that rewrites the outgoing `Request`'s URL, replacing the SDK-computed `.../v2` prefix with the profile's literal `baseUrl`. `rawPostWithHeaders()`/`resolveClusterConfig()` mirror the same suffixing rule for the manually-issued REST calls (the general-purpose escape hatch in `src/core/client.ts`) that bypass the SDK client.
  - **Remediation:** If the SDK adds a config flag (e.g. `CAMUNDA_REST_ADDRESS_EXACT`) to opt out of the suffix, use it directly and remove `buildGatewayFetch`'s URL-rewriting branch and the mirrored logic in `restBaseUrlForProfile()`. Tracked upstream: [camunda/orchestration-cluster-api-js#499](https://github.com/camunda/orchestration-cluster-api-js/issues/499).

---

## Resolved Gaps

- [x] **`searchElementInstanceWaitStates` method missing**
  - **Resolved in:** `@camunda8/orchestration-cluster-api` **10.0.0-alpha.43**
  - **Affected endpoint:** `POST /v2/element-instances/wait-states/search`
  - **Resolution:** The SDK client now exposes `searchElementInstanceWaitStates(input, consistency, options?)`. `c8ctl search wait-state` (`src/commands/search.ts`) calls it via `fetchAllPages()` like every other search command; the `resolveAuthHeaders()` + `rawPostWithHeaders()` workaround was removed. (Those raw-POST helpers remain in `src/core/client.ts` as a general escape hatch for any future gap.)

- [x] **`WaitStateType` enum not exported from SDK**
  - **Resolved in:** `@camunda8/orchestration-cluster-api` **10.0.0-alpha.43**
  - **Affected type:** `WaitStateTypeEnum` (JOB, MESSAGE, USER_TASK, TIMER, SIGNAL, CONDITION)
  - **Resolution:** The SDK now exports `WaitStateTypeEnum` (all six values, including CONDITION). The local `WAIT_STATE_TYPE_ENUM` literal in `src/framework/command-registry.ts` was removed in favour of the SDK export.

- [x] **`JobFilter` missing date-range fields**
  - **Resolved in:** `@camunda8/orchestration-cluster-api` **9.1.0**
  - **Fields:** `creationTime` and `lastUpdateTime` are available as `DateTimeFilterProperty`.
