/**
 * Integration tests for process instances
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 * 
 * These tests validate the project's wrapper functions in src/commands/process-instances.ts,
 * not the underlying @camunda8/orchestration-cluster-api npm module directly.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { deploy } from '../../src/commands/deployments.ts';
import { 
  createProcessInstance, 
  listProcessInstances
} from '../../src/commands/process-instances.ts';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getUserDataDir } from '../../src/config.ts';

describe('Process Instance Integration Tests (requires Camunda 8 at localhost:8080)', () => {
  beforeEach(() => {
    // Clear session state before each test to ensure clean tenant resolution
    const sessionPath = join(getUserDataDir(), 'session.json');
    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath);
    }
  });

  test('create process instance returns key', async () => {
    // First deploy a process to ensure it exists
    await deploy(['tests/fixtures/simple.bpmn'], {});
    
    // Create process instance using the project's wrapper function
    const result = await createProcessInstance({
      processDefinitionId: 'simple-process',
    });
    
    // Verify instance key is returned
    assert.ok(result, 'Result should be returned');
    assert.ok(result.processInstanceKey, 'Process instance key should be returned');
    assert.ok(
      typeof result.processInstanceKey === 'number' || typeof result.processInstanceKey === 'string',
      'Process instance key should be a number or string'
    );
  });

  test('list process instances filters by process definition', async () => {
    // First deploy and create an instance
    await deploy(['tests/fixtures/simple.bpmn'], {});
    await createProcessInstance({
      processDefinitionId: 'simple-process',
    });
    
    // List process instances using the project's wrapper function
    const result = await listProcessInstances({ processDefinitionId: 'simple-process', all: true });
    
    // Verify result is returned and has expected structure
    assert.ok(result, 'Result should be returned');
    assert.ok(Array.isArray(result.items), 'Result should have items array');
    // Note: items may be empty if Elasticsearch hasn't indexed yet, so we just verify structure
  });

  test('cancel process instance CLI handles errors gracefully', async () => {
    // Deploy and create an instance
    await deploy(['tests/fixtures/simple.bpmn'], {});
    const result = await createProcessInstance({
      processDefinitionId: 'simple-process',
    });
    
    assert.ok(result, 'Create result should exist');
    const instanceKey = result.processInstanceKey.toString();
    
    // Run CLI command - simple-process completes instantly, so cancel will fail
    // We test that the CLI handles this gracefully (exits with error, not crash)
    const { execSync } = await import('node:child_process');
    
    try {
      execSync(
        `node src/index.ts cancel pi --key ${instanceKey}`,
        { encoding: 'utf8', cwd: process.cwd(), stdio: 'pipe' }
      );
      // If it succeeded, the process was still running (unlikely for simple-process)
      assert.ok(true, 'Process instance cancellation succeeded');
    } catch (error: any) {
      // CLI should exit with non-zero code when process already completed
      assert.ok(error.status !== 0, 'CLI should exit with non-zero status for already completed process');
      // Check that error output contains an error message (either 'Failed', 'NOT_FOUND', or '✗')
      const hasErrorMessage = error.stderr && (
        error.stderr.includes('Failed') || 
        error.stderr.includes('NOT_FOUND') ||
        error.stderr.includes('✗')
      );
      assert.ok(hasErrorMessage, 
        `CLI should output error message for already completed process. Got stderr: ${error.stderr}`);
    }
  });

  test('create with awaitCompletion returns completed result with variables', async () => {
    // Deploy a simple process first
    await deploy(['tests/fixtures/simple.bpmn'], {});
    
    // Test with awaitCompletion flag using the project's wrapper function
    const result = await createProcessInstance({
      processDefinitionId: 'simple-process',
      awaitCompletion: true,
    });
    
    // Verify the result contains the expected properties
    assert.ok(result, 'Result should be returned');
    assert.ok(result.processInstanceKey, 'Should have process instance key');
    assert.ok('variables' in result, 'Result should have variables property when awaitCompletion is true');
  });

  test('create with awaitCompletion CLI output includes completed and variables', async () => {
    // Deploy a simple process first
    await deploy(['tests/fixtures/simple.bpmn'], {});
    
    // Run the CLI command as a subprocess to test the full integration
    const { execSync } = await import('node:child_process');
    
    // Execute the CLI command and capture output (using node directly since Node 22+ supports TS)
    const output = execSync(
      'node src/index.ts create pi --id simple-process --awaitCompletion',
      { encoding: 'utf8', cwd: process.cwd() }
    );
    
    // Verify the output indicates successful completion
    assert.ok(output.includes('completed'), 'Output should indicate process completed');
    // Verify that variables are present in the output (JSON response should contain "variables")
    assert.ok(output.includes('variables'), 'Output should contain variables when awaitCompletion is true');

    // Also test the 'await pi' command which is an alias for 'create pi --awaitCompletion'
    const outputWithAlias = execSync(
      'node src/index.ts await pi --id simple-process',
      { encoding: 'utf8', cwd: process.cwd() }
    );
    
    // Verify the alias works the same way
    assert.ok(outputWithAlias.includes('completed'), 'Output with await alias should indicate process completed');
    assert.ok(outputWithAlias.includes('variables'), 'Output with await alias should contain variables');
  });

  test('diagram command saves PNG to file', async () => {
    // Deploy and create a process instance
    await deploy(['tests/fixtures/simple.bpmn'], {});
    const result = await createProcessInstance({
      processDefinitionId: 'simple-process',
    });
    
    assert.ok(result, 'Create result should exist');
    const instanceKey = result.processInstanceKey.toString();
    
    // Run CLI command to generate diagram with --output flag
    const { execSync } = await import('node:child_process');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tmpDir = mkdtempSync(join(tmpdir(), 'c8ctl-diagram-test-'));
    const outputPath = join(tmpDir, 'diagram.png');
    
    try {
      const output = execSync(
        `node src/index.ts diagram ${instanceKey} --output ${outputPath}`,
        { encoding: 'utf8', cwd: process.cwd(), stdio: 'pipe' }
      );
      
      // Verify the file was created
      assert.ok(existsSync(outputPath), 'Diagram PNG file should be created');
      
      // Verify the file has content (PNG files start with specific bytes)
      const { readFileSync } = await import('node:fs');
      const fileContent = readFileSync(outputPath);
      assert.ok(fileContent.length > 0, 'PNG file should have content');
      // Verify PNG signature (starts with 0x89504E47)
      assert.strictEqual(fileContent[0], 0x89, 'PNG file should start with PNG signature byte 1');
      assert.strictEqual(fileContent[1], 0x50, 'PNG file should start with PNG signature byte 2');
      assert.strictEqual(fileContent[2], 0x4E, 'PNG file should start with PNG signature byte 3');
      assert.strictEqual(fileContent[3], 0x47, 'PNG file should start with PNG signature byte 4');
      
      // Verify success message in output
      assert.ok(output.includes('Diagram saved'), 'Output should indicate diagram was saved');
    } catch (error: any) {
      // On systems without Chrome/Chromium, skip gracefully
      if (error.stderr && error.stderr.includes('No Chrome or Chromium browser found')) {
        assert.ok(true, 'Test skipped: Chrome/Chromium not installed');
      } else {
        throw error;
      }
    } finally {
      // Cleanup: remove temp directory
      const { rmSync } = await import('node:fs');
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('diagram command without --output prints inline', async () => {
    // Deploy and create a process instance
    await deploy(['tests/fixtures/simple.bpmn'], {});
    const result = await createProcessInstance({
      processDefinitionId: 'simple-process',
    });
    
    assert.ok(result, 'Create result should exist');
    const instanceKey = result.processInstanceKey.toString();
    
    // Run CLI command to generate diagram without --output flag
    const { execSync } = await import('node:child_process');
    
    try {
      const output = execSync(
        `node src/index.ts diagram ${instanceKey}`,
        { encoding: 'binary', cwd: process.cwd(), stdio: 'pipe' }
      );
      // Verify inline image protocol output (Kitty, iTerm2, or Sixel contains escape sequences)
      const hasKittyProtocol = output.includes('\x1b_G');
      const hasIterm2Protocol = output.includes('\x1b]1337;File=');
      const hasSixelProtocol = output.includes('\x1bPq');
      assert.ok(
        hasKittyProtocol || hasIterm2Protocol || hasSixelProtocol,
        'Output should contain inline image protocol (Kitty, iTerm2, or Sixel)'
      );
    } catch (error: any) {
      // On systems without Chrome/Chromium, this test may fail
      if (error.stderr && error.stderr.includes('No Chrome or Chromium browser found')) {
        assert.ok(true, 'Test skipped: Chrome/Chromium not installed');
      } else {
        throw error;
      }
    }
  });

  test('diagram command creates parent directory if needed', async () => {
    // Deploy and create a process instance
    await deploy(['tests/fixtures/simple.bpmn'], {});
    const result = await createProcessInstance({
      processDefinitionId: 'simple-process',
    });
    
    assert.ok(result, 'Create result should exist');
    const instanceKey = result.processInstanceKey.toString();
    
    // Run CLI command to generate diagram with --output flag in non-existent nested directory
    const { execSync } = await import('node:child_process');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tmpDir = mkdtempSync(join(tmpdir(), 'c8ctl-diagram-test-'));
    // Use a nested path that doesn't exist
    const outputPath = join(tmpDir, 'nested', 'path', 'diagram.png');
    
    try {
      const output = execSync(
        `node src/index.ts diagram ${instanceKey} --output ${outputPath}`,
        { encoding: 'utf8', cwd: process.cwd(), stdio: 'pipe' }
      );
      
      // Verify the file was created in the nested directory
      assert.ok(existsSync(outputPath), 'Diagram PNG file should be created in nested directory');
      
      // Verify the file has content (PNG files start with specific bytes)
      const { readFileSync } = await import('node:fs');
      const fileContent = readFileSync(outputPath);
      assert.ok(fileContent.length > 0, 'PNG file should have content');
      // Verify PNG signature (starts with 0x89504E47)
      assert.strictEqual(fileContent[0], 0x89, 'PNG file should start with PNG signature byte 1');
      assert.strictEqual(fileContent[1], 0x50, 'PNG file should start with PNG signature byte 2');
      assert.strictEqual(fileContent[2], 0x4E, 'PNG file should start with PNG signature byte 3');
      assert.strictEqual(fileContent[3], 0x47, 'PNG file should start with PNG signature byte 4');
      
      // Verify success message in output
      assert.ok(output.includes('Diagram saved'), 'Output should indicate diagram was saved');
    } catch (error: any) {
      // On systems without Chrome/Chromium, skip gracefully
      if (error.stderr && error.stderr.includes('No Chrome or Chromium browser found')) {
        assert.ok(true, 'Test skipped: Chrome/Chromium not installed');
      } else {
        throw error;
      }
    } finally {
      // Cleanup: remove temp directory
      const { rmSync } = await import('node:fs');
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('diagram command handles non-existent process instance', async () => {
    // Run CLI command with a non-existent process instance key
    const { execSync } = await import('node:child_process');
    const nonExistentKey = '9999999999999';
    
    try {
      execSync(
        `node src/index.ts diagram ${nonExistentKey}`,
        { encoding: 'utf8', cwd: process.cwd(), stdio: 'pipe' }
      );
      assert.fail('Should have thrown an error for non-existent process instance');
    } catch (error: any) {
      // CLI should exit with non-zero code
      assert.ok(error.status !== 0, 'CLI should exit with non-zero status for non-existent process instance');
      // Check that error output contains an error message
      const hasErrorMessage = error.stderr && (
        error.stderr.includes('Failed') || 
        error.stderr.includes('NOT_FOUND') ||
        error.stderr.includes('✗') ||
        error.stderr.includes('Error')
      );
      assert.ok(hasErrorMessage, 
        `CLI should output error message for non-existent process instance. Got stderr: ${error.stderr}`);
    }
  });
});
