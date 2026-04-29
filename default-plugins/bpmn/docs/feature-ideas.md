# bpmn plugin — feature ideas

The bpmn plugin currently exposes one verb (`lint`). This file is a
brainstorm of additional commands that would help an agent work
efficiently with BPMN XML — an "XML copilot" for big diagrams.
Nothing here is committed; it's food for thought captured from a
discussion so we can pick it up later.

## Why agent-specific commands?

BPMN XML is read-heavy and edit-fragile:

- **Reading**: a 50-element process is hundreds of lines. Locating
  one element requires reading the whole file. Token-expensive.
- **Editing**: namespaces, ID consistency, the parallel DI section —
  easy to corrupt with raw text edits.

The aim of any new command should be: return *less* than the full
XML, or perform a multi-step surgical edit in one shot. The agent
shouldn't have to reconstruct XML in its head.

## Guiding principles (from the discussion)

### Static check → lint rule. Action/query → command.

Static "is X correct?" checks belong in
`bpmnlint-plugin-camunda-compat`. The agent runs `bpmn lint`, gets a
punch list, fixes each issue. Examples that should be (or are) lint
rules:

- FEEL expression syntax — *covered* by the `feel` rule.
- Reference integrity (`sourceRef`, `targetRef`, `messageRef`,
  `errorRef`, `calledElement.processId`, `formRef`, `decisionRef`) —
  partially covered, gaps to be added.
- Thrown error has no handler in scope.
- Variable read with no source / written never read.
- Shape without DI / edge waypoint not landing on shape.

If a rule is missing, upstream it to
`bpmnlint-plugin-camunda-compat` so Modeler, web-modeler, and c8ctl
all benefit. The plugin's `bpmn lint` already wires the
camunda-compat config — adding a rule there gives us the check "for
free."

Commands are for: inventory queries, traversal, mutations, and
sandboxing/testing — anything that returns data or performs an
action, not pass/fail.

### Layout — local shifts allowed, wholesale reformatting forbidden

Auto-layout that recomputes coordinates of unaffected elements is
destructive. Humans lay diagrams out intentionally, and we mustn't
undo their work. But *making room* on insert (push downstream right;
push parallel branches down; expand parent subprocess) is fine —
that's what Modeler's bpmn-js insert behavior already does and what
users expect.

Notes:

- Inserts could place the new shape with offset and shift only the
  affected downstream chain.
- Edits that aren't structural (rename, set attribute) shouldn't
  touch DI.
- Deletes could leave a hole by default — `--collapse` to shift
  downstream left.
- `nudge` / `align` / `distribute` / `waypoint` as surgical fix-up
  tools.
- A `bpmn auto-layout` would only make sense if explicitly opted
  into and loud about being destructive.

## FEEL is the first idea worth pursuing

FEEL is *the* expression language across BPMN, DMN, and Forms — used
for sequence flow conditions, input/output mappings, timer
expressions, message correlation keys, error codes, conditional
events, task assignment, due dates, and more. It's where most
authoring goes wrong, and where an agent benefits most from a tight
feedback loop. It's also orthogonal to the rest of the BPMN tooling
ideas, so it can move first.

Sketch (likely under the bpmn plugin as a `feel` verb, or its own
plugin if it outgrows BPMN):

- **`feel validate '<expr>'`** — syntax-check a single expression.
  Useful during authoring (agent just generated an expression and
  wants to verify before inserting). *Distinct from* the bpmnlint
  `feel` rule, which validates every expression inside a whole BPMN
  file.
- **`feel eval '<expr>' --vars '{…}'`** — evaluate with a payload.
  Lets the agent test a condition without spinning up an engine.
- **`feel list <file.bpmn>`** — extract every FEEL expression with
  location (`<id>:<binding>` → expression). Inventory for refactoring
  or review.
- **`feel format '<expr>'`** — pretty-print / canonicalize. Useful
  for diffs.

Engine choice (open question):

- [`feelin`](https://github.com/nikku/feelin) — JS-based, browser-
  friendly, fast local evaluation. **Does not** support Camunda
  extensions to FEEL — would need to flag this.
- [`feel-scala`](https://github.com/camunda/feel-scala) — JVM-based,
  what Zeebe actually runs. Supports Camunda extensions. Heavier to
  embed.

`feelin` looks like the natural default; opt-in to `feel-scala`
later if extension coverage matters.

## Other command ideas (rough groupings)

### Token-efficient reads

- `outline` — hierarchical summary; biggest single token saver
- `show <id>` — pretty-print one element + its zeebe extensions
- `extensions <id>` — just the zeebe:* config
- `types` — element-type counts
- `info` — top-level metadata (process IDs,
  executionPlatformVersion, etc.)

### Locate without reading

- `find` — by type/name/attribute/has-extension/template-bound
- `grep "pattern"` — substring across names, docs, expressions,
  headers
- `references <id>` — every place the ID is mentioned
- `outgoing <id>` / `incoming <id>` / `path <from> <to>` — sequence
  flow traversal

### Surgical edits

- `set <id> key=value` — generic setter (`input:` / `output:` /
  `header:` / `property:` / `taskDefinition:` prefixes mirror
  element-template `--set`)
- `rename <id> "name"`
- `rename-id <old> <new>` — across all references (the
  corruption-eliminator)
- `delete <id> [--rewire] [--collapse]`
- `condition <flow-id> '=expr'`
- `doc <id>` — get/set `bpmn:documentation`

### Structural edits

- `add-task <type> --after <id>` — insert + wire flows + local
  downstream shift
- `add-flow <from> <to>`
- `add-boundary <task-id> --type
  timer|error|message|signal|escalation [--interrupting] [params]`
- `loop <id> --parallel|--sequential ...` — wrap as multi-instance
- `replace <id> --type <newType>` — preserve flows + extensions

### Surgical layout fix-ups

- `nudge <id> <dx> <dy>` — move + auto-fix edge endpoints
- `align <ids...> --horizontal|--vertical`
- `distribute <ids...>`
- `waypoint <flow-id> --auto`
- `snap <id> [--grid 10]`
- `layout-pending` — only place shapes that have no DI yet

### Domain inventory

- `messages` / `errors` / `signals` / `escalations` —
  definition-level resources
- `handlers --error <code>` / `--message <name>` — find catchers in
  scope
- `calls` / `calls --check <dir>` / `link <call-id> <other.bpmn>` —
  call activity navigation
- `forms` / `assignees` — user task config
- `boundary <task-id>` — list boundary events on a task
- `vars` / `vars trace <name>` — variable inventory and provenance

### Conversion

- `describe` / `to-text` — compact text rendering for
  context-passing
- `to-mermaid` — for PR embeds
- `render --svg|--png` — visual review
- `strip-di` — semantic-only output

## Out of scope (for these ideas)

- Full auto-layout — destructive without explicit opt-in.
- Schema validation — `bpmn-moddle.fromXML` already throws on
  malformed XML.
- A new linter — extend `bpmnlint-plugin-camunda-compat` instead.
