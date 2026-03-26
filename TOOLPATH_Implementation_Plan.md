# Toolpath Implementation Plan

Status: Draft  
Scope: 2.5D toolpath generation and visualization  
Last updated: 2026-03-26

## Goal

Implement first-pass toolpath calculation for 2.5D operations, starting with `Pocket`, using the existing operation model and view system.

This phase should let the user:
- select an operation and see its generated path
- validate pocket clearing behavior before any G-code export exists
- inspect entry, cutting passes, links, and islands in both 2D and 3D
- build the geometry/toolpath engine in a way that can extend cleanly to `Edge Route` and `Surface Clean`

## UI Direction

Do not add a third center tab just for toolpaths.

Use the existing views:
- `Sketch` shows the toolpath as an overlay on top of geometry
- `3D View` shows the toolpath as 3D linework above/on the model

Reason:
- the user needs to compare toolpath to geometry directly
- a separate toolpath-only tab would hide that relationship
- sketch and 3D are already the two right places to validate tool motion

Recommended visualization:
- when an operation is selected, show only that operation’s toolpath by default
- add a later toggle for `Show all toolpaths`
- in sketch:
  - cut moves = strong path color
  - rapid/link moves = dim dashed line
  - entry point = marker/arrow
  - direction arrows at intervals
- in 3D:
  - cutting moves at cut Z
  - rapids at safe Z
  - optional tool cylinder animation later, not in first pass

## First Operation: Pocket

Start with `Pocket`.

Reason:
- highest value
- hardest geometry case
- if pocket works, most of the 2D engine for `Surface Clean` is already present

Pocket first pass must account for:
- multiple selected target features
- islands created by `add` geometry
- pockets inside pockets
- rough vs finish as separate operations
- multiple stepdowns
- entry and exit moves

## Core Decision: Derived, Not Stored

Toolpaths should be generated, not stored in the project file.

Do not persist raw path coordinates in `.camj` yet.

Instead:
- store only operation parameters
- derive toolpaths from `project + operation + tool`
- cache results in memory if needed for performance

Reason:
- avoids stale paths when geometry changes
- keeps the project file smaller and less brittle
- preserves one source of truth

## Engine Architecture

Add a toolpath engine layer under `src/engine/toolpaths/`.

Suggested modules:

- `types.ts`
  - `ToolpathMove`
  - `ToolpathSegment`
  - `ToolpathResult`
  - `ResolvedPocketRegion`

- `geometry.ts`
  - convert sketch profiles to Clipper paths
  - polygon winding normalization
  - arc/bezier flattening for CAM use

- `resolver.ts`
  - resolve operation target geometry into machinable 2D regions
  - determine islands
  - prepare pocket regions by depth band

- `pocket.ts`
  - generate pocket clearing passes
  - stepdown logic
  - lead-in / lead-out
  - link moves

- `visualize.ts`
  - convert toolpath result into sketch overlay primitives
  - convert toolpath result into Three.js line objects

## Data Model Additions

Do not change the saved project schema yet unless clearly necessary.

Use transient result types like:

```ts
type MoveKind = 'rapid' | 'plunge' | 'cut' | 'lead_in' | 'lead_out'

interface ToolpathPoint {
  x: number
  y: number
  z: number
}

interface ToolpathMove {
  kind: MoveKind
  from: ToolpathPoint
  to: ToolpathPoint
}

interface ToolpathResult {
  operationId: string
  moves: ToolpathMove[]
  warnings: string[]
  bounds: {
    minX: number
    minY: number
    minZ: number
    maxX: number
    maxY: number
    maxZ: number
  }
}
```

Optional later:
- `toolpathVersion`
- cached hashes

## Pocket Geometry Resolution

This is the hardest part and should be designed before pass generation.

### First-pass target rule

For a pocket operation:
- target subtract features define the cleared regions
- overlapping `add` features inside those regions become islands

### Practical resolver approach

Use 2D geometry at the operation’s working XY plane, plus Z-range filtering.

Initial rule set:
- collect target subtract features
- union their XY profiles
- subtract overlapping `add` features whose Z span intersects the pocket’s cut span
- merge resulting pocket regions

This should handle:
- multiple pockets in one operation
- islands within a pocket
- local bosses inside a pocket

### Pocket inside a pocket

Do not try to solve this with ad hoc special cases.

Instead, define a resolver that works from feature intent and Z overlap:
- target region comes from selected subtract features
- any `add` feature overlapping that region becomes an island if it occupies material in the same cut band
- any nested subtract feature inside such an island can later become:
  - either a separate target in the same operation
  - or part of another operation

For first pass, keep the rule simple:
- selected target subtract features participate
- non-target subtract features do not automatically create sub-pockets inside islands

That is restrictive, but predictable.

## Pocket Path Strategy

Use offset clearing first, not zig-zag raster.

Reason:
- better match for arbitrary closed regions with islands
- cleaner extension to finish pass
- easier to reason about with Clipper offsets

### Rough pocket

For each resolved pocket region:
- offset inward by tool radius
- repeatedly offset inward by stepover distance
- each offset ring becomes a cut contour
- connect rings with short link moves

Stepover calculation:
- `stepoverDistance = toolDiameter * stepoverRatio`

### Finish pocket

For finish:
- run a final boundary contour at finish allowance removed
- optionally include one final island contour

If `stockToLeaveRadial > 0`:
- rough leaves material
- finish removes it

### Stepdowns

For each stepdown:
- generate the same XY path at the current Z level
- final pass lands exactly at floor Z

Safe first-pass rule:
- constant stepdown from operation top to bottom
- no adaptive last-step compression except final remainder

## Entry / Exit

Do not leave this undefined.

First pass:
- rapid to safe Z above entry point
- rapid in XY to first entry point
- straight plunge at entry point
- cut path
- retract to safe Z at the end

This is not ideal machining, but it is deterministic and easy to verify.

Second pass:
- support lead-in arc or linear ramp where geometry allows

Recommendation:
- implement straight plunge first
- add a per-operation entry style later:
  - `plunge`
  - `ramp`
  - `helix`

## Safe Z and Link Motion

Toolpath visualization needs explicit non-cut motion.

Add generated motion types:
- `rapid`
- `plunge`
- `cut`

First-pass assumptions:
- `safeZ = max(targetTopZ, stockTopZ) + clearance`
- clearance can be a constant engine default first, later a project setting

## Tool/Operation Units

Toolpath generation must normalize all tool and operation dimensions before math.

Rule:
- toolpath engine works in project units internally

So before generation:
- if tool units differ from project units, convert:
  - diameter
  - feed
  - plunge feed
  - stepdown defaults if used

Do not mix unit systems inside geometry code.

## Visualization Plan

### Sketch

Add a toolpath overlay layer to `SketchCanvas`.

Selected operation only:
- solid orange or cyan for cut moves
- dashed muted lines for rapid moves
- small arrowheads every N segments
- entry marker on first plunge

### 3D

Add toolpath line objects to `Viewport3D`.

First pass:
- use `THREE.LineSegments` or grouped `THREE.Line`
- color by move kind
- slight Z bias above model surface to avoid z-fighting

No separate 3D toolpath tab.

## Warnings / Validation

Pocket generation should return warnings, not just path geometry.

Examples:
- no tool assigned
- tool diameter too large for region
- zero or invalid stepover
- zero or invalid stepdown
- target resolves to empty geometry
- island leaves no machinable clearance

Show these warnings on the operation properties panel.

## Proposed Phases

## Phase T1: Toolpath Engine Foundations

Deliverables:
- toolpath transient types
- profile flattening for CAM use
- Clipper conversion helpers
- project/tool unit normalization at generation time

Acceptance:
- any operation target can be resolved into normalized 2D polygon input

## Phase T2: Pocket Region Resolver

Deliverables:
- resolve selected subtract targets into pocket regions
- identify add-feature islands
- support multiple selected targets

Acceptance:
- resolved region data can represent:
  - simple pocket
  - pocket with island
  - multiple pockets

## Phase T3: Pocket Rough Toolpath

Deliverables:
- offset-based ring clearing
- stepdown loop
- rapid/plunge/cut motion generation
- warnings for invalid geometry/tool combos

Acceptance:
- selected pocket operation produces a visible path in sketch and 3D

## Phase T4: Pocket Finish Toolpath

Deliverables:
- finish contour pass
- support radial stock-to-leave interplay with rough pass

Acceptance:
- rough and finish can be visualized separately and together

## Phase T5: UI Integration

Deliverables:
- selected operation generates path automatically
- toolpath overlay in sketch
- toolpath overlay in 3D
- operation warnings in properties

Acceptance:
- user can select an operation and inspect the result without leaving the existing views

## Phase T6: Extend to Edge Route

Deliverables:
- inside contour path
- outside contour path
- finish behavior
- tabs later, not in first pass

Acceptance:
- edge-route operations produce correct contour centerlines

## Phase T7: Extend to Surface Clean

Deliverables:
- stock-facing path
- local add-feature facing path

Acceptance:
- stock and local surfacing both generate visible facing passes

## Open Questions

### 1. Should pocket path order be offset rings or raster?

Recommendation:
- offset rings first

Reason:
- better fit for arbitrary closed geometry with islands

### 2. Should we support ramps/helixes immediately?

Recommendation:
- no

Reason:
- get deterministic plunge-based toolpaths working first
- add smarter entry later

### 3. Should generated toolpaths be cached?

Recommendation:
- yes, but only after correctness

Reason:
- premature caching complicates invalidation

### 4. Should multiple selected operations show combined paths?

Recommendation:
- not initially

Reason:
- selected operation only is clearer for debugging

## Immediate Recommendation

Start with:
1. `Phase T1`
2. `Phase T2`
3. `Phase T3`

That gets you the first real pocket path on screen, which is the main milestone.

## Tracking Checklist

- [x] Phase T1: Toolpath engine foundations
- [ ] Phase T2: Pocket region resolver
- [ ] Phase T3: Pocket rough toolpath
- [ ] Phase T4: Pocket finish toolpath
- [ ] Phase T5: UI integration
- [ ] Phase T6: Edge route toolpaths
- [ ] Phase T7: Surface clean toolpaths
