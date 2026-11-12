# c8ctl-plugin-saas (prototype)

Log in to Camunda SaaS as **yourself** (not an API client) and use that login
for read-only calls. Demo for [camunda/c8ctl#738](https://github.com/camunda/c8ctl/issues/738).

## Usage

```bash
export C8CTL_SAAS_CLIENT_ID=<Auth0 native app client id>   # until ids are built in

c8ctl saas login [--stage prod|int|dev] [--no-browser]  # device code, opens the browser
c8ctl saas status                                       # login state of all stages
c8ctl saas token [--stage …]                            # valid access token, for scripts
c8ctl saas orgs [--stage …]                             # your organisations, default marked
c8ctl saas clusters [--org <id>] [--stage …]            # clusters of an org
c8ctl saas hub [--org <id>] [--stage …]                 # Hub projects of an org
c8ctl saas logout [--stage …]
```

`--stage` defaults to `prod`. Without `--org`, the first organisation of your
login (token claim `https://camunda.com/orgs`) is used.

## Tokens

Stored per stage in `<c8ctl data dir>/saas/<stage>.json` (mode 0600) and
refreshed automatically. A lock file serialises refreshes, so parallel c8ctl
calls do not trip Auth0's refresh-token reuse detection.

## Prototype caveats

- `clusters` calls Console's own `/api`, `hub` calls Hub's `/api/internal`.
  Neither is a documented API and neither has a contract: a Console or Hub
  release can break these commands.
- The public Administration API only accepts API-client tokens, so it can't
  be used with a user login.
