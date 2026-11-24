---
jobs:
  publish_report:
    needs: [agent, detection, report_fitness]
    if: always() && github.ref == 'refs/heads/main' && vars.C8CTL_AUTOMATION_ENABLED == 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
    steps:
      - uses: actions/checkout@v7.0.1
        with:
          ref: ${{ github.sha }}
          path: .agentic-trusted
          persist-credentials: false
          sparse-checkout: scripts/agentic
      - uses: actions/setup-node@v7.0.0
        with:
          node-version: "22"
          package-manager-cache: false
      - uses: actions/download-artifact@v8.0.1
        id: agent_output
        continue-on-error: true
        with:
          name: agent
          path: ${{ runner.temp }}/report-input
      - uses: actions/download-artifact@v8.0.1
        if: steps.agent_output.outcome == 'failure'
        continue-on-error: true
        with:
          name: agent-output-fallback
          path: ${{ runner.temp }}/report-input
      - name: Publish a validated or explicitly blocked report
        env:
          TASK_JSON: ${{ inputs.task }}
          NEEDS_JSON: ${{ toJSON(needs) }}
          GH_AW_AGENT_OUTPUT: ${{ runner.temp }}/report-input/agent_output.json
          REPORT_OUT: ${{ runner.temp }}/report.json
        run: node .agentic-trusted/scripts/agentic/worker.ts publish
      - uses: actions/upload-artifact@v7.0.1
        with:
          name: worker-report-${{ fromJSON(inputs.task).correlation }}-${{ github.run_attempt }}
          path: ${{ runner.temp }}/report.json
          if-no-files-found: error
          retention-days: 7
---
