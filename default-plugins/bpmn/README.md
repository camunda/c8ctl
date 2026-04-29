# c8ctl-plugin-bpmn

A default [c8ctl](https://github.com/camunda/c8ctl) plugin for linting
BPMN diagrams against [bpmnlint](https://github.com/bpmn-io/bpmnlint)'s
recommended rules plus
[bpmnlint-plugin-camunda-compat](https://github.com/camunda/bpmnlint-plugin-camunda-compat)'s
engine-version-specific rules.

## Usage

```bash
# Lint a file
c8ctl bpmn lint process.bpmn

# Lint from stdin (useful in pipelines)
cat process.bpmn | c8ctl bpmn lint

# Compose with other tools — apply a template, then lint the result
c8ctl element-template apply io.camunda.connectors.HttpJson.v2 ServiceTask_1 process.bpmn \
  | c8ctl bpmn lint

# JSON output for scripts/agents
c8ctl --output json bpmn lint process.bpmn
```

Exit code is `0` when there are no errors, `1` otherwise. Warnings do
not change the exit code.

## Rule selection

1. If a `.bpmnlintrc` is present in the working directory, it's used
   verbatim — same behaviour as the standalone `bpmnlint` CLI.
2. Otherwise the plugin reads `modeler:executionPlatformVersion` from
   the BPMN file and picks the matching `camunda-cloud-X-Y` config from
   `bpmnlint-plugin-camunda-compat`. For example, a file with
   `executionPlatformVersion="8.7.0"` uses the `camunda-cloud-8-7`
   ruleset.
3. If the file has no version attribute, the latest available
   `camunda-cloud-*` config is used.

This means linting "just works" against the right rule set for the
target engine version, without any per-project configuration.