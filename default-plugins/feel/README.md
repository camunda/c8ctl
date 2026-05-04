# c8ctl-plugin-feel

A default [c8ctl](https://github.com/camunda/c8ctl) plugin for
evaluating [FEEL](https://docs.camunda.io/docs/components/modeler/feel/what-is-feel/)
expressions. By default uses the connected Camunda cluster's engine
via the 8.9+ REST API; falls back to in-process
[feelin](https://github.com/nikku/feelin) with `--engine local`.

## Usage

```bash
# Evaluate a simple expression on the cluster (default)
c8ctl feel evaluate '1 + 2'
# → 3

# Leading '=' is optional — both forms work
c8ctl feel evaluate '=1 + 2'

# Pass variables individually
c8ctl feel evaluate 'a + b' --var a=1 --var b=2
# → 3

# Tenant-scoped cluster variables
c8ctl feel evaluate 'camunda.vars.env.API_BASE' --tenant my-tenant

# Compose with other tools — bulk JSON via stdin/file
c8ctl feel evaluate 'sum(items)' --vars "$(jq -c '{items: .data}' input.json)"

# Evaluate offline via feelin (no cluster needed)
c8ctl feel evaluate '1 + 2' --engine local
```

## Warnings

Runtime issues (unknown variables, type mismatches) come back as
warnings, not errors — `result` falls to `null` and the expression
still exits 0.

```text
$ c8ctl feel evaluate 'unknownVar' --engine local
null

⚠ 1 warning:
  Variable 'unknownVar' not found (NO_VARIABLE_FOUND)
```

The trailing `(NO_VARIABLE_FOUND)` is the engine's diagnostic type —
emitted when available (local engine) and omitted when not (cluster).

In JSON mode warnings expand to the engine's diagnostic shape:

```bash
c8ctl output json
c8ctl feel evaluate 'unknownVar' --engine local
# → {"expression":"unknownVar","result":null,"warnings":[
#      { "message": "Variable 'unknownVar' not found",
#        "type": "NO_VARIABLE_FOUND",
#        "position": { "from": 0, "to": 10 } }
#    ]}
```

The envelope `{ expression, result, warnings }` is identical across
engines. The per-warning fields differ:

| Field | `cluster` | `local` |
|---|---|---|
| `message` | always | always |
| `type` | — | feelin's `WarningType` (`NO_VARIABLE_FOUND`, `INVALID_TYPE`, …) |
| `position` | — | `{ from, to }` byte offsets in the expression |

JSON consumers should treat `type` and `position` as engine-conditional.

## Engines

| Engine | When | Notes |
|---|---|---|
| `cluster` (default) | Connected to a Camunda 8.9+ cluster | Uses `POST /v2/expression/evaluation`. Real Zeebe FEEL semantics, full Camunda extensions, supports tenant-scoped cluster variables. |
| `local` | Offline or no cluster configured | Uses [feelin](https://github.com/nikku/feelin) in-process. Fast, but **does not support all Camunda FEEL extensions** — result may differ from the cluster engine. |

`feel evaluate` exits non-zero only when the expression fails to
parse — runtime issues are warnings, not failures, because they're
properly the engine's diagnostic output, not a CLI error.

## Error behaviour

The cluster engine never silently falls back to `--engine local` —
hidden behaviour is bad, and feelin's missing Camunda extensions
could give a different answer. When the cluster is unavailable, you
get an explicit error with a hint:

| Failure | Detection | Behaviour |
|---|---|---|
| No cluster configured | client construction fails | error + hint to use `--engine local` |
| Unreachable (DNS / refused / timeout) | network-level error | error + hint |
| Auth failure | 401 / 403 | error + hint |
| Cluster pre-8.9 | 404 on `/v2/expression/evaluation` | error noting 8.9 requirement + hint |
| Server error | 5xx | error (no hint — likely transient, retry-class) |
| Parse error | 400 | error with cleaned-up FEEL parser message |

The hint always reminds you that feelin behaviour may differ from
the cluster engine.

## Setting variables

Two flags, mix and match:

- **`--var key=value`** (repeatable) — set a single variable. Path
  segments separated by `.` nest. The value is parsed as JSON
  (`42`, `true`, `null`, `[1,2,3]`, `{"a":1}`); if JSON parsing
  fails the value is taken as a string literal.
- **`--vars '{...}'`** — bulk-load variables from a JSON object.

When both are given, `--vars` is the base and each `--var` applies
on top. Within `--var`, last write wins.

```bash
# Simple values
c8ctl feel evaluate 'a + b' --var a=10 --var b=5
# → 15

# Strings (no JSON quoting needed)
c8ctl feel evaluate 'name' --var name=Alice
# → Alice

# Booleans, null, numbers — parsed as JSON
c8ctl feel evaluate 'if active then "yes" else "no"' --var active=true
# → yes

# Arrays — quote for the shell so '[' isn't globbed
c8ctl feel evaluate 'sum(items)' --var 'items=[1,2,3,4]'
# → 10

# Nested via dot path
c8ctl feel evaluate 'person.name' --var person.name=Alice --var person.age=30
# → Alice

# Mix --vars (bulk) with --var (override)
c8ctl feel evaluate 'a + b' --vars '{"a": 1, "b": 2}' --var b=99
# → 100

# Or load --vars from a file
c8ctl feel evaluate 'sum(items)' --vars "$(cat payload.json)"
```

### Conflict detection

You can't nest a property under a value that's already a
non-object — the CLI fails with the offending path:

```
$ c8ctl feel evaluate 'foo.bar' --var foo=hello --var foo.bar=nested
✗ Failed to feel evaluate: Cannot set --var foo.bar: 'foo' is of type string; cannot nest a property under it.
```

The reverse direction (a `--var` overwriting an existing object
with a scalar) is allowed — last write wins.

## See also

- [Camunda FEEL docs](https://docs.camunda.io/docs/components/modeler/feel/what-is-feel/)
- [Built-in FEEL functions](https://docs.camunda.io/docs/components/modeler/feel/builtin-functions/feel-built-in-functions-introduction/)
- [Evaluate Expression API reference](https://docs.camunda.io/docs/apis-tools/orchestration-cluster-api-rest/specifications/evaluate-expression/)
