# c8ctl-plugin-top

Interactive process-instance monitor for [c8ctl](https://github.com/camunda/c8ctl) — like **htop** for Camunda 8.

## Overview

`c8 top` provides a live, full-screen terminal view of running Camunda 8 process instances. Navigate the list with the keyboard and press **Enter** to drill into the full details of any selected instance — including its variables.

## Usage

```bash
# Show active process instances (default)
c8 top

# Show all process instances (all states)
c8 top --all

# Set auto-refresh interval (seconds, default: 5)
c8 top --refresh=10

# Use a specific c8ctl profile
c8 top --profile=staging
```

## Keyboard Shortcuts

### List view

| Key            | Action                             |
|----------------|------------------------------------|
| ↑ / ↓          | Move selection up / down           |
| k / j          | Vim-style move up / down           |
| Page Up/Down   | Move selection by one page         |
| Home / End     | Jump to first / last instance      |
| Enter          | Open detail view                   |
| r              | Refresh now                        |
| q / Ctrl+C     | Quit                               |

### Detail view

| Key            | Action                             |
|----------------|------------------------------------|
| q / Escape     | Back to list                       |
| r              | Refresh detail                     |
| Ctrl+C         | Quit                               |

## Column Reference

| Column       | Description                                      |
|--------------|--------------------------------------------------|
| `#`          | Row number                                       |
| `Key`        | Process instance key (unique identifier)         |
| `Process ID` | BPMN process definition ID                       |
| `State`      | Instance state (`ACTIVE`, `COMPLETED`, …)        |
| `Ver`        | Process definition version                       |
| `Start Date` | When the instance was started (UTC)              |
| `⚠`          | Indicates the instance has an active incident    |

## Detail View

When you press **Enter** on a selected instance the plugin fetches:

- All core metadata (key, state, tenant, start/end date, …)
- All process variables (with truncation for long values)

## Implementation Notes

This plugin is **bundled with c8ctl** as a default plugin and requires **no separate installation**.

It is implemented as a pure Node.js ESM module with no external dependencies:
- Terminal UI uses ANSI escape codes written directly to `stdout`
- Keyboard input is handled via Node.js's built-in `readline.emitKeypressEvents()`
- Process instances are fetched from the Camunda 8 REST API via the c8ctl runtime client

## Limitations

- The list view fetches up to **500 process instances** per refresh. For environments with more than 500 active instances the list will be truncated; use the `search pi` command with pagination for full result sets.

## Requirements

- c8ctl v2.x or later
- An interactive terminal (TTY) — does **not** work when piped
- A configured c8ctl profile pointing at a running Camunda 8 cluster
