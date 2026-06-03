# Measure & Dimensions — Handover

**Branch:** `claude/measure-dimensions-design-oXJuu` (pushed to origin)
**Status:** Feature implemented end-to-end; build green (`npm run build` = tsc + 22 tests + vite). Not yet PR'd. Plan still `In progress` at `planning/MEASURE_DIMENSIONS_Plan.md`.
**Design doc:** `planning/MEASURE_DIMENSIONS_Plan.md` (read its "Implementation notes" section for as-built deviations).

## What the feature does

1. **Tape measure** — transient tool. Click point A (snaps to geometry), live readout of distance + Δx + Δy + angle, click B to freeze; next click starts a new measurement. Esc/Done exits. Never persisted, never in undo history.
2. **Permanent dimensions** — aligned/parallel, horizontal, vertical, radius, diameter, angle. Stored as **anchors** (references to a feature's vertex/midpoint/center, the stock, or the origin) — *not* frozen coordinates — so value + graphics recompute live and follow geometry when it moves/edits. Select by clicking, drag the line to reposition (offset), delete via the delete tool or select + Delete key. Dangling (anchored feature deleted) → drawn muted with a ⚠ marker, not auto-removed.
3. **Delete tool** — trash button arms "click a dimension to delete" mode (hover highlights red, stays armed for multiple, Esc/Done exits).
4. **Global show/hide** — `project.meta.showDimensions` (persisted in `.camj`), toggled from the toolbar; gates rendering + hit-testing.

## Commits on the branch (oldest→newest)

```
60fc7f0 design plan
65ead66 confirmed v1 scope decisions
7460e0f data model, pure logic, snap provenance, store
40819c7 canvas rendering, interaction, toolbar
a8deeb1 plan as-built notes
21e45cc global show/hide toggle + toolbar icons
0ff3cbb desktop toolbar controls
1eb564c delete tool + instruction popups
```

## Architecture / key files

**Data model** — `src/types/project.ts`
- `DimensionAnnotation`, `DimensionAnchor`, `AnchorTarget`, `DimensionType`.
- New `Project.annotations: DimensionAnnotation[]` (distinct from the pre-existing parametric `Project.dimensions` map — do not confuse them).
- New `ProjectMeta.showDimensions: boolean`.
- A dimension never stores its measured value; value is computed live from anchors.

**Pure logic (unit-tested)** — `src/sketch/dimensions.ts` + `src/sketch/dimensions.test.ts`
- `resolveAnchor(anchor, project): Point | null` (null = dangling)
- `measureValue(dim, project)`, `dimensionLayout(dim, project)`, `offsetForCursor(dim, project, cursor)`, `dimensionLabelText(...)`, `isDimensionDangling(...)`, `angleBetween(...)`.
- Feature profiles are world coords (see `project.ts` `stockFromFeature` comment), so anchor indices match `profileVertices`/`segments` exactly — this is why auto-update is correct.

**Snap provenance** — `src/components/canvas/snappingHelpers.ts`
- `ResolvedSnap`/`SnapCandidate` gained optional `anchor?: DimensionAnchor`; `addProfileSnapCandidates` takes a `source: AnchorTarget | null`. Stock/features/origin carry provenance; tabs/clamps deferred (null). Purely additive.

**Units** — `src/utils/units.ts`
- `convertProjectUnits` converts `annotations` (free-anchor points, offset, labelOffset; angle/anchored refs untouched). Added `formatAngle`. Round-trip tested in `src/utils/units.test.ts`.

**Store** — `src/store/`
- `slices/dimensionsSlice.ts` — persistent `addDimensionAnnotation`/`updateDimensionAnnotation`/`deleteDimensionAnnotation`/`selectAnnotation` (history-tracked).
- `slices/dimensionToolSlice.ts` — transient tools: `tapeMeasure`, `pendingDimension`, `dimensionDeleteArmed` + their actions (`startTapeMeasure`, `tapeMeasureClick`, `clearTapeMeasure`, `startDimensionTool`, `setPendingDimensionType`, `pendingDimensionPick`, `cancelPendingDimension`, `setDimensionDeleteArmed`). Not in history.
- Wired in `projectStore.ts`; `normalizeProject` defaults `annotations: []` and `showDimensions: true` (legacy `.camj` safe). New top-level state fields: `selectedAnnotationId`, `tapeMeasure`, `pendingDimension`, `dimensionDeleteArmed`. Action signatures in `store/types.ts`.

**Rendering + interaction** — `src/components/canvas/`
- `dimensionRendering.ts` — `drawDimensions` (extension/dimension lines, arrowheads, labels, angle arcs; selected=blue, delete-hover=red, dangling=muted ⚠), `drawTapeMeasure`, `drawPendingDimensionPreview`, `pickDimensionAt`.
- `SketchCanvas.tsx` — draw layer (gated on `showDimensions`); click handling for tape/placement/delete/select; drag-to-reposition offset (begin/move/up + pointer-leave commit); Esc/Delete keys; `CanvasWorkflowPanel` instruction popups (tape / placement / delete) using `useCanvasWorkflowPanel`.

**Toolbar UI**
- Desktop: `src/components/layout/Toolbar.tsx` — `MeasureActions` group (tape, 6 dimension types, delete-trash, show/hide-eye) wired via `useToolbarState`; rendered in both `CreationToolbar` (vertical) and combined `Toolbar`.
- Tablet: `src/components/layout/DimensionPopover.tsx` — rendered in `TopCommandBar.tsx` next to `SnapPopover` (tablet-only; the snap popover does NOT exist on desktop — that was a correction made during development).

**Icons** — added `measure`, `dim-aligned/-horizontal/-vertical/-radius/-diameter/-angle`, `dim-visibility` to `src/assets/icons.camj`; regenerated `public/icons.svg` via `npm run sync-icons`. (Generator was a throwaway script at `/tmp/add-icons.mjs` — not in repo; edit `icons.camj` in-app or re-run sync if regenerating.)

## Build / verify

```
npm run build   # icons + tsc + 22 tests + vite — currently green
npm test        # structural tests only
```
Tests added: `src/sketch/dimensions.test.ts`, `src/utils/units.test.ts`.

## Known limitations / suggested follow-ups

- **Not visually verified in-app** — logic/rendering math are unit-tested, but no one has clicked through tape/placement/delete/drag in a running app. First local step: `npm run dev` and exercise each tool (desktop left toolbar + tablet popover).
- **Per-dimension visibility** — `DimensionAnnotation.visible` is honored by the renderer but has no per-item UI (only the global toggle). A feature-tree/list entry would close this.
- **textOverride / precisionOverride** fields exist on the model but have no editing UI yet (double-click-to-edit-label was scoped but not built).
- **Tabs/clamps** are not yet snappable dimension anchor targets (v1: features + stock + origin).
- **3D viewport / G-code / simulation** intentionally ignore dimensions (annotations are inert).
- **Radius/diameter** dimensions aren't drag-repositionable (offset not cursor-driven for those); label sits at midpoint.
- **Lint**: repo has a pre-existing lint baseline with errors (not gating the build); the measure/dimension files are lint-clean except inheriting SketchCanvas/Toolbar pre-existing warnings.

## To open the PR (when ready)

Per `AGENTS.md`: `git mv planning/MEASURE_DIMENSIONS_Plan.md planning/archive/`, set its frontmatter `status: Done`, remove its entry from `planning/INDEX.md`, then open the PR linking the archived plan.
