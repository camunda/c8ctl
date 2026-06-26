# Proposal: JSON-stringify object cell values in text-mode table renderer

## Problem

`logger.table()` calls `String(obj[key] ?? "")` for every cell in text mode. When a cell value is a plain object or array (e.g. `customHeaders: { "x-foo": "bar" }`), `String()` produces `"[object Object]"` — unreadable in the terminal.

In JSON mode the whole array is already serialised via `JSON.stringify(filteredData, null, 2)`, so nested objects are preserved correctly and need no change.

This was surfaced by the `--customHeaders` flag added to `activate jobs` (PR #448): in JSON mode (`--output json`) `customHeaders` renders as the correct key/value map, but in default text mode it renders as `[object Object]`.

## Proposed change

**File: `src/core/logger.ts`**

Add a single private helper:

```ts
function renderCell(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
}
```

Replace the two `String(obj[key] ?? "")` expressions in the `text` branch of `table()`:

```diff
-  ...filteredData.map((obj) => String(obj[key] ?? "").length),
+  ...filteredData.map((obj) => renderCell(obj[key]).length),

-  .map((key) => String(obj[key] ?? "").padEnd(widths[key]))
+  .map((key) => renderCell(obj[key]).padEnd(widths[key]))
```

No changes needed in `jobs.ts` or any other command — the fix is entirely in the renderer.

## Why here and not in each command handler

Every command that ever places a nested object in a list row gets correct text-mode output for free. Putting `JSON.stringify` in a handler is command-local and would have to be repeated for every future field; fixing the renderer once is the general solution.

## Effect on existing output

All current commands only place primitive values (strings, numbers, booleans) in table rows. `renderCell` takes the `typeof value === "object"` branch only for actual objects and arrays, so every existing primitive continues to go through `String()` unchanged — no behaviour change for today's output.

## Tests to add

| File | What to add |
|------|-------------|
| `tests/unit/logger.test.ts` | Unit tests for `renderCell`: object, array, null, undefined, string, number, boolean |
| `tests/unit/jobs-behaviour.test.ts` | Text-mode mock-server test: set `outputMode: "text"` in the session, assert the `Custom Headers` column line contains `{"x-foo":"bar","x-count":42}` |

## Scope summary

| File | Change |
|------|--------|
| `src/core/logger.ts` | Add `renderCell`, replace 2 `String()` calls |
| `tests/unit/logger.test.ts` | New unit tests for `renderCell` |
| `tests/unit/jobs-behaviour.test.ts` | New text-mode mock-server rendering test |
