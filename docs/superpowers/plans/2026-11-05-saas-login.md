# c8ctl SaaS Login (prototype) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bundled `saas` default plugin that logs a person into Camunda SaaS via Auth0 device code and lists their orgs, an org's clusters, and an org's Hub projects.

**Architecture:** TypeScript default plugin in `default-plugins/saas/`. Pure modules (`stages.ts`, `jwt.ts`, `tokens.ts`, `auth.ts`, `api.ts`) never touch `globalThis.c8ctl` and take `fetch`/dir/clock as parameters so unit tests import them directly; `c8ctl-plugin.ts` is the only file that reads the runtime and wires the `saas` verb. Bundled automatically by `scripts/build-plugins.mjs` (it bundles every `default-plugins/*/c8ctl-plugin.ts`).

**Tech Stack:** Node ≥22 built-ins only (`fetch`, `node:fs`, `node:child_process`, `node:test`), TypeScript via `--experimental-strip-types`, Biome.

**Spec:** `docs/superpowers/specs/2026-11-05-saas-login-design.md`

## Global Constraints

- No new npm dependencies; plugin `package.json` has no `dependencies`. Do not add it to root `workspaces`.
- No changes under `src/` (core).
- Demo on branch `ultraschuppi/saaslogin` only. Commits: Conventional Commits, lowercase subject, body ends with `Refs #738` and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Pure modules must not reference `globalThis.c8ctl`.
- Tokens are never logged; only `saas token` prints one. Tokens go only to the stage's fixed Auth0/Accounts/Console/Hub hosts.
- `--stage` values `prod|int|dev`, default `prod`.
- Token file `<userDataDir>/saas/<stage>.json`, dir mode 0700, file mode 0600, written temp-file + rename.
- Refresh when < 60s of access-token life left. Device-code scope `openid email offline_access`.
- Org claim name `https://camunda.com/orgs` (array of `{id, roles}`); default org = first entry.
- Client id: `C8CTL_SAAS_CLIENT_ID` env wins over the hardcoded per-stage value; hardcoded values are empty strings for now.

## Review Focus

1. Two parallel commands with an about-to-expire token → exactly one refresh request reaches Auth0, both commands get a token (Task 3 test `concurrent getAccessToken refreshes once`).
2. Lock file left behind by a killed process → next command takes it after the stale window instead of hanging (Task 2 test `withLock steals a stale lock`).
3. Token file is corrupt / half-written JSON → treated as "not logged in" with the login hint, not a stack trace (Task 2 test `readToken returns undefined for corrupt file`).
4. Token without org claim and no `--org` → `clusters`/`hub` fail with "no organisation on this account; create or join one in Console" (Task 1 test `defaultOrgId undefined without claim`, Task 5 test).
5. Backend 401 → message tells the user to run `c8ctl saas login --stage <stage>`; other non-2xx → status + first 300 chars of body (Task 5 tests in `saas-api.test.ts`).

---

### Task 1: Stages and JWT helpers

**Files:**
- Create: `default-plugins/saas/stages.ts`, `default-plugins/saas/jwt.ts`
- Test: `tests/unit/saas-stages-jwt.test.ts`

**Interfaces:**
- Produces:
  - `type Stage = "prod" | "int" | "dev"`
  - `interface StageConfig { auth0Domain: string; audience: string; accounts: string; console: string; hub: string; clientId: string }`
  - `const STAGES: Record<Stage, StageConfig>` — values exactly from the spec's Stages table; URLs without trailing slash; `clientId: ""`.
  - `parseStage(value: unknown): Stage` — `undefined` → `"prod"`; unknown string throws `Error("Unknown stage 'x'. Use one of: prod, int, dev")`.
  - `clientIdFor(stage: Stage, env?: NodeJS.ProcessEnv): string` — env `C8CTL_SAAS_CLIENT_ID` (non-empty) wins, else `STAGES[stage].clientId`, else throws `Error("No Auth0 client id for stage '<stage>'. Set C8CTL_SAAS_CLIENT_ID.")`.
  - `const ORG_CLAIM = "https://camunda.com/orgs"`
  - `decodeJwtPayload(token: string): Record<string, unknown>` — base64url-decode segment 2; throws on malformed.
  - `tokenOrgs(token: string): { id: string; roles: string[] }[]` — `[]` when claim missing/not an array; drops entries without string `id`.
  - `defaultOrgId(token: string): string | undefined` — first of `tokenOrgs`.

- [ ] **Step 1: Write the failing tests** — helper `fakeJwt(payload)` = `"h." + base64url(JSON) + ".s"`.
  - `parseStage(undefined) === "prod"`, `parseStage("int") === "int"`, `parseStage("foo")` throws matching `/Use one of: prod, int, dev/`.
  - `STAGES.prod.auth0Domain === "weblogin.cloud.camunda.io"`, `STAGES.dev.hub === "https://hub.dev.ultrawombat.com"`.
  - `clientIdFor("prod", { C8CTL_SAAS_CLIENT_ID: "abc" }) === "abc"`; `clientIdFor("prod", {})` throws `/C8CTL_SAAS_CLIENT_ID/`.
  - `defaultOrgId(fakeJwt({ [ORG_CLAIM]: [{ id: "o1", roles: ["owner"] }, { id: "o2", roles: [] }] })) === "o1"`.
  - `defaultOrgId undefined without claim`: `defaultOrgId(fakeJwt({ sub: "x" })) === undefined`; `tokenOrgs(fakeJwt({ [ORG_CLAIM]: "nope" }))` deep-equals `[]`.
  - `decodeJwtPayload("not-a-jwt")` throws.
- [ ] **Step 2: Run, expect FAIL (module not found)**
  `node --experimental-strip-types --import ./tests/utils/isolate-user-data-dir.ts --test tests/unit/saas-stages-jwt.test.ts`
- [ ] **Step 3: Implement both files** per Interfaces (`Buffer.from(seg, "base64url")`).
- [ ] **Step 4: Run, expect PASS**; `npx biome check default-plugins/saas tests/unit/saas-*.test.ts` clean.
- [ ] **Step 5: Commit** `feat(saas): add stage table and jwt org helpers`

---

### Task 2: Token store and lock

**Files:**
- Create: `default-plugins/saas/tokens.ts`
- Test: `tests/unit/saas-tokens.test.ts`

**Interfaces:**
- Consumes: `Stage` (Task 1)
- Produces:
  - `interface StoredToken { access_token: string; refresh_token: string; expires_at: number /* epoch seconds */; sub: string; email?: string }`
  - `tokenDir(userDataDir: string): string` → `join(userDataDir, "saas")`
  - `readToken(dir: string, stage: Stage): StoredToken | undefined` — missing file, invalid JSON, or missing `access_token`/`refresh_token` → `undefined`.
  - `writeToken(dir: string, stage: Stage, token: StoredToken): void` — `mkdirSync(dir, {recursive, mode: 0o700})`, write `<stage>.json.<pid>.tmp` with mode 0o600, `renameSync`.
  - `deleteToken(dir: string, stage: Stage): boolean` — true if a file was removed.
  - `needsRefresh(token: StoredToken, nowSec: number): boolean` — `token.expires_at - nowSec < 60`.
  - `withLock<T>(dir: string, stage: Stage, fn: () => Promise<T>, opts?: { staleMs?: number; retryMs?: number; timeoutMs?: number }): Promise<T>` — defaults 30000 / 100 / 15000. Lock file `<dir>/<stage>.lock` created with `openSync(path, "wx")`; on `EEXIST`, if lock mtime older than `staleMs` remove it and retry, else sleep `retryMs`; past `timeoutMs` throw `Error("Timed out waiting for SaaS token lock <path>")`. Always release in `finally`.

- [ ] **Step 1: Write the failing tests** (each in `mkdtempSync` dir):
  - round trip: `writeToken` then `readToken` deep-equals input; `statSync(file).mode & 0o777 === 0o600` and dir `=== 0o700` (skip mode asserts on win32).
  - `readToken returns undefined for corrupt file`: write `"{not json"` to `<dir>/prod.json` → `undefined`.
  - `deleteToken` returns true then false.
  - `needsRefresh({…expires_at: 1000}, 941) === false`, `(…, 941 + 1) === true` (59s left).
  - `withLock serialises`: two concurrent `withLock` calls each pushing `start`/`end` into an array with a 50ms await inside → order is `start,end,start,end`.
  - `withLock steals a stale lock`: create `<dir>/prod.lock`, `utimesSync` it to 60s ago, `withLock(dir,"prod",async()=>42,{staleMs:1000})` resolves 42 within 1s.
  - lock file removed after `fn` throws.
- [ ] **Step 2: Run, expect FAIL**
  `node --experimental-strip-types --import ./tests/utils/isolate-user-data-dir.ts --test tests/unit/saas-tokens.test.ts`
- [ ] **Step 3: Implement `tokens.ts`** per Interfaces.
- [ ] **Step 4: Run, expect PASS**; biome clean.
- [ ] **Step 5: Commit** `feat(saas): add token store with per-stage lock`

---

### Task 3: Auth0 device code, refresh, and getAccessToken

**Files:**
- Create: `default-plugins/saas/auth.ts`
- Test: `tests/unit/saas-auth.test.ts`

**Interfaces:**
- Consumes: `StageConfig`, `Stage`, `decodeJwtPayload` (Task 1); `StoredToken`, `readToken`, `writeToken`, `deleteToken`, `needsRefresh`, `withLock` (Task 2)
- Produces:
  - `type FetchFn = typeof fetch`
  - `interface AuthCfg { auth0Domain: string; audience: string; clientId: string }`
  - `interface DeviceCode { device_code: string; user_code: string; verification_uri_complete: string; expires_in: number; interval: number }`
  - `interface TokenResponse { access_token: string; refresh_token?: string; id_token?: string; expires_in: number }`
  - `class NotLoggedInError extends Error` — `constructor(stage: Stage)`, message `Not logged in to SaaS (<stage>). Run: c8ctl saas login --stage <stage>`
  - `requestDeviceCode(cfg: AuthCfg, fetchFn?: FetchFn): Promise<DeviceCode>` — `POST https://{auth0Domain}/oauth/device/code`, form body `client_id`, `audience`, `scope=openid email offline_access`.
  - `pollForToken(cfg: AuthCfg, dc: DeviceCode, deps?: { fetchFn?: FetchFn; sleep?: (ms: number) => Promise<void> }): Promise<TokenResponse>` — `POST /oauth/token` `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code`, `client_id`. Error `authorization_pending` → sleep `interval`s and repeat; `slow_down` → interval += 5; `expired_token` → throw `Error("Login code expired. Run c8ctl saas login again.")`; `access_denied` → throw `Error("Login was denied in the browser.")`; any other → throw with Auth0's `error_description`.
  - `refreshTokens(cfg: AuthCfg, refreshToken: string, fetchFn?: FetchFn): Promise<TokenResponse>` — `grant_type=refresh_token`; Auth0 error `invalid_grant` → throw `InvalidGrantError` (exported class).
  - `toStored(resp: TokenResponse, nowSec: number, prev?: StoredToken): StoredToken` — `refresh_token` = `resp.refresh_token ?? prev?.refresh_token` (throw if neither); `expires_at = nowSec + expires_in`; `sub`/`email` from `id_token` payload if present, else access-token payload, else `prev`.
  - `getAccessToken(dir: string, stage: Stage, cfg: AuthCfg, deps?: { fetchFn?: FetchFn; now?: () => number }): Promise<string>` — algorithm:
    ```
    if !readToken → throw NotLoggedInError
    if !needsRefresh(token) → return access_token          // fast path, no lock
    withLock(dir, stage):
      t = readToken (re-read: another process may have refreshed)
      if !t → throw NotLoggedInError
      if !needsRefresh(t) → return t.access_token
      try resp = refreshTokens(cfg, t.refresh_token)
      catch InvalidGrantError → deleteToken; throw NotLoggedInError
      writeToken(toStored(resp, now, t)); return new access_token
    ```
  - All Auth0 requests: `redirect: "manual"`, `signal: AbortSignal.timeout(30000)`, `content-type: application/x-www-form-urlencoded`.

- [ ] **Step 1: Write the failing tests** with a fake `fetchFn` that records calls and returns queued `Response` objects:
  - `requestDeviceCode` posts to `https://weblogin.cloud.camunda.io/oauth/device/code`, body contains `scope=openid+email+offline_access` and `audience=cloud.camunda.io`.
  - `pollForToken` with responses `[400 authorization_pending, 400 slow_down, 200 token]` resolves the token; recorded sleeps equal `[5000, 10000]` for `interval: 5`.
  - `pollForToken` with `400 expired_token` rejects `/expired/`; with `400 access_denied` rejects `/denied/`.
  - `toStored` keeps `prev.refresh_token` when response has none; takes the new one when present (rotation).
  - `getAccessToken` with a fresh token makes zero fetch calls.
  - `getAccessToken` with no token file rejects `NotLoggedInError` and message matches `/c8ctl saas login --stage prod/`.
  - `getAccessToken` with refresh `400 {error:"invalid_grant"}` rejects `NotLoggedInError` and `readToken` is then `undefined`.
  - `concurrent getAccessToken refreshes once`: expiring stored token, fake refresh responds after 50ms with new tokens; `Promise.all` of two calls → both return the new access token, fetch called exactly once.
- [ ] **Step 2: Run, expect FAIL**
  `node --experimental-strip-types --import ./tests/utils/isolate-user-data-dir.ts --test tests/unit/saas-auth.test.ts`
- [ ] **Step 3: Implement `auth.ts`** per Interfaces.
- [ ] **Step 4: Run, expect PASS**; biome clean.
- [ ] **Step 5: Commit** `feat(saas): add auth0 device code and refresh flow`

---

### Task 4: Plugin shell with login, logout, status, token

**Files:**
- Create: `default-plugins/saas/c8ctl-plugin.ts`, `default-plugins/saas/package.json`, `default-plugins/saas/README.md`
- Test: `tests/unit/saas-plugin.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces (used by Task 5): inside `c8ctl-plugin.ts`
  - `export const metadata` (`satisfies PluginMetadata`) with `commands.saas.subcommands` listing `login, logout, status, token, orgs, clusters, hub` and examples; `export const commands = { saas: { flags, handler } } satisfies PluginCommands`.
  - flags: `stage` (string, "prod|int|dev, default prod"), `org` (string), `no-browser` (boolean).
  - handler dispatches `args[0]` to a `Record<string, (c: SaasCmdCtx) => Promise<void>>`; unknown/missing subcommand → info listing subcommands, `process.exitCode = 1` (copy feel's pattern, `default-plugins/feel/c8ctl-plugin.ts:697-729`).
  - `interface SaasCmdCtx { stage: Stage; cfg: StageConfig; dir: string; flags: Record<string, unknown>; ctx: PluginCtx }` where `dir = tokenDir(c8ctl.getUserDataDir())`.
  - `authCfg(stage: Stage): AuthCfg` → `{ auth0Domain, audience, clientId: clientIdFor(stage) }`.
  - Errors from any subcommand: `logger.error(message)` + `process.exitCode = 1` (no stack trace).
- Copy as in spec Commands table. Behaviour:
  - `login`: `requestDeviceCode` → print `Open <verification_uri_complete>` and `Code: <user_code>` → unless `--no-browser`, `openBrowser(url)` → `pollForToken` → `writeToken(toStored(...))` → success `Logged in to SaaS (<stage>) as <email ?? sub>`. In JSON mode print `{stage, sub, email, expires_at}`.
  - `openBrowser(url: string): void` — `spawn` detached, `stdio: "ignore"`, `unref()`, swallow `error` event: darwin `open url`, win32 `cmd /c start "" url`, else `xdg-open url`.
  - `logout`: `deleteToken` → `Logged out of SaaS (<stage>)` or `Not logged in to SaaS (<stage>)`; exit 0 either way.
  - `status`: all three stages from `readToken` only (no network); row per stage `{stage, loggedIn, user, expiresAt (ISO)}` via `logger.table` / `logger.json`.
  - `token`: `getAccessToken` → raw token on stdout via `logger.output`, nothing else.
- `package.json`: `{"name":"c8ctl-plugin-saas","version":"0.1.0","type":"module","private":true,"description":"c8ctl plugin to log in to Camunda SaaS as a user (prototype)","main":"c8ctl-plugin.ts"}`.
- `README.md`: usage of all seven subcommands, `C8CTL_SAAS_CLIENT_ID`, token location, and a "Prototype" note: Console `/api` and Hub `/api/internal` are undocumented and have no contract.

- [ ] **Step 1: Write the failing tests** using `c8` from `tests/utils/cli.ts` (or `asyncSpawn` with a temp `C8CTL_DATA_DIR`, as `tests/unit/feel-plugin.test.ts` does):
  - `c8ctl saas` (no subcommand) exits 1, output lists `login`.
  - `c8ctl saas status` with empty data dir exits 0, JSON has 3 entries all `loggedIn: false`.
  - `c8ctl saas token` with empty data dir exits 1, stderr matches `/c8ctl saas login --stage prod/`.
  - `c8ctl saas login --stage foo` exits 1, matches `/Use one of: prod, int, dev/`.
  - `c8ctl saas login` with `C8CTL_SAAS_CLIENT_ID` unset exits 1, matches `/C8CTL_SAAS_CLIENT_ID/` (env must explicitly delete it).
  - `c8ctl saas logout` with a token file written via `writeToken` into `<dataDir>/saas` removes it.
- [ ] **Step 2: Run, expect FAIL**
  `node --experimental-strip-types --import ./tests/utils/isolate-user-data-dir.ts --test tests/unit/saas-plugin.test.ts`
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run, expect PASS**; also `npm run typecheck` and `npx biome check default-plugins/saas tests/unit/saas-*.test.ts` clean.
- [ ] **Step 5: Commit** `feat(saas): add saas plugin with login and token commands`

---

### Task 5: API calls — orgs, clusters, hub

**Files:**
- Create: `default-plugins/saas/api.ts`
- Modify: `default-plugins/saas/c8ctl-plugin.ts` (add three subcommands)
- Test: `tests/unit/saas-api.test.ts`, extend `tests/unit/saas-plugin.test.ts`

**Interfaces:**
- Consumes: `NotLoggedInError`, `FetchFn`, `getAccessToken` (Task 3); `defaultOrgId` (Task 1); `SaasCmdCtx`, `authCfg` (Task 4).
- Produces:
  - `apiGet(url: string, token: string, stage: Stage, fetchFn?: FetchFn): Promise<unknown>` — `Authorization: Bearer`, `accept: application/json`, `redirect: "manual"`, 30s timeout. 401 → throw `NotLoggedInError(stage)`; other non-2xx → `Error("GET <path> failed: <status> <first 300 chars of body>")` (path only, never the token); returns parsed JSON, unwrapping a top-level `data` property when present.
  - `resolveOrg(flagOrg: unknown, token: string): string` — non-empty string flag wins, else `defaultOrgId(token)`, else throw `Error("no organisation on this account; create or join one in Console")`.
  - Endpoints:
    - `orgs`: `GET {accounts}/api/organizations/my`; mark entry whose `uuid` (fallback `id`) equals `defaultOrgId(token)` with `default: true`.
    - `clusters`: `GET {console}/api/orgs/{encodeURIComponent(org)}/clusters`
    - `hub`: `GET {hub}/api/internal/organizations/{encodeURIComponent(org)}/projects`
  - Text mode: `logger.table` of chosen columns (builder's call; include id and name). JSON mode: `logger.json` of the data.

- [ ] **Step 1: Write the failing tests** (`saas-api.test.ts`, fake fetch):
  - `apiGet` sends `authorization: Bearer t`; returns `[1]` for body `{"data":[1]}` and `[2]` for `[2]`.
  - `apiGet` on 401 rejects `NotLoggedInError` matching `/c8ctl saas login --stage int/` for stage `int`.
  - `apiGet` on 500 with a 1000-char body rejects with message length < 400 and containing `500`; message does not contain the token.
  - `resolveOrg("o9", tok) === "o9"`; `resolveOrg(undefined, tokWithOrgs) === "o1"`; `resolveOrg(undefined, tokWithoutOrgs)` throws `/no organisation on this account/`.
  - In `saas-plugin.test.ts`: `c8ctl saas clusters` with empty data dir exits 1 with login hint.
- [ ] **Step 2: Run, expect FAIL**
  `node --experimental-strip-types --import ./tests/utils/isolate-user-data-dir.ts --test tests/unit/saas-api.test.ts tests/unit/saas-plugin.test.ts`
- [ ] **Step 3: Implement `api.ts`** and the three subcommands (each: `getAccessToken` → `resolveOrg` where needed → `apiGet` → render).
- [ ] **Step 4: Run, expect PASS**; full saas suite `--test tests/unit/saas-*.test.ts`, `npm run typecheck`, biome clean.
- [ ] **Step 5: Commit** `feat(saas): add orgs, clusters and hub listing`

---

### Manual check (Tim, after Task 5)

With the new Auth0 Native app on int:
```bash
export C8CTL_SAAS_CLIENT_ID=<int client id>
node src/index.ts saas login --stage int
node src/index.ts saas orgs --stage int
node src/index.ts saas clusters --stage int
node src/index.ts saas hub --stage int
# parallel refresh: wait until token is near expiry (or edit expires_at in the file), then
node src/index.ts saas token --stage int & node src/index.ts saas token --stage int; wait
node src/index.ts saas status   # still logged in
```
