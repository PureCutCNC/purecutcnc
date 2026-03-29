# Tab Implementation Plan

Status legend:
- `[ ]` not started
- `[~]` in progress / partial
- `[x]` complete

## Goal

Add first-pass support for machining tabs that keep parts attached during cutout operations:
- tabs live in their own project-tree section
- tabs are created manually by the user as simple rectangles in the sketch
- tabs are visible in sketch and 3D
- toolpath generation treats tabs as material to preserve, not just as visualization
- first-pass behavior works for contour-style operations where tabs are most useful

This phase is about practical tab authoring and preview, not full automated tab placement.

## Core Interpretation

Tabs are not clamps.

Clamps:
- are setup/workholding objects
- do not change part geometry
- only affect clearance and motion safety

Tabs:
- are intentional regions of material left uncut
- do affect machining geometry
- must change how toolpaths are generated near the tab location

For the first pass, tabs should be modeled as sacrificial rectangular keep regions near the bottom of a cut.

## Design Decisions

### 1. Tabs live in a dedicated `Tabs` tree section

Project tree order should become:
- Project
- Grid
- Stock
- Features
- Tabs
- Clamps

Reason:
- tabs are not part features
- tabs are not workholding
- they are CAM/process objects

### 2. First-pass tab geometry is rectangular only

Use simple rectangular tabs for now:
- XY footprint from two-click rectangle placement
- `z_bottom`
- `z_top`

Recommended first-pass authoring model:
- footprint drawn manually in sketch
- bottom defaults to operation/stock bottom reference
- top is set by `tab height`

For user-facing properties, prefer:
- `Z Top`
- `Z Bottom`

Internally this is just a rectangular prism of material to keep.

### 3. Tabs should behave like authored objects, not inferred features

Tabs should support the same basic interaction family as clamps/features:
- create
- select
- show/hide
- edit footprint
- move
- copy
- delete

But unlike clamps, tabs must also participate in machining geometry.

### 4. First-pass scope should target contour operations first

Tabs matter most for:
- `edge_route_outside`
- `edge_route_inside`

They may also matter for:
- some pocket cases

Recommended first pass:
- implement for edge-route operations first
- optionally warn / no-op for unsupported operation kinds until the tab model is proven

Reason:
- contour tabs are the standard use case
- easiest place to make the vertical “leave material here” behavior explicit

### 5. Tabs should be manual, not automatic

Do not implement auto-tab placement in v1.

User workflow should be:
1. create cut operation
2. add one or more tabs where needed
3. preview resulting toolpath

Later:
- automatic evenly spaced tabs
- tab pattern presets

### 6. Toolpath behavior is vertical, not XY reroute, in the first pass

For a contour crossing a tab:
- the XY path stays on the same contour
- when entering the tab span, the tool rises to `tab.z_top`
- traverses across the tab region at that higher Z
- then returns to deeper cutting outside the tab

That means tabs are fundamentally “don’t cut full depth here” regions.

This is much more practical than trying to create separate detour geometry first.

### 7. Tabs should be validated against operations

Not every tab should affect every operation.

First-pass rule:
- a tab only matters if its XY footprint intersects the generated toolpath / target contour region
- tabs outside the operation path are ignored

Warnings should exist for:
- tab above stock top
- tab below operation bottom
- tab not intersecting the selected operation at all

## UI Scope

### Project tree

Add a `Tabs` root similar to `Clamps`:
- count
- show/hide all
- add tab
- collapse/expand

### Properties panel

Tab properties should support:
- `Name`
- `Z Top`
- `Z Bottom`
- `Visible`
- `Edit Sketch`
- `Delete`

Do not expose raw `x/y/w/h` in the main properties workflow.

### Sketch

Sketch should show tabs distinctly from features and clamps:
- filled translucent overlay
- selected tab highlight
- edit anchors for rectangle footprint

### 3D

Tabs should render as translucent retained-material prisms.

Important difference from clamps:
- tabs conceptually belong to machining result
- so the preview language should feel closer to retained material than workholding

## CAM / Toolpath Scope

### First-pass supported behavior

For edge-route operations:
- detect contour segments that intersect tab footprints
- split contour motion into:
  - normal cut segments
  - tab crossing segments
- tab crossing segments cut at the raised tab Z instead of final depth

For multi-step cuts:
- full-depth cutting continues normally until the cut reaches tab height
- below that level, tab span remains uncut

### First-pass unsupported behavior

Do not do in v1:
- automatic tab distribution
- arbitrary shaped tabs
- tab-aware pocket rest machining
- tab-aware surface clean
- tab-aware adaptive/morph strategies
- tab-to-tab optimization

### Geometry interpretation

Contour-style interpretation:
- tab is an XY interval along a contour plus a preserved Z span
- equivalent machining result is “material remains here between `z_bottom..z_top`”

This can be implemented either by:
- true region booleaning in the resolver
- or contour splitting plus raised cut Z during tab crossing

Recommended first pass:
- contour splitting + raised cut Z

Reason:
- simpler for contour operations
- avoids overcomplicating pocket region logic too early

## Validation Rules

Need explicit warnings when:
- tab does not intersect selected operation
- tab `z_top <= z_bottom`
- tab exceeds stock thickness
- tab raised crossing would exceed machine `Max Z` or conflict with clamp clearance
- tab overlaps another tab in a way that creates ambiguous output

## Implementation Phases

### TB1. Tree and schema groundwork
- `[x]` add `Tabs` root to the project tree
- `[x]` add `Tab` schema to the project model
- `[x]` add selection state for tabs

### TB2. Store CRUD and placement
- `[x]` add tab create / update / delete actions
- `[x]` add rectangle-style two-click placement
- `[x]` add show/hide all

### TB3. Sketch and 3D visualization
- `[x]` draw tabs in sketch
- `[x]` draw tabs in 3D
- `[x]` support selection highlight

### TB4. Tab editing workflow
- `[x]` support rectangle-style sketch edit
- `[x]` support move / copy / delete
- `[x]` support context menu actions

### TB5. Operation validation and preview warnings
- `[x]` detect when tabs are relevant to the selected operation
- `[x]` warn when tabs are invalid, out of range, or non-intersecting
- `[x]` show tab-related warnings in operation properties

### TB6. Edge-route tab machining
- `[x]` split contour motion around tab crossings
- `[x]` keep XY contour, but raise Z across tab spans
- `[x]` preview tab-aware edge-route toolpaths in sketch and 3D

### TB7. Clamp / machine-limit interaction
- moved to backlog
- validate tab-raised contour motion against clamp clearance and project `Max Z`
- warn when a tab-crossing lift cannot be performed safely

### TB8. Refinement / backlog candidates
- moved to backlog
- tab presets / default dimensions
- automatic tab placement
- pocket-aware tabs
- non-rectangular tabs

## Recommended Build Order

1. `TB1` tree + schema
2. `TB2` placement and CRUD
3. `TB3` visualization
4. `TB4` editing workflow
5. `TB5` validation
6. `TB6` edge-route tab machining
7. `TB7` clamp/machine interaction if/when machine-safety validation becomes urgent
8. `TB8` polish and advanced behavior as backlog work

Reason:
- first make tabs real authored objects
- then make them visible
- then make toolpaths respect them

## Exit Criteria for First Pass

Tabs are usable for the POC when:
- user can create, edit, move, copy, and delete rectangular tabs
- tabs appear in the tree, sketch, and 3D
- edge-route toolpaths visibly leave material at tab locations by raising Z there
- invalid tab setups produce warnings instead of silent bad output

Current status:
- first-pass tab implementation is complete through `TB6`
- `TB7` and `TB8` are backlog/refinement work
