/**
 * Integration tests for search commands
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 *
 * These tests validate the project's wrapper functions in src/commands/search.ts,
 * not the underlying @camunda8/orchestration-cluster-api npm module directly.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { deploy } from '../../src/commands/deployments.ts';
import { createProcessInstance } from '../../src/commands/process-instances.ts';
import { failJob } from '../../src/commands/jobs.ts';
import {
  searchProcessDefinitions,
  searchProcessInstances,
  searchUserTasks,
  searchIncidents,
  searchJobs,
  searchVariables,
} from '../../src/commands/search.ts';
import { pollUntil } from '../utils/polling.ts';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getUserDataDir } from '../../src/config.ts';

// Polling configuration for Elasticsearch consistency
const POLL_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 1000;

describe('Search Command Integration Tests (requires Camunda 8 at localhost:8080)', () => {
  beforeEach(() => {
    // Clear session state before each test to ensure clean tenant resolution
    const sessionPath = join(getUserDataDir(), 'session.json');
    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath);
    }
  });

  test('search process definitions by processDefinitionId', async () => {
    // Deploy a process to ensure at least one exists
    await deploy(['tests/fixtures/simple.bpmn'], {});

    // Poll until the search command finds the deployed process definition
    const found = await pollUntil(async () => {
      const result = await searchProcessDefinitions({
        processDefinitionId: 'simple-process',
      });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search should find the deployed process definition');
  });

  test('search process definitions with filters', async () => {
    // Deploy a process
    await deploy(['tests/fixtures/simple.bpmn'], {});

    // Poll until the process definition is indexed and extract its key
    let processDefKey: string | undefined;
    const found = await pollUntil(async () => {
      const result = await searchProcessDefinitions({
        processDefinitionId: 'simple-process',
      });
      if (result?.items && result.items.length > 0) {
        const item = result.items[0] as any;
        processDefKey = (item.processDefinitionKey || item.key)?.toString();
        return processDefKey !== undefined;
      }
      return false;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Should find the deployed process');
    assert.ok(processDefKey, 'Should have process definition key');

    // Search by key using the command function
    const result = await searchProcessDefinitions({ key: processDefKey });
    assert.ok(result?.items && result.items.length > 0, 'Search by key should find the process');
  });

  test('search process instances by state', async () => {
    // Deploy and create an instance using CLI wrappers
    await deploy(['tests/fixtures/simple.bpmn'], {});
    await createProcessInstance({
      processDefinitionId: 'simple-process',
    });

    // Poll until completed process instances appear in search results
    const found = await pollUntil(async () => {
      const result = await searchProcessInstances({
        processDefinitionId: 'simple-process',
        state: 'COMPLETED',
      });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search should find completed process instances');
  });

  test('search process instances by processDefinitionKey', async () => {
    // Deploy a process
    await deploy(['tests/fixtures/simple.bpmn'], {});

    // Poll until process definition is indexed and extract its key
    let processDefKey: string | undefined;
    const indexed = await pollUntil(async () => {
      const result = await searchProcessDefinitions({
        processDefinitionId: 'simple-process',
      });
      if (result?.items && result.items.length > 0) {
        const item = result.items[0] as any;
        processDefKey = (item.processDefinitionKey || item.key)?.toString();
        return processDefKey !== undefined;
      }
      return false;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(indexed, 'Should find the deployed process');
    assert.ok(processDefKey, 'Should have process definition key');

    // Create an instance using CLI wrapper
    await createProcessInstance({
      processDefinitionId: 'simple-process',
    });

    // Poll until search by processDefinitionKey finds results
    const found = await pollUntil(async () => {
      const result = await searchProcessInstances({
        processDefinitionKey: processDefKey,
      });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search by processDefinitionKey should find process instances');
  });

  test('search user tasks with filters', async () => {
    // Deploy a process with a user task
    await deploy(['tests/fixtures/list-pis'], {});

    // Create an instance to generate a user task
    await createProcessInstance({
      processDefinitionId: 'Process_0t60ay7',
    });

    // Poll until the user task appears in search results
    const found = await pollUntil(async () => {
      const result = await searchUserTasks({
        state: 'CREATED',
      });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search should find created user tasks');
  });

  test('search incidents with filters', async () => {
    // Deploy a process with a service task that will create a job
    await deploy(['tests/fixtures/simple-will-create-incident.bpmn'], {});

    // Create an instance — the service task creates a job with type 'unhandled-job-type' and retries=0
    await createProcessInstance({
      processDefinitionId: 'Process_0yyrstd',
    });

    // Wait for the job to appear in search results
    let jobKey: string | undefined;
    const jobFound = await pollUntil(async () => {
      const result = await searchJobs({ type: 'unhandled-job-type', state: 'CREATED' });
      if (result?.items && result.items.length > 0) {
        const createdJob = result.items.find((job: any) => (job.state || '').toUpperCase() === 'CREATED') as any;
        if (!createdJob) {
          return false;
        }
        jobKey = String(createdJob.jobKey || createdJob.key);
        return true;
      }
      return false;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(jobFound && jobKey, 'Job should appear before failing it');

    // Explicitly fail the job with retries=0 to trigger an incident
    await failJob(jobKey, { retries: 0, errorMessage: 'Intentional failure for incident test' });

    // Poll until the incident appears in search results
    const found = await pollUntil(async () => {
      const result = await searchIncidents({
        state: 'ACTIVE',
      });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search should find active incidents');
  });

  test('search jobs with filters', async () => {
    // Deploy a process with a service task (job)
    await deploy(['tests/fixtures/simple-service-task.bpmn'], {});

    // Create an instance to generate jobs
    await createProcessInstance({
      processDefinitionId: 'Process_18glkb3',
    });

    // Poll until the job appears in search results
    const found = await pollUntil(async () => {
      const result = await searchJobs({
        type: 'n00b',
        state: 'CREATED',
      });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search should find created jobs');
  });

  test('search variables with filters', async () => {
    // Deploy a process and create an instance with variables
    await deploy(['tests/fixtures/simple.bpmn'], {});

    // Create an instance with variables using the CLI wrapper
    await createProcessInstance({
      processDefinitionId: 'simple-process',
      variables: JSON.stringify({ testVar: 'testValue', count: 42, flag: true }),
    });

    // Poll until the variable appears in search results
    const found = await pollUntil(async () => {
      const result = await searchVariables({
        name: 'testVar',
      });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search should find variable by name');
  });

  test('search variables with fullValue option', async () => {
    // Deploy a process and create an instance with a long variable value
    await deploy(['tests/fixtures/simple.bpmn'], {});

    const longValue = 'a'.repeat(1000); // Create a long value that might be truncated

    await createProcessInstance({
      processDefinitionId: 'simple-process',
      variables: JSON.stringify({ longVar: longValue }),
    });

    // Poll until the variable appears in search results with full value
    const found = await pollUntil(async () => {
      const result = await searchVariables({
        name: 'longVar',
        fullValue: true,
      });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search with fullValue should find the variable');
  });

  // ── Wildcard Search Tests ──────────────────────────────────────────

  test('wildcard * on process definition name matches multiple results', async () => {
    // Deploy processes that have names set in BPMN
    await deploy(['tests/fixtures/sample-project/main.bpmn'], {});
    await deploy(['tests/fixtures/sample-project/sub-folder/sub.bpmn'], {});

    // Wildcard *Process should match "Main Process" and "Sub Process"
    const found = await pollUntil(async () => {
      const result = await searchProcessDefinitions({
        name: '*Process',
      });
      return !!(result?.items && result.items.length >= 2);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Wildcard --name="*Process" should match named process definitions');
  });

  test('wildcard ? on process definition ID matches single character', async () => {
    // Deploy both main.bpmn and sub.bpmn
    await deploy(['tests/fixtures/sample-project/main.bpmn'], {});
    await deploy(['tests/fixtures/sample-project/sub-folder/sub.bpmn'], {});

    // "ma??-process" should match "main-process" but NOT "sub-process"
    const found = await pollUntil(async () => {
      const result = await searchProcessDefinitions({
        processDefinitionId: 'ma??-process',
      });
      if (!result?.items || result.items.length === 0) return false;
      // Verify only main-process matched
      return result.items.every((pd: any) => pd.processDefinitionId === 'main-process');
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Wildcard --id="ma??-process" should match only main-process');
  });

  test('wildcard * on process definition ID matches multiple processes', async () => {
    await deploy(['tests/fixtures/sample-project/main.bpmn'], {});
    await deploy(['tests/fixtures/sample-project/sub-folder/sub.bpmn'], {});

    // "*-process" should match both main-process and sub-process (and possibly simple-process)
    const found = await pollUntil(async () => {
      const result = await searchProcessDefinitions({
        processDefinitionId: '*-process',
      });
      return !!(result?.items && result.items.length >= 2);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Wildcard --id="*-process" should match multiple process definitions');
  });

  test('wildcard * on variable name matches deployed variables', async () => {
    await deploy(['tests/fixtures/simple.bpmn'], {});
    await createProcessInstance({
      processDefinitionId: 'simple-process',
      variables: JSON.stringify({ wildcardTestAlpha: 'a', wildcardTestBeta: 'b' }),
    });

    // "wildcardTest*" should match both variables
    const found = await pollUntil(async () => {
      const result = await searchVariables({
        name: 'wildcardTest*',
      });
      return !!(result?.items && result.items.length >= 2);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Wildcard --name="wildcardTest*" should match multiple variables');
  });

  test('wildcard * on job type matches jobs', async () => {
    await deploy(['tests/fixtures/simple-service-task.bpmn'], {});
    await createProcessInstance({
      processDefinitionId: 'Process_18glkb3',
    });

    // "n*" should match job type "n00b"
    const found = await pollUntil(async () => {
      const result = await searchJobs({
        type: 'n*',
      });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Wildcard --type="n*" should match job type "n00b"');
  });

  test('wildcard ? on job type requires exact character count', async () => {
    await deploy(['tests/fixtures/simple-service-task.bpmn'], {});
    await createProcessInstance({
      processDefinitionId: 'Process_18glkb3',
    });

    // Wait for the job to be indexed first
    const indexed = await pollUntil(async () => {
      const result = await searchJobs({ type: 'n00b' });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(indexed, 'Job should be indexed');

    // "n?b" should NOT match "n00b" (too few ? chars)
    const result = await searchJobs({ type: 'n?b' });
    assert.ok(!result?.items || result.items.length === 0, 'Wildcard "n?b" should not match "n00b" (needs 2 chars)');

    // "n??b" SHOULD match "n00b"
    const result2 = await searchJobs({ type: 'n??b' });
    assert.ok(result2?.items && result2.items.length > 0, 'Wildcard "n??b" should match "n00b"');
  });

  // ── Case-Insensitive Search Tests ──────────────────────────────────

  test('case-insensitive search on process definition name', async () => {
    await deploy(['tests/fixtures/sample-project/main.bpmn'], {});

    // Wait for indexing with exact name first
    const indexed = await pollUntil(async () => {
      const result = await searchProcessDefinitions({
        processDefinitionId: 'main-process',
      });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(indexed, 'Process should be indexed');

    // --iName='main process' should match "Main Process" (different case)
    const result = await searchProcessDefinitions({
      iName: 'main process',
    });
    assert.ok(result?.items && result.items.length > 0, '--iName="main process" should match "Main Process"');
    assert.strictEqual((result!.items[0] as any).processDefinitionId, 'main-process');
  });

  test('case-insensitive search on process definition name with ALL CAPS', async () => {
    await deploy(['tests/fixtures/sample-project/main.bpmn'], {});

    const indexed = await pollUntil(async () => {
      const result = await searchProcessDefinitions({
        processDefinitionId: 'main-process',
      });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(indexed, 'Process should be indexed');

    // --iName='MAIN PROCESS' should match "Main Process"
    const result = await searchProcessDefinitions({
      iName: 'MAIN PROCESS',
    });
    assert.ok(result?.items && result.items.length > 0, '--iName="MAIN PROCESS" should match "Main Process"');
  });

  test('case-insensitive wildcard search on process definition name', async () => {
    await deploy(['tests/fixtures/sample-project/main.bpmn'], {});
    await deploy(['tests/fixtures/sample-project/sub-folder/sub.bpmn'], {});

    // Wait for both to be indexed
    const indexed = await pollUntil(async () => {
      const r1 = await searchProcessDefinitions({ processDefinitionId: 'main-process' });
      const r2 = await searchProcessDefinitions({ processDefinitionId: 'sub-process' });
      return !!(r1?.items?.length && r2?.items?.length);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(indexed, 'Both processes should be indexed');

    // --iName='*PROCESS' should match "Main Process" and "Sub Process" (case-insensitive)
    const result = await searchProcessDefinitions({
      iName: '*PROCESS',
    });
    assert.ok(result?.items && result.items.length >= 2,
      '--iName="*PROCESS" should match multiple named process definitions');
  });

  test('case-insensitive search on process definition ID', async () => {
    await deploy(['tests/fixtures/sample-project/main.bpmn'], {});

    const indexed = await pollUntil(async () => {
      const result = await searchProcessDefinitions({ processDefinitionId: 'main-process' });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(indexed, 'Process should be indexed');

    // --iProcessDefinitionId='MAIN-PROCESS' should match "main-process"
    const result = await searchProcessDefinitions({
      iProcessDefinitionId: 'MAIN-PROCESS',
    });
    assert.ok(result?.items && result.items.length > 0,
      '--iProcessDefinitionId="MAIN-PROCESS" should match "main-process"');
  });

  test('case-insensitive search on variable name', async () => {
    await deploy(['tests/fixtures/simple.bpmn'], {});
    await createProcessInstance({
      processDefinitionId: 'simple-process',
      variables: JSON.stringify({ CamelCaseVar: 'hello' }),
    });

    // Wait for the variable to be indexed
    const indexed = await pollUntil(async () => {
      const result = await searchVariables({ name: 'CamelCaseVar' });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(indexed, 'Variable should be indexed');

    // --iName='camelcasevar' should match "CamelCaseVar"
    const result = await searchVariables({
      iName: 'camelcasevar',
    });
    assert.ok(result?.items && result.items.length > 0,
      '--iName="camelcasevar" should match "CamelCaseVar"');
  });

  test('case-insensitive search on variable value', async () => {
    await deploy(['tests/fixtures/simple.bpmn'], {});
    await createProcessInstance({
      processDefinitionId: 'simple-process',
      variables: JSON.stringify({ statusVar: 'PendingReview' }),
    });

    // Wait for the variable to be indexed
    const indexed = await pollUntil(async () => {
      const result = await searchVariables({ name: 'statusVar' });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(indexed, 'Variable should be indexed');

    // --iValue='pendingreview' should match "PendingReview"
    const result = await searchVariables({
      iValue: 'pendingreview',
    });
    assert.ok(result?.items && result.items.length > 0,
      '--iValue="pendingreview" should match "PendingReview"');
  });

  test('case-insensitive search on job type', async () => {
    await deploy(['tests/fixtures/simple-service-task.bpmn'], {});
    await createProcessInstance({
      processDefinitionId: 'Process_18glkb3',
    });

    // Wait for the job to be indexed
    const indexed = await pollUntil(async () => {
      const result = await searchJobs({ type: 'n00b' });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(indexed, 'Job should be indexed');

    // --iType='N00B' should match "n00b"
    const result = await searchJobs({
      iType: 'N00B',
    });
    assert.ok(result?.items && result.items.length > 0,
      '--iType="N00B" should match job type "n00b"');
  });

  test('case-insensitive search does not match non-matching pattern', async () => {
    await deploy(['tests/fixtures/sample-project/main.bpmn'], {});

    const indexed = await pollUntil(async () => {
      const result = await searchProcessDefinitions({ processDefinitionId: 'main-process' });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(indexed, 'Process should be indexed');

    // --iName='nonexistent' should return no results
    const result = await searchProcessDefinitions({
      iName: 'nonexistent-process-name',
    });
    assert.ok(!result?.items || result.items.length === 0,
      '--iName="nonexistent-process-name" should return no results');
  });
});
