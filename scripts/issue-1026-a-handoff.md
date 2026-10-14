# Issue #1026, slice A: the Around zero line through the middle of the sheet

Follow the Session rules in issue #962. Base: `feat/issue-1026-around-origin` (stacked on
`feat/issue-1015-rotary-model`, PR #1025). `gh` may be blocked in your sandbox; this file carries
what you need. Approved by Frank 2026-10-14.

## Why

On a round bar the Top view shows the origin on the bar's centreline. On the **Around** view
(the bar's surface unrolled) the origin marker sits at the sheet's top-left corner, yet the
coordinates treat the middle as zero. Cause: `aroundFrame()` (`src/engine/aroundFrame.ts`) sets
`sheetStart` (the zero line, a = 0, the top of the bar) to the bar box's lower across edge
(`bounds.minY` for an X bar, `bounds.minX` for a Y bar), and the sheet runs from there one
circumference on. Frank wants the origin in the middle, as on Top.

## The rule

- **Zero line** (a = 0, top of the bar) = the bar's centreline across coordinate,
  `roundStockCentre(stock)`. Angle everywhere: `a = 360 · (across − zero) / C`, `C = π·D`; inverse
  `across = zero + a · C / 360`. Never reduced to one turn (unchanged).
- **Sheet** framed from `zero − C/2` to `zero + C/2`. Its two edges are the seam (the bottom of
  the bar, a = ±180°).
- `AroundFrame` gets a new field **`zero`** (the across coordinate of a = 0) and keeps
  **`sheetStart`** for the sheet's first edge, now `zero − C/2`. Document both in the interface.

## Every current `sheetStart` site, and which one it means

Angle from across, or across from angle → **`zero`**:
- `src/engine/aroundFrame.ts` `wrapPoint`, `unwrapPoint`;
- `src/engine/aroundFeatureSolid.ts` (angle per vertex, line 208; the quarter-turn bands from
  line 135 are counted from the zero line);
- `src/engine/lineBatcher.ts` line 105;
- `src/engine/aroundFold.ts` `acrossAngle`;
- `src/engine/simulation/aroundWrap.ts` shader angle (`aroundWrap`, `aroundNormal`): pass the zero
  as its own uniform;
- `src/components/simulation/aroundView.ts` line 65 (the A readout);
- `src/components/canvas/aroundSheet.ts` turn lines (`zero + k·C`, k = 0 solid) and `aroundOrigin`
  (the marker sits on the zero line at the origin's along position).

Sheet edge or one-circumference range → **`sheetStart`** (= `zero − C/2`):
- `aroundFrame.ts` `unrolledProject` stock profile, `bandAcrossExtent` start;
- `aroundFold.ts` fold range (`start`, `end`): seams are now at the sheet edges;
- `aroundWrap.ts` `aroundClampAcross`;
- `src/app/simulationSetup.ts` lines 134–135 (round fixtures);
- `aroundSheet.ts` sheet rect (lines 109–114), default view range;
- `src/components/canvas/scenePrimitives.ts` `drawAroundModelBands` (#1015's model bands).

Cache signatures (`aroundView.ts` line 29, `aroundToolpaths.ts` line 78): add `zero`.

Check with your own grep for anything this list misses (`sheetStart`, `minY`/`minX` of a round
stock used as the angle origin, `circumference` arithmetic) and classify it the same way. #395's
seam rule (a cut within a tool radius of the seam removes material on both sides) must follow the
seam to the new edges. #1015's rotary operations (`rotaryModel.ts`, `rotaryOperation.ts`): their
angles and moves do not change; only how they are drawn on the sheet follows the frame.

## What changes for the user and in output

- The Around view's zero line runs through the middle; the origin marker sits on it.
- G-code for Around operations: every A value shifts by `360 · (old sheetStart − zero) / C`
  (= −R·360/C = −57.2958°) for the same stored geometry. That is the point of the change. Existing
  Around features from integration-branch files move by that much round the bar; no migration,
  format stays 3.3 (0.6.0 is unreleased).
- Top/Bottom, flat stock, non-Around operations: byte-identical.

## Tests (they must bite; list each mutation and whether a test caught it)

- `aroundFrame` round trip `wrapPoint`/`unwrapPoint` at the new zero; a point on the zero line
  wraps to a = 0, one a quarter circumference to the +across side to +90°, to the other side to
  −90° (check the sign against `src/engine/rotaryFrame.ts`, which is frozen).
- `aroundSheet` tests: rect centred on the zero line, origin marker on it, turn lines at
  `zero + k·C`, clamp and model bands spanning the new rect. Use an **asymmetric** fixture (origin
  not at the bar's centre along the bar; a bar whose box is not centred on 0 across).
- Fold: a path crossing the new seam folds into two pieces; one crossing the zero line stays one.
- Simulation: the seam wrap at the new edges (existing grid wrap tests moved to the new edges).
- Update every existing unit test, conformance golden and browser spec that encodes the old zero
  (`grep -rn "sheetStart\|aroundFrame" src e2e scripts`); do not weaken an assertion: re-derive
  each expected number from the rule above. List each golden whose bytes changed and why.
- Browser specs you must update but cannot run: `e2e/aroundFace`, `aroundSketch`, `around3d`,
  `aroundModel`, `rotaryModel`. Say which assertions you changed; the manager runs them.

## Off limits

`src/engine/rotaryFrame.ts` (frozen sign convention), `rotaryModel.ts` sampling, Top/Bottom setup
code, the project format.

## Report

Changes per file (with your classification of every `sheetStart` site), each mutation and whether
it was caught, goldens changed, the commands with exit codes, RISKS.
