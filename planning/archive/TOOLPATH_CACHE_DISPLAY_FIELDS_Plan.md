---
status: In progress
created: 2026-05-26
---

# Toolpath Cache: Skip Recalculation on Display-Only Field Changes Plan

## Goal

Toolpaths are currently recalculated whenever any `Operation` field changes, including
display-only fields like `showToolpath`, `enabled`, and `name`. Because Zustand uses
immutable updates, toggling an operation's eye-icon or enable checkbox produces a new
object reference, which breaks the reference-equality cache check and triggers a
full recompute. This makes the UI feel sluggish after every visibility toggle.

The fix makes the cache check compare only the fields that actually affect toolpath
geometry, so display-only changes are no longer treated as cache misses.

## Approach

In `src/App.tsx`, replace the single `entry.operation === operation` reference check
inside `isCacheHit` with a field-by-field comparison that ignores the three
display-only fields:

| Field | Reason excluded |
|---|---|
| `name` | UI label only |
| `enabled` | Controls simulation filtering, not geometry |
| `showToolpath` | Controls rendering visibility, not geometry |

A new helper `operationComputationEquals(a, b)` performs the comparison:
- fast path: `a === b` (common case – no change at all)
- slow path: explicit equality check for every remaining field on the `Operation` interface

`isCacheHit` calls this helper instead of `entry.operation === operation`. Everything
else (stock, features, tools, tabs, clamps reference checks) stays the same.

## Files affected

- `src/App.tsx` — add `operationComputationEquals()`, update `isCacheHit()` to call it

## Tests

No new unit tests required: this is a pure cache-invalidation heuristic with no new
engine logic. The existing `npm run build` + structural test suite verifies the project
still compiles and existing toolpath tests still pass. Manual verification: toggling
`showToolpath` or `enabled` in the UI must not trigger the spinner.

## Open questions / risks

- **New Operation fields in future**: the helper lists fields explicitly, so a new
  computation-relevant field added to `Operation` without updating this helper would
  silently serve stale toolpaths. Mitigated by a comment above the function listing
  the excluded fields and stating all others must be added.

## Out of scope

- Changing how `neededOperationIds` or the async pipeline works
- Any changes to simulation mode filtering logic (still uses `enabled` correctly)
- Optimising other cache layers (stock/features/tools/tabs/clamps are reference-equal already)
