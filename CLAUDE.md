# Claude Code Instructions

Read and follow the conventions in DEVELOPMENT.md.

## Claude-specific notes

- use Edit/Write tools for file modifications instead of heredocs or shell redirects
- run `npm run build` before `npm test` — tests require compiled output
- check `.github/SDK_GAPS.md` before implementing SDK-dependent features
- consult CONTEXT.md for CLI structure, resource aliases, and agent flags
- consult EXAMPLES.md for command usage patterns
- consult PLUGIN-HELP.md when working on the plugin system
