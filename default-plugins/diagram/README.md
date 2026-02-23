# c8ctl-plugin-diagram

A default c8ctl plugin that renders BPMN process instance diagrams as PNG images with execution state highlighting.

## Features

- Renders BPMN diagrams for process instances
- Highlights completed elements (blue), active elements (blue/green), and incident elements (red)
- Shows taken sequence flows in blue
- Outputs inline to terminal (Kitty, iTerm2, WezTerm, Sixel) or saves as PNG file
- Uses system-installed Chrome/Chromium via puppeteer-core (no bundled browser)

## Usage

```bash
# Display diagram inline in supported terminals
c8ctl diagram <processInstanceKey>

# Save diagram to a PNG file
c8ctl diagram <processInstanceKey> --output ./diagram.png

# Use a specific profile
c8ctl diagram <processInstanceKey> --profile myprofile
```

## Requirements

- Google Chrome or Chromium must be installed on the system
- Download: https://www.google.com/chrome/

## Terminal Support for Inline Display

| Terminal | Protocol |
|----------|----------|
| Ghostty, Kitty | Kitty Graphics Protocol |
| WezTerm, Konsole | Kitty Graphics Protocol |
| iTerm2 | iTerm2 Inline Images Protocol |
| VS Code terminal | iTerm2 Inline Images Protocol |
| mintty | Sixel |
| xterm | Sixel |
| Others | iTerm2 fallback |

## Carving Out as Standalone Plugin

This plugin is designed to be extractable into a standalone npm package.
To use it as a standalone plugin:

1. Copy this directory to a new repository
2. Add the required dependencies to `package.json`:
   - `puppeteer-core`
   - `bpmn-js`
   - `pngjs`
   - `sixel`
   - `supports-terminal-graphics`
   - `@camunda8/orchestration-cluster-api`
3. Update the asset path resolution for the new package structure
4. Publish to npm with the `c8ctl-plugin` keyword
