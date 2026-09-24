---
name: Agentic Review Copilot
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
  - shared/agentic-report-review.md
  - shared/agentic-review.md
env:
  EXPECTED_KIND: review-copilot
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
    report-review:
      description: "Submit exactly one encoded ReviewReport; no GitHub writes"
      runs-on: ubuntu-latest
      if: always()
      permissions: {}
      inputs:
        report:
          description: "c8ctl-report-v1:gzip-base64: transport of ReviewReport JSON; at most 500000 characters"
          type: string
          required: true
      steps:
        - run: ":"
concurrency:
  cancel-in-progress: false
---

# Independent Copilot review

You are the Copilot reviewer. Independently evaluate this exact PR head/base.
Your evidence must not come from the Claude review.
