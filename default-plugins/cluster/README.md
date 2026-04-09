# c8ctl-plugin-cluster

A default [c8ctl](https://github.com/camunda/c8ctl) plugin that provides an opinionated way to download, start, and stop a local Camunda 8 cluster using [c8run](https://docs.camunda.io/docs/self-managed/setup/deploy/local/c8run/).

## Usage

```bash
# Start with a specific version
c8ctl cluster start 8.9.0-alpha5

# Start using a version alias
c8ctl cluster start stable
c8ctl cluster start alpha

# Starting without specifying a version defaults to alpha
c8ctl cluster start

# Start with debug output (streams raw c8run logs)
c8ctl cluster start --debug

# Stop the running cluster
c8ctl cluster stop
```

## How it works

1. **Download**: Automatically downloads the correct c8run binary for your platform from the Camunda Download Center
2. **Cache**: Stores downloaded binaries in a platform-specific cache directory
3. **Start**: Launches c8run in the background and waits for the cluster to become healthy
4. **Stop**: Gracefully shuts down the running cluster

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
