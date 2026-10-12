# Issue #392 slice A — round stock in the data model

You are the implementation worker for slice A of issue #392 (cylindrical
stock). Work only in your task worktree. Do not create, remove, merge, push or
switch branches or worktrees. Do not open a PR. Do not run `git add` or
`git commit`: leave your edits uncommitted and report `COMMIT: none`. `gh` may
be blocked; everything you need is in this file.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`. Base branch is
`integration/0.6.0`; project format stays `3.3` (no version bump); no
`process.` or `globalThis` in engine code; absolute paths for every write, no
`cd`. Make the smallest change that does the job; no refactor, no renames of
existing things.

## Why (plan approved by the maintainer, 2026-10-12)

`Stock` is an outline plus a thickness: a block. Round bar held on a rotary
axis cannot be described. This slice adds the round variant to the data model
only. No UI, no 3D drawing, no clamps, no toolpath or G-code change: those are
later slices, and they code against the names frozen below.

The approved design keeps `profile` and `thickness` on a round bar as **the
box the bar fits in**: `profile` is the rectangle the bar shows from above
(length × diameter) and `thickness` IS the diameter. The code reads
`stock.thickness` / `stock.profile` in about 119 places and nearly all want
that box, so they must keep compiling and behaving **with no edit**. The
existing setup pivot (`setupPivot` in `src/engine/setupOrientation.ts`: centre
of the stock bounds at mid-thickness) then lands on the bar's centreline.

## Frozen interface — `src/types/project.ts`

Replace `export interface Stock { ... }` with the following. Keep every
existing field, comment and field order of today's `Stock` in `StockBase`.

```ts
/** The project axis a round bar lies along and turns about. */
export type StockAxis = 'x' | 'y'

interface StockBase { /* every field of today's Stock, unchanged */ }

/** A block: an outline extruded by `thickness`. `shape` is absent in files written before round stock existed and is never written for a block. */
export interface BlockStock extends StockBase {
  shape?: 'block'
}

/**
 * A round bar lying along `axis`. `profile` is the rectangle the bar shows
 * from above (length along `axis`, diameter across it) and `thickness` is the
 * diameter, so every reader of the stock's box needs no round case.
 */
export interface RoundStock extends StockBase {
  shape: 'round'
  axis: StockAxis
}

export type Stock = BlockStock | RoundStock

export function isRoundStock(stock: Stock): stock is RoundStock
export function roundStock(diameter: number, length: number, axis?: StockAxis, at?: Point): RoundStock
export function roundStockDiameter(stock: RoundStock): number
export function roundStockLength(stock: RoundStock): number
/** The centreline's coordinate across the bar: a Y value for axis 'x', an X value for axis 'y'. */
export function roundStockCentre(stock: RoundStock): number
export function normalizeRoundStock(stock: RoundStock): RoundStock
```

Rules:

- **`shape` absent means block.** `defaultStock` and `stockFromFeature` keep
  returning an object with NO `shape` key, so every existing project, fixture
  and saved file is byte-identical. Do not add `shape: 'block'` anywhere.
- `isRoundStock`: `stock.shape === 'round'`.
- `roundStock(diameter, length, axis = 'x', at = { x: 0, y: 0 })`: `at` is the
  min corner of the rectangle. Axis `'x'`: `rectProfile(at.x, at.y, length,
  diameter)`. Axis `'y'`: `rectProfile(at.x, at.y, diameter, length)`.
  `thickness: diameter`. `material`, `color`, `visible`, `origin` exactly as
  `defaultStock` sets them (keep the `theme-exempt` comment on the colour
  line). No `sourceFeatureId` / `sourceFeature`.
- `roundStockDiameter`: `stock.thickness`.
- `roundStockLength`: the extent of `getStockBounds(stock)` along `axis`.
- `roundStockCentre`: the middle of `getStockBounds(stock)` across `axis`.
- `normalizeRoundStock`: returns a bar that obeys the invariant. The profile
  becomes a plain rectangle: along `axis` it keeps the bounds' min and max;
  across `axis` it is centred on the existing `roundStockCentre` and exactly
  `thickness` wide. `sourceFeatureId` and `sourceFeature` are removed (a bar
  cannot be derived from a feature). An `axis` that is not `'x'` or `'y'`
  becomes `'x'`. Everything else is kept. Calling it on its own result gives a
  deep-equal value.
- `defaultOrigin(stock)`: for a block, exactly today's result. For a round bar:
  axis `'x'` → `x: bounds.minX`, `y: roundStockCentre(stock)`; axis `'y'` →
  `x: roundStockCentre(stock)`, `y: bounds.maxY`; `z: stock.thickness`; same
  `name` and `visible` as today.
- `getStockBounds`, `profileExceedsStock`, `getEffectiveStockProfile`: no
  change.

## Loading — `src/store/helpers/projectFormat.ts` (`normalizeProject`)

Where `normalizeProject` rebuilds `stock` (the `stock: { ...authoritativeProject.stock, profile: {...} }`
object near the `dedupeProjectIds` call), make the loaded stock canonical:

- raw `shape === 'round'` → a `RoundStock` passed through
  `normalizeRoundStock` (after the existing `closed ?? true` handling);
- anything else (`shape` absent, `'block'`, or an unknown value) → a block
  with **no `shape` key and no `axis` key**. Existing files must come out of
  `normalizeProject` exactly as they do today.

Then read `src/store/helpers/normalize.ts` around the block that re-derives the
stock from `stock.sourceFeature` (it sets `thickness` from the source feature's
`z_top`): a round bar must skip it. Also read `src/import/normalize.ts` and
`src/import/camj.ts` where they touch `stock`; change them only if they would
drop `shape` / `axis` from a project's own stock, and say what you found.

Do not edit any file under `src/engine/toolpaths/`, `src/engine/gcode/`,
`src/machine/`, `src/components/`, `src/i18n/`, or `src/engine/csg.ts`. If the
union makes one of those files fail to compile, STOP and report the file and
the error instead of editing it: the design says they need no edit, and a
compile error there is a finding.

## Tests (plain `assert` + `npx tsx <file>.test.ts`, the repo's convention)

Add `src/types/roundStock.test.ts` (with the licence header every source file
carries; copy it from a neighbour) and extend the existing project-format test
that covers `normalizeProject` round trips (find it with
`grep -rl normalizeProject src --include='*.test.ts'`):

1. `roundStock(20, 100, 'x')`: bounds 100 × 20, thickness 20, `axis 'x'`,
   length 100, diameter 20, centre 10. Same for `'y'` with the bounds swapped.
   `at` moves the rectangle and the centre with it.
2. `isRoundStock(defaultStock())` is false and `'shape' in defaultStock()` is
   false; `'shape' in stockFromFeature(...)` is false.
3. `normalizeRoundStock` repairs a bar whose across-axis width disagrees with
   its thickness (keeps the centreline, keeps the length), for both axes;
   strips `sourceFeatureId`; maps a bad `axis` to `'x'`; is idempotent.
4. `defaultOrigin`: block result unchanged (assert the exact object against
   today's formula); round `'x'` and round `'y'` as specified above.
5. `setupPivot(roundStock(20, 100, 'x', { x: 5, y: 7 }))` (from
   `src/engine/setupOrientation.ts`, test only, do not edit that file) is
   `{ x: 55, y: 17, z: 10 }`: on the centreline, at mid-diameter. Same idea
   for `'y'`.
6. Round trip: a project with a round bar goes through the same save/load path
   the existing round-trip test uses and comes back deep-equal, `shape` and
   `axis` included.
7. A block project: after `normalizeProject` its stock has no `shape` key and
   no `axis` key, and the serialized project is identical to what the same
   input produced before your change (compare against the existing fixture or
   expectation the test already has; do not regenerate a golden file).
8. Loading `shape: 'banana'` gives a block; loading a round bar with
   mismatched width gives the repaired bar.

Every existing test must pass unchanged. Do not edit, weaken or regenerate any
existing fixture, golden file or assertion; if one fails, STOP and report it.

Mutations, one at a time, restored from a `cp` backup (never `git checkout`).
For each, name the test that fails, or report it as a survivor:

- `normalizeRoundStock` stops forcing the across-axis width to `thickness`;
- `normalizeProject` treats a stock with no `shape` as round;
- `normalizeProject` drops `axis` from a round bar;
- `roundStock` swaps length and diameter for axis `'y'`;
- `defaultOrigin` uses the block corner for a round bar.

## Checks to run and report

- `npx tsc -b` (the whole project must compile with no edit outside the files
  named here; list every file you changed);
- `npx eslint` on the files you changed;
- `npx tsx` on each test file you added or changed, plus
  `src/types/project.test.ts`, `src/engine/setupOrientation.test.ts`,
  `src/engine/setupFrameProject.test.ts`, `src/import/camj.test.ts` and the
  project-format tests;
- `npx tsx scripts/check-license-headers.ts`.

Do not run `npm run build`, `npm test`, or any browser test: the manager runs
those. Never start more than one test process at a time.

## Docs

If `ARCHITECTURE.md` or `PROJECT.md` describes the fields of `Stock`, add the
round variant in one or two plain sentences. Otherwise leave docs alone.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS` (each command and
its result), the mutation table, and `RISKS`: anything that surprised you,
every place you saw that builds or copies a `Stock` in a way that could lose
`shape` / `axis` (object literals listing fields one by one, `defaultStock(...)`
calls that rebuild the stock from its size), and anything you did not do.
