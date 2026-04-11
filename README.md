# PureCut CNC

`PureCut CNC` is a browser-based 2.5D CAD / CAM workspace for designing parts, defining machining operations, previewing toolpaths, and checking the result in 3D and simulation before export.

It is aimed at the kind of work where you want one place to:

- draw or import geometry
- organize features into machinable shapes
- assign operations such as pockets, contours, carving, and V-carving
- inspect the toolpath strategy visually
- export the result when it looks right

## What You Can Do

### Sketch geometry

Create and edit geometry directly in the `Sketch` view:

- rectangles, circles, polygons, splines, and composite profiles
- text features with built-in vector fonts
- tabs and clamps
- backdrop images for tracing

The sketch workflow includes:

- grid snapping
- feature / point / line / midpoint / center snapping
- marquee selection
- move, copy, resize, rotate, and offset transforms
- direct sketch editing with point add / delete / move and corner fillets
- on-canvas measurements while drawing and editing

### Import geometry

Import source geometry and continue working with it as native sketch features:

- SVG import
- DXF import

Imported geometry can then be transformed, assigned operations, and used like hand-drawn features.

### Work with text

Text is handled as an editable feature rather than exploded letter geometry.

Current text support includes:

- single-line text
- skeleton and outline text styles
- built-in font selection
- shared operation and Z settings across the text feature
- transform support through a text frame

### Define CAM operations

Operations are created from selected geometry and managed in the CAM panel.

Current operation set includes:

- Pocket Rough
- Pocket Finish
- Surface Rough
- Surface Finish
- Edge Route
- Follow Line
- V-Carve
- V-Carve Recursive

The toolpath system supports things such as:

- multiple operation targets
- tabs and clamps
- parallel and offset-style pocket / surface patterns
- tool selection and feeds
- operation visibility and selection
- toolpath debugging for selected operations where needed

### Inspect the result before export

The app provides three main working views:

- `Sketch`
  - author geometry
  - inspect selected toolpaths in 2D
  - check snapping, ordering, and direction
- `3D View`
  - preview model geometry and toolpaths in 3D
  - inspect entry / exit and path direction
- `Simulation`
  - replay toolpaths against stock
  - verify that pockets, tabs, islands, and carving behavior match expectations

## Typical Workflow

1. Start a new project and define stock.
2. Draw geometry, import SVG / DXF, or place a backdrop image for tracing.
3. Organize and edit features until the sketch matches the intended part.
4. Add CAM operations from the selected geometry.
5. Tune tooling, stepdown, stepover, pattern, and operation parameters.
6. Check the result in `Sketch`, `3D View`, and `Simulation`.
7. Export once the toolpaths look correct.

## Current Focus

`PureCut CNC` is under active development. The core workflow is already usable, but the project is still evolving in areas such as:

- additional font support and text workflows
- deeper DXF coverage
- more toolpath optimization
- richer simulation tooling
- more advanced carving and finishing workflows

## Build And Run

### Requirements

- Node.js 20+ is recommended
- npm

### Install dependencies

```bash
npm install
```

### Run the development server

```bash
npm run dev
```

Vite will print a local URL, typically:

```text
http://localhost:5173
```

### Create a production build

```bash
npm run build
```

### Preview the production build locally

```bash
npm run preview
```
