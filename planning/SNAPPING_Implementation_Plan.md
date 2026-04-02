# Snapping Implementation Plan

Legend:
- `[ ]` not started
- `[~]` in progress / partial
- `[x]` complete
- `[>]` deferred / moved to backlog

## Goal
Replace the current grid-only sketch snapping with a more capable, CAD-style snap system that supports multiple snap sources and can be toggled from an always-visible toolbar.

The new system should:
- stay fast during mouse move
- remain predictable
- show clear visual feedback for what is being snapped to
- work for feature creation, move, resize, rotate, origin placement, tabs, clamps, and backdrops

## First-Pass Scope
The first pass should support these snap modes:
- `Grid`
- `Point`
  - feature/profile vertices
  - tab/clamp rectangle corners
- `Line`
  - nearest point on line/arc/bezier/polyline sample
- `Midpoint`
  - line midpoint
  - arc midpoint
- `Center`
  - circle center
  - arc center
  - rectangle/feature bounding-box center where applicable
- `Perpendicular`
  - from the active reference point to a target line/curve

The first pass should not include:
- inferencing from dimensions/constraints
- 3D snapping
- text-specific snapping
- multi-object snap tracking history

## Candidate Future Snap Types
These are good follow-up candidates, but not required in v1:
- `Intersection`
- `Tangent`
- `Quadrant`
  - circle cardinal points
- `Parallel`
- `Horizontal/Vertical`
- `Extension`
  - infinite continuation of a segment
- `Centerline`
  - center between two parallel lines / opposite edges
- `Stock corners / stock center`
- `Origin`

## Confirmed Direction
### 1. Always-visible snap toolbar
The snap controls should always be visible, not hidden in a dialog.

Recommended location:
- follow the existing main toolbar location rules
- top-toolbar mode: in the main header, alongside the other tool groups
- left-toolbar mode: in the vertical rail, below the creation/edit groups

Reason:
- snapping is a live drafting mode, not a rare setting
- users need to see and change it without leaving the canvas workflow
- it should not create a second competing toolbar pattern

### 2. Snap modes are toggles, not a single dropdown
The toolbar should use toggle buttons.

Recommended behavior:
- multiple modes can be active at once
- `Grid` can be toggled independently
- there should also be:
  - `All`
  - `None`

Reason:
- matches CAD expectations
- avoids burying common combinations

### 3. Snapping should be context-aware
The system should not treat all snap types equally in all situations.

Examples:
- `Perpendicular` only makes sense when the current tool already has a reference point
- `Center` should prefer true circle/arc centers over arbitrary bounding-box centers
- `Midpoint` should only appear for segment types where it is well-defined

Reason:
- reduces noisy/irrelevant snap candidates
- makes cursor behavior more stable

## Data Model
Recommended app/session settings:

```ts
type SnapMode =
  | 'grid'
  | 'point'
  | 'line'
  | 'midpoint'
  | 'center'
  | 'perpendicular'

interface SnapSettings {
  enabled: boolean
  modes: SnapMode[]
  pixelRadius: number
}
```

App/session storage:
- app-local UI state
- optional `localStorage` persistence for convenience
- not saved into `.camj`

Reason:
- snapping is an editing preference, not part of project intent
- users may change it frequently while drafting
- a loaded project should not unexpectedly overwrite the current session snap setup

## UI
### Snap Toolbar
Recommended buttons:
- `Snap` master toggle
- `Grid`
- `Point`
- `Line`
- `Mid`
- `Center`
- `Perp`
- `All`
- `None`

Recommended behavior:
- master `Snap` off disables all snapping without losing the selected mode set
- `All` enables all currently implemented modes
- `None` clears all modes

### Visual Feedback
Need clear graphics for:
- current snapped cursor point
- snap source type
- optional guide line for inferenced snaps

Examples:
- point snap: small filled circle
- midpoint: triangle/diamond
- center: hollow circle + crosshair
- perpendicular: right-angle marker
- line snap: projected point + faint guide

## Runtime Model
### 1. Raw cursor point
Start with unsnapped world coordinates from the canvas transform.

### 2. Build candidate set
Collect candidates from visible/selectable sketch geometry:
- features
- stock
- tabs
- clamps
- origin
- backdrop bounds only if we later decide it matters

Candidate structure:

```ts
interface SnapCandidate {
  mode: SnapMode
  point: Point
  score: number
  distancePx: number
  guide?: {
    kind: 'projection' | 'perpendicular'
    from?: Point
    to?: Point
  }
  sourceId?: string
}
```

### 3. Filter by active snap modes
Only evaluate enabled modes.

### 4. Rank candidates
Recommended ranking:
1. within snap radius
2. lower semantic priority number
3. smaller screen-space distance

Suggested semantic priority:
1. explicit reference snaps
  - `point`, `center`, `midpoint`
2. inferenced snaps
  - `perpendicular`
3. continuous snaps
  - `line`
4. fallback
  - `grid`

Reason:
- avoids line/grid snapping stealing the cursor from more exact geometry anchors

### 5. Resolve final snapped point
Return:
- snapped world point
- candidate metadata for drawing

When snapping is enabled, active point-pick tools should commit only to a resolved snap.
That means:
- click-to-place workflows ignore clicks that do not currently resolve a snap
- commit uses the resolved snapped point, not the unsnapped cursor location
- turning snapping off restores free point picking immediately

## Geometry Rules
### Point snap
Sources:
- profile vertices
- tab/clamp corners
- stock corners
- origin location

### Line snap
Sources:
- line segments: true orthogonal projection
- arcs/beziers: sampled approximation in v1

### Midpoint snap
Sources:
- line midpoint
- arc midpoint
- bezier midpoint by `t=0.5` approximation in v1

### Center snap
Sources:
- true circle center
- true arc center
- optional rectangle/stock center

For arbitrary composite shapes:
- do not invent geometric center in v1 unless explicitly defined

### Perpendicular snap
Needs:
- active reference point from the current operation

Examples:
- second point of a line-like action
- move target after source chosen
- resize/rotate reference stage where appropriate

Rule:
- project the current reference point onto target lines/curves
- only offer if the projection is near the cursor in screen space

## Integration Points
### Sketch canvas
Centralize snapping into one helper:

```ts
resolveSketchSnap(input: {
  rawPoint: Point
  project: Project
  viewTransform: ViewTransform
  context: SnapContext
}): ResolvedSnap
```

Then use it in:
- mouse move preview
- click placement
- move/copy tools
- resize/rotate tools
- origin placement
- tab/clamp placement
- backdrop placement later if needed

### Snap context
The resolver should receive context such as:

```ts
interface SnapContext {
  tool:
    | 'select'
    | 'add_rect'
    | 'add_circle'
    | 'add_polygon'
    | 'add_spline'
    | 'add_composite'
    | 'move'
    | 'copy'
    | 'resize'
    | 'rotate'
    | 'place_origin'
    | 'add_tab'
    | 'add_clamp'
  referencePoint?: Point | null
}
```

Reason:
- keeps perpendicular and similar inferenced snaps context-aware

## Performance Notes
- Use screen-space snap radius, not world-space radius
- Precompute visible geometry samples only when project/view changes, not on every mouse event
- Sample arcs/beziers conservatively in v1
- If needed later, build a simple spatial index for candidates

## Implementation Phases
### SN1. Settings model
- `[x]` add app-local `SnapSettings`
- `[x]` add localStorage persistence
- `[x]` do not store snapping in project files

### SN2. Toolbar
- `[x]` add snap toolbar that follows top/left toolbar layout
- `[x]` add master toggle
- `[x]` add per-mode toggles
- `[x]` add `All` / `None`

### SN3. Candidate extraction
- `[x]` add geometry helpers for point / line / midpoint / center candidates
- `[x]` add sampled curve candidates for arcs/beziers in v1

### SN4. Resolver
- `[x]` add central snap resolver
- `[x]` add candidate ranking / priority rules
- `[x]` add `ResolvedSnap` result with visual metadata

### SN5. Sketch integration
- `[x]` replace direct grid snapping in mouse move/click paths
- `[x]` integrate with feature creation
- `[x]` integrate with move/copy/resize/rotate
- `[x]` integrate with origin/tab/clamp placement

### SN6. Visual feedback
- `[x]` draw snap marker
- `[x]` draw guide lines / perpendicular hints
- `[x]` ensure feedback is visible but not noisy

### SN7. Validation
- `[x]` verify snapping priority feels stable
- `[x]` verify no noticeable lag in dense imported drawings
- `[x]` verify snapping does not break existing edit tools

## Open Questions
### 1. Should grid stay active by default?
Recommendation:
- yes
- keep current feel for simple users
- layer richer snapping on top

### 2. Should line snap include arcs/beziers exactly in v1?
Recommendation:
- no
- sampled approximation is acceptable first
- revisit exact nearest-point solving later

### 3. Should backdrop edges be snappable?
Recommendation:
- not in the first pass
- backdrop is a tracing aid, not design geometry

## Exit Criteria
This work is ready when:
1. snapping is controlled by a visible sketch toolbar
2. multiple snap modes can be enabled together
3. point/line/midpoint/center/perpendicular snapping works in the main sketch workflows
4. visual feedback makes the chosen snap unambiguous
5. existing grid snapping behavior is preserved when richer modes are disabled
6. active point-pick tools commit only on resolved snaps while snapping is enabled
