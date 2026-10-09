# c8ctl-plugin-cluster

A default [c8ctl](https://github.com/camunda/c8ctl) plugin that provides an opinionated way to download, start, stop, and inspect a local Camunda 8 cluster using [c8run](https://docs.camunda.io/docs/self-managed/setup/deploy/local/c8run/).

## Usage

```bash
# Start with a specific version
c8ctl cluster start 8.9.0-alpha5

# Start using a version alias
c8ctl cluster start stable
c8ctl cluster start alpha

# Start with a major.minor version (rolling release)
c8ctl cluster start 8.9

# Starting without specifying a version defaults to stable
c8ctl cluster start

# Start with debug output (streams raw c8run logs)
c8ctl cluster start --debug

# Stop the running cluster
c8ctl cluster stop

# Check whether a cluster is running and see connection details
c8ctl cluster status

# Stream log output from the running cluster
c8ctl cluster logs

# List locally cached versions and available aliases
c8ctl cluster list

# List all versions available on the remote download server
c8ctl cluster list-remote

# Download a version without starting it
c8ctl cluster install 8.8

# Remove a locally cached version to reclaim disk space
c8ctl cluster delete 8.8
```

## Physical tenants

For physical tenants (supporting Camunda 8.10+ builds):

```bash
c8ctl cluster physical-tenants --c8-version 8.10 add sales
c8ctl cluster start 8.10
c8ctl cluster physical-tenants list
c8ctl cluster secrets --physical-tenant sales set OPENAI_API_KEY
c8ctl cluster physical-tenants remove sales --yes
# Or choose physical tenants for one start only:
c8ctl cluster start 8.10 --physical-tenants sales,hr
```

`cluster physical-tenants` delegates to the selected installed c8run, following the same version selection and terminal behavior as `cluster secrets`. `cluster secrets --physical-tenant <id>` (or `--physical-tenant=<id>`) scopes secrets to one physical tenant. The command and selector are forwarded unchanged. These are distinct from logical tenants (`c8ctl list tenants`, `c8ctl use tenant`). c8run owns physical tenant configuration and storage. See [local physical tenants](../../docs/getting-started.md#local-physical-tenants) for authentication, profiles, relative paths, and limitations.

## Version aliases

The `stable` and `alpha` aliases are resolved dynamically by querying the
[Camunda Download Center](https://downloads.camunda.cloud/release/camunda/c8run/).
This means you always get the latest available version without waiting for a
plugin update.

| Alias    | Resolves to |
|----------|-------------|
| `stable` | Highest minor release that is GA (e.g. `8.9`) |
| `alpha`  | Highest minor release overall (e.g. `8.10-alpha1`) |

A `<major>.<minor>` version like `8.8` or `8.9` is also treated as a rolling
release — the download server's `8.8/` directory is updated in-place with new
patch releases.

### `start` vs `install` update behavior

- **`start`** uses the local version if available. A non-blocking remote check runs in the background — if a newer rolling release exists, a hint is printed (e.g. *"A newer server version is available. Install it with: c8ctl cluster install 8.9"*). If the network is unreachable, the hint is silently skipped.
- **`install`** always checks the remote for a newer rolling release (via ETag comparison) and re-downloads if one is available.

If the download server is unreachable, the aliases fall back to the values
shipped in the plugin's `package.json`.

### Resilient running-state tracking

A running cluster is tracked both by c8run's own `.process` pidfiles (which live
inside the version's install directory) **and** by a durable PID record kept at
the cache root (`cluster.pids`). Because that record survives the version's
install directory being replaced, upgraded, or removed while the cluster is
still running, `cluster status` and `cluster stop` continue to see the live
process — where they previously reported the cluster as *stopped* and left the
process orphaned on its ports. To prevent orphaning in the first place, `delete`
and a rolling `install` refuse to **remove the install directory** of a version
whose instance is still running, and `purge` refuses to **delete the runtime
data** of a running version — note that `purge` only clears runtime/history data
and always leaves the install directory itself in place. Stop the cluster first.
If a process does end up orphaned (e.g. the directory was removed outside
c8ctl), `cluster stop` terminates it directly using the recorded PID.

When `cluster start` exits nonzero with surviving Camunda or connector processes,
the PID record also retains the failed startup outcome. `cluster status` reports
**`running after failed startup`**, even if the shared health endpoint responds:
that response does not establish readiness of every physical tenant. Review the
startup error or c8run logs, then run `c8ctl cluster stop` before retrying. The
original startup exit code is preserved. Stop clears the record once all recorded
processes are gone; a successful start replaces any stale failure metadata.
This also applies when c8run exits successfully but c8ctl's readiness check times
out: `cluster start` exits 1 and retains the failed startup outcome. Retrying
while processes survive without an active marker exits 1 without launching a new
instance or replacing the recovery record.

Without a known failed startup, live processes lacking an active marker are
reported as **`running (untracked)`**, with neutral recovery guidance. Both text
and JSON status include instructions to stop the surviving processes.

## How it works

1. **Download**: Automatically downloads the correct c8run binary for your platform from the Camunda Download Center
2. **Cache**: Stores downloaded binaries in a platform-specific cache directory
3. **Start**: Launches c8run in the background and waits for the cluster to become healthy
4. **Stop**: Gracefully shuts down the running cluster
5. **Status**: Reports whether a cluster is running by checking the active marker file, the durable PID record (`cluster.pids`), and the live health endpoint — so it still detects a cluster whose install directory was replaced or removed while running
6. **Logs**: Streams log output (camunda.log, connectors.log) from the running cluster using `tail -f`
7. **List**: Shows all locally cached versions and the current resolved values of available version aliases
8. **List-remote**: Queries the Camunda Download Center and displays all available versions
9. **Install**: Downloads a specific version without starting it, useful for pre-caching
10. **Delete**: Removes a locally cached version to reclaim disk space

### Cache locations

| Platform | Path |
|----------|------|
| macOS    | `~/Library/Caches/c8run/` |
| Linux    | `~/.cache/c8run/` |
| Windows  | `%LOCALAPPDATA%\c8run\cache\` |

Set `C8RUN_CACHE_DIR` environment variable to override.

### Download interruptions

The c8run archive is several hundred MB. If the connection drops, `c8ctl cluster start` and `c8ctl cluster install` retry up to three times and resume from where the download stopped when the server supports it. An attempt that receives no data for 60 seconds is aborted and retried. If the download still fails, the error names the cause and suggests what to try:

- Behind a proxy, set `HTTPS_PROXY` together with `NODE_USE_ENV_PROXY=1` (Node.js 22.21+ or 24.5+).
- Set `C8CTL_C8RUN_DOWNLOAD_URL` to download from a mirror with the same layout as the Camunda Download Center.
- Add `--verbose` to print HTTP details for each download attempt: request and response headers, timing, throughput, and the full error cause chain.

## Physical-tenant verification

The opt-in integration test owns the local cluster lifecycle and needs an installed c8run build with physical-tenant CLI support. Run it separately from the general integration suite, with no other cluster running and a dedicated cache containing that distribution:

```bash
C8RUN_CACHE_DIR=/path/to/scratch-cache \
C8CTL_PHYSICAL_TENANTS_VERSION=8.10.1 \
node --experimental-strip-types --test tests/integration/physical-tenants.test.ts
```

Set the version to the actual installed cache version. The test uses temporary tenant/secrets/profile files, validates authenticated profile routing and deployment isolation, restarts the cluster, and stops it on completion. Its tenant's engine data remains in the dedicated cache. The normal unit suite tests forwarding and failure handling without downloading or launching Java.

## Supported platforms

- macOS (x86_64, aarch64)
- Linux (x86_64, aarch64)
- Windows (x86_64)

## License

MIT
