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

Examples:

feat(worker): add job worker concurrency gating
fix(retry): prevent double backoff application
chore(ci): stabilize deterministic publish (skip spec fetch)
docs: document deterministic build flag
refactor(auth): simplify token refresh jitter logic