# Source Refactoring Plan

## Overview

The project has grown to the point where several files are becoming difficult to
maintain and create high merge-conflict risk when working in parallel. The main
hot spots are:

| File | Approx. size | Problem |
|---|---:|---|
| `src/store/projectStore.ts` | 200KB+ | Monolithic store with state, actions, helper types, and utility logic mixed together |
| `src/components/canvas/SketchCanvas.tsx` | 150KB+ | Rendering, interaction, math, hit-testing, overlays, and React wiring all in one component |
| `src/components/cam/CAMPanel.tsx` | 50KB+ | Every operation editor lives in one file |
| `src/components/feature-tree/PropertiesPanel.tsx` | 39KB+ | Per-node property UIs all live in one file |
| `src/components/layout/Toolbar.tsx` | 32KB+ | All toolbar groups and contextual tool modes in one component |
| `src/styles/layout.css` | 35KB+ | Layout, toolbar, panel, form, and canvas chrome mixed together |

The goals are:
- reduce merge conflicts when multiple agents or people work in parallel
- establish files with clearer ownership
- make files easier to reason about and review

The target is usually under ~500 lines, but cohesion matters more than an
absolute cutoff.

---

## 1. `projectStore.ts` → phased extraction, then Zustand slices

This is the most important refactor because the store is the central coupling
point for almost every feature.

### Phase A: extract types and pure helpers first

Before moving to full Zustand slices, pull low-risk shared surface area out of
the file:

```
src/store/
  projectStore.ts         ← still owns the single Zustand store and runtime actions
  types.ts                ← SelectionState, pending tool/session types, ProjectStore interface
  helpers/
    ids.ts                ← genId, syncIdCounter, nextPlacementSession
    geometry.ts           ← clonePoint/addPoint/subtractPoint/normalizePoint/etc.
    clipping.ts           ← executeClipPaths, executeClipTree, offsetClipperPaths
    derivedFeatures.ts    ← join/cut/offset derived feature generation helpers
```

This reduces import coupling immediately because components can import types
from `src/store/types.ts` instead of importing runtime store code just to get a
type.

**Status:** in progress
- extracted `src/store/types.ts`
- moved consumer type imports off `projectStore.ts`
- extracted helper modules:
  - `src/store/helpers/ids.ts`
  - `src/store/helpers/geometry.ts`
  - `src/store/helpers/clipping.ts`
  - `src/store/helpers/derivedFeatures.ts`
  - `src/store/helpers/normalize.ts`
- started runtime slices:
  - `src/store/slices/selectionSlice.ts`
  - `src/store/slices/pendingActionsSlice.ts`
  - `src/store/slices/pendingCompletionSlice.ts`
- `projectStore.ts` reduced from ~7177 lines to ~5034 lines

### Phase B: move runtime logic into slices

Once Phase A helpers are real modules, split the runtime store:

```
src/store/
  index.ts
  types.ts
  helpers/
    ids.ts
    geometry.ts
    clipping.ts
    derivedFeatures.ts
  slices/
    projectSlice.ts
    featureSlice.ts
    operationSlice.ts
    toolSlice.ts
    clampSlice.ts
    tabSlice.ts
    selectionSlice.ts
    sketchEditSlice.ts
    importSlice.ts
```

Parallel work value:
- features, tools, operations, clamps, and tabs stop colliding
- selection and sketch-edit changes become localized

---

## 2. `SketchCanvas.tsx` → pure modules + thin component shell

`SketchCanvas.tsx` currently mixes at least four different concerns:

1. view-transform / coordinate math
2. low-level draw primitives
3. scene and overlay drawing
4. interaction / hit-testing / pending tool state machines
5. React lifecycle and canvas wiring

### Proposed structure

```
src/components/canvas/
  SketchCanvas.tsx         ← thin React shell
  viewTransform.ts         ← worldToCanvas, canvasToWorld, computeViewTransform
  drawPrimitives.ts        ← arrows, diamonds, text badges, handles
  drawScene.ts             ← stock, grid, backdrop, origin
  drawFeatures.ts          ← feature/profile drawing
  drawOverlays.ts          ← toolpaths, clamps, tabs, pending previews, snap overlay
  hitTest.ts               ← feature/control/clamp/tab hit-testing
  interactionHandlers.ts   ← pointer/wheel/key handlers
  manualEntry.ts           ← transform manual-entry helpers
  measurements.ts          ← sketch/transform measurement helpers
```

This should be done incrementally:
- extract pure math first
- then draw primitives
- then scene/feature drawing
- interaction last

**Status:** in progress
- extracted `src/components/canvas/measurements.ts`
- extracted `src/components/canvas/viewTransform.ts`
- extracted `src/components/canvas/profilePrimitives.ts`
- extracted `src/components/canvas/scenePrimitives.ts`
- extracted `src/components/canvas/hitTest.ts`
- extracted `src/components/canvas/draftGeometry.ts`
- extracted `src/components/canvas/draftHelpers.ts`
- extracted `src/components/canvas/manualEntry.ts`
- extracted `src/components/canvas/snappingHelpers.ts`
- extracted `src/components/canvas/previewPrimitives.ts`
- `SketchCanvas.tsx` reduced from ~5873 lines to ~3527 lines

---

## 3. `CAMPanel.tsx` → per-operation editor components

This is UI-only complexity and is a good candidate for a registry-driven split.

### Proposed structure

```
src/components/cam/
  CAMPanel.tsx
  OperationHeader.tsx
  editors/
    PocketEditor.tsx
    SurfaceEditor.tsx
    EdgeEditor.tsx
    CarvingEditor.tsx
    VCarveEditor.tsx
    OperationTargetPicker.tsx
    FinishPassOptions.tsx
```

`CAMPanel.tsx` should keep selection/list management and use an editor registry
to render the operation-specific form.

---

## 4. `PropertiesPanel.tsx` → per-node subpanels

Same pattern as CAM:

```
src/components/feature-tree/
  PropertiesPanel.tsx
  panels/
    EmptyPanel.tsx
    ProjectPanel.tsx
    StockPanel.tsx
    GridPanel.tsx
    OriginPanel.tsx
    BackdropPanel.tsx
    FolderPanel.tsx
    FeaturePanel.tsx
    ClampPanel.tsx
    TabPanel.tsx
```

---

## 5. `Toolbar.tsx` → grouped components, shared button

Keep one toolbar container, but split the groups:

```
src/components/layout/
  Toolbar.tsx
  toolbar/
    ToolButton.tsx
    ViewControls.tsx
    DrawTools.tsx
    TransformTools.tsx
    BooleanTools.tsx
    SketchEditTools.tsx
```

Avoid over-abstracting into a giant metadata DSL. Group-level extraction is the
right first step.

---

## 6. CSS split

Keep the CSS split coarse rather than creating many tiny stylesheets.

### Proposed structure

```
src/styles/
  base.css
  layout.css
  canvas.css
  toolbar.css
  panels.css
  forms.css
  dialog.css
```

---

## Suggested execution order

1. **Store Phase A**
   - extract `src/store/types.ts`
   - extract pure helper modules
   - keep runtime behavior unchanged

2. **Store Phase B**
   - move runtime logic to slices once the helper boundaries are real

3. **SketchCanvas**
   - pure math/draw extraction first
   - interaction extraction last

4. **CSS split**
   - low-risk and can be parallelized

5. **CAMPanel / PropertiesPanel / Toolbar**
   - each can be split independently once the store refactor has stabilized

---

## Rules of thumb

- Prefer behavior-preserving extractions over broad rewrites.
- Extract pure functions before moving stateful logic.
- Components should not import store runtime code only to access types.
- Utility/math modules must stay synchronous and side-effect-free.
- Refactors should reduce ownership overlap first, not just line counts.
