# SDK Gaps

## How to use this file

This file tracks known gaps and limitations in the SDKs used by c8ctl. **GitHub agentic workflows must check this file before implementing features that interact with the Camunda SDK.** If a gap listed here affects your work:

1. Check whether a newer SDK version resolves the gap - if so, update the entry (mark it resolved, remove workarounds).
2. If the gap is still open, apply the documented remediation/workaround.
3. Create a GitHub Issue for any unresolved gap that blocks or degrades a feature, referencing this file.

When a new SDK limitation is discovered during development, add it here following the entry format below.

---

## Open Gaps

- [ ] **`searchElementInstanceWaitStates` method missing**
  - **SDK:** `@camunda8/orchestration-cluster-api` — current version **9.1.2**
  - **Affected endpoint:** `POST /v2/element-instances/wait-states/search`
  - **Missing:** No SDK method for the wait-states search endpoint
  - **Available in:** Camunda 8.8+ REST API
  - **Impact:** `c8ctl search wait-state` cannot use the SDK client directly; uses `resolveAuthHeaders()` + `rawPostWithHeaders()` to make authenticated HTTP requests.
  - **Remediation:** Upgrade SDK when a release ships with `searchElementInstanceWaitStates`; replace `rawPostWithHeaders()` call with the SDK method.

- [ ] **No config flag to disable the automatic `/v2` suffix on `CAMUNDA_REST_ADDRESS`**
  - **SDK:** `@camunda8/orchestration-cluster-api` — current version **9.1.2**
  - **Behavior:** `hydrateConfig()` always appends `/v2` to `CAMUNDA_REST_ADDRESS` unless the value already ends with `/v2` or `/v2/`; there is no override.
  - **Affected:** gateway/proxy-fronted profiles whose base path doesn't match this convention (`c8ctl add profile --exactBaseUrl`, #547).
  - **Impact:** `createClient()` (`src/core/client.ts`) works around this by passing a custom `fetch` (`buildGatewayFetch`) that rewrites the outgoing `Request`'s URL, replacing the SDK-computed `.../v2` prefix with the profile's literal `baseUrl`. `rawPostWithHeaders()`/`resolveClusterConfig()` mirror the same suffixing rule for the one manually-issued REST call (`search wait-state`) that bypasses the SDK client.
  - **Remediation:** If the SDK adds a config flag (e.g. `CAMUNDA_REST_ADDRESS_EXACT`) to opt out of the suffix, use it directly and remove `buildGatewayFetch`'s URL-rewriting branch and the mirrored logic in `restBaseUrlForProfile()`.

- [ ] **`WaitStateType` enum not exported from SDK**
  - **SDK:** `@camunda8/orchestration-cluster-api` — current version **9.1.0**
  - **Affected type:** `WaitStateType` (JOB, MESSAGE, TIMER, CONDITION, USER_TASK, SIGNAL)
  - **Missing:** The SDK does not export any WaitStateType enum or type definition. Five of the six values (JOB, MESSAGE, TIMER, USER_TASK, SIGNAL) are present in the OpenAPI spec; CONDITION is not yet documented.
  - **Impact:** `c8ctl` defines a local `WAIT_STATE_TYPE_ENUM` object literal for flag validation. The CONDITION value was added ahead of the spec based on API behaviour.
  - **Remediation:** Import the enum from the SDK when available; remove local definition.

---

## Resolved Gaps

- [x] **`JobFilter` missing date-range fields**
  - **Resolved in:** `@camunda8/orchestration-cluster-api` **9.1.0**
  - **Fields:** `creationTime` and `lastUpdateTime` are available as `DateTimeFilterProperty`.
