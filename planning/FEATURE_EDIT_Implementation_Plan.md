# Feature Edit Implementation Plan

Legend:
- `[ ]` not started
- `[~]` in progress / partial
- `[x]` complete
- `[>]` deferred / moved to backlog

## Goal
Add interactive feature editing tools so selected features can be edited directly from contextual toolbars instead of relying only on tree context menus or raw property edits.

The first implemented pass supports:
- `Copy`
- `Move`
- `Delete`
- `Resize`
- `Rotate`

The next sketch-edit pass should extend this with direct profile editing:
- `Add Point`
- `Delete Point`
- open-path `Extend`
- future `Round Corner / Fillet`

The next selected-feature toolbar pass should extend this with shape-generation tools:
- future `Join / Cut Overlaps`
- future `Offset / Repeat`

These tools should work from the sketch and use the same icon-strip toolbar pattern already established elsewhere in the app.

## First-Pass Scope
The first pass should support:
- selected sketch features only
- single-feature and multi-feature editing
- a contextual feature-edit toolbar that appears when one or more features are selected
- point-driven sketch interactions for resize and rotate
- live preview during the final placement step

The first pass should **not** include:
- clamp/tab resize or rotate
- numeric transform dialogs
- arbitrary pivot editing UI beyond the defined point workflow
- history of editable transform handles on-screen after commit

## Confirmed Interaction Model
### Contextual toolbars
When one or more features are selected, show a dedicated feature-edit toolbar with:
- `Copy`
- `Move`
- `Delete`
- `Resize`
- `Rotate`

This toolbar should be contextual, not always visible.

When a single feature enters `Edit Sketch`, replace that strip with a dedicated sketch-edit toolbar with:
- `Add Point`
- `Delete Point`
- future `Round Corner`

First implementation note:
- only `Add Point` and `Delete Point` need to be wired now
- `Round Corner / Fillet` remains a planned sketch-edit phase

When one or more closed features are selected in normal feature-selection mode, extend the existing selected-feature toolbar later with:
- `Join`
- `Cut`
- `Offset`

Reason:
- these create or derive whole new shapes
- they are not point-level sketch editing
- offset especially should be thought of as creating another feature from the selected one(s)

### Move / Copy
Use the existing sketch move/copy flow:
- first click defines source/reference point
- second click defines destination
- preview is shown before commit

### Resize
Resize uses three picked points:
1. first point defines the start of the reference
2. second point defines the end of the reference
3. moving toward a third point constrained to that same line previews the resize
4. click commits

Interpretation:
- the original distance from point 1 to point 2 is the reference length
- the preview distance from point 1 to point 3 defines the scale factor
- scaling is applied in the reference direction

### Rotate
Rotate also uses three picked points:
1. first point defines the rotation origin
2. second point defines the reference direction
3. moving to a third point previews the new angle
4. click commits

Interpretation:
- vector `(p2 - p1)` is the starting reference
- vector `(p3 - p1)` is the target reference
- the signed angle between those vectors is applied to the selection

### Sketch Edit: Add Point
`Add Point` is a click tool inside `Edit Sketch`.

Behavior:
- clicking an existing segment inserts a new anchor on that segment
- line segments split into two lines
- bezier segments split into two beziers
- arc segments split into two arcs
- on open paths, clicking the start or end anchor arms an extension from that end
- the next click places the new endpoint

First-pass constraints:
- insertion is geometry-first, not numeric
- extension should preserve spline feel when practical
- if an open path is edited back onto its opposite endpoint, closure should be detected automatically
- backdrop is not editable through this flow

### Sketch Edit: Delete Point
`Delete Point` is also a click tool inside `Edit Sketch`.

Behavior:
- clicking an anchor removes it
- open-path endpoints can be deleted to shorten the path
- internal anchors reconnect neighbors

First-pass constraints:
- reconnect with a straight segment if preserving the original primitive would require a larger solve
- reject deletions that would leave an invalid profile

### Sketch Edit: Round Corner / Fillet
Planned tool:
- click an eligible corner anchor
- preview a tangent fillet
- click to commit

Proper term:
- `Fillet` is the standard CAD term
- UI can still say `Round Corner` if that reads better to users

### Selected Feature Toolbar: Join / Cut Overlaps
Planned tools:
- `Join` combines overlapping closed features into one profile set
- `Cut` subtracts one overlapping profile from another

These should operate on feature profiles, not CAM solids.
They belong on the normal selected-feature toolbar, not inside `Edit Sketch`.

### Selected Feature Toolbar: Offset
Planned tools:
- `Offset`
- repeated offset count / distance later

This should eventually reuse the same offsetting foundations already used in CAM contour generation, but with sketch-safe output and preview.
Offset should create a new derived shape rather than mutate point topology one anchor at a time.
The first interactive version should use a single `Offset` button:
- move the snapped preview point inside the shape for inward offset
- move it outside the shape for outward offset
- click to commit using the current preview distance and direction

## Core Design Decisions
### 1. This is a sketch-space editing system
Resize and rotate operate in sketch XY only.

They do **not** change:
- `z_top`
- `z_bottom`
- operation assignments
- tool settings

### 2. Preview-first interaction is required
Resize and rotate should not commit incrementally after point 2.

After the first two clicks:
- the tool enters a preview state
- mouse movement updates the transformed preview
- final click commits

This matches the existing placement mentality and keeps the interaction predictable.

### 3. Multi-selection transforms use one shared reference frame
If multiple features are selected:
- the same resize transform is applied to all selected features
- the same rotation transform is applied to all selected features

For first pass, treat the selection as one group in sketch space.

### 4. Resize should be directional, not freeform box-scaling
The requested interaction is line-based.

So first pass resize should behave like simultaneous feature-local X/Y resizing derived from the picked reference line:
- the third point is constrained to the reference line
- each feature carries a stored local frame angle
- new features start with a default local frame aligned to the unrotated sketch
- rotate updates that local frame
- if the reference is parallel or near-parallel to one local side, only that side direction changes
- if the reference is parallel or near-parallel to the perpendicular side, only that direction changes
- if the reference is diagonal, both local side directions change together
- the result must stay a scale-style transform, not a shear/skew

Reason:
- matches the requested directional behavior
- gives pure X-only or Y-only resizing when the reference is axis-aligned
- naturally blends into mixed side-length change when the reference is diagonal

### 5. Rotation should preserve relative group layout
For multi-selection:
- all selected features rotate around the chosen origin point
- the same signed angle applies to each feature

This should preserve the group arrangement.

### 6. Existing move/copy actions should migrate into the contextual toolbar
The new toolbar should become the primary fast-access path for:
- copy
- move
- delete

Existing context menu entries can remain for now, but the toolbar becomes the standard workflow.

### 7. Sketch edit tools live inside the existing sketch-edit session model
`Edit Sketch` already creates a reversible session snapshot.

The new direct profile tools should reuse that:
- `Enter` applies the whole sketch edit session
- `Esc` restores the original feature
- point insert/delete should be undoable during the session and also fully revert on `Esc`

### 8. Sketch edit toolbar follows the existing toolbar layout rules
The sketch-edit toolbar should not float independently.

Rules:
- top-toolbar layout: render to the right of the creation toolbar
- left-toolbar layout: render below the creation toolbar
- use the same square joined-button treatment and sprite icons

## State Model
Current store already has:
- `pendingAdd`
- `pendingMove`

Resize and rotate should follow the same pattern by adding a dedicated transform-pending state rather than overloading `pendingMove`.

Recommended model:
```ts
type PendingTransformMode = 'resize' | 'rotate'

interface PendingTransformTool {
  mode: PendingTransformMode
  entityIds: string[]
  referenceStart: Point | null
  referenceEnd: Point | null
  session: number
}
```

Reason:
- resize/rotate are not simple translations
- they need 3-point staged input
- they need dedicated preview math
- they should remain parallel to the existing pending interaction system

## Geometry Rules
### Resize math
Given:
- `a = referenceStart`
- `b = referenceEnd`
- `c = previewPoint`

Compute:
- `u = normalize(b - a)`
- `refLength = dot(b - a, u)`
- `nextLength = dot(c - a, u)`
- `scale = nextLength / refLength`

Apply to each feature point:
1. constrain `c` to the line through `a -> b`
2. derive feature-local side axes from the stored feature frame angle
3. derive scale factors from the constrained reference components in that local basis
4. apply those scale factors in the feature-local basis about `a`

Important validation:
- reject or clamp near-zero `refLength`
- do not commit if `scale` is effectively zero

Arc note:
- non-uniform/directional resize does not preserve circular arcs
- for first pass, arc segments should be converted to cubic bezier segments during resize commit/preview

### Rotate math
Given:
- `a = rotation origin`
- `b = reference direction point`
- `c = preview point`

Compute:
- `start = normalize(b - a)`
- `end = normalize(c - a)`
- `angle = atan2(cross(start, end), dot(start, end))`

Apply:
- rotate every feature sketch point about `a` by `angle`
- increment the stored feature frame angle by that same signed angle

### Feature local frame
Each feature should carry a stored local frame angle used by transform tools.

Rules:
- default new feature frame angle is `90` degrees
- the angle represents the feature local `+Y` axis measured from project `+X`
- resize uses this frame instead of trying to infer direction from current geometry
- move and copy preserve the frame
- rotate updates the frame
- legacy projects without the field should be normalized with a fallback value or inferred angle

## Preview Requirements
### Resize preview
Show:
- reference line from point 1 to point 2
- live target line from point 1 to current preview point
- transformed feature preview

### Rotate preview
Show:
- origin marker at point 1
- reference ray to point 2
- live target ray to point 3 preview
- transformed feature preview

### Shared preview behavior
- preview should be sketch-only and non-destructive
- `Esc` cancels
- final click commits

## Toolbar Design
### Visibility
Show the feature-edit toolbar when:
- one or more features are selected
- not in sketch-edit handle mode for a single feature

Optional first-pass rule:
- keep it visible in normal feature selection mode only

### Orientation integration
The toolbar should work with both existing toolbar layouts:
- top toolbar mode
- left toolbar mode

Recommended first pass:
- render it as a contextual strip near the existing global/creation toolbar area
- keep the button set compact and icon-friendly

### Button set
Initial buttons:
- `Copy`
- `Move`
- `Delete`
- `Resize`
- `Rotate`

Sketch-edit buttons:
- `Add Point`
- `Delete Point`
- `Round Corner` / `Fillet` (tracked)

Selected-feature toolbar future additions:
- `Join` (tracked)
- `Cut` (tracked)
- `Offset` (tracked)

## UI Text / User Guidance
Resize banner copy:
- click first point to start reference
- click second point to define reference length
- move along the reference and click to commit resize

Rotate banner copy:
- click rotation origin
- click reference direction
- move to preview angle and click to commit rotation

## Implementation Phases
### FE1. Contextual feature-edit toolbar
- `[x]` add a feature-selection-aware toolbar strip
- `[x]` show it only when one or more features are selected
- `[x]` wire existing `copy`, `move`, `delete` actions into it
- `[x]` keep current project tree internals unchanged

### FE2. Pending transform store state
- `[x]` add `pendingTransform` store state
- `[x]` add actions:
  - `startResizeFeature`
  - `startRotateFeature`
  - `cancelPendingTransform`
  - `setPendingTransformReferenceStart`
  - `setPendingTransformReferenceEnd`
  - `completePendingTransform`
- `[x]` preserve undo/redo behavior parity with move/copy

### FE3. Resize preview in sketch
- `[x]` draw resize reference guides
- `[x]` draw transformed feature preview for single selection
- `[x]` draw transformed feature preview for multi-selection
- `[x]` support preview updates from pointer movement

### FE4. Resize commit behavior
- `[x]` apply directional scaling in sketch space from the reference line ratio
- `[x]` update selected feature profiles on commit
- `[x]` reject invalid zero-length reference cases
- `[x]` ensure history entry is created once per committed resize

### FE5. Rotate preview in sketch
- `[x]` draw rotation origin and direction guides
- `[x]` draw rotated preview for single selection
- `[x]` draw rotated preview for multi-selection
- `[x]` support preview updates from pointer movement

### FE6. Rotate commit behavior
- `[x]` apply signed-angle rotation in sketch space
- `[x]` update selected feature profiles on commit
- `[x]` ensure history entry is created once per committed rotate

### FE7. Interaction polish
- `[x]` add banner/help text for resize and rotate modes
- `[x]` support `Esc` cancel cleanly
- `[x]` ensure cursor/selection state resets after commit
- `[x]` verify toolbar visibility rules in both top and left toolbar orientations

## Risks / Edge Cases
### 1. Directional resize can change primitive representation
Directional resize of circular geometry no longer stays a true circular arc.

Risk:
- circles/arcs can no longer remain exact arc primitives after affine resize

Mitigation:
- convert affected arc segments to cubic beziers
- re-infer kind from the transformed profile

### 2. Negative scale / flip behavior
If point 3 crosses behind point 1 along the reference axis, scale becomes negative.

Recommendation for first pass:
- allow preview only while scale stays positive
- clamp or reject negative-scale commit

This avoids accidental mirroring in v1.

### 3. Multi-selection can feel ambiguous
Users may not immediately understand what is being resized when multiple unrelated features are selected.

Mitigation:
- preview all affected features clearly
- use the same transform for the whole selection
- keep the reference guides explicit

### 4. Toolbar crowding
A contextual toolbar adds more chrome to an already dense header.

Mitigation:
- keep it compact
- render only when needed
- use icon-first treatment later if needed

## Open Questions
### 1. Should resize eventually support true 2D scaling?
Recommendation:
- not in first pass
- first pass keeps line-driven directional scaling only

### 2. Should negative scale become mirror?
Recommendation:
- not in first pass
- reject/clamp negative scale for now

### 3. Should rotate/resize apply to tabs and clamps later?
Recommendation:
- yes, likely later
- but keep first pass feature-only

## Exit Criteria
This work is ready when:
1. selecting one or more features shows a contextual edit toolbar
2. copy, move, and delete are available from that toolbar
3. resize works with the requested three-point line-based workflow and live preview
4. rotate works with the requested three-point angle workflow and live preview
5. both tools commit as a single undoable action
6. the workflow works in both top-toolbar and left-toolbar app layouts

## Current Status
- `[x]` first pass complete

## Sketch Edit Expansion
### FE8. Sketch-edit toolbar
- `[x]` add a dedicated sketch-edit toolbar that appears while a single feature is in `Edit Sketch`
- `[x]` make it follow the existing top/left toolbar placement rules
- `[x]` use icon-strip buttons instead of text buttons

### FE9. Insert point
- `[x]` add `Add Point` tool state
- `[x]` allow clicking line segments to insert anchors
- `[x]` allow clicking bezier segments to split them
- `[x]` allow clicking arc segments to split them

### FE10. Delete point
- `[x]` add `Delete Point` tool state
- `[x]` allow deleting anchors from closed profiles when still valid
- `[x]` allow deleting endpoints from open profiles
- `[x]` reconnect neighbors conservatively on delete

### FE11. Open-path extension
- `[x]` allow `Add Point` to extend an open path from its start or end
- `[x]` preserve spline-style continuity heuristically for bezier-ended paths
- `[~]` validate imported/open-feature edge cases further

### FE12. Round corner / fillet
- `[x]` design a first-pass radius interaction using prompted numeric input
- `[x]` implement tangent fillet solve for line-line corners
- `[~]` define first-pass behavior for bezier/arc corners

### FE13. Selected-feature join / cut overlaps
- `[x]` define first-pass behavior as derived feature creation rather than destructive replace
- `[x]` implement closed-profile boolean join
- `[x]` implement closed-profile cut / subtract

### FE14. Selected-feature offset
- `[x]` define first-pass offset distance workflow with prompted numeric input
- `[x]` implement sketch-safe offset out
- `[x]` implement sketch-safe offset in
- `[~]` resolve self-intersection / collapse behavior

### FE15. Polish / validation
- `[~]` improve visual preview for add/delete point targeting
- `[~]` validate open imported spline/polyline editing
- `[~]` consider explicit apply/cancel buttons in the sketch-edit toolbar
