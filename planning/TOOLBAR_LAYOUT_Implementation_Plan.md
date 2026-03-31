# TOOLBAR LAYOUT Implementation Plan

Legend:
- `[ ]` not started
- `[~]` in progress / partial
- `[x]` complete
- `[>]` deferred / moved to backlog

## Goal
Add a user-selectable toolbar orientation system so the app can run in either:
- a traditional top horizontal toolbar
- a CAD-style left vertical creation rail

The main purpose is to recover vertical space in the center workspace without losing fast access to core actions.

## First-Pass Scope
The first pass should support:
- `top` toolbar mode
- `left` toolbar mode
- a slim global header in left mode
- a docked creation rail in left mode
- a toolbar orientation toggle in the center header area
- responsive fallback to top mode on smaller screens

The first pass should **not** include:
- contextual CAM/tool-specific rail tools
- floating/detached toolbars
- collapsible rail behavior
- full-screen chrome hiding
- a global icon-system migration outside the toolbar work

## Confirmed Decisions
### Orientation modes
- `top`: current standard horizontal toolbar
- `left`: slim vertical creation rail + slim top global header

### Left-mode split
In left mode, split toolbar responsibilities into two groups:
- `Global actions` stay at the top of the app:
  - new
  - open
  - save
  - undo
  - redo
  - zoom fit
- `Creation tools` move into the left rail:
  - rectangle
  - circle
  - polygon
  - spline
  - composite

### Docking
The left rail should be docked inside the layout grid, not floating.

### Size target
The rail should stay slim, around `44px` wide.

### Mobile / small screens
Below a small-screen threshold, force top mode regardless of saved preference.

## Corrected State Model
Toolbar orientation should **not** be stored in project data.

Reason:
- it is app UI preference, not project content
- opening a project should not change the user’s global chrome/layout preference

First-pass implementation should use:
- app-local UI state in `App.tsx`
- optional persistence in `localStorage`

Suggested model:
```ts
type ToolbarOrientation = 'top' | 'left'
```

This should live alongside existing UI state such as:
- workspace layout (`lcr`, `lc`, `c`, `cr`)
- active center tab
- active right tab

## Layout Strategy
Current structure already has:
- top header toolbar area
- body with left / center / right panels

So the lowest-risk implementation is:
- keep the existing top header container
- in `top` mode:
  - render the full toolbar there
- in `left` mode:
  - render a compact global toolbar in the header
  - add a dedicated left rail inside `app-body`
  - keep the existing left project/properties panel separate from the rail

This is better than redefining the whole app shell around a brand new top-level layout system.

## UI Behavior
### Top mode
- current combined toolbar behavior remains
- project name + global actions + creation tools stay in the header

### Left mode
- header contains:
  - project name
  - global actions
- left rail contains:
  - creation tools only
- tooltips should appear to the right of the rail

### Toggle placement
The orientation toggle should sit near the existing workspace layout controls in the center panel header.

Important:
- it should be visually separated from the `L-C-R / L-C / C / C-R` controls
- toolbar orientation is a different axis from panel visibility

## Implementation Phases
### TL1. Toolbar orientation state
- `[ ]` add `toolbarOrientation` as app-local UI state
- `[ ]` optionally persist it in `localStorage`
- `[ ]` apply small-screen override to force `top`

### TL2. AppShell rail slot
- `[ ]` add a dedicated left-rail slot to `AppShell`
- `[ ]` update layout CSS to support:
  - top mode with no rail
  - left mode with docked rail
- `[ ]` preserve current left project/properties panel behavior

### TL3. Toolbar split
- `[ ]` split current toolbar into:
  - `GlobalToolbar`
  - `CreationToolbar`
- `[ ]` render both together in top mode
- `[ ]` render only global tools in the header in left mode
- `[ ]` render only creation tools in the left rail in left mode

### TL4. Orientation toggle UI
- `[ ]` add toolbar-orientation controls near the workspace layout controls
- `[ ]` keep the two control groups visually distinct
- `[ ]` ensure keyboard and tooltip behavior remain usable

### TL5. Vertical rail polish
- `[ ]` tune spacing for the `44px` rail target
- `[ ]` move tooltips to the right in left mode
- `[ ]` ensure active tool state remains visually obvious
- `[ ]` prevent tooltip clipping near the canvas edge

### TL6. Responsive behavior
- `[ ]` force top mode below the chosen width threshold
- `[ ]` ensure the toggle reflects the forced state clearly
- `[ ]` avoid layout jitter when crossing the breakpoint

### TL7. Optional icon cleanup
- `[ ]` use the shared `Icon` component in toolbar-related UI where it helps
- `[>]` full toolbar/icon-system migration outside this layout change

## Risks / Edge Cases
### 1. Persistence boundary confusion
If toolbar orientation is stored in project data, layout becomes project-dependent, which is the wrong UX.

Mitigation:
- keep it in app UI state only
- use `localStorage` if persistence is needed

### 2. Rail vs left project panel crowding
The app already has a left-side panel stack.
A new rail can make that side feel overloaded if spacing is not handled carefully.

Mitigation:
- keep the rail slim and visually separate
- do not merge the rail into the project tree column

### 3. Tooltip discoverability
A slim rail makes text labels less obvious.

Mitigation:
- keep right-side tooltips simple and reliable
- avoid fancy delayed/floating behavior in the first pass

### 4. Workspace control ambiguity
Users may confuse toolbar-orientation controls with panel-layout controls.

Mitigation:
- separate them visually in the header
- use distinct icons and tooltips

## Open Questions
### 1. Should the left rail be collapsible?
Recommendation:
- not in the first pass
- keep it fixed to avoid layout jumping

### 2. Should the rail float over the canvas?
Recommendation:
- no
- keep it docked in the grid for predictable canvas sizing

### 3. Should contextual tools ever move into the rail?
Recommendation:
- not in the first pass
- keep contextual tools in their own panels/bars

## Exit Criteria for First Pass
This work is ready when:
1. users can switch between top and left toolbar orientation
2. left mode keeps global actions in the header and creation tools in the rail
3. the center workspace gains usable vertical space in left mode
4. small screens force top mode cleanly
5. the change does not disturb the existing project tree / properties / CAM panel workflow
