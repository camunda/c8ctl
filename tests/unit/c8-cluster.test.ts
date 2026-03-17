import assert from 'node:assert';
import { describe, test } from 'node:test';
import { extractStartupSummary } from '../../src/commands/c8-cluster.ts';

describe('extractStartupSummary', () => {
  test('extracts the 8.9 startup section verbatim', () => {
    const rawOutput = `noise before
- Operate:                http://localhost:8080/operate
- Tasklist:               http://localhost:8080/tasklist
- Admin:                  http://localhost:8080/admin

Login with:
- Username: demo
- Password: demo

API endpoints:
- Orchestration Cluster API:  http://localhost:8080/v2/
- Inbound Connectors API:     http://localhost:8086/
- Zeebe API (gRPC):           http://localhost:26500
- Camunda metrics:            http://localhost:9600/actuator/prometheus

MCP servers:
- Orchestration Cluster:      http://localhost:8080/mcp/cluster

Note: When using the Desktop Modeler, Authentication may be set to None.

Next steps:
1. Model and deploy a process with Desktop Modeler -> Cluster endpoint: http://localhost:8080/v2/
2. View your process in Operate
3. Run a job worker via Java/Node SDK
4. Build your first AI agent
5. Connect any AI agent to the Orchestration API MCP Server and chat with your processes

Need guidance?
- Quickstart:       https://docs.camunda.io/docs/next/guides/getting-started-example/
- Java developers:  https://docs.camunda.io/docs/guides/getting-started-java-spring/
- Build an agent:   https://docs.camunda.io/docs/next/guides/getting-started-agentic-orchestration/

Run \`./c8run help\` to see available commands and options.
noise after`;

    const summary = extractStartupSummary(rawOutput);

    assert.ok(summary);
    assert.strictEqual(summary?.startsWith('- Operate:                http://localhost:8080/operate'), true);
    assert.strictEqual(summary?.endsWith('Run `./c8run help` to see available commands and options.'), true);
    assert.strictEqual(summary?.includes('noise before'), false);
    assert.strictEqual(summary?.includes('noise after'), false);
  });

  test('extracts the 8.8 startup section verbatim', () => {
    const rawOutput = `noise before
Access each component at the following urls with these default credentials:
- username: demo
- password: demo

Operate:                    http://localhost:8080/operate
Tasklist:                   http://localhost:8080/tasklist
Identity:                   http://localhost:8080/identity

Orchestration Cluster API:  http://localhost:8080/v2/
Inbound Connectors API:     http://localhost:8086/
Zeebe API (gRPC):           http://localhost:26500/

Camunda metrics endpoint:   http://localhost:9600/actuator/prometheus

When using the Desktop Modeler, Authentication may be set to None.

Refer to https://docs.camunda.io/docs/guides/getting-started-java-spring/ for help getting started with Camunda
noise after`;

    const summary = extractStartupSummary(rawOutput);

    assert.ok(summary);
    assert.strictEqual(
      summary?.startsWith('Access each component at the following urls with these default credentials:'),
      true,
    );
    assert.strictEqual(
      summary?.endsWith('Refer to https://docs.camunda.io/docs/guides/getting-started-java-spring/ for help getting started with Camunda'),
      true,
    );
    assert.strictEqual(summary?.includes('noise before'), false);
    assert.strictEqual(summary?.includes('noise after'), false);
  });

  test('returns null when no known startup section is present', () => {
    assert.strictEqual(extractStartupSummary('just some logs'), null);
  });
});