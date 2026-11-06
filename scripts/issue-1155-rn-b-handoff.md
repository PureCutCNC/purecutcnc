# Issue #1155 slice rn-b: neighbour edits refresh rotary toolpaths

Issue #1155, second slice of the plan Frank approved on 2026-11-05 (the approved
comment on #1155). Branch `feat/issue-1155-rotary-neighbours`. **This slice
assumes rn-a is merged on the branch.** After rn-a, a rotary rough/finish reads
every STL model that overlaps its target's along range, not only its targets.

## Cause (read at 428a285e)

- The toolpath cache decides whether an operation must regenerate from
  `operationFootprint` / `operationAffectedByChange`
  (`src/engine/toolpaths/toolpathDependencies.ts:324` and `:483`). A changed
  non-target feature invalidates only if its world bounds touch the footprint
  bounds, which are the union of the **targets'** profile bounds.
- A rotary operation's footprint is its target's bounds in that frame. After rn-a
  the output also depends on neighbour models along its range. Their bounds can
  miss the target's: a narrow imported target, or a neighbour moved so its
  profile no longer touches the target's box while it still overlaps along the
  bar. Editing such a neighbour would leave a stale rotary toolpath that cuts the
  neighbour's old shape.

## What to build

For rotary rough/finish operations (around face), make the footprint cover the
**bar's full cross-section over the target's along extent**, in the coordinates
`featureWorldBounds` uses. Editing, moving, adding or deleting any model that
overlaps that along span must then invalidate the operation. Construction,
region and line exemptions keep working as today. Other operation kinds are
unchanged.

## Acceptance

1. **Committed tests** in `src/engine/toolpaths/toolpathDependencies.test.ts` (or
   the existing rotary cache tests), each with a mutation that must fail; the
   report gives the failing test for each:
   - Moving the Hex (bolt case built in code, as in rn-a) invalidates the Turn
     rotary rough and finish. Mutation: restore the target-bbox footprint for
     rotary ops.
   - A neighbour whose profile box does not touch the target's box but which
     overlaps its along range invalidates. Mutation: same.
   - Editing a model wholly outside the target's along range does **not**
     invalidate. Mutation: mark rotary ops `readsWholeModel`.
   - A non-rotary operation's footprint is unchanged (existing tests stay green
     untouched).
2. **End-to-end check in the store** (unit level is enough): after moving the Hex
   on a project with both Turn ops generated, the regenerated Turn rough equals a
   fresh generation of the edited project (same moves hash).
3. No toolpath output changes: the rn-a byte-identical controls and bolt hashes
   are unchanged (report them).
4. `npm run build` green (report the exit code); `npm test` before pushing.

## Rules

- Scope: the rotary footprint in `toolpathDependencies.ts` and its tests. No
  engine sampling, generator, format, UI or locale change.
- Frank's files live only in the primary checkout's `work/`; read them from there
  and never copy them.
- Report: what changed (file:line), mutation results, build exit code.
