---
name: Agentic Fitness
run-name: c8ctl-${{ fromJSON(inputs.task).correlation }}
on:
  workflow_dispatch:
    inputs:
      task:
        type: string
        required: true
  roles: all
if: github.ref == 'refs/heads/main' && vars.C8CTL_AUTOMATION_ENABLED == 'true' && github.actor == vars.C8CTL_APP_BOT_LOGIN && github.run_attempt == 1
permissions:
  contents: read
  issues: read
  pull-requests: read
imports:
  - shared/agentic-common.md
  - shared/agentic-report-fitness.md
env:
  EXPECTED_KIND: fitness
  EXPECTED_ENGINE: copilot
engine:
  id: copilot
  model: gpt-5.4
  max-continuations: 1
max-turns: 30
timeout-minutes: 30
max-ai-credits: 100
features:
  group-concurrency-queue: false
sandbox:
  agent:
    model-fallback: false
    token-steering: false
safe-outputs:
  github-token: ${{ secrets.GITHUB_TOKEN }}
  missing-tool: false
  missing-data: false
  report-failed-jobs: false
  report-failure-as-issue: false
  report-incomplete:
    create-issue: false
  threat-detection:
    max-ai-credits: 25
  jobs:
    report-fitness:
      description: "Submit exactly one encoded FitnessReport; no GitHub writes"
      runs-on: ubuntu-latest
      if: always()
      permissions: {}
      inputs:
        report:
          description: "c8ctl-report-v1:gzip-base64: transport of FitnessReport JSON; at most 500000 characters"
          type: string
          required: true
      steps:
        - run: ":"
concurrency:
  cancel-in-progress: false
---

# Fitness assessment

Assess the issue at the reserved main revision before implementation. Read its
acceptance criteria, existing implementation, tests, relevant docs and known SDK
gaps. Check open PRs for overlapping work. Do not change files. Distinguish
`ready`, `already_implemented`, `needs_spec`, `in_progress`, and `blocked`.
Readiness requires concrete testable acceptance criteria and a bounded change
inside the implementation allowlist. Missing credentials/context or an upstream
dependency defect is blocked; unclear requirements need specification.

Map each acceptance criterion to intended unit and, where applicable, existing
or proposed integration coverage. The absence of live integration in the worker is not a readiness blocker:
build/typecheck/unit validation belongs to the worker, and required Test CI owns
live-Camunda integration and cross-platform checks after a trusted commit.
Do not run full `npm test` as a fitness baseline or mark unavailable integration
green. A criterion requiring protected controls, an unavailable dependency, or
unclear intended behavior still needs specification or an explicit blocker.

Call `report_fitness` exactly once using the shared byte-preserving transport.
The decoded report has this JSON shape:

```json
{"schema_version":1,"decision":"ready","criteria":["Concrete acceptance criterion."],"evidence":"Relevant files, tests and open PRs examined.","blockers":[],"related_prs":[]}
```

Use at least one criterion, positive PR numbers only, at most 50 entries per
array, 2000 characters per criterion, 4000 per blocker, and 12000 evidence
characters. A ready report has no blockers. Never invent implementation evidence.
