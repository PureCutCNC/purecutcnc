# CAM Implementation Plan

Status: Draft  
Scope: 2.5D CAM operations foundation only  
Last updated: 2026-03-26

## Goal

Implement the data model, UI, and selection flow for 2.5D CAM operations without generating toolpaths yet.

This phase should let the user:
- define a tool library
- create operations against valid geometry targets
- edit operation parameters
- see which features an operation applies to
- prepare the project model so toolpath generation can be added later without reworking the schema

## Confirmed Decisions

### Units

- Project units live at project level in `project.meta.units`
- The current location under Grid is only a temporary UI placement and should be changed
- All dimensional input fields must accept values in the current project unit
- Switching units should convert the full project numerically
- Imperial fractions are nice to have, not required for the first pass

### Operation Scope

For this phase, support only:
- Pocket
- Edge Route Inside
- Edge Route Outside
- Surface Clean

Each operation can have:
- Rough variant
- Finish variant

Drill and other operation families come later.

### Operation Creation Flow

Operation creation should be operation-first, not feature-first:
1. User chooses an operation type
2. App enters an operation target selection mode
3. Only compatible features can be selected
4. User confirms target selection
5. Operation is created with default parameters

This is important because applicability is operation-dependent:
- Pocket applies only to subtract features
- Edge Route applies to profile boundaries
- Surface Clean initially applies to stock

### Edge Routing Semantics

Inside vs outside should be encoded by operation type, not by a separate side parameter.

So the model should use:
- `edge_route_inside`
- `edge_route_outside`

instead of:
- `edge_route` + `side`

## Proposed Data Model

### Tools

Tools stay project-embedded and are managed separately from operations.

Initial tool schema:

```ts
type ToolType = 'flat_endmill' | 'ball_endmill' | 'v_bit' | 'drill'

interface Tool {
  id: string
  name: string
  type: ToolType
  diameter: number
  flutes: number
  material: 'hss' | 'carbide'
  defaultRpm: number
  defaultFeed: number
  defaultPlungeFeed: number
  defaultStepdown: number
  defaultStepover: number
}
```

Notes:
- Keep all numeric fields in project units
- `defaultStepover` should be stored as a ratio `0..1` or percent-equivalent, not absolute distance

### Operations

Replace the current placeholder `Operation` schema with an operation model that separates geometry target from machining strategy.

```ts
type OperationKind =
  | 'pocket'
  | 'edge_route_inside'
  | 'edge_route_outside'
  | 'surface_clean'

type OperationPass = 'rough' | 'finish'

type OperationTarget =
  | { source: 'features'; featureIds: string[] }
  | { source: 'stock' }

interface Operation {
  id: string
  name: string
  kind: OperationKind
  pass: OperationPass
  enabled: boolean
  target: OperationTarget
  toolRef: string | null

  stepdown: number
  stepover: number
  feed: number
  plungeFeed: number
  rpm: number

  stockToLeaveRadial: number
  stockToLeaveAxial: number
}
```

Notes:
- No toolpath geometry is stored yet
- Operations reference targets, not generated contours
- Rough and finish are separate operations, not flags on one operation

## Operation Target Rules

### Pocket

Valid targets:
- one or more subtract features

Not valid:
- add features
- stock

Reason:
- at this phase, a pocket operation should target subtractive regions only

### Edge Route Inside

Valid targets:
- subtract features

Reason:
- inside edge routing is the natural contour operation for holes/pockets/openings

### Edge Route Outside

Valid targets:
- add features
- stock boundary later if needed

Reason:
- outside routing is the natural contour operation for external perimeters and bosses

### Surface Clean

Valid targets:
- stock

First pass:
- stock only

Later:
- optionally support selected local regions

## UI Plan

### Right Panel Structure

Keep the existing right-side tab structure, but replace the placeholder Operations panel with nested CAM tabs:

- Operations
- Tools

Optional later:
- Posts
- Materials

### Operations Tab

Top section:
- operation list/tree
- reorderable
- enable/disable
- grouped visually by rough/finish if useful

Bottom section:
- properties editor for selected operation

Each operation row should show:
- name
- kind
- rough/finish
- target summary
- tool name
- enabled state

Primary actions:
- Add Operation
- Duplicate Operation
- Delete Operation

### Tools Tab

Top section:
- tool list

Bottom section:
- tool properties editor

Primary actions:
- Add Tool
- Duplicate Tool
- Delete Tool

### Selection Mode for Operation Creation

When the user clicks `Add Operation`:
1. pick operation type
2. app enters target-selection mode
3. incompatible features are dimmed or non-selectable
4. compatible targets highlight on hover
5. confirmation creates the operation

Selection mode rules:
- `Esc` cancels
- `Enter` confirms if current selection is valid
- status banner explains what can be selected

## Units Refactor Plan

This needs to happen before operation editing, otherwise tool and operation numeric fields will become inconsistent.

### Step 1: Centralize length formatting/parsing

Add helpers for:
- `formatLength(value, units)`
- `parseLengthInput(text, units)`
- `convertLength(value, from, to)`

First pass:
- support decimal mm/inch

Later:
- support imperial fractions like `1/4`, `3/8`, `1 1/2`

### Step 2: Convert project on unit switch

When units change:
- convert stock profile and thickness
- convert feature geometry
- convert feature Z values
- convert grid values
- convert tool dimensions and feeds
- convert operation dimensions and feeds

Do not convert:
- ratios
- enums
- ids

### Step 3: Move units UI

Add a project-level properties node or equivalent project settings UI.

Move these there:
- units
- later, project defaults

Leave grid panel for:
- extent
- spacing
- snap
- visibility

### Step 4: Make all numeric dimension fields unit-aware

Targets:
- stock fields
- feature Z fields
- grid values
- tool dimensions
- operation parameters

## Implementation Phases

## Phase 1: Units Foundation

Deliverables:
- project-level units UI
- centralized parse/format/convert helpers
- unit-aware numeric entry components
- full project conversion on unit switch

Acceptance:
- switching `mm` to `inch` updates existing geometry numerically
- editing numeric fields uses the selected unit consistently

## Phase 2: Tool Library

Deliverables:
- upgraded `Tool` schema
- tool CRUD in store
- Tools UI in right panel
- default tool creation flow

Acceptance:
- tools can be added, edited, deleted, and persisted
- operations can later reference these tools without schema changes

## Phase 3: Operations Schema and Store

Deliverables:
- replace placeholder `Operation` type
- operation CRUD + reorder in store
- operation target model
- operation applicability validation

Acceptance:
- operations persist in `.camj`
- invalid target combinations are blocked at creation time

## Phase 4: Operations UI

Deliverables:
- operation list
- operation properties panel
- operation-first creation flow
- feature target selection mode

Acceptance:
- user can create:
  - pocket rough
  - pocket finish
  - edge route inside rough/finish
  - edge route outside rough/finish
  - surface clean rough/finish

## Phase 5: Boundary Preview

Deliverables:
- visual preview of operation targets in sketch view
- operation selection highlights its target
- optional badge or overlay showing linked operations on selected features

Acceptance:
- user can see what geometry each operation will act on before toolpaths exist

## Open Questions

### 1. Can one operation target multiple features?

Recommendation:
- yes for pocket and edge-route families

Reason:
- roughing or finishing multiple equivalent regions with one operation is a useful workflow

### 2. Should operation depths inherit from feature geometry or be editable?

Recommendation:
- inherit by default from target geometry in this phase
- avoid separate operation depth unless operation kind truly needs it

Exception:
- surface clean may need its own cut depth or stock-to-leave-top

### 3. How should rough + finish be created?

Recommendation:
- support both:
  - single operation creation
  - quick action for `Create Rough + Finish Pair`

### 4. Should tools store feeds and speeds?

Recommendation:
- yes, as defaults
- operations should copy those defaults when a tool is assigned
- operation values then become local editable overrides

## Tracking Checklist

- [x] Phase 1: Units foundation
- [x] Phase 2: Tool library
- [x] Phase 3: Operations schema and store
- [x] Phase 4: Operations UI
- [ ] Phase 5: Boundary preview
