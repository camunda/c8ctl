# Watch --run Architecture Diagram

## Component Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          User Command Line                               │
│  c8 watch . --run a.bpmn --run b/** --variables='{"x":1}'               │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        src/index.ts                                      │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  parseCliArgs()                                                    │  │
│  │  - parseArgs({ run: { type: 'string', multiple: true } })        │  │
│  │  - Extracts: ['a.bpmn', 'b/**']                                  │  │
│  │  - Parses variables: {"x":1}                                     │  │
│  └───────────────────────────┬───────────────────────────────────────┘  │
│                               │                                          │
│  ┌───────────────────────────▼───────────────────────────────────────┐  │
│  │  watch command handler                                            │  │
│  │  - Creates runSpecs: [                                            │  │
│  │      { path: 'a.bpmn', variables: {"x":1} },                     │  │
│  │      { path: 'b/**', variables: {"x":1} }                        │  │
│  │    ]                                                              │  │
│  │  - Calls: watchFiles(paths, { profile, runSpecs })              │  │
│  └───────────────────────────┬───────────────────────────────────────┘  │
└────────────────────────────┬─┴──────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     src/commands/watch.ts                                │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  watchFiles(paths, options)                                        │  │
│  │  - Sets up file watchers for paths                                 │  │
│  │  - On file change detected:                                        │  │
│  └──────────┬─────────────────────────────────────────────────────────┘  │
│             │                                                             │
│  ┌──────────▼──────────────────────────────────────────────────────┐    │
│  │  Watch Callback                                                  │    │
│  │  1. await deploy([changedFile])        ← Deploy changed file    │    │
│  │  2. await delay(500ms)                 ← Wait for propagation   │    │
│  │  3. await executeRunSpecs(runSpecs)    ← Create instances       │    │
│  └──────────┬──────────────────────────────────────────────────────┘    │
│             │                                                             │
│  ┌──────────▼──────────────────────────────────────────────────────┐    │
│  │  executeRunSpecs(runSpecs, profile)                             │    │
│  │  ┌─────────────────────────────────────────────────────────────┐│    │
│  │  │ 1. Resolve Patterns                                          ││    │
│  │  │    For each runSpec:                                         ││    │
│  │  │      files = resolveGlobPattern(spec.path) ───────┐         ││    │
│  │  │                                                     │         ││    │
│  │  │ 2. Deduplicate Files                               │         ││    │
│  │  │    uniqueFiles = new Map()                         │         ││    │
│  │  │    (avoid overlapping patterns)                    │         ││    │
│  │  │                                                     │         ││    │
│  │  │ 3. Create Instances                                │         ││    │
│  │  │    For each unique file:                           │         ││    │
│  │  │      processId = extractProcessId(bpmn) ──┐       │         ││    │
│  │  │      await createProcessInstance()         │       │         ││    │
│  │  │      logger.success(instanceKey)           │       │         ││    │
│  │  └────────────────────────────────────────────┼───────┼─────────┘│    │
│  └───────────────────────────────────────────────┼───────┼──────────┘    │
└────────────────────────────────────────────────┬─┼───────┼───────────────┘
                                                 │ │       │
                 ┌───────────────────────────────┘ │       │
                 │           ┌─────────────────────┘       │
                 │           │           ┌─────────────────┘
                 │           │           │
                 ▼           ▼           ▼
┌──────────────────┐ ┌───────────────┐ ┌──────────────────┐
│ src/utils/       │ │ src/commands/ │ │ Reused:          │
│ glob-resolver.ts │ │ run.ts        │ │ - createClient() │
│                  │ │               │ │ - resolveTenantId()│
│ resolveGlobPattern()│ extractProcessId()│ - getLogger()    │
│ ├─ No globs?     │ │               │ │                  │
│ │  → exact file  │ │ Exported fn   │ │ From existing    │
│ ├─ Single *?     │ │ Parses BPMN   │ │ modules          │
│ │  → current dir │ │ Extracts ID   │ │                  │
│ └─ Double **?    │ │               │ │                  │
│    → recursive   │ │               │ │                  │
│                  │ │               │ │                  │
│ Returns:         │ │               │ │                  │
│ [               │ │               │ │                  │
│   { path, name },│ │               │ │                  │
│   { path, name } │ │               │ │                  │
│ ]                │ │               │ │                  │
└──────────────────┘ └───────────────┘ └──────────────────┘
```

## Data Flow

### Input Parsing Flow

```
Command Line
    │
    │  c8 watch . --run a.bpmn --run b/** --variables='{"x":1}'
    │
    ▼
parseArgs
    │
    ├─► values.run = ['a.bpmn', 'b/**']
    └─► values.variables = '{"x":1}'
    │
    ▼
Parse into RunSpecs
    │
    └─► [
          { path: 'a.bpmn', variables: {x:1} },
          { path: 'b/**', variables: {x:1} }
        ]
```

### Execution Flow (Per Watch Event)

```
File Change Detected
    │
    ▼
Deploy Changed File
    │  await deploy([changedFile])
    ▼
Wait for Propagation
    │  await delay(500ms)
    ▼
Execute Run Specs
    │
    ├─► Resolve Patterns
    │   │
    │   ├─► 'a.bpmn' → resolveGlobPattern('a.bpmn')
    │   │               └─► [{path: '/abs/a.bpmn', name: 'a.bpmn'}]
    │   │
    │   └─► 'b/**' → resolveGlobPattern('b/**')
    │                   └─► [{path: '/abs/b/1.bpmn', name: '1.bpmn'},
    │                        {path: '/abs/b/sub/2.bpmn', name: '2.bpmn'}]
    │
    ├─► Deduplicate
    │   │  uniqueFiles = {
    │   │    '/abs/a.bpmn': { file: ..., variables: {x:1} },
    │   │    '/abs/b/1.bpmn': { file: ..., variables: {x:1} },
    │   │    '/abs/b/sub/2.bpmn': { file: ..., variables: {x:1} }
    │   │  }
    │   │
    │
    └─► Create Instances
        │
        ├─► For '/abs/a.bpmn'
        │   │  Read file → extract processId → create instance
        │   │  logger.success("Instance: 123456")
        │
        ├─► For '/abs/b/1.bpmn'
        │   │  Read file → extract processId → create instance
        │   │  logger.success("Instance: 123457")
        │
        └─► For '/abs/b/sub/2.bpmn'
            │  Read file → extract processId → create instance
            │  logger.success("Instance: 123458")
```

## Module Dependencies

```
┌─────────────────────────────────────────────────────────────────┐
│                         index.ts                                 │
│  (Main CLI entry point)                                          │
└────────────┬───────────────────────────────────────────────────┘
             │
             │ imports
             │
             ├──────────────────────────┐
             │                          │
             ▼                          ▼
┌───────────────────────┐  ┌──────────────────────────────────────┐
│  commands/watch.ts    │  │  Other command modules                │
│                       │  │  - deployments.ts                     │
│  Exports:             │  │  - process-instances.ts               │
│  - watchFiles()       │  │  - run.ts                             │
│                       │  │  etc.                                 │
│  Imports:             │  └──────────────────────────────────────┘
│  - deploy()           │
│  - createClient()     │
│  - resolveTenantId()  │
│  - getLogger()        │
│  - resolveGlobPattern()│
│  - extractProcessId() │
└────────┬──────────────┘
         │
         │ imports
         │
         ├────────────────────────────┐
         │                            │
         ▼                            ▼
┌─────────────────────┐    ┌──────────────────────────┐
│ utils/              │    │ commands/run.ts          │
│ glob-resolver.ts    │    │                          │
│                     │    │ Exports:                 │
│ Exports:            │    │ - extractProcessId()     │
│ - resolveGlobPattern()│   │   (now exported)         │
│                     │    │ - run()                  │
│ NEW MODULE          │    │                          │
└─────────────────────┘    │ MODIFIED (1 line)        │
                           └──────────────────────────┘
```

## File Structure (Before vs After)

### Before
```
src/
├── commands/
│   ├── watch.ts              ← Existing
│   ├── run.ts                ← Existing (extractProcessId not exported)
│   ├── deployments.ts
│   ├── process-instances.ts
│   └── ...
├── client.ts
├── config.ts
├── logger.ts
└── index.ts                  ← Existing (no --run parsing)
```

### After
```
src/
├── commands/
│   ├── watch.ts              ← Modified (+ executeRunSpecs)
│   ├── run.ts                ← Modified (export extractProcessId)
│   ├── deployments.ts
│   ├── process-instances.ts
│   └── ...
├── utils/                    ← NEW directory
│   └── glob-resolver.ts      ← NEW file
├── client.ts
├── config.ts
├── logger.ts
└── index.ts                  ← Modified (+ --run parsing)

tests/
├── unit/
│   ├── glob-resolver.test.ts ← NEW file
│   └── ...
└── integration/
    ├── watch-run.test.ts     ← NEW file
    └── ...
```

## Sequence Diagram (Watch Trigger with --run)

```
User    Watch   Deploy  GlobResolver  Run.ts  Client  Camunda
 │       │       │           │          │       │        │
 │ Save  │       │           │          │       │        │
 │ file  │       │           │          │       │        │
 │──────►│       │           │          │       │        │
 │       │       │           │          │       │        │
 │       │ Deploy│           │          │       │        │
 │       │ changed          │          │       │        │
 │       │ file  │           │          │       │        │
 │       │──────►│           │          │       │        │
 │       │       │ Deploy API│          │       │        │
 │       │       │───────────┼──────────┼───────┼───────►│
 │       │       │◄──────────┼──────────┼───────┼────────│
 │       │       │ Success   │          │       │        │
 │       │◄──────│           │          │       │        │
 │       │       │           │          │       │        │
 │       │ Wait  │           │          │       │        │
 │       │ 500ms │           │          │       │        │
 │       │───    │           │          │       │        │
 │       │   │   │           │          │       │        │
 │       │◄──    │           │          │       │        │
 │       │       │           │          │       │        │
 │       │ Resolve patterns  │          │       │        │
 │       │──────────────────►│          │       │        │
 │       │ 'a.bpmn', 'b/**'  │          │       │        │
 │       │       │           │          │       │        │
 │       │◄──────────────────│          │       │        │
 │       │ [{path:...}, ...] │          │       │        │
 │       │       │           │          │       │        │
 │       │ Extract process IDs          │       │        │
 │       │─────────────────────────────►│       │        │
 │       │ Read BPMN content │          │       │        │
 │       │       │           │          │       │        │
 │       │◄─────────────────────────────│       │        │
 │       │ 'process-id-1'    │          │       │        │
 │       │       │           │          │       │        │
 │       │ Create instance   │          │       │        │
 │       │───────────────────┼──────────┼───────►        │
 │       │       │           │          │ Create │       │
 │       │       │           │          │ PI API │       │
 │       │       │           │          │       │───────►│
 │       │       │           │          │       │◄───────│
 │       │       │           │          │       │ Key:123│
 │       │◄──────────────────┼──────────┼───────│        │
 │       │       │           │          │       │        │
 │       │ Log success       │          │       │        │
 │◄──────│       │           │          │       │        │
 │ "Instance: 123456"        │          │       │        │
 │       │       │           │          │       │        │
 │       │ (Repeat for each resolved file)     │        │
 │       │       │           │          │       │        │
```

## Error Flow

```
Watch Trigger
    │
    ▼
Deploy Changed File
    │
    ├─► SUCCESS ──────────┐
    │                     │
    └─► FAILURE ─────────►│ Log error, continue watching
                          │ (Don't execute runSpecs)
                          ▼
                    Wait 500ms
                          │
                          ▼
                    Execute Run Specs
                          │
          ┌───────────────┼───────────────┐
          │               │               │
          ▼               ▼               ▼
    Spec 1: 'a.bpmn'  Spec 2: 'b/**'  Spec 3: 'c.bpmn'
          │               │               │
          ▼               ▼               ▼
    Resolve Pattern   Resolve Pattern  Resolve Pattern
          │               │               │
    ├─► SUCCESS       ├─► SUCCESS      ├─► NO FILES FOUND
    │   [file1]       │   [file2,       │   []
    │                 │    file3]       │
    │                 │                 └─► Log warning
    │                 │                     Continue
    │                 │
    └─► Deduplicate ◄─┘
          │
          │ uniqueFiles = {file1, file2, file3}
          │
          ▼
    For each file:
          │
          ├─► Extract Process ID
          │   ├─► SUCCESS: 'process-1' ──────┐
          │   └─► FAILURE: null ─────────────►│ Log warning, skip file
          │                                    │
          │                                    ▼
          └──────────────────────────► Create Instance
                                              │
                                        ├─► SUCCESS ─► Log success
                                        └─► FAILURE ─► Log error, continue
                                                        to next file
```

## Key Principles

### 1. Separation of Concerns
```
CLI Parsing    ← index.ts
    ↓
Watch Logic    ← watch.ts
    ↓
Glob Resolution ← utils/glob-resolver.ts
    ↓
BPMN Parsing   ← run.ts (extracted)
    ↓
API Calls      ← client.ts, config.ts
```

### 2. Error Isolation
```
Watch Process (never crashes)
    │
    ├─► File Change 1
    │   ├─► Deploy: SUCCESS
    │   └─► Run Specs:
    │       ├─► File A: SUCCESS ✓
    │       ├─► File B: FAILURE ✗ (logged, continued)
    │       └─► File C: SUCCESS ✓
    │
    ├─► File Change 2
    │   ├─► Deploy: FAILURE (logged, skip run specs)
    │   └─► Continue watching
    │
    └─► Continue watching...
```

### 3. Code Reuse
```
Existing Functions              New Function
────────────────────           ──────────────
extractProcessId()      ────►  executeRunSpecs()
createClient()          ────►  (uses all existing)
resolveTenantId()       ────►
getLogger()             ────►
deploy()                ────►
                               
Existing Pattern               New Implementation
────────────────              ──────────────────
collectResourceFiles()  ────► collectBpmnFiles()
                               (adapted pattern)
```

## Summary

**3 Modified Files**:
- index.ts: CLI parsing
- watch.ts: Execution logic
- run.ts: Export function

**3 New Files**:
- utils/glob-resolver.ts: Pattern resolution
- tests/unit/glob-resolver.test.ts: Unit tests
- tests/integration/watch-run.test.ts: E2E tests

**Total Addition**: ~300 lines
**Total Modification**: ~20 lines

**Zero** external dependencies added.
**Minimal** changes to existing code.
**Maximum** code reuse.

