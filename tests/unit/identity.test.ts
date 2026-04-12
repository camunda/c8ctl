/**
 * Unit tests for identity commands
 * Covers: required-flag validation, dry-run request construction, assign/unassign flag validation
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { c8ctl } from '../../src/runtime.ts';
import { createIdentityUser, deleteIdentityUser } from '../../src/commands/identity-users.ts';
import { createIdentityRole, deleteIdentityRole } from '../../src/commands/identity-roles.ts';
import { createIdentityMappingRule, deleteIdentityMappingRule } from '../../src/commands/identity-mapping-rules.ts';
import { createIdentityAuthorization, deleteIdentityAuthorization } from '../../src/commands/identity-authorizations.ts';
import { handleAssign, handleUnassign } from '../../src/commands/identity.ts';

const TEST_BASE_URL = 'http://test-cluster/v2';

// ─── Shared spy / mock infrastructure ───────────────────────────────────────

let logSpy: string[];
let errorSpy: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalExit: typeof process.exit;
let originalBaseUrl: string | undefined;
let originalActiveProfile: typeof c8ctl.activeProfile;
let originalDryRun: typeof c8ctl.dryRun;
let originalOutputMode: typeof c8ctl.outputMode;

function setup() {
  logSpy = [];
  errorSpy = [];
  originalLog = console.log;
  originalError = console.error;
  originalExit = process.exit;
  originalBaseUrl = process.env.CAMUNDA_BASE_URL;
  originalActiveProfile = c8ctl.activeProfile;
  originalDryRun = c8ctl.dryRun;
  originalOutputMode = c8ctl.outputMode;

  console.log = (...args: any[]) => logSpy.push(args.join(' '));
  console.error = (...args: any[]) => errorSpy.push(args.join(' '));
  // Make process.exit throw so tests can catch it with assert.rejects / assert.throws
  (process.exit as any) = (code: number) => { throw new Error(`process.exit(${code})`); };

  // Provide a base URL so resolveClusterConfig uses the env-var path,
  // no profile file or local cluster needed.
  process.env.CAMUNDA_BASE_URL = TEST_BASE_URL;
  c8ctl.activeProfile = undefined;
  c8ctl.dryRun = false;
  c8ctl.outputMode = 'text';
}

function teardown() {
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  if (originalBaseUrl === undefined) {
    delete process.env.CAMUNDA_BASE_URL;
  } else {
    process.env.CAMUNDA_BASE_URL = originalBaseUrl;
  }
  c8ctl.activeProfile = originalActiveProfile;
  c8ctl.dryRun = originalDryRun;
  c8ctl.outputMode = originalOutputMode;
}

/** Parse the first JSON line captured on stdout */
function capturedJson(): Record<string, unknown> {
  assert.ok(logSpy.length > 0, 'Expected at least one stdout line');
  return JSON.parse(logSpy[0]);
}

// ─── Required-flag validation ────────────────────────────────────────────────

describe('Identity Commands — required-flag validation', () => {
  beforeEach(setup);
  afterEach(teardown);

  // createIdentityUser
  test('createIdentityUser: errors when --username is missing', async () => {
    await assert.rejects(
      () => createIdentityUser({ password: 'secret' }),
      /process\.exit\(1\)/,
    );
    assert.ok(errorSpy.some(l => l.includes('--username is required')));
  });

  test('createIdentityUser: errors when --password is missing', async () => {
    await assert.rejects(
      () => createIdentityUser({ username: 'alice' }),
      /process\.exit\(1\)/,
    );
    assert.ok(errorSpy.some(l => l.includes('--password is required')));
  });

  // createIdentityRole
  test('createIdentityRole: errors when --name is missing', async () => {
    await assert.rejects(
      () => createIdentityRole({}),
      /process\.exit\(1\)/,
    );
    assert.ok(errorSpy.some(l => l.includes('--name is required')));
  });

  // createIdentityMappingRule
  test('createIdentityMappingRule: errors when --mappingRuleId is missing', async () => {
    await assert.rejects(
      () => createIdentityMappingRule({ name: 'n', claimName: 'c', claimValue: 'v' }),
      /process\.exit\(1\)/,
    );
    assert.ok(errorSpy.some(l => l.includes('--mappingRuleId is required')));
  });

  test('createIdentityMappingRule: errors when --name is missing', async () => {
    await assert.rejects(
      () => createIdentityMappingRule({ mappingRuleId: 'r1', claimName: 'c', claimValue: 'v' }),
      /process\.exit\(1\)/,
    );
    assert.ok(errorSpy.some(l => l.includes('--name is required')));
  });

  test('createIdentityMappingRule: errors when --claimName is missing', async () => {
    await assert.rejects(
      () => createIdentityMappingRule({ mappingRuleId: 'r1', name: 'n', claimValue: 'v' }),
      /process\.exit\(1\)/,
    );
    assert.ok(errorSpy.some(l => l.includes('--claimName is required')));
  });

  test('createIdentityMappingRule: errors when --claimValue is missing', async () => {
    await assert.rejects(
      () => createIdentityMappingRule({ mappingRuleId: 'r1', name: 'n', claimName: 'c' }),
      /process\.exit\(1\)/,
    );
    assert.ok(errorSpy.some(l => l.includes('--claimValue is required')));
  });

  // createIdentityAuthorization
  test('createIdentityAuthorization: errors when --ownerId is missing', async () => {
    await assert.rejects(
      () => createIdentityAuthorization({ ownerType: 'USER', resourceType: 'PROCESS_DEFINITION', resourceId: 'r', permissions: 'READ' }),
      /process\.exit\(1\)/,
    );
    assert.ok(errorSpy.some(l => l.includes('--ownerId is required')));
  });

  test('createIdentityAuthorization: errors when --ownerType is missing', async () => {
    await assert.rejects(
      () => createIdentityAuthorization({ ownerId: 'alice', resourceType: 'PROCESS_DEFINITION', resourceId: 'r', permissions: 'READ' }),
      /process\.exit\(1\)/,
    );
    assert.ok(errorSpy.some(l => l.includes('--ownerType is required')));
  });

  test('createIdentityAuthorization: errors when --resourceId is missing', async () => {
    await assert.rejects(
      () => createIdentityAuthorization({ ownerId: 'alice', ownerType: 'USER', resourceType: 'PROCESS_DEFINITION', permissions: 'READ' }),
      /process\.exit\(1\)/,
    );
    assert.ok(errorSpy.some(l => l.includes('--resourceId is required')));
  });

  test('createIdentityAuthorization: errors when --permissions is missing', async () => {
    await assert.rejects(
      () => createIdentityAuthorization({ ownerId: 'alice', ownerType: 'USER', resourceType: 'PROCESS_DEFINITION', resourceId: 'r' }),
      /process\.exit\(1\)/,
    );
    assert.ok(errorSpy.some(l => l.includes('--permissions is required')));
  });
});

// ─── Dry-run request construction ────────────────────────────────────────────

describe('Identity Commands — dry-run output', () => {
  beforeEach(() => {
    setup();
    c8ctl.dryRun = true;
  });
  afterEach(teardown);

  test('createIdentityUser: emits POST to /users with body; password is redacted', async () => {
    await createIdentityUser({ username: 'alice', password: 'secret', name: 'Alice', email: 'alice@example.com' });

    const out = capturedJson();
    assert.strictEqual(out.dryRun, true);
    assert.strictEqual(out.method, 'POST');
    assert.ok((out.url as string).endsWith('/users'), `expected URL to end with /users, got: ${out.url}`);
    const body = out.body as Record<string, unknown>;
    assert.strictEqual(body.username, 'alice');
    assert.strictEqual(body.password, '[REDACTED]', 'password must be redacted in dry-run output');
    assert.strictEqual(body.name, 'Alice');
    assert.strictEqual(body.email, 'alice@example.com');
  });

  test('deleteIdentityUser: emits DELETE to /users/:username', async () => {
    await deleteIdentityUser('alice', {});

    const out = capturedJson();
    assert.strictEqual(out.dryRun, true);
    assert.strictEqual(out.method, 'DELETE');
    assert.ok((out.url as string).endsWith('/users/alice'), `expected URL to end with /users/alice, got: ${out.url}`);
  });

  test('createIdentityRole: emits POST to /roles with name in body', async () => {
    await createIdentityRole({ name: 'admin' });

    const out = capturedJson();
    assert.strictEqual(out.dryRun, true);
    assert.strictEqual(out.method, 'POST');
    assert.ok((out.url as string).endsWith('/roles'), `expected URL to end with /roles, got: ${out.url}`);
    assert.deepStrictEqual(out.body, { name: 'admin' });
  });

  test('deleteIdentityRole: emits DELETE to /roles/:roleId', async () => {
    await deleteIdentityRole('admin-role', {});

    const out = capturedJson();
    assert.strictEqual(out.dryRun, true);
    assert.strictEqual(out.method, 'DELETE');
    assert.ok((out.url as string).endsWith('/roles/admin-role'));
  });

  test('createIdentityMappingRule: emits POST to /mapping-rules with all fields', async () => {
    await createIdentityMappingRule({
      mappingRuleId: 'rule-1',
      name: 'My Rule',
      claimName: 'email',
      claimValue: '*@example.com',
    });

    const out = capturedJson();
    assert.strictEqual(out.dryRun, true);
    assert.strictEqual(out.method, 'POST');
    assert.ok((out.url as string).endsWith('/mapping-rules'));
    assert.deepStrictEqual(out.body, {
      mappingRuleId: 'rule-1',
      name: 'My Rule',
      claimName: 'email',
      claimValue: '*@example.com',
    });
  });

  test('deleteIdentityMappingRule: emits DELETE to /mapping-rules/:id', async () => {
    await deleteIdentityMappingRule('rule-1', {});

    const out = capturedJson();
    assert.strictEqual(out.dryRun, true);
    assert.strictEqual(out.method, 'DELETE');
    assert.ok((out.url as string).endsWith('/mapping-rules/rule-1'));
  });

  test('createIdentityAuthorization: emits POST to /authorizations with permissionTypes array', async () => {
    await createIdentityAuthorization({
      ownerId: 'alice',
      ownerType: 'USER',
      resourceType: 'PROCESS_DEFINITION',
      resourceId: 'my-process',
      permissions: 'READ,UPDATE',
    });

    const out = capturedJson();
    assert.strictEqual(out.dryRun, true);
    assert.strictEqual(out.method, 'POST');
    assert.ok((out.url as string).endsWith('/authorizations'));
    const body = out.body as Record<string, unknown>;
    assert.strictEqual(body.ownerId, 'alice');
    assert.strictEqual(body.ownerType, 'USER');
    assert.strictEqual(body.resourceType, 'PROCESS_DEFINITION');
    assert.strictEqual(body.resourceId, 'my-process');
    assert.deepStrictEqual(body.permissionTypes, ['READ', 'UPDATE']);
  });

  test('deleteIdentityAuthorization: emits DELETE to /authorizations/:key', async () => {
    await deleteIdentityAuthorization('auth-key-42', {});

    const out = capturedJson();
    assert.strictEqual(out.dryRun, true);
    assert.strictEqual(out.method, 'DELETE');
    assert.ok((out.url as string).endsWith('/authorizations/auth-key-42'));
  });
});

// ─── handleAssign / handleUnassign ───────────────────────────────────────────

describe('handleAssign — dry-run and flag validation', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('dry-run emits method/url/body and returns without making API call', async () => {
    c8ctl.dryRun = true;
    await handleAssign('role', 'admin-role', { 'to-user': 'alice' }, {});

    const out = capturedJson();
    assert.strictEqual(out.dryRun, true);
    assert.strictEqual(out.command, 'assign');
    assert.strictEqual(out.method, 'POST');
    assert.ok((out.url as string).includes('/roles/admin-role/users/alice'));
    assert.strictEqual(out.body, null);
  });

  test('errors when multiple --to-* flags are provided', async () => {
    await assert.rejects(
      () => handleAssign('role', 'admin-role', { 'to-user': 'alice', 'to-group': 'ops' }, {}),
      /process\.exit\(1\)/,
    );
    const allError = errorSpy.join('\n');
    assert.ok(allError.includes('--to-user'), 'error should list the conflicting flags');
    assert.ok(allError.includes('--to-group'), 'error should list the conflicting flags');
  });

  test('errors when no --to-* flag is provided', async () => {
    await assert.rejects(
      () => handleAssign('role', 'admin-role', {}, {}),
      /process\.exit\(1\)/,
    );
    assert.ok(errorSpy.some(l => l.includes('Target required')));
  });

  test('dry-run with multiple --to-* flags errors before emitting', async () => {
    c8ctl.dryRun = true;
    await assert.rejects(
      () => handleAssign('role', 'admin', { 'to-user': 'alice', 'to-group': 'ops', 'to-tenant': 't1' }, {}),
      /process\.exit\(1\)/,
    );
    // No JSON should have been emitted
    assert.strictEqual(logSpy.length, 0);
  });

  test('dry-run encodes special characters in path', async () => {
    c8ctl.dryRun = true;
    await handleAssign('user', 'alice@example.com', { 'to-group': 'my group' }, {});

    const out = capturedJson();
    assert.ok((out.url as string).includes(encodeURIComponent('alice@example.com')));
    assert.ok((out.url as string).includes(encodeURIComponent('my group')));
  });
});

describe('handleUnassign — dry-run and flag validation', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('dry-run emits method/url/body and returns without making API call', async () => {
    c8ctl.dryRun = true;
    await handleUnassign('user', 'alice', { 'from-group': 'ops' }, {});

    const out = capturedJson();
    assert.strictEqual(out.dryRun, true);
    assert.strictEqual(out.command, 'unassign');
    assert.strictEqual(out.method, 'DELETE');
    assert.ok((out.url as string).includes('/users/alice/groups/ops'));
    assert.strictEqual(out.body, null);
  });

  test('errors when multiple --from-* flags are provided', async () => {
    await assert.rejects(
      () => handleUnassign('user', 'alice', { 'from-group': 'ops', 'from-tenant': 't1' }, {}),
      /process\.exit\(1\)/,
    );
    const allError = errorSpy.join('\n');
    assert.ok(allError.includes('--from-group'), 'error should list the conflicting flags');
    assert.ok(allError.includes('--from-tenant'), 'error should list the conflicting flags');
  });

  test('errors when no --from-* flag is provided', async () => {
    await assert.rejects(
      () => handleUnassign('user', 'alice', {}, {}),
      /process\.exit\(1\)/,
    );
    assert.ok(errorSpy.some(l => l.includes('Source required')));
  });
});

// ─── sanitizeForLogging (logger boundary) ────────────────────────────────────

describe('sanitizeForLogging — credential redaction', () => {
  // Import directly to unit-test the sanitizer in isolation
  test('redacts password from a flat object', async () => {
    const { sanitizeForLogging } = await import('../../src/logger.ts');
    const result = sanitizeForLogging({ username: 'alice', password: 'secret' }) as any;
    assert.strictEqual(result.username, 'alice');
    assert.strictEqual(result.password, '[REDACTED]');
  });

  test('redacts clientSecret from a nested body object', async () => {
    const { sanitizeForLogging } = await import('../../src/logger.ts');
    const result = sanitizeForLogging({ config: { clientId: 'id', clientSecret: 'shhh' } }) as any;
    assert.strictEqual(result.config.clientId, 'id');
    assert.strictEqual(result.config.clientSecret, '[REDACTED]');
  });

  test('does NOT redact oAuthUrl (it is a URL, not a credential)', async () => {
    const { sanitizeForLogging } = await import('../../src/logger.ts');
    const url = 'https://auth.example.com/oauth/token';
    const result = sanitizeForLogging({ oAuthUrl: url }) as Record<string, unknown>;
    assert.strictEqual(result.oAuthUrl, url);
  });

  test('does NOT redact authorizationKey (false positive — it is a resource identifier)', async () => {
    const { sanitizeForLogging } = await import('../../src/logger.ts');
    const result = sanitizeForLogging({ authorizationKey: '42' }) as any;
    assert.strictEqual(result.authorizationKey, '42');
  });

  test('redacts password inside an array of objects', async () => {
    const { sanitizeForLogging } = await import('../../src/logger.ts');
    const result = sanitizeForLogging([
      { user: 'alice', password: 'p1' },
      { user: 'bob', password: 'p2' },
    ]) as any[];
    assert.strictEqual(result[0].password, '[REDACTED]');
    assert.strictEqual(result[1].password, '[REDACTED]');
    assert.strictEqual(result[0].user, 'alice');
  });

  test('passes primitives through unchanged', async () => {
    const { sanitizeForLogging } = await import('../../src/logger.ts');
    assert.strictEqual(sanitizeForLogging('hello'), 'hello');
    assert.strictEqual(sanitizeForLogging(42), 42);
    assert.strictEqual(sanitizeForLogging(null), null);
  });
});
