# Watch --run Feature: Executive Summary

**Feature**: Add `--run` flag to `watch` command for automatic process instance creation  
**Status**: Design Complete, Ready for Implementation  
**Estimated Effort**: 6-7 hours  
**Risk Level**: Low  

---

## What This Feature Does

Allows developers to automatically create process instances when watch detects file changes:

```bash
# After any file change, create instance of simple.bpmn
c8 watch . --run tests/fixtures/simple.bpmn

# With variables
c8 watch . --run path/to/process.bpmn --variables='{"orderId":"12345","amount":100}'

# Multiple processes and glob patterns
c8 watch . --run file1.bpmn --run dir/** --variables='{"test":true}'
```

**Key Behavior**:
- Watch detects file change → Deploys changed file → Creates instances of --run specs
- Does NOT redeploy the --run referenced files (only creates instances)
- Supports glob patterns (* for current dir, ** for recursive)
- Logs created process instance keys

---

## Implementation Strategy

### Minimal-Change Approach

| Component | Changes | Lines |
|-----------|---------|-------|
| **Modified** | 3 files | ~20 lines changed |
| **New** | 3 files | ~300 lines added |
| **Dependencies** | 0 added | Zero |
| **Total Impact** | 6 files | ~320 lines |

### Files Changed

#### Modified (3)
1. `src/index.ts` - Add `--run` parsing (~15 lines)
2. `src/commands/watch.ts` - Add execution logic (~80 lines)
3. `src/commands/run.ts` - Export extractProcessId (1 line)

#### New (3)
4. `src/utils/glob-resolver.ts` - Pattern resolution (~100 lines)
5. `tests/unit/glob-resolver.test.ts` - Unit tests (~120 lines)
6. `tests/integration/watch-run.test.ts` - E2E tests (~200 lines)

---

## Answers to Key Questions

### 1. Most Minimal Approach?
**Answer**: Extend existing patterns, add one utility module, export one function.  
**Why**: Reuses `collectResourceFiles` pattern, parseArgs approach, existing client/logger.

### 2. CLI Argument Parsing?
**Answer**: Use `run: { type: 'string', multiple: true }` in Node.js 22 parseArgs.  
**Why**: Native feature, returns array automatically, no external parsing needed.

### 3. Glob Pattern Resolution?
**Answer**: Custom utility module (zero dependencies).  
**Why**: Maintains project philosophy, full control, simple semantics.

### 4. Avoid Code Duplication?
**Answer**: Export `extractProcessId` from run.ts, reuse client/config functions.  
**Why**: DRY principle, single source of truth.

### 5. Architectural Concerns?
**Answer**: 5 key concerns identified with mitigations:

| Concern | Mitigation | Priority |
|---------|-----------|----------|
| Variable scoping | Document, enhance v2 | P2 |
| Overlapping globs | Deduplicate files | P1 (implement now) |
| Timing race | 500ms delay | P1 (implement now) |
| Error isolation | Continue on error | P1 (implement now) |
| No redeploy | Correct implementation | Critical |

---

## Architecture Overview

```
User Command
    ↓
parseArgs (index.ts)
    ↓ runSpecs: [{ path, variables }, ...]
watchFiles (watch.ts)
    ↓
File change detected
    ↓
deploy(changedFile)
    ↓
Wait 500ms (propagation)
    ↓
executeRunSpecs()
    ├─ Resolve patterns (glob-resolver.ts)
    ├─ Deduplicate files
    ├─ Extract process IDs (run.ts)
    └─ Create instances (client.ts)
```

---

## Testing Strategy

### Unit Tests (10+)
- Exact file path resolution
- Single asterisk (current dir only)
- Double asterisk (recursive)
- Non-existent paths
- Non-BPMN file filtering

### E2E Tests (8+)
- Basic watch --run creates instances
- Glob pattern resolution (* and **)
- Variable passing
- Multiple --run flags
- No redeployment verification
- Logging verification
- Path handling (absolute/relative)

---

## Implementation Phases

### Phase 1: Core Functionality (4 hours)
1. Create glob-resolver.ts utility
2. Export extractProcessId from run.ts
3. Extend watch.ts with RunSpec and executeRunSpecs
4. Wire up CLI parsing in index.ts
5. Manual testing

### Phase 2: Testing (2 hours)
6. Unit tests for glob resolver
7. E2E tests for watch --run
8. Verify all scenarios

### Phase 3: Polish (1 hour)
9. Update documentation (EXAMPLES.md, README.md)
10. Add help text
11. Edge case handling (deduplication)

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| `multiple: true` doesn't work | Low | Medium | Manual parsing fallback |
| Glob patterns confusing | Medium | Low | Clear documentation |
| Variables apply to wrong BPMNs | Low | Medium | Document, enhance v2 |
| Timing race on instance creation | Low | Medium | 500ms delay |
| Overlapping globs cause duplicates | Medium | Medium | Deduplication (Priority 1) |

**Overall Risk**: LOW - Well-understood patterns, isolated changes, comprehensive testing.

---

## Key Design Decisions

### ✅ Decisions Made

1. **Use Node.js native parseArgs with `multiple: true`**
   - Rationale: Native, simple, no dependencies

2. **Custom glob resolver (no external libs)**
   - Rationale: Zero dependencies, full control, simple semantics

3. **Export extractProcessId from run.ts**
   - Rationale: DRY principle, single source of truth

4. **Deduplicate overlapping patterns**
   - Rationale: Avoid confusing duplicate instances

5. **500ms delay after deployment**
   - Rationale: Allow Zeebe to propagate deployment

6. **Continue on error per file**
   - Rationale: Best effort for bulk operations

7. **Variables apply to all --run specs**
   - Rationale: Simple v1, enhance later if needed

---

## Technical Debt & Future Enhancements

### Documented Limitations

1. **Single --variables for all --run specs** (P2)
   - Current: One --variables applies to all BPMNs
   - Future: `--run a.bpmn --with-vars='{"x":1}'` syntax

2. **Limited glob syntax** (P3)
   - Current: Only `*` and `**`
   - Future: Character classes, negation, brace expansion

3. **Synchronous file operations** (P4)
   - Current: Sync fs methods in glob resolver
   - Future: Async if performance issues

### Recommended GitHub Issues (Post-Implementation)

1. "Support fine-grained --variables per --run spec"
2. "Add glob pattern deduplication in watch --run"
3. "Extend glob syntax support (character classes, negation)"

---

## Success Criteria

### Functional Requirements ✅
- [ ] `c8 watch . --run path/to/file.bpmn` creates instances
- [ ] Variables passed correctly
- [ ] Glob patterns (* and **) work
- [ ] Multiple --run flags supported
- [ ] Process instance keys logged
- [ ] No redeployment of --run BPMNs

### Quality Requirements ✅
- [ ] Unit tests pass (10+)
- [ ] E2E tests pass (8+)
- [ ] Documentation updated
- [ ] Code follows existing patterns
- [ ] Error handling graceful

### Non-Functional Requirements ✅
- [ ] Zero dependencies added
- [ ] Minimal changes to existing code
- [ ] Maintainable architecture

---

## Documentation Deliverables

| Document | Purpose | Size |
|----------|---------|------|
| **WATCH_RUN_IMPLEMENTATION_STRATEGY.md** | Complete implementation guide | 33 KB |
| **IMPLEMENTATION_SUMMARY.md** | Quick reference | 7 KB |
| **QA_RESPONSES.md** | Direct answers to questions | 22 KB |
| **ARCHITECTURE_DIAGRAM.md** | Visual architecture | 24 KB |
| **WATCH_RUN_EXECUTIVE_SUMMARY.md** | This document | 6 KB |

**Total**: 92 KB of comprehensive documentation

---

## Code Examples

### Usage Examples

```bash
# Single file
c8 watch . --run tests/fixtures/simple.bpmn

# With variables
c8 watch . --run path/to/process.bpmn --variables='{"orderId":"12345","amount":100}'

# Multiple files
c8 watch . --run file1.bpmn --run file2.bpmn

# Glob patterns
c8 watch . --run processes/*.bpmn              # Current dir only
c8 watch . --run processes/**/*.bpmn           # Recursive

# Combined
c8 watch . --run specific.bpmn --run dir/** --variables='{"env":"dev"}'
```

### Implementation Snippet (executeRunSpecs)

```typescript
async function executeRunSpecs(runSpecs: RunSpec[], profile?: string) {
  const client = createClient(profile);
  const tenantId = resolveTenantId(profile);
  
  // Deduplicate files across all run specs
  const uniqueFiles = new Map<string, { file: ResolvedBpmnFile; variables?: any }>();
  
  for (const spec of runSpecs) {
    const resolvedFiles = resolveGlobPattern(spec.path);
    for (const file of resolvedFiles) {
      if (!uniqueFiles.has(file.path)) {
        uniqueFiles.set(file.path, { file, variables: spec.variables });
      }
    }
  }
  
  // Create instances for unique files
  for (const { file, variables } of uniqueFiles.values()) {
    try {
      const content = readFileSync(file.path, 'utf-8');
      const processId = extractProcessId(content);
      
      if (!processId) {
        logger.warn(`Could not extract process ID from ${file.name}, skipping`);
        continue;
      }
      
      logger.info(`🚀 Creating process instance for ${processId}`);
      
      const result = await client.createProcessInstance({
        processDefinitionId: processId,
        tenantId,
        variables,
      });
      
      logger.success(`Process instance created: ${result.processInstanceKey}`);
    } catch (error) {
      logger.error(`Failed to create instance for ${file.name}`, error as Error);
    }
  }
}
```

---

## Verification Checklist

Before marking complete, verify:

### Development
- [ ] All 6 files created/modified
- [ ] Code follows TypeScript/ESM conventions
- [ ] Imports use .ts extensions
- [ ] Error handling consistent with existing code
- [ ] Logger usage consistent
- [ ] No console.log (use logger)

### Testing
- [ ] `npm run test:unit` passes
- [ ] `npm run test:integration` passes
- [ ] Manual testing with live Camunda:
  - [ ] Single file
  - [ ] Multiple --run flags
  - [ ] Glob patterns (* and **)
  - [ ] Variables
  - [ ] Error scenarios

### Documentation
- [ ] EXAMPLES.md updated with watch --run examples
- [ ] README.md updated
- [ ] Help text updated in help.ts
- [ ] All new code has JSDoc comments

---

## Next Steps

### Option 1: Proceed with Implementation
**Action**: Follow Phase 1 → Phase 2 → Phase 3  
**Effort**: 6-7 hours  
**Risk**: Low  

### Option 2: Review & Adjust
**Action**: Review strategy, adjust if needed  
**Effort**: 30 minutes review  
**Then**: Proceed with implementation  

### Option 3: Create GitHub Issues First
**Action**: Track technical debt before implementation  
**Items**: Fine-grained variables, extended globs, performance  
**Then**: Proceed with implementation  

---

## Recommendation

**Proceed with Option 1: Direct Implementation**

**Rationale**:
- ✅ Strategy is comprehensive and low-risk
- ✅ All questions answered
- ✅ Minimal changes to existing code
- ✅ Well-isolated functionality
- ✅ Comprehensive testing planned
- ✅ Technical debt documented for later

**Next Action**: Begin Phase 1 (Core Functionality)

---

## Contact Points

### Questions During Implementation?

**Refer to**:
1. **WATCH_RUN_IMPLEMENTATION_STRATEGY.md** - Complete guide
2. **QA_RESPONSES.md** - Direct answers to questions
3. **ARCHITECTURE_DIAGRAM.md** - Visual reference
4. **IMPLEMENTATION_SUMMARY.md** - Quick reference

### After Implementation

**Create GitHub Issues** for:
- Fine-grained variables per --run
- Extended glob syntax
- Performance optimizations (if needed)

---

## Summary

**What**: Add `--run` flag to watch command for auto-instantiation  
**How**: 3 modified + 3 new files (~320 lines)  
**Why**: Developer productivity, reduce manual steps  
**When**: 6-7 hours implementation  
**Risk**: Low (isolated, well-tested)  
**Dependencies**: Zero added  

**Status**: ✅ Ready to implement

---

**Document Version**: 1.0  
**Created**: 2024-02-03  
**Author**: Principal Software Engineer Mode  
**Review Status**: Complete
