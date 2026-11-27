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
  - **SDK:** Installed `@camunda8/orchestration-cluster-api` **10.0.1**, depending on `typed-env` **2.0.0**.
  - **Behavior:** `typed-env/package.json` declares `"sideEffects": "false"` as a string. esbuild requires a boolean or array and emits a warning during plugin bundling.
  - **Affected:** `npm run build` and the distribution build performed by `npm test`.
  - **Impact:** Commands exit successfully, but the warnings-fatal release gate remains blocked. The complete Node 22 migration verification recorded this warning twice.
  - **Remediation:** Correct the upstream package metadata and consume a corrected dependency release. Do not suppress the warning or patch the dependency locally. Tracked in the [SDK package metadata issue](https://github.com/camunda/orchestration-cluster-api-js/issues/665). Neither package has a newer published release that resolves this warning.

- [ ] **Process instance suspend/resume endpoints not available before Camunda 8.10**
  - **SDK:** `@camunda8/orchestration-cluster-api` — current version **10.0.0-alpha.43**
  - **Behavior:** The SDK client exposes `suspendProcessInstance()`/`resumeProcessInstance()` (`POST /process-instances/{key}/suspension` and `/resumption`) and the types compile against every supported server version, but the REST API gateway on Camunda 8.8/8.9 returns `404 Not Found [suspendProcessInstance]: No endpoint POST /v2/process-instances/{key}/suspension.` — the endpoint only exists starting with 8.10.
  - **Affected:** `c8ctl suspend process-instance` / `c8ctl resume process-instance` (#57996).
  - **Impact:** Running either command against an 8.8/8.9 cluster surfaces the gateway's 404 as a normal command error (no special-casing needed — the framework's error path already renders it clearly). The live CLI integration tests for these commands (`tests/integration/process-instances.test.ts`) are skipped on `CAMUNDA_VERSION` 8.8/8.9 via `suspendResumeSkip`, mirroring the existing `businessIdSkip` pattern in the same file.
  - **Remediation:** None needed — this is a platform version floor, not an SDK defect. Revisit only if a future SDK release needs adjusting for a change in the endpoint's shape.

- [ ] **Cluster variables not available before Camunda 8.9; `kind`, `metadata` and own authorizations before 8.10**
  - **SDK:** `@camunda8/orchestration-cluster-api` — current version **10.0.1**
  - **Behavior:** The SDK exposes the `/cluster-variables` endpoints, the `kind` and `metadata` fields, and `searchOwnAuthorizations()` (`POST /authentication/me/authorizations/search`) for every server version. The REST API has no `/cluster-variables` endpoints on 8.8; `kind`, `metadata` and the own authorizations search are new in 8.10 (`stable/8.9` and `stable/8.10` specs in camunda/camunda).
  - **Affected:** `c8ctl list|search|get|create|update|delete cluster-variable`, `--kind`, `--metadata`, `c8ctl search authorization --own`.
  - **Impact:** Against an older cluster, the gateway's error is a normal command error. `tests/integration/cluster-variables.test.ts` skips on `CAMUNDA_VERSION` 8.8 (`clusterVariablesSkip`) and skips the 8.10 features on 8.8/8.9 (`camunda810Skip`).
  - **Remediation:** None needed — this is a platform version floor, not an SDK defect.

- [ ] **Cluster variable `value` typed as an object only**
  - **SDK:** `@camunda8/orchestration-cluster-api` — current version **10.0.1**
  - **Behavior:** `create*ClusterVariable()` and `update*ClusterVariable()` type `value` as `{ [key: string]: unknown }`. The REST API accepts any JSON value: Camunda 8.10.6 stores a string, a number or an array as well.
  - **Affected:** `c8ctl create|update cluster-variable --value`.
  - **Impact:** c8ctl accepts JSON objects only and rejects other values before the request.
  - **Remediation:** Report upstream to camunda/orchestration-cluster-api-js; once the SDK accepts any JSON value, relax `requireValue()` in `src/services/cluster-variables.ts`.

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
