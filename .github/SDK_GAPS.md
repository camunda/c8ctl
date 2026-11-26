# SDK Gaps

## How to use this file

This file tracks known gaps and limitations in the SDKs used by c8ctl. **GitHub agentic workflows must check this file before implementing features that interact with the Camunda SDK.** If a gap listed here affects your work:

1. Check whether a newer SDK version resolves the gap - if so, update the entry (mark it resolved, remove workarounds).
2. If the gap is still open, apply the documented remediation/workaround.
3. Create a GitHub Issue for any unresolved gap that blocks or degrades a feature, referencing this file.

When a new SDK limitation is discovered during development, add it here following the entry format below.

---

## Open Gaps

- [ ] **Transitive `typed-env` package emits a bundler warning**
  - **SDK:** Installed `@camunda8/orchestration-cluster-api` **11.0.0-alpha.6**, depending on `typed-env` **2.0.0**.
  - **Behavior:** `typed-env/package.json` declares `"sideEffects": "false"` as a string. esbuild requires a boolean or array and emits a warning during plugin bundling.
  - **Affected:** `npm run build` and the distribution build performed by `npm test`.
  - **Impact:** Commands exit successfully, but the warnings-fatal release gate remains blocked. The complete Node 22 migration verification recorded this warning twice.
  - **Remediation:** Correct the upstream package metadata and consume a corrected dependency release. Do not suppress the warning or patch the dependency locally. Tracked in the [SDK package metadata issue](https://github.com/camunda/orchestration-cluster-api-js/issues/665). Neither package has a newer published release that resolves this warning.

- [ ] **Process instance suspend/resume endpoints not available before Camunda 8.10**
  - **SDK:** `@camunda8/orchestration-cluster-api` - current version **11.0.0-alpha.6**
  - **Behavior:** The SDK client exposes `suspendProcessInstance()`/`resumeProcessInstance()` (`POST /process-instances/{key}/suspension` and `/resumption`) and the types compile against every supported server version, but the REST API gateway on Camunda 8.8/8.9 returns `404 Not Found [suspendProcessInstance]: No endpoint POST /v2/process-instances/{key}/suspension.` — the endpoint only exists starting with 8.10.
  - **Affected:** `c8ctl suspend process-instance` / `c8ctl resume process-instance` (#57996).
  - **Impact:** Running either command against an 8.8/8.9 cluster surfaces the gateway's 404 as a normal command error (no special-casing needed — the framework's error path already renders it clearly). The live CLI integration tests for these commands (`tests/integration/process-instances.test.ts`) are skipped on `CAMUNDA_VERSION` 8.8/8.9 via `suspendResumeSkip`, mirroring the existing `businessIdSkip` pattern in the same file.
  - **Remediation:** None needed — this is a platform version floor, not an SDK defect. Revisit only if a future SDK release needs adjusting for a change in the endpoint's shape.

- [ ] **Process definition suspend/resume endpoints not available before Camunda 8.11**
  - **SDK:** `@camunda8/orchestration-cluster-api` - current version **11.0.0-alpha.6**. The SDK moved from 10.x to this pre-release major to get `suspendProcessDefinitions()`/`resumeProcessDefinitions()`; no 10.x release has them.
  - **Behavior:** The SDK client exposes `suspendProcessDefinitions()`/`resumeProcessDefinitions()` (`POST /process-definitions/suspension` and `/resumption`) and the types compile against every supported server version, but the REST API gateway on Camunda 8.8, 8.9 and 8.10 returns `404 Not Found` because the endpoints only exist starting with 8.11.
  - **Affected:** `c8ctl suspend process-definition` / `c8ctl resume process-definition`.
  - **Impact:** Running either command against an 8.8-8.10 cluster surfaces the gateway's 404 as a normal command error. The live CLI integration tests for these commands (`tests/integration/process-definitions.test.ts`) are skipped on `CAMUNDA_VERSION` 8.8-8.10 via `pdSuspendResumeSkip`, so they do not run in CI until an 8.11 matrix entry exists.
  - **Remediation:** None needed, this is a platform version floor and not an SDK defect. Revisit the pre-release SDK dependency once a stable release carries these methods.

- [ ] **No config flag to disable the automatic `/v2` suffix on `CAMUNDA_REST_ADDRESS`**
  - **SDK:** `@camunda8/orchestration-cluster-api` - current version **11.0.0-alpha.6**. This version adds the `CAMUNDA_REST_ADDRESS_EXACT` flag (see Remediation); the workaround below has not been migrated to it yet.
  - **Behavior:** `hydrateConfig()` always appends `/v2` to `CAMUNDA_REST_ADDRESS` unless the value already ends with `/v2` or `/v2/`. Before 11.0.0-alpha.6 there is no override.
  - **Affected:** gateway/proxy-fronted profiles whose base path doesn't match this convention (`c8ctl add profile --exactBaseUrl`, #547).
  - **Impact:** `createClient()` (`src/core/client.ts`) works around this by passing a custom `fetch` (`buildGatewayFetch`) that rewrites the outgoing `Request`'s URL, replacing the SDK-computed `.../v2` prefix with the profile's literal `baseUrl`. `rawPostWithHeaders()`/`resolveClusterConfig()` mirror the same suffixing rule for the manually-issued REST calls (the general-purpose escape hatch in `src/core/client.ts`) that bypass the SDK client.
  - **Remediation:** The SDK now has the opt-out flag `CAMUNDA_REST_ADDRESS_EXACT` (it also trims trailing slashes). Once the SDK is on a stable release that includes it, set the flag instead and remove `buildGatewayFetch`'s URL-rewriting branch and the mirrored logic in `restBaseUrlForProfile()`. Tracked upstream: [camunda/orchestration-cluster-api-js#499](https://github.com/camunda/orchestration-cluster-api-js/issues/499).

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
