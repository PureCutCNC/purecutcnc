# Issue #1157 slice cu-a: a unit change keeps canned-shape models the same size

One slice, one PR into `integration/0.6.0`. Read issue #1157 first; its "Done
when" list is the acceptance.

## Cause (read in the code, 2026-11-05)

- `convertFeatureDefinition` (`src/utils/units.ts` ~250) converts the canned
  parameters (`convertCannedShapeData`) **and** `stl.scale` through
  `convertStlFeatureData` (~238), which multiplies the scale by 25.4 on
  inch → mm.
- `setUnits` with mode `'convert'` (`src/store/slices/workpieceSlice.ts` ~492)
  then runs `rebuildCannedShapeModels`, which regenerates the mesh from the
  converted parameters (already in the new units) and keeps the converted
  scale (`src/cannedShapes/model.ts` ~94).
- Result: canned models grow 25.4× on inch → mm (shrink on mm → inch).

## What to build

- For a definition with `canned` data, a unit change must not convert
  `stl.scale`: it stays the dimensionless user factor it was. Its regenerated
  mesh carries the new units. Decide with evidence whether `silhouettePaths` of
  a canned definition are in project units (convert) or rebuilt (then either is
  harmless); state which in the report.
- Imported STL/STEP definitions (no `canned`) keep today's behaviour exactly.
- Check every other caller of `convertProjectUnits` / `convertFeatureDefinition`
  (grep), for example import or paste paths that convert units without a
  rebuild: a canned definition must end up the right physical size on each of
  them. Name each caller and what it does in the report.

## Acceptance

1. Committed test: a project with a canned model (Turn or Hex) and an imported
   STL, inch → mm → inch, leaves every feature's world-space mesh bounds
   unchanged within float tolerance after each step (assert on the bounds after
   the rebuild, not on the scale field). Mutation: restore the scale
   conversion for canned definitions; the test must fail.
2. Committed test: a canned model with user scale 2 keeps scale 2 and twice the
   unscaled size through a unit change.
3. Frank's file `work/bolt-test-02-x.camj` exists only in the primary checkout
   (`/home/frankp/Projects/purecutcnc/work/`); read it from there, never copy it
   into the repo. Probe (node, under this worktree's gitignored `work/`):
   convert it to mm through the store's `setUnits(..., 'convert')` path, report
   each feature's mesh bounds before and after (in mm), and generate every
   rotary operation: no "move the model" warning, operations generate.
4. `npm run build` green (report the exit code on its own line).

## Rules

- Scope: the unit conversion of canned definitions and its tests. No change to
  the canned generators, the format version, migrations of already saved
  files, UI, locale or the toolpath engine.
- Report: what changed (file:line), the callers checked, the probe table, the
  mutation result, build exit code.
