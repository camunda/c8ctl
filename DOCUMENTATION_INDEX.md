# Watch --run Implementation: Documentation Index

This directory contains comprehensive documentation for implementing the `--run` flag feature in the c8ctl watch command.

---

## Quick Start

**New to this feature?** Start here:
1. Read **WATCH_RUN_EXECUTIVE_SUMMARY.md** (5 min read)
2. Review **IMPLEMENTATION_SUMMARY.md** (2 min read)
3. Proceed with **WATCH_RUN_IMPLEMENTATION_STRATEGY.md** (15 min read)

**Ready to implement?** Jump to:
- **Phase 1**: WATCH_RUN_IMPLEMENTATION_STRATEGY.md → "Implementation Checklist" section
- **Reference**: Keep ARCHITECTURE_DIAGRAM.md open while coding

**Have specific questions?** Check:
- **QA_RESPONSES.md** → Direct answers to 5 key questions

---

## Document Overview

### 1. 📋 WATCH_RUN_EXECUTIVE_SUMMARY.md
**Purpose**: High-level overview for decision makers  
**Size**: ~6 KB  
**Read Time**: 5 minutes  
**Contains**:
- Feature description
- Implementation strategy summary
- Risk assessment
- Success criteria
- Recommended next steps

**When to use**: First document to read, reference for stakeholders

---

### 2. 📖 WATCH_RUN_IMPLEMENTATION_STRATEGY.md
**Purpose**: Complete implementation guide  
**Size**: ~33 KB  
**Read Time**: 15-20 minutes  
**Contains**:
- Detailed implementation plan
- Code snippets for all changes
- Testing strategy (unit + E2E)
- Technical debt documentation
- Edge case handling
- Architectural concerns with mitigations

**When to use**: Primary reference during implementation

**Key Sections**:
- "Detailed Implementation Plan" → Step-by-step instructions
- "Testing Strategy" → Unit and E2E test templates
- "Technical Debt & Future Enhancements" → Known limitations
- "Architecture Considerations" → Design decisions

---

### 3. 📄 IMPLEMENTATION_SUMMARY.md
**Purpose**: Quick reference guide  
**Size**: ~7 KB  
**Read Time**: 2 minutes  
**Contains**:
- TL;DR (effort, files changed)
- Implementation flow diagram
- Key design decisions table
- Critical code snippets
- Testing commands
- Success checklist

**When to use**: Quick reference while coding, checklist during implementation

---

### 4. ❓ QA_RESPONSES.md
**Purpose**: Direct answers to specific questions  
**Size**: ~22 KB  
**Read Time**: 10 minutes  
**Contains**:
- Detailed answers to 5 key questions:
  1. Minimal-change approach?
  2. CLI argument parsing?
  3. Glob pattern resolution?
  4. Code structure to avoid duplication?
  5. Architectural concerns?

**When to use**: Reference when you have specific questions, troubleshooting

**Question Index**:
- **Q1** → Files to change, lines to add
- **Q2** → parseArgs with `multiple: true`
- **Q3** → Custom glob resolver implementation
- **Q4** → Export/reuse strategy
- **Q5** → 5 concerns + mitigations

---

### 5. 🏗️ ARCHITECTURE_DIAGRAM.md
**Purpose**: Visual architecture reference  
**Size**: ~24 KB  
**Contains**:
- Component architecture diagram
- Data flow diagrams
- Module dependency graph
- Sequence diagram
- Error flow diagram
- Before/After file structure

**When to use**: Visual learner, understanding data flow, reviewing architecture

**Diagrams**:
- "Component Architecture" → High-level structure
- "Data Flow" → Input parsing and execution flow
- "Sequence Diagram" → Watch trigger lifecycle
- "Error Flow" → Error handling strategy

---

## Documentation Map

```
watch --run Feature Documentation
│
├─ WATCH_RUN_EXECUTIVE_SUMMARY.md ─── Start Here (Decision Makers)
│  ├─ What & Why
│  ├─ Risk Assessment
│  └─ Recommendation
│
├─ IMPLEMENTATION_SUMMARY.md ────────── Quick Reference (Developers)
│  ├─ TL;DR
│  ├─ Flow Diagrams
│  └─ Checklists
│
├─ WATCH_RUN_IMPLEMENTATION_STRATEGY.md ─ Complete Guide (Implementers)
│  ├─ Detailed Plan
│  ├─ Code Snippets
│  ├─ Testing Strategy
│  └─ Technical Debt
│
├─ QA_RESPONSES.md ──────────────────── Question Reference (All)
│  ├─ Q1: Minimal Approach
│  ├─ Q2: CLI Parsing
│  ├─ Q3: Glob Resolution
│  ├─ Q4: Code Structure
│  └─ Q5: Concerns
│
└─ ARCHITECTURE_DIAGRAM.md ──────────── Visual Reference (All)
   ├─ Component Diagram
   ├─ Data Flow
   ├─ Sequence Diagram
   └─ Module Dependencies
```

---

## Implementation Workflow

### Phase 1: Understanding (30 minutes)
1. ✅ Read WATCH_RUN_EXECUTIVE_SUMMARY.md
2. ✅ Review IMPLEMENTATION_SUMMARY.md
3. ✅ Skim WATCH_RUN_IMPLEMENTATION_STRATEGY.md (focus on "Detailed Implementation Plan")
4. ✅ Review ARCHITECTURE_DIAGRAM.md (focus on "Component Architecture")

### Phase 2: Implementation (4 hours)
1. Open WATCH_RUN_IMPLEMENTATION_STRATEGY.md
2. Open ARCHITECTURE_DIAGRAM.md in second window
3. Follow "Implementation Checklist" → Development Tasks
4. Reference QA_RESPONSES.md for specific questions
5. Use code snippets from WATCH_RUN_IMPLEMENTATION_STRATEGY.md

**Files to create/modify**:
- [ ] `src/utils/glob-resolver.ts` (NEW)
- [ ] `src/commands/run.ts` (MODIFY - 1 line)
- [ ] `src/commands/watch.ts` (MODIFY - 80 lines)
- [ ] `src/index.ts` (MODIFY - 15 lines)

### Phase 3: Testing (2 hours)
1. Open WATCH_RUN_IMPLEMENTATION_STRATEGY.md → "Testing Strategy"
2. Create unit tests: `tests/unit/glob-resolver.test.ts`
3. Create E2E tests: `tests/integration/watch-run.test.ts`
4. Run: `npm run test:unit && npm run test:integration`

**Test checklist**:
- [ ] Unit tests pass (10+ tests)
- [ ] E2E tests pass (8+ tests)
- [ ] Manual testing successful

### Phase 4: Documentation & Polish (1 hour)
1. Update EXAMPLES.md with watch --run examples
2. Update README.md
3. Update help text in `src/commands/help.ts`
4. Verify all checklists in IMPLEMENTATION_SUMMARY.md

### Phase 5: Review & Finalize (30 minutes)
1. Review "Success Criteria" in WATCH_RUN_EXECUTIVE_SUMMARY.md
2. Review "Technical Debt" in WATCH_RUN_IMPLEMENTATION_STRATEGY.md
3. Create GitHub Issues for future enhancements
4. Commit with descriptive message

---

## Quick Reference Tables

### File Changes Summary

| File | Type | Lines | Purpose |
|------|------|-------|---------|
| `src/index.ts` | Modify | +15 | CLI parsing |
| `src/commands/watch.ts` | Modify | +80 | Execution logic |
| `src/commands/run.ts` | Modify | +1 | Export function |
| `src/utils/glob-resolver.ts` | New | +100 | Pattern resolution |
| `tests/unit/glob-resolver.test.ts` | New | +120 | Unit tests |
| `tests/integration/watch-run.test.ts` | New | +200 | E2E tests |
| **Total** | **6 files** | **~516** | **3 modified, 3 new** |

### Document Purpose Matrix

| Document | Stakeholder | Decision Maker | Implementer | Reviewer |
|----------|------------|----------------|-------------|----------|
| Executive Summary | ✅✅ | ✅✅ | ✅ | ✅ |
| Implementation Strategy | ✅ | ✅ | ✅✅ | ✅✅ |
| Quick Summary | ✅ | ✅ | ✅✅ | ✅ |
| Q&A Responses | ✅ | ✅ | ✅✅ | ✅ |
| Architecture Diagrams | ✅ | - | ✅✅ | ✅✅ |

**Legend**: ✅ Useful, ✅✅ Essential

---

## Code Snippets Index

### CLI Parsing (index.ts)
**Location**: QA_RESPONSES.md → Question 2  
**Also in**: WATCH_RUN_IMPLEMENTATION_STRATEGY.md → Section 1

### Glob Resolver (glob-resolver.ts)
**Location**: QA_RESPONSES.md → Question 3  
**Also in**: WATCH_RUN_IMPLEMENTATION_STRATEGY.md → Section 2

### Execute Run Specs (watch.ts)
**Location**: IMPLEMENTATION_SUMMARY.md → Critical Code Snippets  
**Also in**: WATCH_RUN_IMPLEMENTATION_STRATEGY.md → Section 3

### Test Templates
**Location**: WATCH_RUN_IMPLEMENTATION_STRATEGY.md → Testing Strategy

---

## Testing Reference

### Unit Tests
**File**: `tests/unit/glob-resolver.test.ts`  
**Documentation**: WATCH_RUN_IMPLEMENTATION_STRATEGY.md → "1. Unit Tests"  
**Count**: 10+ tests  
**Coverage**:
- Exact file paths
- Single asterisk (current dir)
- Double asterisk (recursive)
- Non-existent paths
- Non-BPMN filtering

### E2E Tests
**File**: `tests/integration/watch-run.test.ts`  
**Documentation**: WATCH_RUN_IMPLEMENTATION_STRATEGY.md → "2. Integration Tests"  
**Count**: 8+ tests  
**Coverage**:
- Basic watch --run
- Glob patterns
- Variables
- Multiple --run flags
- No redeployment
- Logging
- Path handling

### Manual Testing Commands
```bash
c8 watch . --run tests/fixtures/simple.bpmn
c8 watch . --run '**/*.bpmn' --variables='{"x":1}'
c8 watch . --run a.bpmn --run b.bpmn
```

---

## Decision Log

### Design Decisions
**Document**: QA_RESPONSES.md → Section 5  
**Key Decisions**:
1. Use `multiple: true` in parseArgs
2. Custom glob resolver (no dependencies)
3. Export extractProcessId from run.ts
4. Deduplicate overlapping patterns
5. 500ms delay after deployment
6. Continue on error per file
7. Variables apply to all --run specs

### Architectural Concerns
**Document**: WATCH_RUN_IMPLEMENTATION_STRATEGY.md → "Architecture Considerations"  
**Also in**: QA_RESPONSES.md → Question 5  
**Concerns**:
1. Variable scoping (accept for v1)
2. Overlapping globs (implement deduplication)
3. Timing race (implement 500ms delay)
4. Error isolation (continue on error)
5. No redeploy (verify with test)

---

## Technical Debt Tracking

### Documented Limitations
**Location**: WATCH_RUN_IMPLEMENTATION_STRATEGY.md → "Technical Debt & Future Enhancements"  
**Also in**: WATCH_RUN_EXECUTIVE_SUMMARY.md → "Technical Debt & Future Enhancements"

**Items**:
1. Fine-grained variables per --run (P2)
2. Extended glob syntax (P3)
3. Async file operations (P4)
4. Duplicate detection across specs (P2)

### GitHub Issues to Create
**After Implementation**:
- "Support fine-grained --variables per --run spec"
- "Add glob pattern deduplication in watch --run"
- "Extend glob syntax support"

---

## Success Criteria Checklist

### Functional ✅
- [ ] `c8 watch . --run file.bpmn` works
- [ ] Variables passed correctly
- [ ] Glob patterns (* and **) work
- [ ] Multiple --run flags supported
- [ ] Process instance keys logged
- [ ] No redeployment of --run BPMNs

### Quality ✅
- [ ] Unit tests pass (10+)
- [ ] E2E tests pass (8+)
- [ ] Documentation updated
- [ ] Code follows patterns
- [ ] Error handling graceful

### Non-Functional ✅
- [ ] Zero dependencies added
- [ ] Minimal code changes
- [ ] Maintainable architecture

**Full checklist**: WATCH_RUN_EXECUTIVE_SUMMARY.md → "Success Criteria"

---

## Troubleshooting Guide

### Issue: parseArgs doesn't recognize `multiple: true`
**Solution**: QA_RESPONSES.md → Question 2 → "Fallback Plan"  
**Fallback**: Manual parsing with `process.argv.slice(2)`

### Issue: Glob patterns not resolving correctly
**Solution**: WATCH_RUN_IMPLEMENTATION_STRATEGY.md → Section 2 → "Edge Cases Handled"  
**Debug**: Add logging in `collectBpmnFiles` function

### Issue: Process instance creation fails after deployment
**Solution**: QA_RESPONSES.md → Question 5 → Concern 3  
**Fix**: Increase delay from 500ms to 1000ms

### Issue: Duplicate instances created
**Solution**: WATCH_RUN_IMPLEMENTATION_STRATEGY.md → "Architecture Considerations" → Section 4.B  
**Fix**: Ensure deduplication logic is implemented

---

## Related Documentation

### Project Documentation
- `README.md` - Project overview
- `EXAMPLES.md` - Usage examples (to be updated)
- `IMPLEMENTATION.md` - Project implementation status

### Testing Documentation
- `tests/unit/*.test.ts` - Existing unit tests (for pattern reference)
- `tests/integration/*.test.ts` - Existing E2E tests (for pattern reference)

---

## Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2024-02-03 | Principal SE Mode | Initial documentation |

---

## Document Statistics

| Document | Size | Lines | Words | Read Time |
|----------|------|-------|-------|-----------|
| Executive Summary | 6 KB | 400 | 2,800 | 5 min |
| Implementation Strategy | 33 KB | 1,100 | 8,500 | 15 min |
| Quick Summary | 7 KB | 450 | 3,200 | 2 min |
| Q&A Responses | 22 KB | 750 | 5,800 | 10 min |
| Architecture Diagrams | 24 KB | 800 | 4,200 | 8 min |
| **Total** | **92 KB** | **3,500** | **24,500** | **40 min** |

---

## Contact & Feedback

**Questions during implementation?**
- Refer to QA_RESPONSES.md first
- Check WATCH_RUN_IMPLEMENTATION_STRATEGY.md
- Review ARCHITECTURE_DIAGRAM.md

**Found an issue in documentation?**
- Note it for post-implementation review
- Update as you go

**Suggestions for improvement?**
- Create GitHub Issue for tracking
- Reference in technical debt section

---

## Next Steps

1. ✅ **Read** WATCH_RUN_EXECUTIVE_SUMMARY.md (5 min)
2. ✅ **Review** IMPLEMENTATION_SUMMARY.md (2 min)
3. ✅ **Study** WATCH_RUN_IMPLEMENTATION_STRATEGY.md (15 min)
4. ✅ **Reference** ARCHITECTURE_DIAGRAM.md (as needed)
5. ⏭️ **Begin** Phase 1: Core Functionality
6. ⏭️ **Test** Phase 2: Testing
7. ⏭️ **Polish** Phase 3: Documentation

---

**Ready to implement?** → Start with WATCH_RUN_IMPLEMENTATION_STRATEGY.md → "Implementation Checklist"

**Have questions?** → Check QA_RESPONSES.md → Find your question

**Need visual reference?** → Open ARCHITECTURE_DIAGRAM.md

**Quick lookup?** → Use IMPLEMENTATION_SUMMARY.md

---

**Status**: 📚 Documentation Complete, ✅ Ready for Implementation
