# c8ctl-plugin-cluster

A default [c8ctl](https://github.com/camunda/c8ctl) plugin that provides an opinionated way to download, start, stop, and inspect a local Camunda 8 cluster using [c8run](https://docs.camunda.io/docs/self-managed/setup/deploy/local/c8run/).

## Usage

```bash
# Start with a specific version
c8ctl cluster start 8.9.0-alpha5

# Start using a version alias (dynamically resolved)
c8ctl cluster start stable
c8ctl cluster start alpha

# Start with a major.minor version (rolling release)
c8ctl cluster start 8.8

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

## Version aliases

The `stable` and `alpha` aliases are resolved dynamically by querying the
[Camunda Download Center](https://downloads.camunda.cloud/release/camunda/c8run/).
This means you always get the latest available version without waiting for a
plugin update.

| Alias    | Resolves to |
|----------|-------------|
| `stable` | Highest minor release that is GA (e.g. `8.8`) |
| `alpha`  | Highest minor release overall (e.g. `8.9`) |

A `<major>.<minor>` version like `8.8` or `8.9` is also treated as a rolling
release — the download server's `8.8/` directory is updated in-place with new
patch releases.

### `start` vs `install` update behavior

- **`start`** uses the local version if available. A non-blocking remote check runs in the background — if a newer rolling release exists, a hint is printed (e.g. *"A newer server version is available. Install it with: c8ctl cluster install 8.8"*). If the network is unreachable, the hint is silently skipped.
- **`install`** always checks the remote for a newer rolling release (via ETag comparison) and re-downloads if one is available.

If the download server is unreachable, the aliases fall back to the values
shipped in the plugin's `package.json`.

## How it works

1. **Download**: Automatically downloads the correct c8run binary for your platform from the Camunda Download Center
2. **Cache**: Stores downloaded binaries in a platform-specific cache directory
3. **Start**: Launches c8run in the background and waits for the cluster to become healthy
4. **Stop**: Gracefully shuts down the running cluster
5. **Status**: Reports whether a cluster is running by checking the active marker file and the live health endpoint
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

## Supported platforms

- macOS (x86_64, aarch64)
- Linux (x86_64, aarch64)
- Windows (x86_64)

## License

MIT
