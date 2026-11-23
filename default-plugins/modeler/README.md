# c8ctl-plugin-modeler

Default c8ctl plugin that manages Camunda Desktop Modeler.

## Commands

- `c8ctl modeler install` — install the latest stable Desktop Modeler on
  macOS (Homebrew or the Camunda-signed release into `/Applications`),
  Windows (winget), or Linux (x64, into `/usr/bin` via sudo). Skips the
  installation when Modeler is already installed, and warns when a newer
  release is available.
- `c8ctl modeler update` — update through Homebrew, winget, or the direct
  release installation method. Reports when the installation is already up to
  date.
- `c8ctl modeler remove` — uninstall through the matching package manager or
  remove the direct app/release installation. Linux file-type registrations
  are removed with Modeler's bundled XDG unregister script. Unmanaged
  installations are left untouched: direct macOS bundles in `/Applications` or
  `~/Applications` must be signed by Camunda, Windows installs must be managed by
  winget, and Linux installs must use c8ctl's versioned `/usr/bin` link.

Supports the global `--dry-run`, `--json`, `--quiet`, and `--verbose` flags.
