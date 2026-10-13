# Issue #395 slice B — the Around face in the model layer

You are the implementation worker for slice B of issue #395 (wrapped rotary,
part A: an "Around" face on a round bar). Work only in your task worktree. Do
not create, remove, merge, push or switch branches or worktrees. Do not open a
PR. Do not run `git add` or `git commit`: leave your edits uncommitted and
report `COMMIT: none`. `gh` may be blocked; everything you need is in this file
and in `scripts/issue-395-audit.md`.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`, `src/engine/INDEX.md`,
`src/store/INDEX.md` (and the helpers/slices indexes), then
`src/engine/aroundFrame.ts` (slice A, on your branch),
`src/engine/setupOrientation.ts`, `src/engine/setupTargets.ts`,
`src/store/helpers/activeFace.ts`, `src/store/helpers/setups.ts`,
`src/store/helpers/provisionalSetup.ts`, `src/store/slices/setupsSlice.ts` in
full, and `scripts/issue-395-audit.md` in full. Project format stays `3.3`;
absolute paths for every write, no `cd`. Smallest change that does the job; no
refactor, no renames; match the surrounding code and comment density. No
`process.` or `globalThis` in engine code. `node_modules` is a symlink:
type-check with `npx tsc -p tsconfig.app.json --noEmit` and
`npx tsc -p tsconfig.node.json --noEmit`, never `npx tsc -b`.

## Where things stand

Slice A added `SetupFace = 'top' | 'bottom' | 'around'`, `FlatFace`,
`MachiningSetup.kind?: 'around'`, `isAroundSetup`, `setupFace` returning
`'around'`, and `src/engine/aroundFrame.ts`: an operation in an Around setup is
generated on the unrolled flat block and wrapped onto the bar
(`computeOperationToolpath`). Nothing can create, load or save an Around setup
or feature yet, and about 80 places still assume a face is Top or else Bottom.

**This slice makes the model layer correct for Around**: types, engine
(outside `src/engine/gcode/**`), store helpers and slices, file load/save,
`.camj` merge, the clipboard, the toolpath cache key. After it, a test can
build a project with a round bar, create an Around setup through the store,
add a feature and an operation on it, generate, save, reload and get the same
thing; and nothing in the model layer treats Around as Top or as Bottom by
accident.

**Not this slice** (later slices; leave these files alone except where `tsc`
forces a one-line narrowing, which you list in the report):
`src/components/**` and `src/styles/**` (labels, face switch, Sketch view,
dialogs), `src/engine/gcode/**` and `src/engine/operationBooklet/**` (export,
headers, booklet), `src/app/simulationSetup.ts` and `useSimulationModel.ts`
(simulation), `src/engine/designPrint/**`, `e2e/**`, locale files except the
new warning messages named below.

## Approved rules (Frank, 2026-10-12)

1. An Around setup is stored with `kind: 'around'`, `orientation`
   `{ axis: <the bar's axis>, angleDeg: 0 }`, `indexing: 'manual'`. Top and
   Bottom setups never carry `kind`. A project has at most one Around setup.
2. A feature on Around has `authoringFace: 'around'`. Its plan coordinates are
   the unrolled sheet's (see the header of `aroundFrame.ts`), and its heights
   are stored **exactly like a Top feature on the same bar**: the surface is
   `z = thickness`, depth goes down. So every "depth from the face" helper
   treats Around as it treats Top. An Around feature may not reach the
   centreline: its bottom must stay above `thickness / 2`.
3. A flat face and Around exchange nothing: no "change face" to or from
   Around; an operation cannot move between a flat setup and an Around setup;
   an Around operation targets only Around features, and a Top or Bottom
   operation never targets an Around feature (the through-feature and
   imported-model exceptions do not apply in either direction).
4. Copy and paste between a flat face and Around is allowed: the shape is
   pasted as drawn, with no mirror, with its top at the stock's top surface
   (`thickness`) and the depth it had.
5. No imported models on Around: importing a model while Around is the active
   face is refused, and a model on a flat face is not reachable from Around.
6. No tabs on Around. Only chuck and tailstock clamps matter there (slice A's
   `unrolledProject` already does this for generation).
7. The automatic CAM plan is not offered on Around: it refuses the way it
   refuses a turned (Bottom) setup today.
8. Plasma stays Top-only.
9. Around is available when the stock is a round bar. Give the model layer one
   function for that, next to the other active-face helpers:
   `aroundUnavailableReason(project): null | 'needsRoundBar' | 'needsRotaryMachine' | 'machineAxisMismatch'`
   — a round bar, a selected machine with a `rotary` block
   (`project.meta.machineDefinitions[0]`), and that block's `about` equal to
   the bar's `axis`. `switchWorkspaceFace('around')` and creating an Around
   setup are refused when it is not null. An existing Around setup whose bar
   has since changed keeps its features and operations; its operations are
   blocked at generation (rule 11) instead of throwing.
10. Origin and artwork on Around behave as on Top: no mirror, origin placement
    identity (`faceArtworkMirror`, `reversedStockAxes`, `activeOriginInStock`,
    `originPlacementFromStock`, `faceOffsets`, `faceAngles`).
11. Generation never throws for an Around operation in a normal project:
    `setupGenerationBlock` returns a block, with its own warning, when the
    setup is Around and (a) the stock is not a round bar on the setup's axis,
    or (b) a target's bottom is at or below the centreline. Add the two
    warning codes where `setupGenerationBlock`'s existing codes live and their
    messages in all five locales next to the existing ones (only new keys,
    each file's own quote style, no existing value changed). English:
    "{operation}: the Around face needs a round bar lying along the same axis
    as when it was set up." and "{operation}: {feature} reaches the bar's
    centreline; a cut on the Around face must stop short of it." Keep an
    Around setup's `orientation.axis` equal to the bar's axis in
    `syncProjectSetups` whenever the stock is a round bar.

## What to do with the audit

`scripts/issue-395-audit.md` lists every face-dependent site, classed B / E /
G / N with a recommendation. For every **B** and **G** site, and every **N**
site marked "unclear", in the model layer (everything outside the "Not this
slice" list): apply the audit's recommendation, read through the rules above,
which win where they differ. In particular:

- "unroll frame here" in `setupOrientation.ts` / `setupFrameProject.ts`: the
  unroll lives in `aroundFrame.ts` and the seam in `generateOperation.ts`
  already. Those rotation functions must simply never be reached for an Around
  setup: make each entry point that takes a setup or a frame refuse or bypass
  Around explicitly rather than fall into the 0° or 180° branch, and say which
  in the report.
- `orientationForFace`, `PROVISIONAL_SETUPS`, `defaultSetupForFace`,
  `provisionalSetupId`, `provisionalSetupFor`, `setActiveSetup`: an Around
  provisional setup exists like the Bottom one does, but its axis comes from
  the bar, so it cannot be a constant: build it from the project.
- Remove every `as FlatFace` cast slice A left in `src/engine/**` and
  `src/store/**` by handling Around properly at that site. (The two in
  `src/components/**` stay for the UI slice.)
- `decodeSetups` and `normalizeInstance`: accept `kind: 'around'` /
  `authoringFace: 'around'` strictly (an Around setup must have angle 0 and
  manual indexing; any other `kind` value is refused like an unknown
  orientation), write `kind` back only for Around, keep the missing-field
  rule: a file with no `kind` anywhere loads exactly as today.
- `.camj` merge (`src/import/camj.ts` `setupIdFor`) and `findSetupWithTurn`:
  compare and preserve `kind`; an Around setup never matches Top.
- `src/app/toolpathGeneration/cacheInputs.ts` (`operationSetupOrientation`,
  `sameOrientation`): the cache key must tell an Around setup from Top. This
  one file in `src/app/` is yours.
- `depthFromFace`, `spanFromFaceDepth`, `newFeatureSpan`,
  `operationCutRange`, `inferLineTopZFromEnclosingFeature`, `flippedZRange`
  callers: Around as Top (rule 2).
- `projectUsesBothFaces`: true when the project has any setup or feature that
  is not Top (keep the name).
- `throughFeatureCoverage` and the cross-face helpers: Around operations and
  Around features take no part.

## Carry-over from the slice A review

- `unrolledProject` must also lower `meta.maxTravelZ` by the radius (it is an
  absolute height compared with clamp tops in `clamps.ts`; floor at 0), with a
  test.
- Give `FlatFace`, `MachiningSetup.kind` and `isAroundSetup` in
  `src/types/project.ts` doc comments in the style of their neighbours.

## Tests

Extend the existing test files next to each changed module (keep every
existing assertion; existing Top/Bottom tests must pass unmodified), and add
one end-to-end model test (new file, e.g.
`src/store/helpers/aroundFace.test.ts` or wherever the store-level setup tests
live): round bar + rotary machine → switch to Around → the provisional setup
becomes real when a feature is added → the feature is stamped `'around'` with
Top-style heights → add a pocket and an engrave operation → both generate with
`a` on every point → encode the project to file form and decode it → deep
equal, including `kind` → generate again → identical. Then the refusals:
change face to/from Around; moving an operation across; a Top operation
targeting an Around feature and the reverse; a through hole on Top not
offered to Around; a model import on Around; a tab on Around; the CAM plan on
Around; Around on a block stock, with no rotary machine, with the machine on
the other axis; a file with `kind: 'sideways'`; a feature reaching the
centreline; the bar turned into a block after the fact (blocked, not thrown).
And: paste from Top to Around and back (no mirror, top at the surface, same
depth); a 3.3 file with no `kind` loads byte-for-byte as before (compare the
re-encoded file).

Mutations, one at a time, restored from a `cp` backup (never `git checkout`);
name the failing test or report a survivor: `setupFace` ignoring `kind`;
`decodeSetups` dropping `kind`; the cache key ignoring `kind`;
`featureReachableFromFace` letting a through feature into Around;
`newFeatureSpan` giving Around the Bottom span; `findSetupWithTurn` matching
Around to Top; the centreline block removed; paste applying the Bottom mirror.

## Checks to run and report

The two `tsc --noEmit` commands; `npx eslint` on changed files; `npx tsx` on
every test file you changed or added, plus `src/engine/aroundFrame.test.ts`,
`setupOrientation.test.ts`, `setupFrameProject.test.ts`,
`setupTargets.test.ts`, `setupReach.test.ts`,
`src/i18n/warningsCoverage.test.ts`, `registry.test.ts`, `catalog.test.ts`;
`npm run check:i18n`; `npx tsx scripts/check-license-headers.ts`;
`npm run docs:check` (if the sandbox blocks it, run its two scripts directly
and say so). One test process at a time. Do not run `npm run build`,
`npm test` or any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, then **the audit
table**: one line for every B and G site and every "unclear" N site in the
model layer, as `file — function — what it does for Around now`; the list of
sites you left for the UI, export and simulation slices; the mutation table;
the locale keys added per file; and `RISKS`: anything that surprised you, any
rule above you think is wrong (say so rather than work around it), any
face-dependent site you found that the audit missed, and anything you did not
do.
