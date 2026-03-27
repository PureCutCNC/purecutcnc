# Composite Feature Implementation Plan

Status legend:
- `[ ]` not started
- `[~]` in progress / partial
- `[x]` complete

## Goal

Add a new closed-profile feature type that can be drawn from mixed connected segments:
- line
- arc
- spline / bezier

The final result should still behave like one normal feature:
- one feature node in the tree
- one `add` / `subtract` operation
- one `z_top` / `z_bottom`
- one closed profile used by sketch rendering, 3D preview, and CAM resolution

## Current State

The geometry model already supports mixed segment types in one profile:
- `SketchProfile.start`
- `segments: Segment[]`
- `Segment = line | arc | bezier`

This means composite feature support is primarily:
- creation workflow
- edit workflow
- validation

It is not a major geometry schema redesign.

## Design Decisions

### 1. Keep existing primitive tools

Existing tools stay:
- Rectangle
- Circle
- Polygon
- Spline

Composite becomes an additional tool, not a replacement.

### 2. Add feature-kind metadata

Add a lightweight feature-kind flag so creation and edit behavior can differ without changing the profile format.

Suggested values:
- `rect`
- `circle`
- `polygon`
- `spline`
- `composite`

### 3. Composite feature remains a single closed profile

No support in this phase for:
- multiple loops in one feature
- holes inside one feature
- open profiles

### 4. Creation is segment-by-segment

Composite creation should let the user switch segment mode while building one profile:
- `Line`
- `Arc`
- `Spline`

### 5. Initial scope stays narrow

Do not include in v1:
- trimming / extend
- constraints across mixed segments
- automatic self-intersection solving
- nested loops
- parametric segment editing beyond direct manipulation

## Recommended Interaction

### Tool activation

User clicks `Composite` in the toolbar.

### Segment modes

During creation, segment mode can be switched with:
- `L` = line
- `A` = arc
- `S` = spline

### Draft creation flow

1. first click sets the profile start point
2. each next click adds a connected segment
3. user may switch mode between clicks
4. user closes the shape by:
   - clicking the first point
   - pressing `Enter`
   - later optionally using an explicit `Close` action
5. `Esc` cancels
6. `Backspace` should remove the last draft segment

## Segment Creation Rules

### Line

Simple:
- previous point -> clicked point

### Spline / Bezier

First pass:
- clicking an endpoint creates a bezier segment with auto handles
- handles are adjusted later in sketch edit mode

This keeps initial creation simple while still allowing smooth mixed profiles.

### Arc

Recommended first pass:
- use a 3-point arc workflow
- previous point = arc start
- click end point
- click a third point on the arc to define curvature

Reason:
- explicit
- robust
- easier to validate than inferred arc centers from hover alone

## Editing Requirements

Composite features need real sketch editing support.

Minimum useful edit support:
- move anchor points
- move bezier handles
- move arc-defining controls

Later improvements:
- insert point on segment
- delete point / segment
- convert segment type

## Validation Rules

Before feature commit:
- closed profile required
- minimum valid enclosed area
- no zero-length segments
- valid arc geometry
- no obviously degenerate beziers

Future enhancement:
- detect self-intersection and warn or block

## Rendering / 3D / CAM Expectations

No separate geometry pipeline should be introduced.

Composite-created profiles should flow through the same systems as existing features:
- sketch rendering
- 3D CSG preview
- operation target resolution
- toolpath generation

This requires only that:
- flattening of mixed segments remains consistent
- closure and winding stay valid

## Implementation Phases

### C1. Feature kind groundwork
- `[x]` add feature-kind metadata
- `[x]` mark existing primitive feature creators with a kind
- `[x]` introduce `composite`

### C2. Composite draft state
- `[x]` add composite creation state to store
- `[x]` track current segment mode
- `[x]` track draft points / pending segment data
- `[x]` support cancel / close / undo-last

### C3. Composite sketch creation UI
- `[x]` add toolbar entry
- `[x]` add on-canvas creation hints
- `[x]` render mixed-segment preview
- `[x]` support mode hotkeys

### C4. Composite commit path
- `[x]` convert draft profile into one `SketchFeature`
- `[x]` create normal feature metadata (`name`, `operation`, `z_top`, `z_bottom`, etc.)
- `[x]` validate before commit

### C5. Edit-mode support
- `[x]` anchor dragging
- `[x]` bezier handle dragging
- `[x]` arc-control dragging

### C6. Refinement
- `[x]` `Backspace` remove last draft segment
- `[x]` segment-type conversion moved to general backlog
- `[x]` self-intersection warning

## Recommended Build Order

Recommended practical sequence:

1. C1
2. C2
3. C3 for line + spline only
4. C4
5. add arc creation
6. C5 editing improvements

Reason:
- line + spline gets the workflow in place quickly
- arc authoring is the highest interaction risk

## Risks

The hardest part is editor interaction, not geometry storage:
- segment switching during creation
- arc authoring UX
- mixed-segment hit-testing and editing

This is why the first pass should stay narrow and explicit.

## Exit Criteria

This feature is considered complete enough for the first POC when:
- user can create one closed composite feature from mixed line / arc / spline segments
- the feature renders correctly in sketch and 3D
- the feature participates normally in boolean modeling and CAM operations
- the feature can be edited at least at anchor / handle level
