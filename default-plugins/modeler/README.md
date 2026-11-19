# c8ctl-plugin-modeler

Default c8ctl plugin that installs Camunda Desktop Modeler.

## Commands

- `c8ctl modeler install` — install the latest stable Desktop Modeler on
  macOS (Homebrew or the Camunda-signed release into `/Applications`),
  Windows (winget), or Linux (x64, into `/usr/bin` via sudo). Skips the
  installation when Modeler is already installed.

Supports the global `--dry-run`, `--json`, `--quiet`, and `--verbose` flags.
