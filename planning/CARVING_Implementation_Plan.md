# Carving Implementation Plan

Status legend:
- `[ ]` not started
- `[~]` in progress / partial
- `[x]` complete

## Goal

Add a first-pass carving workflow centered on one operation:
- `Follow Line`

This operation should:
- accept open or closed sketch geometry
- follow the authored path directly instead of clearing an area
- use operation-defined cut depth, not feature `z_bottom`
- work with flat endmills, ball endmills, and V-bits
- appear correctly in `Sketch`, `3D View`, and `Simulation`

## First-Pass Scope

Included in the first pass:
- open-profile authoring for line-based tools
- one carving operation kind: `follow_line`
- operation-defined carving depth
- toolpath preview in `Sketch` and `3D View`
- simulation support for the generated toolpath
- validation so open profiles are rejected by pocket / edge / surface operations

Explicitly not included in the first pass:
- text feature generation
- skeleton fonts
- outline-font engraving strategies
- V-carve area solving / variable-width fill
- advanced 3D relief carving
- full open-profile boolean modeling

## Key Design Decisions

### 1. Open profiles are a sketch capability, not a special feature type

The geometry layer should support both:
- closed profiles
- open profiles

This applies to authored geometry from:
- continuous line / polyline
- spline
- composite

Closed features remain required for:
- `Pocket`
- `Edge Route Inside`
- `Edge Route Outside`
- `Surface Clean`

Open or closed profiles are valid for:
- `Follow Line`

### 2. Feature depth is ignored for carving bottom depth

For carving:
- feature `z_top` still matters and defines the starting reference level of the sketch geometry
- feature `z_bottom` is ignored by the carving toolpath generator
- operation defines the actual carve depth

Recommended operation parameters:
- `carveDepth`
- optional later: `startZOverride`

First-pass rule:
- effective carve bottom = `feature.z_top - carveDepth`

This keeps the feature useful as sketch placement while making carving behavior explicit in the operation.

### 3. Follow-line is centerline toolpath generation

First pass should generate a centerline path directly from the profile segments.

That means:
- open path: tool follows from one end to the other
- closed path: tool follows a closed loop
- no area clearing
- no profile offsetting in first pass

### 4. Tool shape matters in simulation and later semantics, but not in the authored path

The authored carving path is still the drawn centerline.

Tool differences matter in:
- simulation replay
- visual/material interpretation
- later feed/depth heuristics

First-pass operation should allow:
- flat endmill
- ball endmill
- V-bit

### 5. Existing feature tools should not regress

Current closed-shape workflows must still work as they do now.

This means:
- rectangle and circle stay closed-only
- polygon / spline / composite gain an explicit open/close authoring path
- existing closed feature behavior must remain valid for current CAM ops

## Data Model Changes

### Feature/profile shape state

Add explicit profile closure state instead of assuming every profile is closed.

Recommended model direction:

```ts
interface SketchProfile {
  start: Point
  segments: Segment[]
  closed: boolean
}
```

Implications:
- profile renderers must not always call `closePath()`
- flatten/sample helpers need both open and closed variants where appropriate
- hit-testing and fill logic must guard on `closed`

### Operation kind

Add:
- `follow_line`

### Operation parameters

Add first-pass carving params:
- `carveDepth: number`

Optional later:
- `multipleDepthPasses`
- `maxCarveStepdown`
- `startFromCenterlineDirection`
- `reversePath`

First pass recommendation:
- default to one depth per operation unless tool/load later forces multiple passes

## Validation Rules

### Profile validation

Closed-only operations reject open profiles:
- pocket
- edge route inside/outside
- surface clean

Follow-line accepts:
- open profiles
- closed profiles

### Carving operation validation

A follow-line operation requires:
- valid target features
- assigned tool
- positive `carveDepth`
- resulting bottom Z not above feature top Z

Warnings to surface early:
- open profile used in non-carving operation
- carve depth exceeds stock/material bottom
- V-bit selected but first-pass simulation/toolpath is approximate

## UI / Workflow Changes

### Sketch authoring

Need a real open-profile completion flow for:
- polyline / continuous line
- spline
- composite

Recommended behavior:
- `Enter` completes current draft as-authored
- closed if user explicitly closes to first point or uses a `Close` action
- otherwise commit as open profile
- `Esc` cancels
- `Backspace` removes last draft segment/point

### Feature tree / properties

Feature properties should show whether a profile is:
- `Closed`
- `Open`

For closed-only operations:
- block invalid targeting
- show clear warnings rather than failing silently

### CAM panel

Add operation kind:
- `Follow Line`

Properties should include at least:
- `Target`
- `Tool`
- `Carve depth`
- feed/rpm/plunge
- optional pass selector if needed later

## Toolpath Strategy

### First-pass follow-line generation

Generate toolpath directly from the authored profile geometry.

For each targeted feature:
- flatten/convert profile segments into ordered path points or direct segment moves
- use feature `z_top` as the path top reference
- cut at `z = feature.z_top - carveDepth`
- open paths stay open
- closed paths loop back to start

Recommended move pattern:
1. rapid to safe Z
2. rapid to path start XY
3. plunge to carve Z
4. follow the line
5. retract to safe Z

### Multi-feature operations

Support multiple targets in one operation.

First pass ordering can be simple:
- feature tree order / selection order

Later optimization:
- nearest-neighbor path ordering

### Depth passes

The cleanest first pass is:
- one carving depth per operation

However, define the design so later we can add:
- multiple depth passes for deep carving with flat endmills or ball tools

## View Support

### Sketch

Show carving path overlay like other operations.

Open-path requirements:
- do not visually close the path
- show clear start/end
- selected operation emphasis still applies

### 3D View

Render carving path as 3D linework at carve depth.

Open-path requirements:
- no forced loop closure
- preserve authored direction if relevant later

### Simulation

Simulation should replay the resulting carving toolpath.

First pass expectation:
- flat endmill simulation should already work once toolpath exists
- ball endmill and V-bit simulation can start as approximate or use existing flat-endmill fallback until their dedicated tool-shape simulation is added

## Recommended Bundled First-Pass Items

These are worth bundling now because they are directly coupled to carving:

1. `SketchProfile.closed` support through the geometry/rendering layer
2. open-profile authoring for polyline / spline / composite
3. operation-target validation for open vs closed profiles
4. `follow_line` toolpath generation
5. first-pass view support in Sketch / 3D / Simulation

These should stay out of first pass and go to backlog:
- text features
- font import/rendering
- skeleton/outline text carving strategies
- full V-carve solving
- open-profile edit tools beyond the current direct-manipulation basics

## Implementation Phases

### FV1. Open-profile groundwork
- `[x]` add explicit profile closure state
- `[x]` update sampling / rendering / hit-testing helpers to support open profiles
- `[x]` keep closed-profile behavior unchanged for existing features

### FV2. Open-profile authoring
- `[x]` allow continuous line creation without forced closure
- `[x]` allow spline creation without forced closure
- `[x]` allow composite creation/commit as open or closed
- `[x]` preserve explicit close action / close-on-first-point behavior

### FV3. Open-profile validation in existing CAM ops
- `[x]` reject open profiles for pocket
- `[x]` reject open profiles for edge routes
- `[x]` reject open profiles for surface clean
- `[x]` show clear warnings in CAM properties

### FV4. Carving operation schema and UI
- `[x]` add `follow_line` operation kind
- `[x]` add `carveDepth` parameter
- `[x]` surface operation controls in CAM panel
- `[x]` allow any feature targets, open or closed

### FV5. Follow-line toolpath engine
- `[x]` generate follow-line path from authored profile geometry
- `[x]` support open and closed targets
- `[x]` use `feature.z_top - carveDepth`
- `[x]` support multiple targets in one operation

### FV6. View integration
- `[x]` sketch overlay for follow-line
- `[x]` 3D path overlay for follow-line
- `[x]` operation warnings/status integration

### FV7. Simulation integration
- `[x]` replay follow-line moves in simulation
- `[x]` verify flat endmill simulation
- `[x]` define first-pass behavior for ball endmill and V-bit simulation

### FV8. Refinement / backlog split
- `[>]` text feature planning
- `[>]` variable-width V-carve planning
- `[>]` follow-line ordering / linking refinement
- `[>]` decide when multi-depth carving passes are needed

## Risks / Edge Cases

### 1. Open-profile support touches core assumptions

A lot of current helpers assume closure.

Most likely impact areas:
- sketch rendering
- fill/hit-testing
- profile flattening
- 3D conversion helpers
- CAM target validation

This is the real structural part of the work.

### 2. Open profiles should not enter boolean modeling paths

Part-model CSG should continue using closed additive/subtractive features only.

Open profiles are sketch/CAM geometry, not solid model geometry.

This means:
- open profiles should not be treated as normal `add` / `subtract` solids in 3D model generation
- they may need a feature-level flag or validation that prevents solid-model participation

### 3. V-bit and ball-end support is only partially meaningful without carving

This is why follow-line carving is the right place to introduce them first.

They should not be bolted onto pocket/edge semantics prematurely.

## Recommended Build Order

1. `FV1` open-profile groundwork
2. `FV2` authoring for line/spline/composite
3. `FV3` validation wall for current CAM ops
4. `FV4` add `follow_line` operation UI/schema
5. `FV5` generate first carving toolpath
6. `FV6` view integration
7. `FV7` simulation validation
8. then move `FV8` items to backlog or follow-on plans

## Exit Criteria For First Pass

The first pass is done when:
- user can author an open or closed line-based feature
- user can create a `Follow Line` operation targeting it
- carve depth is controlled by the operation, not feature bottom Z
- toolpath is visible in sketch and 3D
- simulation shows the resulting carve coherently
- existing closed-only operations reject open targets clearly and predictably
