# Copilot Instructions

Read and follow the conventions in [DEVELOPMENT.md](../DEVELOPMENT.md) at the project root.

## Commit scope for review-comment fixes

When committing changes that address PR review comments, always use `chore:` — never `fix:`. The `fix:` scope triggers a patch release and CHANGELOG entry, which is incorrect for review iterations within a PR.

```
# Correct
chore: address review comments — use logger.json for dry-run

# Wrong
fix: address review comments — use logger.json for dry-run
```
