# Clamp Implementation Plan

Status legend:
- `[ ]` not started
- `[~]` in progress / partial
- `[x]` complete

## Goal

Add first-pass clamp support that is useful in both modeling and CAM preview:
- clamps appear in the project tree under a dedicated `Clamps` entry
- clamps are simple rectangular keep-out solids from `z = 0` up to user-defined `height`
- clamps are visible in sketch and 3D
- toolpath preview becomes clamp-aware and warns or reroutes to avoid clamp collisions where practical

This phase is not about full workholding simulation. It is about giving the CAM engine enough information to avoid obviously unsafe moves.

## Current State

The project schema already contains a basic clamp model in [project.ts](./src/types/project.ts):
- `project.clamps: Clamp[]`
- `Clamp = { id, type, x, y, w, h, height }`

That is enough for a first pass.

What is missing:
- no project-tree UI for clamps
- no clamp creation/edit workflow
- no sketch or 3D rendering for clamps
- no toolpath collision awareness

## Design Decisions

### 1. Keep first-pass clamp geometry simple

Use simple rectangular boxes only:
- XY footprint: `x, y, w, h`
- Z extent: `0 .. height`

Do not model physical hardware detail yet.

### 2. Treat clamps as keep-out solids, not part geometry

Clamps are not features:
- they are not booleaned into the part
- they do not affect stock or feature modeling
- they only affect visualization and toolpath safety

### 3. Add a dedicated `Clamps` node in the project tree

Tree order should be:
- Project
- Grid
- Stock
- Features
- Clamps

`Clamps` should behave similarly to `Features` as a container node:
- count
- show/hide all
- add clamp
- collapse/expand

### 4. First-pass clamp authoring should match existing rectangle placement

Clamp creation should be simple:
1. click `Add Clamp`
2. first click sets one corner
3. second click sets opposite corner
4. default height is applied
5. height is edited in properties

This avoids a custom placement flow initially.

### 5. Clamp avoidance should start conservative

First pass toolpath safety rule:
- cut moves are allowed below clamp height if the XY path does not enter the clamp footprint
- rapid, plunge, lead, and linking moves that cross clamp footprints must clear the maximum blocking clamp height plus clearance

That means:
- start with safe-Z inflation and simple crossing tests
- do not attempt full 3D detour planning in v1

### 6. Clamp collision logic should be preview-first

For this phase, clamp awareness should primarily improve preview correctness and warnings:
- adjust vertical / rapid clearance where needed
- surface warnings when a move crosses clamp XY at an unsafe Z

If clean rerouting is too invasive in a case, warn instead of silently pretending the path is safe.

## UI Scope

### Left panel

Add `Clamps` section in the project tree:
- dedicated root row
- child clamp rows
- count in header or section row
- bulk show/hide controls
- collapse/expand

### Properties panel

Clamp properties should support:
- name or type label
- X
- Y
- Width
- Height in XY (`h` in model should likely be relabeled to `Depth` or `Length` for UI clarity later)
- clamp Z height
- visible
- delete

### Toolbar / actions

First pass options:
- add `Clamp` button in toolbar
- or `Add Clamp` on the `Clamps` row in the tree

Recommended first pass:
- tree action only

Reason:
- clamps are setup/workholding objects, not primary sketch primitives
- avoids adding more top-toolbar clutter immediately

### Visualization

Sketch:
- draw clamp footprints distinctly from part features
- use dashed or semi-transparent fill
- selected clamp should highlight like other editable objects

3D:
- render clamp boxes as translucent setup solids
- not booleaned into the part

## CAM Behavior Scope

### What clamp awareness should affect

Clamp awareness should affect non-cut motion first:
- safe Z
- rapids
- linking moves
- plunges where relevant

### What clamp awareness should not attempt yet

Do not do in v1:
- full path rerouting around arbitrary clamp obstacles in XY
- tool-holder collision
- clamp collision during cutting inside clamp footprint
- workholding optimization

### First-pass collision model

For each clamp:
- footprint = rectangle in XY
- blocked volume = footprint × `[0, height]`

For each toolpath move:
- if move is vertical and outside clamp XY, ignore clamp
- if move is XY or diagonal and intersects clamp footprint in plan view:
  - required clearance Z = `maxClampHeightAlongPath + safetyClearance`
- if actual move Z is lower than required clearance:
  - either lift the move to safe clearance
  - or emit a warning if the move type should not be auto-modified yet

### Clearance policy

Need one shared rule:
- `clampClearance = max(project stock safe Z, clamp height + tool radius? + margin)`

Recommended first pass:
- `requiredZ = clamp.height + clearanceMargin`
- margin can reuse existing safe-Z concept or be a small constant derived from project units

Later, make this configurable.

## Implementation Phases

### K1. Tree and selection groundwork
- `[x]` add `Clamps` root to the project tree
- `[x]` add clamp selection state and properties handling
- `[x]` add bulk visibility controls for clamps

### K2. Clamp CRUD in store
- `[x]` add create / update / delete actions for clamps
- `[x]` add default clamp creation
- `[x]` support show/hide and selection sanitization

### K3. Clamp sketch and 3D rendering
- `[x]` draw clamp footprints in sketch
- `[x]` draw clamp boxes in 3D
- `[x]` highlight selected clamp

### K4. Clamp placement UI
- `[x]` add rectangle-style clamp placement flow
- `[x]` create clamp from two-click XY definition
- `[x]` edit clamp height in properties

### K5. Clamp-aware toolpath checks
- `[x]` add XY footprint intersection helpers
- `[x]` add clamp clearance evaluation for generated toolpaths
- `[x]` surface warnings on unsafe moves

### K6. Clamp-aware toolpath adjustment
- `[x]` lift rapid/link moves when clamp crossing requires more clearance
- `[x]` keep cut paths unchanged in v1 unless explicitly impossible
- `[x]` show adjusted preview in sketch and 3D

### K7. Refinement
- `[~]` moved to backlog

## Recommended Build Order

1. `K1` tree integration
2. `K2` store actions
3. `K3` visualization
4. `K4` placement and property editing
5. `K5` clamp collision checks and warnings
6. `K6` conservative rapid/link adjustment
7. `K7` polish

Reason:
- get clamps visible and editable first
- then make CAM aware of them
- only after that start modifying generated motion

## Exit Criteria for First Pass

Clamp support is usable for the POC when:
- user can create and edit simple clamp boxes
- clamps appear in the left tree and both viewports
- selected toolpaths account for clamp clearance on non-cut motion
- unsafe clamp crossings are no longer silent

Status:
- core clamp implementation complete through `K6`
- `K7` items are backlog refinement, not blockers for current processing

## Notes / Open Questions

- Should clamp creation live only under the `Clamps` tree node, or also get a toolbar action later?
- Do we want one clamp `type` in first pass, with the existing enum kept only for future extension?
- Should clamp visibility be independent from clamp collision participation later (`visible` vs `enabled`)?
- Should safe-Z be globally recomputed from clamp heights, or should clamp avoidance only affect moves that actually cross clamp footprints?

Recommended first-pass answer:
- keep collision participation tied to existence/visibility for now
- recompute only for moves that cross clamps, not globally
