# Issue #392 slice C — chuck and tailstock keep-outs

You are the implementation worker for slice C of issue #392 (cylindrical
stock). Work only in your task worktree. Do not create, remove, merge, push or
switch branches or worktrees. Do not open a PR. Do not run `git add` or
`git commit`: leave your edits uncommitted and report `COMMIT: none`. `gh` may
be blocked; everything you need is in this file.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`, `src/store/INDEX.md`,
`src/i18n/INDEX.md`, `src/i18n/GLOSSARY.md`. Base branch is
`integration/0.6.0`; project format stays `3.3`; absolute paths for every
write, no `cd`. Smallest change that does the job; no refactor; match the
surrounding code.

## What exists (slices A and B, already on your branch)

- `src/types/project.ts`: `Stock = BlockStock | RoundStock` (a bar has
  `shape: 'round'`, `axis`, a rectangle `profile` of length × diameter and
  `thickness` = diameter; a block has no `shape` key), `isRoundStock`,
  `roundStock`, `roundStockDiameter`, `roundStockLength`, `roundStockCentre`,
  `normalizeRoundStock`, `defaultOrigin`.
- `src/store/helpers/stockShape.ts`: `toRoundStock`, `toBlockStock`,
  `resizeRoundStock`, `originAfterStockEdit`.
- `workpieceSlice.ts`: `setStockAndOrigin(stock, origin)`.
- `PropertiesPanel.tsx`: the stock panel's Shape / Diameter / Length / Axis.
- `e2e/roundStock.smoke.spec.ts`.

The bar's start end is `minX` for axis `'x'` and `maxY` for axis `'y'`; the
far end is the other one.

## Background you need

A `Clamp` is a rectangle seen from above (`x`, `y`, `w`, `h`) plus `height`.
`src/engine/toolpaths/clamps.ts` forbids the cutter inside that rectangle
below `clamp.height + clearance`, where Z is measured from the stock's bottom
face (Z = 0) and the bar's top is at Z = diameter, its centreline at
Z = diameter / 2. **Do not edit anything under `src/engine/`**: the existing
check must cover a chuck with no change, which is the point of this design.
`ClampType` exists but nothing reads it yet.

A chuck or a tailstock is round about the bar's axis. Seen from above it is a
rectangle centred on the bar's centreline, and that rectangle is the same at
every index angle. Its top is half its own diameter above the centreline.

## What to build (approved plan; one automatic behaviour)

### 1. Types — `src/types/project.ts`

`ClampType` gains `'chuck' | 'tailstock'`. Nothing else changes in `Clamp`.

### 2. Pure helpers — new `src/store/helpers/roundWorkholding.ts` (+ test)

```ts
export function isRoundWorkholding(clamp: Clamp): boolean          // type is 'chuck' or 'tailstock'
/** The clamp's diameter: its size across the bar's axis (h for axis 'x', w for axis 'y'). */
export function roundWorkholdingDiameter(clamp: Clamp, stock: RoundStock): number
/** A chuck or tailstock at its default place and size on this bar. */
export function defaultRoundWorkholding(type: 'chuck' | 'tailstock', stock: RoundStock, units: ProjectMeta['units']): Pick<Clamp, 'type' | 'x' | 'y' | 'w' | 'h' | 'height'>
/** Every chuck and tailstock centred on the centreline with its height derived. Returns the SAME project object when nothing needs changing. */
export function syncRoundWorkholding(project: Project): Project
```

- Default size (lengths converted with `convertLength(…, 'mm', units)`):
  diameter = the larger of `2 × bar diameter` and 50 mm; body = 40 mm.
  A **chuck** sits at the start end: along the axis it covers `grip` inside
  the bar plus the body beyond the bar's end, where `grip` = 15 mm but never
  more than a quarter of the bar's length. A **tailstock** sits at the far
  end: it touches the bar's end face (no overlap) and extends the body length
  beyond it. Across the axis both are centred on `roundStockCentre(stock)`.
- `height` for both, always: `bar diameter / 2 + own diameter / 2`.
- `syncRoundWorkholding`: when the stock is a bar, every clamp with
  `isRoundWorkholding` is moved across the axis so it is centred on the
  centreline (its own across-size is kept) and its `height` is set by the rule
  above. Its position and size along the axis are never touched. Other clamps
  are never touched. When the stock is a block, nothing is touched. If no
  clamp changes, return the same `project` object (identity matters: the
  store compares projects and React memoizes on them); otherwise return a new
  project with a new `clamps` array in which unchanged clamps keep their
  object identity. It never adds or removes a clamp.

### 3. Run the sync in two places only

- Store: `src/store/projectStore.ts` builds `set` as
  `withAutoDirty(withSetupSync(withGhostSelectionGuard(rawSet)))`. Read how
  `withSetupSync` reconciles every project written through `set`, and make
  workholding sync part of the same pass (extend that wrapper or add a sibling
  wrapper beside it, whichever is smaller; keep `projectStore.ts` under its
  ESLint `max-lines` 600). After this, a stock resize, a clamp drag, a corner
  drag (`moveClampControl`), a duplicate, a unit conversion and undo/redo all
  leave chucks and tailstocks centred with the right height, with no change in
  those actions.
- Load: `normalizeProject` (`src/store/helpers/projectFormat.ts`) applies
  `syncRoundWorkholding` once the stock and clamps are normalized.

### 4. Shape switch becomes one helper and one action

- In `src/store/helpers/stockShape.ts` add
  `projectWithStockShape(project: Project, shape: 'block' | 'round'): Project`:
  - to `'round'`: stock = `toRoundStock(project.stock)`; origin =
    `defaultOrigin` of the new stock, keeping the origin's `name` and
    `visible`; if the project has no clamp of type `'chuck'`, append one named
    `Chuck` from `defaultRoundWorkholding('chuck', …)` (new id the way
    `clampsSlice.addClamp` makes ids, `visible: true`);
  - to `'block'`: stock = `toBlockStock(project.stock)`; origin =
    `defaultOrigin` of the block the same way; every chuck and tailstock clamp
    is removed;
  - same shape as now: return the same project object.
- `workpieceSlice.ts` / `store/types.ts`: add `setStockShape(shape)`, modelled
  on `setStockAndOrigin` (ONE history entry). If a removed clamp was selected,
  clear that selection the way `deleteClamp` does.
- `PropertiesPanel.tsx`: the Shape select calls `setStockShape`; remove the
  panel's own `switchShape` composition.

### 5. Corrections to slice B (same file, do them here)

- The Shape field must be hidden in plasma mode **only when the stock is a
  block**. A bar under a plasma machine still shows it, so the user can go
  back to a block.
- The comment `a bar is a lathe workpiece` is wrong (this is a rotary axis on
  a router, and the product is explicitly not a lathe). Say that plasma is
  sheet work.

### 6. Clamp properties — `PropertiesPanel.tsx`, single-clamp panel only

Only when the stock is a bar:

- a **Type** `Select` (Clamp / Chuck / Tailstock) after the name. "Clamp"
  stands for every existing type: it shows for `step_clamp`, `toe_clamp`,
  `vacuum_zone`, `vise_jaw`, and choosing it sets `step_clamp`. Choosing Chuck
  or Tailstock patches the clamp with `defaultRoundWorkholding(type, …)`.
- for a chuck or tailstock: a **Diameter** number field (reuse the
  `featureTree.properties.diameter` key) that patches the across-axis size,
  and NO height/Z control (the height is derived; the store sync sets it).

On a block the clamp panel is exactly as today. The bulk clamp panel is not
changed. Add stable test hooks and `e2e/selectors.ts` entries.

### 7. Locales (en, de, fr, es, zh-CN)

Only new keys, next to their neighbours, each file's own quote style, no
existing value changed: `Type` (reuse an existing key in the namespace if one
exists), `Clamp`, `Chuck`, `Tailstock`. Clamp names (`Chuck`, like today's
`Clamp 1`) are project data and stay English, as existing names do.

## Do not touch

`src/engine/**` (tests may import from it), `src/machine/**`,
`src/components/viewport3d/**`, `src/components/canvas/**`,
`src/components/simulation/**`, `NewProjectDialog.tsx`. Drawing chucks as
cylinders is slice D. If something there fails to compile, STOP and report.

## Tests

`src/store/helpers/roundWorkholding.test.ts` (plain `assert`, licence header):

- defaults for a 20 × 100 mm bar on X: chuck 50 across, centred on the
  centreline, from `minX − 40` to `minX + 15`, height `10 + 25`; tailstock
  from `maxX` to `maxX + 40`. A 40 mm bar gets 80 across. A 30 mm long bar
  grips 7.5. The same in inches (values converted). The same for axis `'y'`
  (start end is `maxY`).
- `syncRoundWorkholding`: recentres a chuck dragged off the centreline and
  keeps its across-size; sets height after a diameter change; leaves a
  `step_clamp` alone; returns the same object for a block project, for a bar
  with no chuck, and for an already-synced bar (`===`); unchanged clamps keep
  identity.
- `projectWithStockShape`: to round adds exactly one chuck, moves the origin
  and does not add a second chuck when one exists; to block removes chucks and
  tailstocks and keeps other clamps; same shape returns the same object.
- **The existing check covers a chuck** (import `applyClampWarnings` /
  `expandedClampBounds` from `src/engine/toolpaths/clamps.ts`, build the
  project and toolpath the way `src/engine/toolpaths/clamps.test.ts` or its
  nearest neighbour does): a cut move through the chuck's rectangle below its
  top is reported with the existing clamp warning; the same move above
  `height + clearance` is not; a move beside the chuck but over the bar is
  not.
- Store level (as `src/store/setups.test.ts` does): Block → Round bar →
  undo restores stock, origin and clamps in ONE step; resizing the bar's
  diameter through the store leaves the chuck centred with the new height;
  `moveClampControl` on a chuck leaves it centred; loading a saved bar project
  whose chuck is off-centre repairs it; a block project with ordinary clamps
  comes out of `normalizeProject` identical to before your change.

Browser spec: extend `e2e/roundStock.smoke.spec.ts` (keep its assertions):
after switching to Round bar a clamp named `Chuck` is in the tree and the
origin is on the bar's centreline (read the project the way other specs read
state); selecting the chuck shows Type and Diameter and no Z control;
switching back to Block removes the chuck; one undo brings the bar and the
chuck back. With a plasma machine selected: a block hides Shape, a bar still
shows it. You cannot run a browser; say it was not run.

Every existing test must pass unchanged; do not edit, weaken or regenerate an
existing fixture, golden file or assertion. If one fails, STOP and report it.

Mutations, one at a time, restored from a `cp` backup (never `git checkout`);
name the failing test or report a survivor:

- `syncRoundWorkholding` stops setting `height`;
- `syncRoundWorkholding` returns a new object when nothing changed;
- the store wrapper no longer calls the sync;
- `projectWithStockShape` to round does not move the origin;
- `projectWithStockShape` to block keeps the chuck;
- the chuck's default height uses the full bar diameter instead of half.

## Checks to run and report

`npx tsc -b`; `npx eslint` on changed files; `npx tsx` on each test you added
or changed plus `src/store/helpers/stockShape.test.ts`,
`src/types/roundStock.test.ts`, `src/store/featureReferencesMigration.test.ts`,
`src/store/setups.test.ts`, `src/engine/toolpaths/clamps.test.ts` if it
exists, `src/i18n/registry.test.ts`; `npm run check:i18n`;
`npx tsx scripts/check-license-headers.ts`. Never more than one test process
at a time. Do not run `npm run build`, `npm test` or any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, the mutation
table, the locale keys added per file, and `RISKS`: anything that surprised
you, every write path you found that bypasses the store's `set` wrapper,
anything the 3D slice (drawing the bar and its chuck as cylinders) will trip
over, and anything you did not do.
