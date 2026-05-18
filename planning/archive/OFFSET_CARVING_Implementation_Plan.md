# OFFSET CARVING Implementation Plan

Legend:
- `[ ]` not started
- `[~]` in progress / partial
- `[x]` complete
- `[>]` deferred / moved to backlog

## Goal
Add an `Offset Carving` operation that follows one or more offset copies of a target sketch profile, producing a widened outline/channel around the authored line.

This is intentionally different from `Follow Line`:
- `Follow Line`: tool center runs directly on the authored profile
- `Offset Carving`: tool center runs on offset copies of the authored profile

## First-Pass Scope
The first pass should support:
- open and closed target features
- operation-defined carve depth
- operation-defined total carve width
- rough and finish behavior
- flat endmill path generation first
- sketch / 3D / simulation visibility through the shared preview pipeline

The first pass does **not** need:
- variable-width carving
- V-carve depth-from-geometry logic
- automatic corner cleanup / cusp elimination
- advanced corner-join strategy controls
- text features
- adaptive stepover

## Semantics
### Target support
`Offset Carving` should accept:
- open profiles
- closed profiles

### Depth model
Depth should follow the same rule as `Follow Line`:
- reference top = `feature.z_top`
- final cut Z = `feature.z_top - carveDepth`

### Width model
The operation should define a total carve width, for example:
- `carveWidth`

This width is independent of tool diameter.

### Side / offset mode
For open profiles, first-pass offset modes should be:
- `centered`
- `left`
- `right`

For closed profiles, first-pass offset modes should be:
- `centered`
- `inside`
- `outside`

Long-term these may collapse into a more unified model, but this split is clearer for users.

### Horizontal passes
If the requested carve width exceeds the tool diameter, generate multiple offset passes using:
- tool diameter
- stepover ratio

So:
- rough can have multiple horizontal offsets and multiple Z levels
- finish can still have multiple horizontal offsets, but only one Z level

## Design Notes
### Open profiles
Open-profile offsets are the harder case.

For the first pass:
- flatten the profile first
- offset the flattened polyline
- accept simple join behavior
- prefer predictable output over mathematically perfect joins

### Closed profiles
Closed-profile offsetting should reuse existing offset/Clipper-based infrastructure where possible.

### Tool support
Path generation should start with:
- `flat_endmill`

Simulation should later support:
- `ball_endmill`
- `v_bit`

But toolpath generation itself does not need to special-case those cutter shapes in the first pass, because the centerline path definition is still valid.

## Phases
### OC1. Operation schema and CAM UI
- `[ ]` add `offset_carve` operation kind
- `[ ]` add `carveWidth`
- `[ ]` add offset mode / side mode
- `[ ]` expose controls in CAM panel
- `[ ]` keep target validation open-or-closed like `Follow Line`

### OC2. Closed-profile offset generation
- `[ ]` generate one or more offset centerlines for closed targets
- `[ ]` support `inside`, `outside`, and `centered`
- `[ ]` support horizontal multi-pass widening
- `[ ]` warn when inside offsets collapse completely

### OC3. Open-profile offset generation
- `[ ]` generate left/right/centered offset centerlines for open targets
- `[ ]` support simple endpoint caps / joins for first pass
- `[ ]` support horizontal multi-pass widening
- `[ ]` keep geometry predictable even if corner handling is basic

### OC4. Z-level behavior
- `[ ]` rough uses multi-stepdown passes
- `[ ]` finish uses one final-depth pass
- `[ ]` preserve existing carve-depth semantics relative to `feature.z_top`

### OC5. View integration
- `[ ]` sketch preview
- `[ ]` 3D path preview
- `[ ]` operation warnings/status integration

### OC6. Simulation integration
- `[ ]` flat endmill simulation validation
- `[ ]` confirm ball / V-bit simulation looks coherent through existing cutter replay model
- `[ ]` document any limits for open-profile offset carving simulation

### OC7. Refinement / backlog split
- `[ ]` corner join strategy controls
- `[ ]` cusp cleanup / cleanup pass logic
- `[ ]` text / font carving integration
- `[ ]` variable-width offset carving

## Likely Risks
### 1. Open-profile offset robustness
Open-profile offsetting is less forgiving than closed loops.

Risk:
- endpoint behavior
- self-overlap near sharp corners
- inconsistent left/right interpretation if profile direction changes unexpectedly

Mitigation:
- define offset relative to authored direction
- keep first-pass joins/caps simple and explicit

### 2. Width vs tool diameter semantics
Users may expect `carveWidth` to mean final visible channel width, not tool-center offset span.

Mitigation:
- define width in finished geometry terms
- derive the offset centerline family from tool radius + requested width

### 3. Closed inward collapse
Inside offsets for small closed shapes can disappear.

Mitigation:
- stop generating when no valid offset region remains
- emit a warning instead of failing silently

## Exit Criteria for First Pass
This feature is ready for first-pass use when:
1. users can create an `Offset Carving` operation on open and closed profiles
2. width and side mode visibly change the path as expected
3. rough uses stepdown levels and finish uses one final-depth pass
4. sketch, 3D, and simulation all show coherent results
5. failure cases produce explicit warnings rather than broken geometry
