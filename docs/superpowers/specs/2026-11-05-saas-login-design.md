# c8ctl SaaS login (prototype) — design

Date: 2026-11-05 · Owner: Tim Schuppener · Status: draft · Issue: https://github.com/camunda/c8ctl/issues/738

## Intent

Let a customer log c8ctl into Camunda SaaS as **themselves** (a person, not an
API client), the way `ccmacli login` works for Camundis today, and prove the
login is useful with three read-only calls: their orgs, the clusters of an
org, and the Hub projects of an org.

Why: the long-term goal is a prompt like *"log into my prod account in SaaS and
get me BPMN diagram xyz from my default organisation"*. That needs a user login
first. This is Tim's own prototype to show what that login should feel like;
it runs ahead of (not inside) PDP-3814 (user login for c8ctl / Desktop
Modeler). Context: Slack thread
https://camunda.slack.com/archives/C0BHBR30HJ7/p1793810984869789.

## Goals

- `c8ctl saas login` with the OAuth device-code flow against the SaaS Auth0
  tenant; token kept and refreshed on disk.
- Read-only calls that prove the token works: `orgs`, `clusters`, `hub`.
- Feels like ccmacli: one command to log in, every other command just works
  until the refresh token dies.

## Non-goals (this prototype)

- Wiring the login into c8ctl profiles / `createClient` (talking to a cluster's
  Orchestration API with the user token).
- Fetching, editing or pushing Hub diagrams (later step toward the prompt).
- API-client (client-credentials) login.
- Onboarding users without an org (they get an empty list and a hint).
- Changes to c8ctl core (`src/`).
- Shipping: this is a **demo on the branch**, not merged to `main` or released
  (decided by Tim). No feature flag, packaging, release notes, or PDP-3814
  naming alignment needed.

## Anti-goals

- Parallel c8ctl calls must not log the user out (Auth0 refresh-token reuse
  detection revokes the whole token family — see Token handling).
- Tokens never printed except by `saas token`, never logged in `--verbose`,
  never sent to a host other than the fixed Auth0/Accounts/Console/Hub hosts.
- No new npm dependencies.

## Shape: a bundled default plugin

Lives in `default-plugins/saas/` next to `cluster`, `bpmn`, `feel`,
`element-template`. Follow those for layout, help text, and how `ctx`,
`ctx.logger` and the output mode are used. TypeScript or JavaScript is the
builder's pick (default plugins allow both).

Why a plugin (decided): it's a prototype, it touches nothing in core. Known
limits accepted: a plugin can only add its own verb (`c8ctl saas …`, not
`c8ctl list clusters`), gets no profile/auth helpers, and must open the
browser itself (core's `open-helpers` isn't exposed to plugins).

## Commands

All take `--stage prod|int|dev`. **Default `prod`** (my call: customers only
use prod; ccmacli requires it, but for customers prod is the only real one).

| Command | Does |
|---|---|
| `c8ctl saas login` | Device-code flow: print URL + user code, open browser (skip with `--no-browser`), poll until approved, store tokens. |
| `c8ctl saas logout` | Delete the stored tokens of the stage. |
| `c8ctl saas status` | Per stage: logged in or not, user (`email`/`sub`), access-token expiry. No network call needed. |
| `c8ctl saas token` | Print a valid access token (refresh first if needed). For scripts / curl. |
| `c8ctl saas orgs` | List the user's orgs: id, name, user's roles; mark the default. |
| `c8ctl saas clusters [--org <id>]` | List clusters of the org (default org if omitted). |
| `c8ctl saas hub [--org <id>]` | List Hub projects of the org (default org if omitted). |

Output: respect c8ctl's text/JSON output mode. Text = a compact table of the
useful fields; JSON = the API response data. Which columns go in the tables is
the builder's call.

Not logged in / refresh token dead → clear error telling the user to run
`c8ctl saas login [--stage X]`, non-zero exit.

## Stages (hardcoded, from ccmacli `registry.rs`)

| stage | Auth0 domain | audience | Accounts | Console | Hub |
|---|---|---|---|---|---|
| prod | `weblogin.cloud.camunda.io` | `cloud.camunda.io` | `https://accounts.cloud.camunda.io` | `https://console.cloud.camunda.io` | `https://hub.camunda.io` |
| int | `weblogin.cloud.ultrawombat.com` | `cloud.ultrawombat.com` | `https://accounts.cloud.ultrawombat.com` | `https://console.cloud.ultrawombat.com` | `https://hub.ultrawombat.com` |
| dev | `weblogin.cloud.dev.ultrawombat.com` | `cloud.dev.ultrawombat.com` | `https://accounts.cloud.dev.ultrawombat.com` | `https://console.cloud.dev.ultrawombat.com` | `https://hub.dev.ultrawombat.com` |

Auth0 **client_id**: a new Native application per tenant, with device code
enabled and the customer connections (not Okta-only like ccmacli's). Tim
creates these in Auth0. Hardcode the per-stage ids in the plugin once they
exist; until then, and for testing, read an override from env
`C8CTL_SAAS_CLIENT_ID` (my call). If neither is set, `login` fails with a
clear message.

Confirmed by Tim: tokens from the new Native app carry the
`https://camunda.com/orgs` claim and are accepted by Accounts and Console
(same audience as ccmacli). No pre-build verification step needed.

## Auth flow (mirrors ccmacli `src/auth.rs`)

- Device code: `POST https://{auth0}/oauth/device/code`, form-encoded,
  `client_id`, `audience`, `scope=openid email offline_access`.
- Poll: `POST https://{auth0}/oauth/token`,
  `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
  `authorization_pending` → keep polling at `interval`; `slow_down` → interval
  +5s; `expired_token` / `access_denied` → fail with a clear message.
- Refresh: `grant_type=refresh_token`. Take the new refresh token if Auth0
  rotates it, else keep the old one. `invalid_grant` → delete the token file,
  tell the user to log in again. Refresh when < 60s of access-token life left.
- HTTP: Node built-in `fetch`, don't follow redirects on token calls
  (`redirect: 'manual'`), sensible timeout.
- Open browser with the platform opener (`open` / `xdg-open` /
  `cmd /c start`); ignore failure — the URL is printed anyway.

## Token handling

- File per stage: `<c8ctl user data dir>/saas/<stage>.json` via
  `c8ctl.getUserDataDir()`. Dir 0700, file 0600, write temp file + rename.
  Content: `{access_token, refresh_token, expires_at, sub, email}`.
- **Lock around read-check-refresh-write**, per stage. Auth0 rotates refresh
  tokens and revokes the family when an old one is reused; two parallel
  `c8ctl saas …` calls refreshing at once would log the user out. Under the
  lock, re-read the file before deciding to refresh. Node has no file lock in
  stdlib: use a lock file created with `open(…, 'wx')`, retry briefly, treat a
  lock older than ~30s as stale. Exact mechanism is the builder's call, but
  the "parallel calls don't log me out" property is required.

## Orgs and the default org

- `orgs` calls `GET {accounts}/api/organizations/my` with the bearer token.
  Accounts expands the token's org claim into org records (with names); orgs
  missing in the DB are dropped by the backend. (accounts-backend
  `src/routes/OrganizationRouter.ts:228`, mounted under `/api/organizations`.)
- **Default org = the first entry of the token's org claim**
  `https://camunda.com/orgs` (array of `{id, roles}`), decided by Tim. Read it
  by decoding the access-token payload (no signature check needed — we only
  use it to pick an id; the backends verify). `clusters` and `hub` use it when
  `--org` is not given, so they need no extra call to Accounts.
- No orgs in the claim → `orgs` prints an empty list; `clusters`/`hub` without
  `--org` fail with "no organisation on this account; create or join one in
  Console".

## Clusters

`GET {console}/api/orgs/{orgId}/clusters`, bearer token. This is Console's
own (undocumented) API — the public Administration API rejects user tokens.

## Hub

`GET {hub}/api/internal/organizations/{orgId}/projects`, bearer token. Proven
with the same kind of token by hub-ccmacli
(camunda-cloud-management-apps PR #11283). `/api/internal` has **no contract**;
a Hub release may break it. Say so in the plugin README.

## Tests

Small and focused (prototype): unit tests for the pure parts — device-code
poll state handling, refresh decision (expiry window, rotation, invalid_grant),
default-org pick from a token payload, lock acquire/stale. Use mocked `fetch`;
no live SaaS in CI. Follow the repo's test layout for default plugins.
Manual check by Tim against prod/int once the Auth0 client exists.

## Left to the builder

- JS vs TS, file split inside `default-plugins/saas/`.
- Table columns for text output.
- Lock mechanics (as long as the property above holds).
- Timeouts, poll fallback interval, help wording.

## Calls made by me (Claude), not by Tim

- `--stage` defaults to `prod`.
- Client id via hardcoded per-stage value with `C8CTL_SAAS_CLIENT_ID` override.
- Token file under `<userDataDir>/saas/`.
- `hub` lists projects only; `status` makes no network call.
