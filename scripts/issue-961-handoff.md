# Issue #961 — plasma kerf-width preview and pierce markers: slice handoff

You are the implementation worker for ONE slice of issue #961 (the manager's
brief names which). Work only in your task worktree. Do not create, remove,
merge, push or switch branches or worktrees. Do not open a PR. Do not run
`git add` or `git commit`: leave your edits uncommitted and report
`COMMIT: none`. `gh` may be blocked in your sandbox; everything you need from
the approved plan is in this file.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`. Follow AGENTS.md for the
Apache source header, strict TypeScript and focused tests. Base branch is
`integration/0.6.0`; project format stays 3.3; no `process.` or `globalThis`
anywhere you touch. Absolute paths for every write, no `cd`.

## What the feature is (approved plan, 2026-10-11)

Display only. No engine, G-code, store, format or locale change. No new option,
toggle or theme colour. For operations of kind `plasma_profile` only; every
other operation must draw exactly as today.

| View | After |
|---|---|
| 2D sketch | a translucent band one kerf wide under the existing centre line; the lead part of the band in the plunge colour, the contour part in the cut colour; a fixed-size marker at each pierce |
| 3D view | the same band and markers at the top of the sheet |
| Simulation tab | the uncut sheet with the same band and markers for the plasma operations in scope |

Plasma rules the preview must follow:

1. The band is centred on the torch path and exactly one kerf wide. The kerf is
   the torch's diameter: `2 * normalizeToolForProject(tool, project).radius`,
   the same value `src/engine/toolpaths/plasma.ts` offsets by. The band's edge
   must land on the drawn part line.
2. Leads are cut at full kerf too: the band covers `lead_in`, `cut` and
   `lead_out` moves.
3. The pierce marker marks a place, not a size: fixed size in screen pixels,
   never scaled with zoom.

Visibility reuses the existing switches (`ToolpathVisibility`): contour band
with `cuts`, lead band with `leadIns`, pierce markers with `plunges`. Selected,
unselected and muted operations keep the existing strengths
(`toolpathStrokeAlpha` in 2D, `toolpathOverlayOpacity` in 3D).

Not changed: the centre line, arrows, export, the printed booklet and design
print, milling simulation, playback (stays unavailable for a plasma operation).

## Frozen interfaces (later slices code against these; do not rename)

`src/components/plasmaKerfPreview.ts` (slice A creates it):

```ts
export interface PlasmaKerfPoint { x: number; y: number }
export interface PlasmaKerfSegment { fromX: number; fromY: number; toX: number; toY: number }
export interface PlasmaKerfGeometry {
  /** Every `cut` move, in move order. */
  contour: PlasmaKerfSegment[]
  /** Every `lead_in` and `lead_out` move, in move order. */
  leads: PlasmaKerfSegment[]
  /** The `to` of every `plunge` move, in move order (plasma.ts writes one per cut). */
  pierces: PlasmaKerfPoint[]
}
/** Share of the ordinary stroke strength the band is drawn at. */
export const PLASMA_KERF_BAND_ALPHA = 0.35
/** Pierce marker radius in screen pixels. */
export const PLASMA_PIERCE_MARKER_RADIUS_PX = 5
/**
 * Kerf width in project units for the operation with this id, or null when it
 * is not a `plasma_profile` operation with a plasma torch of finite, positive
 * diameter. Uses findOperationTool + normalizeToolForProject.
 */
export function plasmaKerfWidth(project: Project, operationId: string): number | null
/** Pure split of the moves; cached by toolpath identity in a WeakMap, like `toolpathLayerBuckets`. */
export function plasmaKerfGeometry(toolpath: { moves: readonly ToolpathMove[] }): PlasmaKerfGeometry
```

Stock space throughout: the coordinates are the moves' own x and y.

## Slice A — model and 2D sketch

Files: new `src/components/plasmaKerfPreview.ts` + `plasmaKerfPreview.test.ts`;
new `src/components/canvas/plasmaKerfBand.ts` + `plasmaKerfBand.test.ts`;
`src/components/canvas/renderSketchToolpaths.ts` (and its test if one of its
assertions needs extending). Nothing else.

`plasmaKerfBand.ts` exports two functions taking the same entry list
`renderSketchToolpaths` already builds (`{ toolpath, emphasized, muted }`):

- `drawPlasmaKerfBands(ctx, project, entries, vt, visibility)`: for each entry
  whose `plasmaKerfWidth` is not null, stroke the contour segments (when
  `visibility.cuts`) in `canvasColors().toolpathCut` and the lead segments (when
  `visibility.leadIns`) in `canvasColors().toolpathPlunge`. One path per colour
  per entry. `lineWidth = width * vt.scale`, `lineCap` and `lineJoin` `'round'`,
  no dash, `globalAlpha = toolpathStrokeAlpha(emphasized, muted) * PLASMA_KERF_BAND_ALPHA`.
  Map points with `worldToCanvas` from `viewTransform.ts` (it handles the
  mirrored Bottom view); do not transform the context. Wrap in
  `ctx.save()` / `ctx.restore()`.
- `drawPlasmaPierceMarkers(ctx, project, entries, vt, visibility)`: when
  `visibility.plunges`, at each pierce draw a ring of radius
  `PLASMA_PIERCE_MARKER_RADIUS_PX` (stroke 1.5 px) and a filled centre dot of
  radius 1.5 px, both in `canvasColors().toolpathPlunge`, at
  `globalAlpha = toolpathStrokeAlpha(emphasized, muted)`.

In `renderSketchToolpaths`: call `drawPlasmaKerfBands` on the BASE `ctx`
straight after `entries` is built, before the GPU/Canvas line drawing (the GPU
canvas and the foreground canvas sit above the base canvas, so both line
renderers end up on top of the band). Call `drawPlasmaPierceMarkers` last, on
the context the function returns (the foreground when the GPU drew, else the
base), after the mirrored `ctx.restore()`. The function's return value and its
existing behaviour must not change for a project with no plasma operation.

Tests (the repo's plain `assert` + `npx tsx file.test.ts` style; register the
new test files wherever `scripts/run-tests.ts` discovers them):

- `plasmaKerfPreview.test.ts`: width equals the torch diameter in project
  units, for an mm project and an inch project (build the project and torch the
  way `src/engine/toolpaths/plasma.test.ts` does); null for a milling
  operation, for a plasma operation without a tool, for an unknown id. Geometry
  on a real `generatePlasmaProfileToolpath` result: `contour.length +
  leads.length` equals the number of torch-on moves (`cut`, `lead_in`,
  `lead_out`); one pierce per cut, equal to the first lead-in point of that
  cut; rapids contribute nothing; a milling toolpath gives empty arrays; the
  same toolpath object returns the same cached object.
- The kerf-edge check (rule 1), on the plasma.test.ts fixtures: for an outside
  contour and for a hole, every contour segment's distance to the part outline
  equals `width / 2` within 1e-6, so the band edge lies on the part line.
- `plasmaKerfBand.test.ts` with a recording fake context: band stroked with
  `lineWidth === width * vt.scale`; contour and lead colours differ; each of
  `cuts`, `leadIns`, `plunges` switched off removes exactly its own part; a
  non-plasma entry draws nothing; in `renderSketchToolpaths` the band calls
  come before the first toolpath line stroke and the markers after the last.

Then break the code on purpose and confirm a test fails for each: halve the
width, drop the leads, drop the plasma-only guard in `plasmaKerfWidth`. Restore
from a `cp` backup, never `git checkout`. Report the survivors, if any.

## Slice B — 3D view and Simulation tab

Files: new `src/components/viewport3d/plasmaKerfObjects.ts` + test;
`src/components/viewport3d/Viewport3D.tsx`; `src/app/useSimulationModel.ts`;
`src/components/simulation/SimulationViewport.tsx`; `src/App.tsx` only to pass
the new prop through. Nothing else. `src/app/**` has an ESLint `max-lines` of
530: keep `useSimulationModel.ts` under it.

`plasmaKerfObjects.ts`:

```ts
/** [x, topZ, y, x, topZ, y] per segment — the world mapping of toolpathPointToWorldTuple. */
export function plasmaKerfSegmentPositions(segments: readonly PlasmaKerfSegment[], topZ: number): Float32Array
/** [x, topZ, y] per pierce. */
export function plasmaPiercePositions(pierces: readonly PlasmaKerfPoint[], topZ: number): Float32Array
export interface PlasmaKerfObjectOptions {
  width: number; topZ: number
  cutColor: number; leadColor: number
  emphasized: boolean; muted: boolean
  resolution: THREE.Vector2
  showContour: boolean; showLeads: boolean; showPierces: boolean
}
export function buildPlasmaKerfObjects(geometry: PlasmaKerfGeometry, options: PlasmaKerfObjectOptions): THREE.Object3D[]
```

- Band: `LineSegments2` + `LineMaterial` exactly as `buildToolpathOverlay` in
  `Viewport3D.tsx` builds its lines, but `worldUnits: true` and
  `linewidth: options.width`, `opacity = toolpathOverlayOpacity(0.98, emphasized, muted) * PLASMA_KERF_BAND_ALPHA`,
  `transparent: true`, `depthWrite: false`, `depthTest: false`. Contour in
  `cutColor`, leads in `leadColor`. Chunk long lists the way
  `buildToolpathLinePositionChunks` does.
- Markers: one `THREE.Points` with `PointsMaterial({ size: 2 * PLASMA_PIERCE_MARKER_RADIUS_PX, sizeAttenuation: false, color: leadColor, transparent: true, depthWrite: false, depthTest: false })`
  and a small ring `THREE.DataTexture` built in code as its `map` (no DOM, so
  the module loads under `npx tsx`). Make sure the texture is disposed with the
  object by the viewports' existing dispose paths; extend them if they do not
  dispose a material's `map`.
- `Viewport3D.tsx`: in the effect that builds `nextObjects`, for a toolpath
  whose `plasmaKerfWidth(projectRef.current, toolpath.operationId)` is not
  null, put the kerf objects BEFORE that toolpath's line objects so the centre
  line draws on top. `topZ = project.stock.thickness`, colours
  `threePalette.toolpathCut` / `threePalette.toolpathPlunge`, the three show
  flags from `toolpathVisibility` (`cuts`, `leadIns`, `plunges`), the same
  `emphasized` and `muted` the lines get. The existing resize handling that
  updates `resolution` on `LineSegments2` materials must cover the new ones.
- Simulation: `useSimulationModel` returns one more field,
  `simulationPlasmaKerf: readonly { operationId: string; width: number; geometry: PlasmaKerfGeometry }[]`,
  memoized: in `'selected'` mode the selected operation when it is a plasma
  cut with a toolpath in hand; otherwise every enabled, shown plasma operation
  of the simulated setup, read from `setupInput.project` / `setupInput.toolpaths`
  (read, never generate). Empty when the tab is not `simulation`. Leave
  `simulationResult`, `simulationOperationCount` and `simulationPlaybackInput`
  exactly as they are. `SimulationViewport` takes it as a new prop
  `plasmaKerf` and adds `buildPlasmaKerfObjects` for each item to its scene
  (`topZ = simulation.grid.stockTopZ`, all three show flags true, emphasized,
  not muted), removing and disposing them when the list or the simulation
  changes. Confirm the scene uses the same world mapping as `Viewport3D`
  (`[x, z, y]`); if it does not, say so in RISKS and map accordingly.

Tests: `plasmaKerfObjects.test.ts` — positions arrays (values and length);
`buildPlasmaKerfObjects` returns no object for a switched-off part and none for
empty geometry; the band material has `worldUnits === true` and
`linewidth === width`; contour and lead materials differ in colour. A unit test
for the `simulationPlasmaKerf` selection if `useSimulationModel` has a testable
pure seam; otherwise extract the selection into a small pure function in a new
file under `src/app/` and test that. Mutations: `worldUnits: false`, and
dropping the plasma check in the simulation selection, must each fail a test.

## Slice C — browser test

File: one new `e2e/plasmaKerfPreview.smoke.spec.ts` (model it on
`e2e/plasmaMode.smoke.spec.ts` for seeding, machine selection and adding a
plasma operation; put it in the same lane that spec is in, wherever lanes are
declared). You cannot run a browser: write it carefully against the existing
helpers and say it was not run.

- 2D: a project with a plasma machine, a torch and a plasma through-cut on a
  closed feature. Read canvas pixels with `page.evaluate` on the sketch canvas:
  a pixel on the torch path differs from the same pixel with Cuts, Lead-ins and
  Plunges all switched off; switching Cuts back on alone restores the contour
  band but not a lead pixel. Compute the probe points from the operation's
  generated toolpath (use whatever seam the existing specs use to read
  toolpaths from the page), not from hard-coded coordinates.
- Simulation tab: opening it with the plasma operation selected shows no error
  overlay and the WebGL canvas is present. Do not pixel-probe WebGL.
- No stored screenshots.

## Required checks (every slice)

`npx tsx` on each test file you add or change; `npx tsc -b`; `npx eslint` on
the files you changed. Do not run the full `npm run build` or `npm test`: the
manager runs the gates. Do not claim an unrun check passed.

Finish with exactly:

```
STATUS: complete | blocked
COMMIT: none
CHANGED_FILES: <comma-separated paths>
CHECKS: <each command and pass/fail result>
MUTATIONS: <each mutation and whether a test caught it>
RISKS: <none or concise unresolved risks>
```
