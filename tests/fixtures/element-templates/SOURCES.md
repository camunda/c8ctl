# Element template fixtures

Real templates are copied unchanged from the c8ctl element template cache
(`templates.json`). Each carries `metadata.upstreamRef`, which names the
`camunda/connectors` commit `b361d7026764e3fd43aab49744eebb04e3ea3d9a` it came
from. Tests never fetch from the network.

| File | Template | Version | Origin |
| --- | --- | --- | --- |
| `http-json-connector-v10.json` | `io.camunda.connectors.HttpJson.v2` | 10 | `connectors/http/rest/element-templates/versioned/http-json-connector-10.json` |
| `http-json-connector-v12.json` | `io.camunda.connectors.HttpJson.v2` | 12 | `connectors/http/rest/element-templates/versioned/http-json-connector-12.json` |
| `http-json-connector-v17.json` | `io.camunda.connectors.HttpJson.v2` | 17 | `connectors/http/rest/element-templates/http-json-connector.json` |
| `aiagent-v1-v10.json` | `io.camunda.connectors.agenticai.aiagent.v1` | 10 | `connectors/agentic-ai/connector-agentic-ai/element-templates/versioned/agenticai-aiagent-outbound-connector-10.json` |
| `aiagent-v1-v11.json` | `io.camunda.connectors.agenticai.aiagent.v1` | 11 | `connectors/agentic-ai/connector-agentic-ai/element-templates/agenticai-aiagent-outbound-connector.json` |

The AI Agent v1 to v2 recipe fixtures are copied unchanged from
`camunda/connectors` commit `517d62d28c` (paths relative to
`connectors/agentic-ai/connector-agentic-ai/element-templates/`). They carry no
`metadata.upstreamRef`. These tests also use `aiagent-v1-v10.json` from above;
upstream changed only its keywords since.

| File | Template | Version | Origin |
| --- | --- | --- | --- |
| `aiagent-v1-v13.json` | `io.camunda.connectors.agenticai.aiagent.v1` | 13 | `agenticai-aiagent-outbound-connector.json` |
| `aiagent-jobworker-v1-v10.json` | `io.camunda.connectors.agenticai.aiagent.jobworker.v1` | 10 | `versioned/agenticai-aiagent-job-worker-10.json` |
| `aiagent-jobworker-v1-v13.json` | `io.camunda.connectors.agenticai.aiagent.jobworker.v1` | 13 | `agenticai-aiagent-job-worker.json` |
| `aiagent-v1-hybrid-v13.json` | `io.camunda.connectors.agenticai.aiagent.v1-hybrid` | 13 | `hybrid/agenticai-aiagent-outbound-connector-hybrid.json` |
| `aiagent-jobworker-v1-hybrid-v13.json` | `io.camunda.connectors.agenticai.aiagent.jobworker.v1-hybrid` | 13 | `hybrid/agenticai-aiagent-job-worker-hybrid.json` |
| `ai-agent-task-v2-v1.json` | `io.camunda.connectors.agenticai.ai-agent-task.v2` | 1 | `agenticai-ai-agent-task.v2.json` |
| `ai-agent-subprocess-v2-v1.json` | `io.camunda.connectors.agenticai.ai-agent-subprocess.v2` | 1 | `agenticai-ai-agent-subprocess.v2.json` |
| `ai-agent-task-v2-hybrid-v1.json` | `io.camunda.connectors.agenticai.ai-agent-task.v2-hybrid` | 1 | `hybrid/agenticai-ai-agent-task.v2-hybrid.json` |
| `ai-agent-subprocess-v2-hybrid-v1.json` | `io.camunda.connectors.agenticai.ai-agent-subprocess.v2-hybrid` | 1 | `hybrid/agenticai-ai-agent-subprocess.v2-hybrid.json` |

## Derived fixture

`aiagent-v2-derived.json` is not an upstream template. Upstream has no
`aiagent.v2` and no template that carries `metadata.migratesFrom`, so this file
is `aiagent-v1-v11.json` with:

- `id` changed to `io.camunda.connectors.agenticai.aiagent.v2` and `version` reset to 1,
- the `data.limits.maxModelCalls` binding renamed to `data.limits.maxCalls`,
- an authored `metadata.migratesFrom` recipe that moves the value between them.

It exists to exercise a cross-template migration with an embedded recipe on a
realistic template.
