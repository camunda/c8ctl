# Watch --run Implementation: Quick Reference

## TL;DR

**Effort**: 6-7 hours | **Files Changed**: 3 modified, 3 new | **Lines Added**: ~300

## File Changes

### New Files (3)
1. `src/utils/glob-resolver.ts` - Pattern resolution (~100 lines)
2. `tests/unit/glob-resolver.test.ts` - Unit tests (~120 lines)
3. `tests/integration/watch-run.test.ts` - E2E tests (~200 lines)

### Modified Files (3)
1. `src/index.ts` - Add run flag parsing (~15 lines changed)
2. `src/commands/watch.ts` - Add run execution logic (~80 lines added)
3. `src/commands/run.ts` - Export extractProcessId (1 line changed)

## Implementation Flow

```
┌─────────────────┐
│  User runs:     │
│  c8 watch .     │
│  --run a.bpmn   │
│  --run b/**     │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  index.ts: parseArgs()              │
│  - Extract all --run flags          │
│  - Parse --variables (applies to    │
│    all run specs)                   │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  watch.ts: watchFiles()             │
│  - Initialize file watcher          │
│  - On change detected:              │
│    1. Deploy changed file           │
│    2. Call executeRunSpecs()        │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  watch.ts: executeRunSpecs()        │
│  For each run spec:                 │
│    1. Resolve glob pattern          │
│    2. Extract process ID from BPMN  │
│    3. Create process instance       │
│    4. Log instance key              │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  glob-resolver.ts:                  │
│  resolveGlobPattern()               │
│  - Handle * (current dir)           │
│  - Handle ** (recursive)            │
│  - Return BPMN file paths           │
└─────────────────────────────────────┘
```

## Key Design Decisions

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| **Multiple --run parsing** | `multiple: true` in parseArgs | Native Node 22 feature, minimal code |
| **Glob resolution** | Custom utility module | Zero dependencies, full control |
| **Code reuse** | Export `extractProcessId` from run.ts | DRY principle |
| **Error handling** | Continue on failure per file | Best effort for bulk operations |
| **Variable scoping** | One --variables for all --run | Simple v1, enhance later |
| **Deduplication** | Deduplicate resolved files | Avoid duplicate instances |

## Critical Code Snippets

### 1. Parse CLI Args (index.ts)
```typescript
// In parseArgs options:
run: { type: 'string', multiple: true },

// In watch handler:
let runSpecs: RunSpec[] | undefined;
if (values.run) {
  runSpecs = Array.isArray(values.run) 
    ? values.run.map(path => ({ path, variables: parsedVars }))
    : [{ path: values.run, variables: parsedVars }];
}
```

### 2. Execute Run Specs (watch.ts)
```typescript
async function executeRunSpecs(runSpecs: RunSpec[], profile?: string) {
  const client = createClient(profile);
  const tenantId = resolveTenantId(profile);
  
  // Deduplicate files
  const uniqueFiles = new Map();
  for (const spec of runSpecs) {
    const files = resolveGlobPattern(spec.path);
    files.forEach(f => uniqueFiles.set(f.path, { file: f, vars: spec.variables }));
  }
  
  // Create instances
  for (const { file, vars } of uniqueFiles.values()) {
    const content = readFileSync(file.path, 'utf-8');
    const processId = extractProcessId(content);
    
    await client.createProcessInstance({
      processDefinitionId: processId,
      tenantId,
      variables: vars,
    });
  }
}
```

### 3. Glob Resolver (glob-resolver.ts)
```typescript
export function resolveGlobPattern(pattern: string): ResolvedBpmnFile[] {
  const isRecursive = pattern.includes('**');
  const baseDir = dirname(pattern.replace(/\*+.*$/, ''));
  
  return collectBpmnFiles(resolve(baseDir), isRecursive);
}
```

## Testing Strategy

### Unit Tests (10 tests)
- Exact file path resolution
- Single asterisk (current dir only)
- Double asterisk (recursive)
- Non-existent paths
- Non-BPMN file filtering

### E2E Tests (8 tests)
- Basic watch --run creates instances
- Glob pattern resolution
- Variable passing
- Multiple --run flags
- No redeployment verification
- Logging verification
- Path type handling (absolute/relative)

## Gotchas & Mitigations

| Gotcha | Mitigation |
|--------|-----------|
| Variables apply to ALL run specs | Document clearly, offer enhancement |
| Overlapping globs create duplicates | Deduplicate in executeRunSpecs |
| Instance creation timing race | Add 500ms delay after deploy |
| Glob syntax limited | Document supported patterns |

## Testing Commands

```bash
# Unit tests
npm run test:unit

# Integration tests (requires Camunda at localhost:8080)
npm run test:integration

# Manual testing
c8 watch . --run tests/fixtures/simple.bpmn
c8 watch . --run '**/*.bpmn' --variables='{"x":1}'
c8 watch . --run a.bpmn --run b.bpmn --variables='{"y":2}'
```

## Success Checklist

- [ ] All unit tests pass (10+)
- [ ] All E2E tests pass (8+)
- [ ] Manual testing successful
- [ ] Documentation updated
- [ ] Help text updated
- [ ] No external dependencies added
- [ ] Process instance keys logged
- [ ] Variables passed correctly
- [ ] Glob patterns work (*, **)
- [ ] Multiple --run flags supported

## Next Steps After Implementation

1. **Create GitHub Issues** for technical debt:
   - Fine-grained variables per --run spec
   - Extended glob syntax support
   - Performance optimization for large file sets

2. **Documentation Updates**:
   - Add examples to EXAMPLES.md
   - Update README.md
   - Update help text

3. **Optional Enhancements** (P2):
   - Retry logic for instance creation
   - Progress indicator for bulk operations
   - Dry-run mode for testing patterns

---

**Ready to implement?** Start with Phase 1 (Core Functionality), then test and polish.

See `WATCH_RUN_IMPLEMENTATION_STRATEGY.md` for full details.
