# Questions & Answers: Watch --run Implementation

This document provides direct answers to your specific questions about implementing the `--run` flag.

---

## Question 1: What's the most minimal-change approach to implement this?

### Answer: 3 Modified Files + 3 New Files (~300 Lines Total)

#### Modified Files (Minimal Changes)

1. **src/index.ts** (~15 lines changed)
   - Add `run: { type: 'string', multiple: true }` to parseArgs options
   - Parse run specs in watch command handler
   - Pass runSpecs to watchFiles()

2. **src/commands/watch.ts** (~80 lines added)
   - Add RunSpec interface
   - Update watchFiles() signature to accept runSpecs
   - Add executeRunSpecs() function
   - Call executeRunSpecs after successful deployment

3. **src/commands/run.ts** (1 line changed)
   - Export extractProcessId function (change from implicit to explicit export)

#### New Files (Isolated Additions)

4. **src/utils/glob-resolver.ts** (~100 lines)
   - Standalone utility for pattern resolution
   - No impact on existing code

5. **tests/unit/glob-resolver.test.ts** (~120 lines)
   - Isolated unit tests

6. **tests/integration/watch-run.test.ts** (~200 lines)
   - E2E tests, no changes to existing tests

### Why This is Minimal

✅ **No refactoring** of existing functionality
✅ **Reuses** existing patterns (collectResourceFiles, parseArgs, error handling)
✅ **Isolates** new functionality in separate utility module
✅ **Exports** (not duplicates) shared function (extractProcessId)
✅ **Extends** (not replaces) watch command behavior
✅ **Zero** external dependencies added

### Alternative Approaches (Rejected as More Invasive)

❌ **Refactor run.ts and watch.ts into shared module** - Higher risk, more files changed
❌ **Use external glob library** - Adds dependency, against project philosophy
❌ **Create separate watch-run command** - Duplicates watch logic, not DRY

---

## Question 2: How should I handle the CLI argument parsing for multiple --run flags?

### Answer: Use Node.js 22's `multiple: true` Feature

#### Implementation

```typescript
// In src/index.ts, parseCliArgs() function
function parseCliArgs() {
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      options: {
        // ... existing options ...
        run: { type: 'string', multiple: true }, // NEW
        // ... rest of options ...
      },
      allowPositionals: true,
      strict: false,
    });

    return { values, positionals };
  } catch (error: any) {
    console.error(`Error parsing arguments: ${error.message}`);
    process.exit(1);
  }
}
```

#### How It Works

When user runs:
```bash
c8 watch . --run a.bpmn --run b.bpmn --run dir/**
```

`values.run` becomes:
```typescript
['a.bpmn', 'b.bpmn', 'dir/**']  // Array of strings
```

#### Processing Multiple Values

```typescript
// In watch command handler (src/index.ts)
if (verb === 'watch' || verb === 'w') {
  const paths = resource ? [resource, ...args] : (args.length > 0 ? args : ['.']);
  
  // Parse --run flags
  let runSpecs: RunSpec[] | undefined;
  
  if (values.run) {
    // Parse variables once (applies to all run specs)
    let variables: Record<string, any> | undefined;
    if (values.variables && typeof values.variables === 'string') {
      try {
        variables = JSON.parse(values.variables);
      } catch (error) {
        logger.error('Invalid JSON for --variables', error as Error);
        process.exit(1);
      }
    }
    
    // Handle single or multiple run flags
    const runPaths = Array.isArray(values.run) ? values.run : [values.run];
    runSpecs = runPaths.map(path => ({ path, variables }));
  }
  
  await watchFiles(paths, {
    profile: values.profile as string | undefined,
    runSpecs,
  });
  return;
}
```

### Why This Approach?

✅ **Native Node.js feature** - No external parsing needed
✅ **Simple** - Single option flag handles multiple values
✅ **Consistent** - Matches existing parseArgs pattern in the codebase
✅ **Documented** - Official Node.js API (available since Node 18)

### Fallback Plan (If multiple: true Has Issues)

If `multiple: true` doesn't work as expected, use manual parsing:

```typescript
// Extract all --run flags manually
const runFlags: string[] = [];
const args = process.argv.slice(2);

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--run' && args[i + 1] && !args[i + 1].startsWith('-')) {
    runFlags.push(args[i + 1]);
    i++; // Skip the value
  }
}
```

**Recommendation**: Start with `multiple: true` (cleaner), document fallback as technical debt if issues arise.

---

## Question 3: What's the best way to resolve glob patterns for BPMN files?

### Answer: Custom Utility Module (No External Dependencies)

#### Implementation: src/utils/glob-resolver.ts

```typescript
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, extname, dirname, basename } from 'node:path';

export interface ResolvedBpmnFile {
  path: string;
  name: string;
}

/**
 * Resolve glob patterns to BPMN files
 * - Single asterisk (*) matches files in current directory only
 * - Double asterisk (**) matches files recursively
 */
export function resolveGlobPattern(pattern: string): ResolvedBpmnFile[] {
  const resolved: ResolvedBpmnFile[] = [];
  const absolutePath = resolve(pattern);

  // No glob - exact file reference
  if (!pattern.includes('*')) {
    if (existsSync(absolutePath) && statSync(absolutePath).isFile()) {
      if (extname(absolutePath) === '.bpmn') {
        resolved.push({
          path: absolutePath,
          name: basename(absolutePath),
        });
      }
    }
    return resolved;
  }

  // Handle glob patterns
  const isRecursive = pattern.includes('**');
  const baseDir = dirname(pattern.replace(/\*+.*$/, ''));
  const resolvedBaseDir = resolve(baseDir);

  if (!existsSync(resolvedBaseDir)) {
    return resolved;
  }

  collectBpmnFiles(resolvedBaseDir, isRecursive, resolved);
  return resolved;
}

function collectBpmnFiles(
  dirPath: string,
  recursive: boolean,
  collected: ResolvedBpmnFile[]
): void {
  if (!existsSync(dirPath)) return;

  const stat = statSync(dirPath);
  
  if (stat.isFile()) {
    if (extname(dirPath) === '.bpmn') {
      collected.push({
        path: dirPath,
        name: basename(dirPath),
      });
    }
    return;
  }

  if (stat.isDirectory()) {
    const entries = readdirSync(dirPath);
    
    for (const entry of entries) {
      const fullPath = join(dirPath, entry);
      const entryStat = statSync(fullPath);
      
      if (entryStat.isFile() && extname(fullPath) === '.bpmn') {
        collected.push({
          path: fullPath,
          name: basename(fullPath),
        });
      } else if (entryStat.isDirectory() && recursive) {
        collectBpmnFiles(fullPath, recursive, collected);
      }
    }
  }
}
```

### Supported Patterns

| Pattern | Meaning | Example |
|---------|---------|---------|
| `path/to/file.bpmn` | Exact file | `tests/fixtures/simple.bpmn` |
| `path/to/*.bpmn` | Current directory only | `src/*.bpmn` |
| `path/to/**/*.bpmn` | Recursive | `processes/**/*.bpmn` |
| `path/to/**` | All BPMNs recursively | `processes/**` |

### Why Custom Implementation?

✅ **Zero dependencies** - Maintains project philosophy (only 1 runtime dependency)
✅ **Full control** - Exact behavior we need, no surprises
✅ **Simple semantics** - Easy to document and explain
✅ **Reuses pattern** - Based on collectResourceFiles from deployments.ts
✅ **Testable** - Pure function, easy to unit test

### Alternative Approaches (Rejected)

| Approach | Why Rejected |
|----------|-------------|
| **minimatch** | Adds dependency, overkill for simple glob |
| **fast-glob** | Adds dependency, more features than needed |
| **glob** | Adds dependency, larger footprint |
| **Extend collectResourceFiles** | Tightly coupled to deployment logic |

### Trade-offs

**Limitations** (Acceptable for v1):
- No character classes: `[abc]`
- No negation: `!excluded`
- No brace expansion: `{a,b,c}`

**If needed later**, these can be added incrementally or we can switch to a library.

### Edge Cases Handled

✅ Non-existent paths → Returns empty array
✅ Non-BPMN files → Filtered out
✅ Absolute paths → Resolved correctly
✅ Relative paths → Resolved relative to CWD
✅ Nested directories → Handled by recursive flag

---

## Question 4: How should I structure the code to avoid duplication?

### Answer: Export and Reuse Existing Functions

#### Strategy: EXTRACT, EXPORT, REUSE

### 1. Extract Process ID Extraction

**Current** (in run.ts):
```typescript
function extractProcessId(bpmnContent: string): string | null {
  const match = bpmnContent.match(/process[^>]+id="([^"]+)"/);
  return match ? match[1] : null;
}
```

**Change** (export it):
```typescript
export function extractProcessId(bpmnContent: string): string | null {
  const match = bpmnContent.match(/process[^>]+id="([^"]+)"/);
  return match ? match[1] : null;
}
```

**Reuse** (in watch.ts):
```typescript
import { extractProcessId } from './run.ts';

// In executeRunSpecs function:
const content = readFileSync(file.path, 'utf-8');
const processId = extractProcessId(content);
```

---

### 2. Reuse Client Creation Pattern

**Already exists** (available everywhere):
```typescript
import { createClient } from '../client.ts';
import { resolveTenantId } from '../config.ts';

const client = createClient(profile);
const tenantId = resolveTenantId(profile);
```

**Use consistently** in watch.ts:
```typescript
async function executeRunSpecs(runSpecs: RunSpec[], profile?: string) {
  const client = createClient(profile);
  const tenantId = resolveTenantId(profile);
  // ... rest of logic
}
```

---

### 3. Reuse File Collection Pattern

**Existing pattern** (from deployments.ts):
```typescript
function collectResourceFiles(dirPath: string, collected: ResourceFile[] = []): ResourceFile[] {
  // Recursively collect files with specific extensions
}
```

**Adapted** for glob resolver:
```typescript
function collectBpmnFiles(
  dirPath: string,
  recursive: boolean,
  collected: ResolvedBpmnFile[]
): void {
  // Similar logic, specialized for BPMN files
}
```

**Why adapt, not reuse directly?**
- `collectResourceFiles` is deployment-specific (handles .dmn, .form, building blocks)
- Glob resolver is simpler (only .bpmn, no building block logic)
- Keeps concerns separated

---

### 4. Reuse Error Handling Pattern

**Existing pattern** (from run.ts, deploy.ts):
```typescript
try {
  await someOperation();
  logger.success('Operation succeeded', result);
} catch (error) {
  logger.error('Operation failed', error as Error);
  process.exit(1); // For top-level commands
}
```

**Apply** in watch.ts (with modification for watch context):
```typescript
try {
  await executeRunSpecs(options.runSpecs, options.profile);
} catch (error) {
  logger.error('Failed to create process instances', error as Error);
  // Don't exit - continue watching
}
```

**Note**: In watch context, we DON'T exit on error (keep watching).

---

### 5. Reuse Logger Pattern

**Existing usage**:
```typescript
const logger = getLogger();
logger.info('Starting operation...');
logger.success('Operation complete', result);
logger.error('Operation failed', error);
logger.table(tableData);
```

**Consistent usage** in watch.ts:
```typescript
logger.info(`🚀 Creating process instance for ${processId}`);
logger.success(`Process instance created: ${result.processInstanceKey}`);
logger.warn(`No BPMN files found matching pattern: ${spec.path}`);
```

---

### Code Structure Summary

```
src/
├── commands/
│   ├── run.ts
│   │   └── extractProcessId() ← EXPORT this
│   └── watch.ts
│       ├── watchFiles() ← EXTEND signature
│       └── executeRunSpecs() ← NEW function
│           ├── uses: createClient() ← REUSE
│           ├── uses: resolveTenantId() ← REUSE
│           ├── uses: extractProcessId() ← REUSE from run.ts
│           └── uses: resolveGlobPattern() ← NEW utility
└── utils/
    └── glob-resolver.ts ← NEW module
        └── resolveGlobPattern()
            └── uses: collectBpmnFiles() ← ADAPTED pattern
```

### Anti-Patterns to Avoid

❌ **Copy-paste extractProcessId into watch.ts**
✅ **Export from run.ts, import in watch.ts**

❌ **Inline glob resolution logic in watch.ts**
✅ **Separate utility module**

❌ **Duplicate client creation logic**
✅ **Reuse createClient() and resolveTenantId()**

❌ **Different error handling styles**
✅ **Consistent logger usage**

---

## Question 5: Any architectural concerns or gotchas I should watch out for?

### Answer: 5 Key Concerns + Mitigations

---

### Concern 1: Variable Scoping ⚠️ LIMITATION

#### Problem
```bash
c8 watch . --run a.bpmn --run b.bpmn --variables='{"x":1}'
```
Variables `{"x":1}` apply to **BOTH** a.bpmn and b.bpmn.

**Cannot do**: Different variables per BPMN file in a single command.

#### Why This Happens
`parseArgs` returns a single `--variables` value, even with multiple `--run` flags.

#### Mitigation Strategy

**Short-term** (v1):
1. Document clearly in help text and examples
2. Variables apply to ALL run specs
3. Users who need different variables run multiple commands

**Example workaround**:
```bash
# Run two separate watch commands
c8 watch . --run a.bpmn --variables='{"x":1}' &
c8 watch . --run b.bpmn --variables='{"y":2}' &
```

**Long-term** (v2 - Technical Debt):
Extend syntax to support per-file variables:
```bash
c8 watch . --run a.bpmn --with-vars='{"x":1}' --run b.bpmn --with-vars='{"y":2}'
```

**Recommendation**: Accept limitation for v1, create GitHub Issue for enhancement.

---

### Concern 2: Overlapping Glob Patterns ⚠️ MUST FIX

#### Problem
```bash
c8 watch . --run a.bpmn --run *.bpmn
```
If `a.bpmn` matches `*.bpmn`, it will be instantiated **twice** on every watch trigger.

#### Why This is Bad
- Confusing behavior
- Unexpected duplicate instances
- Wasted API calls

#### Mitigation: Deduplication

**Implementation** (in executeRunSpecs):
```typescript
async function executeRunSpecs(runSpecs: RunSpec[], profile?: string) {
  const logger = getLogger();
  const client = createClient(profile);
  const tenantId = resolveTenantId(profile);

  // Deduplicate files across all run specs
  const uniqueFiles = new Map<string, { file: ResolvedBpmnFile; variables?: any }>();

  for (const spec of runSpecs) {
    const resolvedFiles = resolveGlobPattern(spec.path);
    for (const file of resolvedFiles) {
      // Use file path as key - first match wins
      if (!uniqueFiles.has(file.path)) {
        uniqueFiles.set(file.path, { 
          file, 
          variables: spec.variables 
        });
      }
    }
  }

  // Process each unique file only once
  for (const { file, variables } of uniqueFiles.values()) {
    // ... create instance
  }
}
```

**Benefits**:
✅ No duplicate instances
✅ First match wins (predictable)
✅ Minimal performance overhead (Map lookup)

**Recommendation**: Implement deduplication in v1 (Priority 1).

---

### Concern 3: Process Instance Creation Timing ⚠️ RACE CONDITION

#### Problem
```
1. Watch detects change
2. Deploy BPMN file
3. Immediately create process instance  ← May fail!
4. Deployment not yet propagated to Zeebe
```

#### Why This Happens
- Deployment API returns success
- But Zeebe may take milliseconds to make process definition available
- CreateProcessInstance fails with "Process definition not found"

#### Mitigation: Small Delay

**Implementation**:
```typescript
// In watch.ts, after successful deploy
try {
  await deploy([fullPath], { profile: options.profile });
  
  if (options.runSpecs) {
    // Allow deployment to propagate
    await new Promise(resolve => setTimeout(resolve, 500));
    await executeRunSpecs(options.runSpecs, options.profile);
  }
} catch (error) {
  logger.error(`Failed to deploy ${basename(filename)}`, error as Error);
}
```

**Alternative**: Retry with exponential backoff
```typescript
async function createInstanceWithRetry(request, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await client.createProcessInstance(request);
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 500));
    }
  }
}
```

**Recommendation**: Start with 500ms delay (simpler), add retry as enhancement if issues persist.

---

### Concern 4: Error Isolation ✅ DECISION REQUIRED

#### Question
If one BPMN file in a glob pattern fails to create instance, should others continue?

**Example**:
```bash
c8 watch . --run '**/*.bpmn'
```
- `a.bpmn` → Success
- `b.bpmn` → Fails (invalid process ID)
- `c.bpmn` → ???

#### Decision: YES, Continue Processing

**Rationale**:
- Watch is a long-running, development-time tool
- Users want "best effort" behavior
- Logging errors is sufficient for debugging

**Implementation**:
```typescript
for (const { file, variables } of uniqueFiles.values()) {
  try {
    // Extract process ID
    const content = readFileSync(file.path, 'utf-8');
    const processId = extractProcessId(content);

    if (!processId) {
      logger.warn(`Could not extract process ID from ${file.name}, skipping`);
      continue; // Skip this file, continue to next
    }

    // Create instance
    const result = await client.createProcessInstance({
      processDefinitionId: processId,
      tenantId,
      variables,
    });
    
    logger.success(`Process instance created: ${result.processInstanceKey}`);
  } catch (error) {
    // Log error, continue to next file
    logger.error(`Failed to create instance for ${file.name}`, error as Error);
  }
}
```

**Benefits**:
✅ Bulk operations don't fail completely
✅ Clear error logging per file
✅ Developer sees which files succeeded/failed

---

### Concern 5: Watch Does NOT Redeploy --run BPMNs ✅ CRITICAL REQUIREMENT

#### Requirement
```bash
c8 watch . --run path/to/some.bpmn
```
- When ANY file in `.` changes → Deploy changed file
- Then create instance of `path/to/some.bpmn` (using EXISTING deployed version)
- Do NOT redeploy `path/to/some.bpmn`

#### Why This Matters
- `--run` is a shortcut for "also instantiate these processes"
- Unlike `run` command (which deploys first), `watch --run` assumes BPMNs are already deployed
- Redeploying would create new versions unnecessarily

#### Implementation Verification

**Correct** (in watch.ts):
```typescript
// Watch callback
const watcher = watch(path, { recursive: isDirectory }, async (eventType, filename) => {
  // ... file validation ...

  logger.info(`\n🔄 Change detected: ${basename(filename)}`);

  try {
    // ONLY deploy the changed file
    await deploy([fullPath], { profile: options.profile });
    
    // THEN create instances (does NOT deploy run specs)
    if (options.runSpecs) {
      await new Promise(resolve => setTimeout(resolve, 500));
      await executeRunSpecs(options.runSpecs, options.profile);
    }
  } catch (error) {
    logger.error(`Failed to deploy ${basename(filename)}`, error as Error);
  }
});
```

**executeRunSpecs does NOT call deploy()**:
```typescript
async function executeRunSpecs(runSpecs: RunSpec[], profile?: string) {
  // NO deploy() call here
  // Only createProcessInstance()
  
  for (const { file, variables } of uniqueFiles.values()) {
    const processId = extractProcessId(...);
    await client.createProcessInstance({ processDefinitionId: processId, ... });
  }
}
```

#### Test Verification

**E2E Test** (in watch-run.test.ts):
```typescript
test('watch --run does NOT redeploy referenced BPMNs', async () => {
  // 1. Manually deploy BPMN
  await deploy([bpmnPath], {});
  
  // 2. Get version
  const versionBefore = await getProcessDefinitionVersion('process-id');
  
  // 3. Start watch --run
  watchProcess = spawn('c8', ['watch', '.', '--run', bpmnPath]);
  
  // 4. Trigger watch on a DIFFERENT file
  writeFileSync(otherFile, '...');
  await delay(5000);
  
  // 5. Verify version unchanged
  const versionAfter = await getProcessDefinitionVersion('process-id');
  assert.strictEqual(versionBefore, versionAfter);
});
```

---

### Summary of Concerns

| Concern | Severity | Mitigation | Status |
|---------|----------|------------|--------|
| Variable scoping | Medium | Document, enhance v2 | Accept for v1 |
| Overlapping globs | High | Deduplicate files | Implement now |
| Timing race | Medium | 500ms delay | Implement now |
| Error isolation | Low | Continue on error | Implement now |
| No redeploy | Critical | Correct implementation | Verify with test |

---

### Additional Gotchas

#### A. Absolute vs Relative Paths

**Example**:
```bash
c8 watch . --run tests/fixtures/simple.bpmn
c8 watch . --run /abs/path/to/simple.bpmn
```

**Solution**: `resolve()` in glob resolver normalizes all paths.

---

#### B. Non-BPMN Files in Glob

**Example**:
```bash
c8 watch . --run '**/*'
```

**Solution**: Filter by `.bpmn` extension in collectBpmnFiles.

---

#### C. Process ID Not Found in BPMN

**Example**: Malformed BPMN file

**Solution**: Log warning, skip file, continue.

---

#### D. Camunda API Error (e.g., Invalid Tenant)

**Solution**: Log error, continue to next file. Don't crash watch process.

---

### Testing Gotchas

All concerns have corresponding tests in watch-run.test.ts:
✅ Variable passing test
✅ Multiple --run flags test
✅ No redeployment verification test
✅ Logging test
✅ Path handling test
✅ Glob pattern tests

---

## Summary: Answers at a Glance

| Question | Quick Answer | Details |
|----------|-------------|---------|
| **Minimal approach?** | 3 modified, 3 new files (~300 lines) | Section 1 |
| **CLI parsing?** | `run: { type: 'string', multiple: true }` | Section 2 |
| **Glob resolution?** | Custom utility module (zero deps) | Section 3 |
| **Avoid duplication?** | Export extractProcessId, reuse patterns | Section 4 |
| **Concerns?** | 5 key: variables, globs, timing, errors, no-redeploy | Section 5 |

---

## Next Steps

1. ✅ Review this Q&A document
2. ✅ Review full implementation strategy (WATCH_RUN_IMPLEMENTATION_STRATEGY.md)
3. ✅ Review quick reference (IMPLEMENTATION_SUMMARY.md)
4. ❓ Ready to implement? (Phase 1 → Phase 2 → Phase 3)
5. ❓ Need GitHub Issues created for technical debt?

**Let me know when you're ready to proceed with implementation!**
