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

# Suppress the success line in scripts that key off exit codes
c8ctl bpmn lint --quiet process.bpmn
c8ctl bpmn lint -q process.bpmn

# Compose with other tools — apply a template, then lint the result
c8ctl element-template apply io.camunda.connectors.HttpJson.v2 ServiceTask_1 process.bpmn \
  | c8ctl bpmn lint
```

Exit code is `0` when there are no errors, `1` otherwise. Warnings do
not change the exit code.

## Output

A clean lint prints a bold green `✓ No issues found.` so you know the
linter actually ran. Pass `--quiet` / `-q` to suppress it.

When there are issues, they're rendered in an aligned table that mirrors
the upstream [bpmnlint](https://github.com/bpmn-io/bpmnlint) CLI:
element ID, severity, message, rule. `error` cells are colored red,
`warning` yellow, the file path is underlined, and the summary is bold
red (or yellow if there are only warnings). Color is auto-disabled when
stdout isn't a TTY, so `c8ctl bpmn lint … | tee log` produces clean text.

For machine-readable output, switch the session into JSON mode:

```bash
c8ctl output json
c8ctl bpmn lint process.bpmn
# → {"file":"…","issues":[…],"errorCount":3,"warningCount":0}
```

## Rule selection

1. If a `.bpmnlintrc` is present in the working directory, it's used
   verbatim — same behaviour as the standalone `bpmnlint` CLI.
   **Only JSON `.bpmnlintrc` is supported**; for YAML or JS configs,
   run the upstream `bpmnlint` CLI directly.
2. Otherwise, if the BPMN file has both
   `modeler:executionPlatform="Camunda Cloud"` and a
   `modeler:executionPlatformVersion`, the plugin picks the matching
   `camunda-cloud-X-Y` config from `bpmnlint-plugin-camunda-compat`.
   For example, a file with `executionPlatformVersion="8.7.0"` uses
   the `camunda-cloud-8-7` ruleset.
3. If `executionPlatformVersion` doesn't match any known
   `camunda-cloud-X-Y` config (e.g. a newer minor than this plugin
   ships), the highest available `camunda-cloud-*` config is used as
   a fallback.
4. If either attribute is missing (or `executionPlatform` is something
   other than `Camunda Cloud`), only `bpmnlint:recommended` rules run
   — no Camunda-specific rules are applied.

This means linting "just works" against the right rule set for the
target engine version, without any per-project configuration.