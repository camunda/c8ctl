---
name: Agentic Implement
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
  - shared/agentic-report-change.md
  - shared/agentic-change.md
env:
  EXPECTED_KIND: implement
  EXPECTED_ENGINE: copilot
engine:
  id: copilot
  model: gpt-5.4
  max-continuations: 1
max-turns: 60
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
    report-change:
      description: "Submit exactly one encoded ChangeReport; no GitHub writes"
      runs-on: ubuntu-latest
      if: always()
      permissions: {}
      inputs:
        report:
          description: "c8ctl-report-v1:gzip-base64: transport of ChangeReport JSON; at most 500000 characters"
          type: string
          required: true
      steps:
        - run: ":"
concurrency:
  cancel-in-progress: false
---

# Initial implementation

Implement the issue's accepted criteria on the reserved main revision. The task
number identifies the issue, not a PR. Choose a Conventional Commit title that
accurately describes the change (`fix` for a bug, `feat` for additive behavior).
Return the tested full-file proposal; the coordinator owns branch and PR creation.
