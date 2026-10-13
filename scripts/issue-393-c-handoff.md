# Issue #393 slice C — reading the angle back, and keeping it everywhere else

You are the implementation worker for slice C of issue #393 (rotary axis
contract). Work only in your task worktree. Do not create, remove, merge, push
or switch branches or worktrees. Do not open a PR. Do not run `git add` or
`git commit`: leave your edits uncommitted and report `COMMIT: none`. `gh` may
be blocked; everything you need is in this file.

Read first: `INDEX.md`, `PROJECT.md` (CNC safety contract), `AGENTS.md`,
`src/engine/gcode/INDEX.md`, `ARCHITECTURE.md` §8,
`scripts/gcode-conformance/README.md`. Base branch is `integration/0.6.0`;
project format stays `3.3`; no `process.` or `globalThis` in engine code;
absolute paths for every write, no `cd`. Smallest change that does the job; no
refactor. `node_modules` in this worktree is a symlink to the primary
checkout's; if a tool cannot run because of that, STOP and say so in the first
line of your report.

## What exists (slices A and B, on your branch)

- `src/engine/gcode/types.ts`: optional `rotary` block on a machine
  (`about: 'x' | 'y'` the PROJECT axis the bar lies along, `drive: 'own' |
  'borrowed'`, `reversed`, `inverseTimeFeed: { on, off } | null`) and helpers
  `rotaryWord` (`'A'`, or the borrowed motor's machine letter), 
  `rotaryBorrowedAxis`, `rotaryDirection`.
- `ToolpathPoint.a?: number`: degrees the stock is turned to when the tool is
  at that point; absent = no rotary component.
- Export (`utils.ts`, `arcFitting.ts`, `motionPipeline.ts`, `postprocessor.ts`):
  the angle is written under `rotaryWord`, times `rotaryDirection`, never
  reduced modulo 360; a turning move is never an arc; a borrowed motor's
  linear coordinate is never written; a turning feed move is written in
  inverse time (`G93` … `G94`), `F = feed / length` with
  `length = sqrt(linear² + (mean radius × Δθ)²)`; four refusals. Read
  `rotaryOutput.test.ts` for the emitted text.
- A round bar: `isRoundStock`, `roundStockCentre(stock)` (the centreline's
  coordinate across the bar), centreline height Z = `stock.thickness / 2`.

## What to build

### 0. One bug left in slice B (fix first) — `splitRapid`, `motionPipeline.ts`

Rule: the angle word is never written on a block that has a Z word. Today
`splitRapid({x:0,y:0,z:0,a:0}, {x:0,y:0,z:10,a:20})` returns
`[{ z: 10, a: 20 }]`: when Z rises and the bar turns with no XY change, the
angle is attached to the Z block. It must return `[{ z: 10 }, { a: 20 }]`.
The angle rides the XY block when there is one, otherwise a block of its own;
never the Z block, in either order. Add the missing cases to
`testSplitRapidRotary` (`motionPipeline.test.ts`): rise + turn with no XY;
unknown start position with a turn and no XY difference. Mutation: attach the
angle to the last block again.

### 1. Sign convention, frozen — new `src/engine/rotaryFrame.ts` (+ test)

A point `{x, y, z, a}` says: the tool tip is at `(x, y, z)` in the project's
frame while the stock is turned to `a` degrees. Where on the *stock* is that?

```ts
/** The point of the unturned stock that is under the tool tip at `point` (issue #393). */
export function stockSpacePoint(point: ToolpathPoint, stock: RoundStock): { x: number; y: number; z: number }
/** The inverse: where the tool must be, with the stock turned to `a`, to touch `stockPoint`. */
export function toolSpacePoint(stockPoint: { x: number; y: number; z: number }, a: number, stock: RoundStock): ToolpathPoint
```

With `c = roundStockCentre(stock)`, `h = stock.thickness / 2`, `t` = `a` in
radians:

- axis `'x'`: `x' = x`; `y' = c + (y − c)·cos t + (z − h)·sin t`;
  `z' = h − (y − c)·sin t + (z − h)·cos t`.
- axis `'y'`: `y' = y`; `x' = c + (x − c)·cos t + (z − h)·sin t`;
  `z' = h − (x − c)·sin t + (z − h)·cos t`.

So with the tool straight above the centreline at radius `r`, the stock point
is `r·sin a` across and `r·cos a` up: as the angle grows from 0, material on
the positive side of the bar comes up under the tool. A point with no `a` is
returned unchanged (as `{x, y, z}`). `toolSpacePoint` is the exact inverse and
sets `a`. Tests: 0°, 90°, 180°, 270°, 360° (identity within 1e-9), 450° equals
90°, both axes, a point off the centreline, and the round trip in both
directions.

### 2. `machineToProjectPoint` — `src/engine/gcode/utils.ts`

Carries `a` back (divided by `rotaryDirection`), the exact inverse of
`projectToMachinePoint`; a point with no `a` returns exactly today's keys.

### 3. Reading a program back — `gcodeMotionParser.ts`, `motionDebug.ts`

The exported-motion view (issue #356) parses the emitted program and compares
it with the planned motion. Make it read a rotary program:

- the rotary word (`A`, or the borrowed motor's letter when the definition
  says so: that letter then carries an angle and is NOT a linear coordinate)
  becomes `a` on the parsed position, modal like the other axes;
- `G93` / `G94` (the definition's own `inverseTimeFeed.on` / `.off` strings)
  switch the feed mode; an `F` read in inverse-time mode is kept as inverse
  time and never shown or compared as a speed. If the view shows feeds,
  convert it for display with the same length the emitter used
  (`inverseTimeFeedValue`'s arithmetic, exported from `motionPipeline.ts`;
  reuse it, do not copy it);
- a program with no rotary word and no `G93` parses exactly as today.

Read how the parser is given the definition and how `motionDebug.ts` builds
points; keep the change inside those two files plus their tests. Round-trip
test: export the own-axis and the borrowed-motor programs from
`rotaryOutput.test.ts`'s fixtures, parse them, and get back the machine points
(x, y, z, a) and the turning/non-turning feed modes that were planned, with no
"unsupported word" report.

### 4. Places that silently drop the angle

- `src/engine/setupOrientation.ts` `halfTurn` (used by
  `canonicalToSetupPoint` / `setupToCanonicalPoint`) rebuilds `{x, y, z}` and
  drops `a`. Carry `a` through unchanged, and return no `a` key when the input
  has none (existing callers and tests must see identical objects).
- `src/engine/toolpaths/linearMoveOptimization.ts`: `isZeroLength` treats a
  move with unchanged x/y/z as zero-length even when its angle changes, so a
  rotation-only move is dropped; `canMerge` ignores the angle, so two collinear
  moves with different angles merge and the middle angle is lost. A move whose
  angle changes is never zero-length; two moves merge only when neither turns
  and they are at the same angle (absent counts as an angle of its own). Every
  existing optimizer test passes unchanged; a toolpath with no `a` is optimized
  exactly as before.
- Search for every other place that builds a `ToolpathPoint` or a move's
  `from`/`to` field by field (`{ x: …, y: …, z: … }`) on the path from a
  generator's result to export and to the 3D preview
  (`rg -n "x: .*y: .*z: " src/engine src/app src/components --glob '!*.test.*'`
  is a start). Fix the ones in `src/engine/gcode/**`, `setupFrameProject.ts`
  and `setupOrientation.ts` so `a` is carried. For `src/engine/simulation/**`
  and anything under `src/engine/toolpaths/` other than the optimizer, do NOT
  edit: list file and function in the report (simulation of a turning job is a
  later issue).

### 5. Real controller parsers — `scripts/gcode-conformance/`

Slice B added a borrowed-`Y` rotary case, but an own-axis `A` program cannot
be added because every case is run through every validator that claims its
machine, and the Grbl validator rejects `A`. Add an optional per-case list of
validator ids (`validators?: readonly string[]`; absent = all, as today) in
`corpus.ts`, honour it in `run.ts`, and add an own-axis `A` + `G93` case
restricted to the LinuxCNC validator. Update the README's case table. Existing
cases keep running on exactly the validators they run on today (assert this in
whatever unit test the harness has; if it has none, add a small one for the
selection function). Do not run the harness itself.

## Do not touch

`src/engine/simulation/**`, strategies under `src/engine/toolpaths/` other than
`linearMoveOptimization.ts`, `src/components/**`, `src/store/**`, locales,
`legacyMachineParity.json`, bundled machine JSON, `opensbpEmitter.ts`,
`sbpMotionParser.ts`. If one needs a change to compile, STOP and report it.

## Tests and mutations

Plain `assert` + `npx tsx <file>.test.ts`; licence header on new files. Every
existing test passes unchanged; do not edit, weaken or regenerate an existing
fixture, golden file or assertion (adding cases is fine); if one fails, STOP
and report it. Mutations, one at a time, restored from a `cp` backup (never
`git checkout`); name the failing test or report a survivor:

- item 0: the angle attached to the last block;
- `stockSpacePoint`: sign of the `sin` term flipped; axis `'y'` using the
  axis-`'x'` formula;
- `machineToProjectPoint` not dividing by the direction;
- the parser treating the borrowed letter as a linear coordinate;
- the parser ignoring `G94` (staying in inverse time);
- `halfTurn` dropping `a`;
- `isZeroLength` ignoring the angle; `canMerge` ignoring the angle;
- the harness ignoring `validators`.

## Checks to run and report

`npx tsc -b`; `npx eslint` on changed files; `npx tsx` on each test you added
or changed plus `src/engine/gcode/rotaryOutput.test.ts`,
`rotaryDefinition.test.ts`, `motionPipeline.test.ts`, `postprocessor.test.ts`,
`gcodeMotionParser.test.ts`, `motionDebug.test.ts`,
`legacyMachineParity.test.ts`, `setupExport.test.ts`,
`src/engine/setupOrientation.test.ts`, `src/engine/setupFrameProject.test.ts`,
and the optimizer's own tests; `npx tsx scripts/check-license-headers.ts`;
`npm run docs:check`. Never more than one test process at a time. Do not run
`npm run build`, `npm test`, `npm run check:gcode` or any browser test.

## Docs

`src/engine/INDEX.md` (the new file), `src/engine/gcode/INDEX.md`,
`ARCHITECTURE.md` §8: the sign convention in two sentences and that the
exported-motion view reads rotary programs.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, the mutation
table, the list from item 4 (fixed / deliberately not edited), and `RISKS`:
anything that surprised you, anything the machine-editor slice or the
"Around" face (#395: unroll a round bar's surface, generate flat, wrap with
`toolSpacePoint`) will trip over, and anything you did not do.
