# Issue #395 slice G1 — Around features in the 3D model

You are the implementation worker for one slice of issue #395 (an "Around"
face on a round bar). Work only in your task worktree. Do not create, remove,
merge, push or switch branches or worktrees. Do not open a PR. Do not run
`git add` or `git commit`: leave your edits uncommitted and report
`COMMIT: none`. `gh` may be blocked; everything you need is in this file.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`, `src/engine/INDEX.md`, then
in full `src/engine/aroundFrame.ts`, `src/engine/rotaryFrame.ts`,
`src/engine/csg.ts` (`roundBarGeometry`, `buildFeatureSolid`,
`buildBooleanModel`, `manifoldMeshToGeometry`, `buildFeatureMesh`,
`buildScene`), `src/engine/lineBatcher.ts`, `src/engine/csgAroundFace.test.ts`,
`src/engine/csgRoundStock.test.ts`, and the two Around comments in
`src/components/viewport3d/Viewport3D.tsx` (search `authoringFace !== 'around'`).
Absolute paths for every write, no `cd`. Smallest change that does the job; no
refactor; match the surrounding code. No `process.` or `globalThis` in engine
code. `node_modules` is a symlink: type-check with
`npx tsc -p tsconfig.app.json --noEmit` and
`npx tsc -p tsconfig.node.json --noEmit`, never `npx tsc -b`.

Another worker is building the simulation at the same time. **Do not touch**
`src/app/**`, `src/App.tsx`, `src/components/simulation/**`,
`src/engine/simulation/**`, `e2e/around3d.smoke.spec.ts`, any file under
`src/i18n/**`, `src/engine/aroundFrame.ts`, `src/engine/rotaryFrame.ts`. If you
think one of them must change, stop and say so in the report.

## What the user asked for

The maintainer tested the Around face and found that the 3D view draws Around
toolpaths but leaves Around **features** out of the model: changing one to Add
or Subtract shows nothing. Today `buildScene` filters them out (the comment
says "until wrapped display lands"). This slice lands it.

## Background you need

- A round bar: `thickness` is the diameter `D`, radius `R = D/2`, lying along
  `stock.axis` (`'x'` or `'y'`). `aroundFrame(stock)` gives `axis`, `centre`
  (the centreline's across coordinate), `radius`, `sheetStart`, `circumference`.
- An Around feature (`authoringFace === 'around'`) stores **sheet**
  coordinates: along the bar on the bar's axis, and across the unrolled surface
  on the other axis (Y for an X bar, X for a Y bar). Across is never reduced to
  one turn: a shape may lie on any turn, or span several.
- Its heights are stored Top-style: the surface is `z = D`, the centreline is
  `z = R`. So a height `z` is the radius `r = z − R` from the centreline.
- The frozen wrap (header of `aroundFrame.ts`): with
  `a = 2π·(across − sheetStart)/circumference`, a sheet point at radius `r`
  is the stock point `across' = centre + r·sin a`, `z' = R + r·cos a`, along
  unchanged. Use exactly this; do not invent a sign. `wrapPoint` followed by
  `stockSpacePoint(…, stock)` gives the same point and is what your tests must
  compare against.

## Rules (the approved design)

1. **A subtract** drawn on Around is a cut in the bar: its shape wrapped round
   the bar, from its top radius down to its bottom radius.
2. **An add** drawn on Around is an island: material left standing inside a
   surrounding cut. Inside a subtract that comes before it, it shows as
   standing material. Alone it shows nothing, because the bar is already solid.
3. A shape that crosses the seam, lies on another turn, or runs past one turn
   wraps onto the same bar (angles modulo one turn). One cut, never two halves
   with a gap.
4. Walls point at the centre (radial). Display only.
5. The "first feature must be Add" rule for flat features is untouched: Around
   features never count for it and never serve as a flat model's base.
6. Top and Bottom features draw exactly as before. A project with no visible
   Around feature must produce a `SceneObjects` identical to today's
   (position arrays compared exactly).

## Build

### a. A wrapped slab — new file `src/engine/aroundFeatureSolid.ts`

One exported function that turns one expanded Around feature (closed profile,
`add` or `subtract`) into a Manifold solid in **project coordinates** (the
same space `buildFeatureSolid` returns, before `manifoldMeshToGeometry`):

- Polygon from `profileToPolygon(feature.sketch.profile, arcStepRadians)` as
  `buildFeatureSolid` does. Fewer than 3 points, an open profile or a `line`
  operation → `null`. Imported models (`kind === 'stl'`) → `null`; they are a
  later issue.
- Radii: `rBottom = min(z_top, z_bottom) − R`, `rTop = max(…) − R`, resolved
  the way `buildFeatureSolid` resolves them, with the same `minRenderHeight`
  floor on the difference. Clamp `rBottom` to at least `minRenderHeight` so
  the slab never reaches the centreline. If `rTop` is at or above the surface
  (`rTop >= R − 1e-9`), extend it to `R + margin` (margin: 2 % of `R`) so a
  subtract breaks cleanly through the surface instead of leaving a skin
  coplanar with the bar's facets.
- Build it flat first (`CrossSection.ofPolygons(…, 'EvenOdd')`, extruded from
  `rBottom` to `rTop`, x/y still sheet coordinates), then curve it:
  - **Cut the cross-section into bands of at most a quarter turn** across
    (intersect with rectangles `[sheetStart + k·C/4, sheetStart + (k+1)·C/4]`
    over the shape's across extent). A warped piece longer than a turn would
    overlap itself, which Manifold's `warp` forbids.
  - **Refine each piece so no edge of its mesh spans more than 5° of turn** —
    every edge, including the triangles inside the top and bottom faces, or a
    large flat triangle will chord through the bar. Sheet distance across
    maps to angle as `distance / R` at every depth, so
    `Manifold.refineToLength(R · 5·π/180)` on the flat piece does this.
  - **`warp` every vertex** `(along, across, r)` to the stock point given
    above, for the bar's axis.
  - Union the pieces. Delete every intermediate Manifold and CrossSection
    (`try/finally`, as the neighbouring code does).

manifold-3d here is 3.3.2; `warp`, `refineToLength`, `Manifold.cylinder`,
`Manifold.union/difference/intersection` and `CrossSection.intersect` exist
(see `node_modules/manifold-3d/manifold-encapsulated-types.d.ts`).

### b. The bar as the base — `src/engine/csg.ts`

- A helper that builds the bar as a Manifold cylinder with the same
  dimensions and the same `ROUND_BAR_SEGMENTS` as `roundBarGeometry`, in
  project coordinates, so the model's uncut surface coincides with the stock
  mesh drawn over it.
- In `buildScene`, keep `visibleFeatures` flat-only for everything it feeds
  today, and collect the visible Around features separately (through
  `modelFeatures`, so construction geometry stays out, and only when the stock
  is a round bar).
- In the boolean model: when at least one visible Around **subtract** yields a
  solid, build the Around solid: start from the bar; walk the expanded Around
  features in project order; subtract → `difference`; add →
  `union(current, intersection(slab, bar))`, so restored material ends exactly
  at the bar's own surface. With no Around subtract, the Around solid does not
  exist and nothing changes (rule 2 and rule 6).
- The scene has one `modelMesh`. If a flat model also exists (a Top add came
  first), union the two solids into that one mesh; if only one exists, it is
  the mesh. A flat model alone is built by exactly the code path it has today.
- A failure in the Around part must not take the flat model down: catch it,
  `console.error` once, and fall back to the flat model as today.
- Replace the comment in `buildScene` that says Around features are never
  carved; keep the camera-fit and grid comments in `Viewport3D.tsx` true (the
  wrapped features lie inside the bar, so the bar's bounds already cover them
  and sheet coordinates must still stay out of those bounds). You should not
  need to edit `Viewport3D.tsx` at all.

### c. Around lines and open shapes — `src/engine/lineBatcher.ts`

Flat line features and open profiles are drawn in 3D as lines at their top
height. Around ones must be drawn too, on the bar: each segment subdivided so
no piece spans more than 5° of turn, each point wrapped with the same formula
at radius `z_top − R`, in the same world mapping the flat entries use
(read how `computeLineProfileBatch` lays out `positions` and how the batch is
placed in the scene before choosing). Same two colour batches as flat lines. A
line that runs 1.5 turns is drawn as 1.5 turns round the bar. For a project
with no Around feature the batch output is unchanged, value for value.

### d. Around regions (lowest priority)

A flat `region` feature gets a display-only mesh in `featureMeshes`
(`buildFeatureMesh`). Give an Around region the wrapped slab from (a) with the
region's material, as its `featureMeshes` entry. If that does not fall out of
(a) in a few lines, leave regions out and say so under RISKS; do not design
something new for it.

## Tests

`npx tsx`-style test files like their neighbours (plain asserts, license
header, a final `console.log('… passed')`).

New `src/engine/aroundFeatureSolid.test.ts`:

- A square pocket centred at a quarter turn on a 40 mm bar: every vertex of
  the slab lies between its two radii (within the 5° chord sag) and the
  vertices' mean angle is 90° on the side `wrapPoint` + `stockSpacePoint` say
  it is. **Both bar axes** (`'x'` and `'y'`).
- Its volume equals the annular sector's
  (`length · Δθ/2 · (rTop² − rBottom²)`, with the real `rTop` including the
  margin) within 0.5 %.
- No edge of the slab spans more than 5° of turn (check the mesh).
- A shape across the seam: one connected solid (`decompose().length === 1`)
  with the same volume as the same shape placed mid-sheet.
- The same shape one whole turn further along the sheet gives the same solid
  (compare volume and bounding box).
- A shape 1.5 turns long gives a solid whose volume is the full ring's, not
  1.5 rings'.
- An open profile, a line feature and an STL feature give `null`.

`src/engine/csgAroundFace.test.ts` — the "Around pocket changes nothing" test
is **replaced**, not kept beside the new ones:

- The scene with a Top pad, a Top pocket and an Around pocket differs from the
  scene with only the Top pad and Top pocket: the model's positions differ,
  and vertices exist at the pocket's bottom radius at the pocket's angle.
- An Around subtract alone on a bar: a model exists (no flat add needed), its
  bounding box is the bar's, and its volume (compute from the mesh or expose
  the solid to the test through a small exported helper) is the bar's minus
  the annular sector's, within 0.5 %.
- An Around add alone: `modelMesh` is `null` and the scene equals the bare
  bar's, exactly.
- Subtract then add inside it: volume is the bar minus the subtract plus the
  add (island stands). Add then subtract over it: the add has no effect.
- A project with no Around feature: `sceneSummary` is identical with and
  without the code change's path being reachable (compare against a project
  whose only difference is an invisible Around subtract: `visible: false`
  must draw nothing).
- An Around line: `batchedLinesMeta.segmentCount` grows, and every drawn
  point is at radius `z_top − R` from the centreline (within 1e-6), for a line
  1.5 turns long, whose drawn angles cover more than 360°.
- A Y-axis bar: one of the cases above again, so the axis branch is tested.

New `e2e/aroundModel.smoke.spec.ts` (you cannot run it; the manager will, and
will fix it against the real page, so keep it small and say what you
assumed): copy the minimum of the fixture in `e2e/around3d.smoke.spec.ts`
(`seedAroundProject` and the constants it needs) into the new file — do not
import from a spec file, do not edit that file, and do not edit
`e2e/selectors.ts` (the other worker owns both; use the selectors that
exist). Open the 3D tab, wait for the generation gear to read "up to date", and assert the
model exists through a new `data-model-triangles` attribute on the
`.viewport-3d` element next to the existing `data-toolpath-*` attributes
(triangle count of `modelMesh`, absent when there is none) — that attribute is
the one edit you may make in `Viewport3D.tsx`. Then take two screenshots with
`testInfo.outputPath`: the default view, and one after a left-drag of about
−60 px on the canvas for a low angle.

## Mutations

One at a time, restored from a `cp` backup (never `git checkout`); name the
failing test or report a survivor: the sine and cosine swapped in the warp;
the sign of the angle flipped; the quarter-turn banding removed; the refine
step removed; the add's `intersection` with the bar removed; the Around solid
built when there is no Around subtract; an invisible Around feature drawn;
the Y-bar branch using the X-bar's axes; the line's radius using `z_bottom`.

## Checks to run and report

The two `tsc --noEmit` commands; `npx eslint` on changed files; `npx tsx` on
every test file you changed or added, plus `src/engine/csgRoundStock.test.ts`,
`src/engine/lineBatcher.test.ts`, `src/engine/aroundFrame.test.ts`,
`src/engine/constructionExclusion.test.ts`,
`src/components/viewport3d/toolpathOverlay.test.ts`;
`npx tsx scripts/check-license-headers.ts`; `npm run docs:check` (add the new
file to `src/engine/INDEX.md`). One test process at a time. Do not run
`npm run build`, `npm test` or any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, one line per
rule and per build section saying what you did, the mutation table, what the
browser spec assumes about the page, and `RISKS`: anything that surprised
you, any rule above you think is wrong (say so rather than work around it),
anything you did not do, and how long the model takes to build for a
full-sheet subtract on a 40 × 200 mm bar (time it in a test and give the
number and the triangle count).
