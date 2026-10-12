# Issue #392 slice B — choosing and sizing round stock

You are the implementation worker for slice B of issue #392 (cylindrical
stock). Work only in your task worktree. Do not create, remove, merge, push or
switch branches or worktrees. Do not open a PR. Do not run `git add` or
`git commit`: leave your edits uncommitted and report `COMMIT: none`. `gh` may
be blocked; everything you need is in this file.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`, `src/i18n/INDEX.md` and
`src/i18n/GLOSSARY.md`. Base branch is `integration/0.6.0`; project format
stays `3.3`; absolute paths for every write, no `cd`. Smallest change that does
the job; no refactor; match the surrounding code.

## What exists (slice A, already on your branch)

`src/types/project.ts`: `Stock = BlockStock | RoundStock`. A round bar has
`shape: 'round'` and `axis: 'x' | 'y'`; its `profile` is the rectangle it shows
from above (length along `axis`, diameter across) and its `thickness` IS the
diameter. A block has **no `shape` key at all**. Helpers: `isRoundStock`,
`roundStock(diameter, length, axis, at)`, `roundStockDiameter`,
`roundStockLength`, `roundStockCentre`, `normalizeRoundStock`, and
`defaultOrigin(stock)` (for a bar: start end, on the centreline, on top; the
start end is `minX` for axis `'x'` and `maxY` for axis `'y'`). Read them and
`src/types/roundStock.test.ts` before you start. Do not change their
behaviour.

## What to build (approved plan; one automatic behaviour, no extra options)

### 1. Pure helpers — new file `src/store/helpers/stockShape.ts` (+ test)

```ts
/** A block turned into a bar: the long side becomes the length, the thickness the diameter. */
export function toRoundStock(stock: Stock): RoundStock
/** A bar turned back into a block of the same box. */
export function toBlockStock(stock: Stock): BlockStock
/** A bar resized or re-aimed. Keeps the centreline and the start end. */
export function resizeRoundStock(stock: RoundStock, change: { diameter?: number; length?: number; axis?: StockAxis }): RoundStock
/** The origin after a stock edit: it follows the stock while it sits on the stock's default origin, and is left alone once the user has moved it. */
export function originAfterStockEdit(origin: MachineOrigin, before: Stock, after: Stock): MachineOrigin
```

- `toRoundStock`: axis `'x'` when the block's bounds are at least as wide (X)
  as tall (Y), else `'y'`; length = the long side, diameter = `thickness`;
  `at` = the bounds' min corner; `material`, `color`, `visible`, `origin`
  (the `Stock.origin` point field) carried over. No `sourceFeatureId` /
  `sourceFeature`. A stock that is already round is returned unchanged.
- `toBlockStock`: `rectProfile` over the bar's bounds, `thickness` = the
  diameter, same carried fields, and **no `shape` and no `axis` key**. A block
  is returned unchanged.
- `resizeRoundStock`: a new diameter keeps the centreline and the length; a
  new length keeps the centreline and the start end (`minX` for `'x'`, `maxY`
  for `'y'`); a new axis keeps the bounds' min corner, the length and the
  diameter. The result always satisfies `normalizeRoundStock(r)` deep-equals
  `r`.
- `originAfterStockEdit`: if `origin.x`, `.y`, `.z` equal
  `defaultOrigin(before)`, return `{ ...origin, x, y, z }` from
  `defaultOrigin(after)` (keep `name` and `visible`); otherwise return
  `origin` itself.

### 2. One store action

In `src/store/slices/workpieceSlice.ts` and `src/store/types.ts`, add
`setStockAndOrigin(stock: Stock, origin: Project['origin'])`, modelled exactly
on `setStock` (same equality short-circuit, same transaction and history
handling, ONE history entry). Register it wherever `setStock` is registered
(the action-name union at the top of the slice, any INDEX.md that lists store
actions).

### 3. Stock properties — `src/components/feature-tree/PropertiesPanel.tsx`

In the stock branch (the one that computes `isFeatureStock`):

- **Shape** field, first after the disabled name, using the panel's existing
  `Select`: Block / Round bar. Shown for a plain block and for a bar. NOT shown
  in the feature-derived stock panel (`isFeatureStock`), and NOT shown while
  the project is in plasma mode (find how #960 decides plasma mode: read
  `e2e/plasmaMode.smoke.spec.ts` and the helper the CAM panel uses, and reuse
  that helper; do not write a second rule).
  - Block → Round bar: `const next = toRoundStock(project.stock)`, then
    `setStockAndOrigin(next, { ...project.origin, ...defaultOrigin(next), name: project.origin.name, visible: project.origin.visible })`
    (the origin always moves to the bar's default: a block's corner is in the
    air on a bar).
  - Round bar → Block: `toBlockStock`, origin to `defaultOrigin` of the block
    the same way.
- For a bar the panel shows **Diameter**, **Length** and **Axis** (a `Select`:
  X / Y) in place of Width, Height and Thickness, then Colour and Visible as
  today. Each commit goes through `resizeRoundStock` and
  `setStockAndOrigin(next, originAfterStockEdit(project.origin, project.stock, next))`.
  Colour and Visible on a bar must keep the bar (spread the stock; do not call
  `defaultStock`).
- The block panel keeps its exact current behaviour and markup.
- Give the new controls stable hooks for the browser test, following how
  nearby controls are identified (ids or `data-testid`), and add them to
  `e2e/selectors.ts`.

### 4. Every other place that edits the stock

- `setStockDimension` (`workpieceSlice.ts`) rebuilds `profile` from a dragged
  width/height. For a bar: a change along the axis is a length change; a
  change across the axis is a diameter change (`thickness` must follow, and
  the result must be a canonical bar: `normalizeRoundStock(result)`
  deep-equals it). Keep which side is held as it is today. Blocks unchanged.
- `setStockSourceFeature` (same slice) and the matching code in
  `featureSlice.ts`: when a feature becomes the stock, the stock becomes a
  block: drop `shape` and `axis`. Resetting to a rectangle gives a block.
- Search for any other writer (`setStock(`, `stock: {`, `defaultStock(` in
  `src/store` and `src/components`) and make sure none can leave a round bar
  whose width and diameter disagree, or a block carrying `shape`/`axis`.
  Report each one you looked at. Do not touch `NewProjectDialog.tsx`: a new
  project starts as a block.

### 5. Loading — `src/store/helpers/projectFormat.ts`

`normalizeProject` has a legacy rule (`legacyDefaultOrigin`) that moves an
origin sitting on the stock's min corner. A round bar is never a legacy file:
make the rule skip a round bar, so a bar whose origin the user put on its min
corner reloads unchanged. Blocks unchanged. Add a test beside the round-stock
tests in `src/store/featureReferencesMigration.test.ts`.

### 6. Status bar — `src/components/layout/AppShell.tsx`

The stock size label (`appShell.status.stockDim`) reads width × height ×
thickness. For a bar show diameter and length instead, with a new key
`appShell.status.stockDimRound` (English: `Ø{diameter} × {length} {units}`,
matching how the existing key places its units). Block label unchanged.

### 7. Locales (en, de, fr, es, zh-CN)

Add only the keys you need, in every locale, next to their neighbours, in each
file's own quote style. English: `Shape`, `Block`, `Round bar`, `Diameter`,
`Length`, `Axis`, `X`, `Y`. Reuse an existing key when the same namespace
already has the word. Do not change any existing value, not even whitespace.
Follow `GLOSSARY.md` for "stock". Edit locale files with the edit tool, never
with a script that rewrites the file.

## Do not touch

`src/engine/**`, `src/machine/**`, `src/components/viewport3d/**`,
`src/components/canvas/**`, `src/components/simulation/**`,
`src/components/project/NewProjectDialog.tsx`, clamps of any kind (slice C),
3D drawing (slice D). If something there fails to compile, STOP and report it.

## Tests

`src/store/helpers/stockShape.test.ts` (plain `assert`, licence header):

- `toRoundStock(defaultStock(100, 80, 20))` is a 100 long, 20 diameter bar
  along X at the block's min corner; a 60 × 100 block gives axis `'y'`;
  a square block gives `'x'`; a block carrying `sourceFeatureId` loses it;
  colour, material and visibility survive.
- `toBlockStock(toRoundStock(b))` has the bar's box, no `shape`, no `axis`.
- `resizeRoundStock`: diameter change keeps centreline and length; length
  change keeps centreline and start end, for both axes; axis change keeps
  the min corner, length and diameter; every result is canonical.
- `originAfterStockEdit`: follows from the default place (x, y and z), keeps
  name and visibility, and returns the same object when the user had moved it.
- Reducer level (use the store the way existing slice tests do, e.g.
  `src/store/setups.test.ts`): Block → Round bar is ONE undo step and undo
  restores both stock and origin; `setStockDimension` on a bar across the axis
  changes the diameter and stays canonical; making a feature the stock of a
  round project yields a block with no `shape`/`axis`.

Browser spec `e2e/roundStock.smoke.spec.ts`, modelled on a small existing
spec (same fixtures, seeding and selectors style): open the stock properties,
switch to Round bar, assert Diameter / Length / Axis are shown and Width /
Height / Thickness are not, change the diameter and assert the status bar
label follows, switch the axis, undo once and assert the previous axis is
back, switch to Block and assert the block fields return. A second test: with
a plasma machine selected the Shape field is absent. You cannot run a browser;
say it was not run.

Every existing test must pass unchanged; do not edit, weaken or regenerate an
existing fixture, golden file or assertion. If one fails, STOP and report it.

Mutations, one at a time, restored from a `cp` backup (never `git checkout`);
name the failing test or report a survivor:

- `resizeRoundStock` keeps the min corner instead of the centreline on a
  diameter change;
- `originAfterStockEdit` always follows;
- `toBlockStock` leaves `shape` on the result;
- `setStockDimension` on a bar stops updating `thickness`;
- the legacy origin rule applies to a round bar again.

## Checks to run and report

`npx tsc -b`; `npx eslint` on changed files; `npx tsx` on each test you added
or changed plus `src/types/roundStock.test.ts`,
`src/store/featureReferencesMigration.test.ts`, `src/store/setups.test.ts`,
`src/i18n/catalog.test.ts`, `src/i18n/registry.test.ts`;
`npx tsx scripts/check-license-headers.ts`. Never more than one test process
at a time. Do not run `npm run build`, `npm test` or any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, the mutation
table, the list of stock writers you inspected, the locale keys added per
file, and `RISKS`: anything that surprised you, anything a later slice (chuck
and tailstock keep-outs; 3D cylinder) will trip over, and anything you did
not do.
