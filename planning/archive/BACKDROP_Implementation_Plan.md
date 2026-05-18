# Backdrop Implementation Plan

Legend:
- `[ ]` not started
- `[~]` in progress / partial
- `[x]` complete
- `[>]` deferred / moved to backlog

## Goal
Add a single project-level backdrop image that can be shown in the sketch and traced with normal features.

The backdrop should:
- load from `jpg` / `jpeg` / `png`
- be selectable from the project tree
- render in the sketch behind normal feature geometry
- support show/hide
- support move, resize, rotate, and delete
- optionally support opacity adjustment

## First-Pass Scope
The first pass should support:
- one backdrop per project
- persistent storage inside the project file
- loading/replacing from local image files
- display in the sketch only
- tree selection and property editing
- reuse of the existing move / resize / rotate interaction flow
- opacity slider

The first pass should not include:
- multiple backdrops
- crop/mask tools
- direct pixel editing
- perspective/skew transforms
- image filters
- 3D viewport rendering

## Model
Recommended project shape:

```ts
interface BackdropImage {
  name: string
  mimeType: string
  imageDataUrl: string
  intrinsicWidth: number
  intrinsicHeight: number
  center: Point
  width: number
  height: number
  orientationAngle: number
  opacity: number
  visible: boolean
}
```

Project storage:
- `project.backdrop: BackdropImage | null`

Reason:
- single object keeps the feature model untouched
- persisted data URL avoids external file path dependencies
- transform state is explicit and easy to edit

## UX
### Project tree
Add one top-level entry:
- `Backdrop`

Behavior:
- always visible in the tree
- when no backdrop is loaded, selecting it shows a load action in Properties
- when loaded, the row shows visibility toggle like other project items

### Properties
When `Backdrop` is selected:
- `Name`
- `Image`
  - `Load` or `Replace`
- `Opacity`
- `Width`
- `Height`
- `Angle`
- `Visible`
- `Delete`

### Toolbar
When the backdrop is selected:
- show a contextual edit toolbar
- actions:
  - `Move`
  - `Delete`
  - `Resize`
  - `Rotate`

No `Copy` for v1.

### Sketch
Draw backdrop:
- behind features, tabs, clamps, and toolpaths
- centered and transformed by width/height/rotation
- with configurable opacity

Selection feedback:
- subtle outline / bounds when selected
- preview outline during move / resize / rotate

## Transform Rules
### Move
Translate backdrop center by the chosen offset.

### Rotate
Reuse the existing 3-point rotation workflow:
- point 1 = pivot
- point 2 = reference direction
- point 3 = preview / final angle

This updates:
- `center`
- `orientationAngle`

### Resize
Reuse the existing 3-point resize workflow with the backdrop's local frame:
- the local frame comes from `orientationAngle`
- resizing is axis-aware against the backdrop's own width/height axes
- result updates:
  - `center`
  - `width`
  - `height`

The resize should stay rectangular, not shear the image.

## Rendering Notes
- use a cached `HTMLImageElement` built from the stored data URL
- only redraw when image or transform changes
- if the image is not loaded yet, skip rendering for that frame

## Implementation Phases
### BD1. Project schema
- `[x]` add backdrop type
- `[x]` add `project.backdrop`
- `[x]` normalize older projects to `null`

### BD2. Store actions
- `[x]` add load / replace / update / delete actions
- `[x]` add backdrop selection
- `[x]` extend move / resize / rotate flows to support backdrop

### BD3. Tree and properties
- `[x]` add `Backdrop` tree node
- `[x]` add backdrop properties panel
- `[x]` add file input for load / replace

### BD4. Sketch rendering
- `[x]` draw backdrop image in sketch
- `[x]` draw selected outline
- `[x]` draw move / resize / rotate previews

### BD5. Toolbar integration
- `[x]` show contextual backdrop edit actions
- `[x]` keep top and left toolbar placement behavior aligned with existing feature tools

### BD6. Validation
- `[ ]` confirm save/load persistence
- `[x]` confirm backdrop works with project unit changes
- `[~]` confirm backdrop does not interfere with feature editing

## Risks / Follow-Up
- data URLs can increase project file size
- very large images may need future downsampling
- direct clicking / hit testing on rotated images can be added later if needed
- richer texturing / image adjustments are out of scope for v1
