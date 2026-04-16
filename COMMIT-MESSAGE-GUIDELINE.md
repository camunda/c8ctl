# Commit Message Guidelines

We use Conventional Commits.

Format:

<type>(optional scope): <subject>

<body>

BREAKING CHANGE: <explanation>
Allowed type values (common set):

feat
fix
chore
docs
style
refactor
test
ci
build
perf
Rules:

Subject length: 5–100 characters (commitlint enforces subject-min-length & subject-max-length).
Use imperative mood ("add support", not "added support").
Lowercase subject (except proper nouns). No PascalCase subjects (rule enforced).
Keep subject concise; body can include details, rationale, links.
Prefix breaking changes with BREAKING CHANGE: either in body or footer.

### Review-comment fix-ups

Commits that address PR review comments must use `chore:`, **not** `fix:`.
`fix:` triggers a patch release and a CHANGELOG entry — review iterations are not user-facing bug fixes.

```
# Correct
chore: address review comments — use logger.json for dry-run

# Wrong — will pollute the CHANGELOG
fix: address review comments — use logger.json for dry-run
```

Examples:

feat(worker): add job worker concurrency gating
fix(retry): prevent double backoff application
chore(ci): stabilize deterministic publish (skip spec fetch)
chore: address review comments — NUL-safe pre-commit hook
docs: document deterministic build flag
refactor(auth): simplify token refresh jitter logic