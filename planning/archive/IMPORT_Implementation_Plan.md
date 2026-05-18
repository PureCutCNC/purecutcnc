# Import Implementation Plan

Legend:
- `[ ]` not started
- `[~]` in progress / partial
- `[x]` complete
- `[>]` deferred / moved to backlog

## Goal
Add first-pass geometry import for:
- `SVG`
- `DXF`

Imported geometry should become normal CAMCAM features using the existing sketch/profile model. After import, the rest of the app should work exactly the same as if the geometry had been drawn manually.

## First-Pass Scope
The first pass should support:
- importing from `.svg`
- importing from `.dxf`
- converting source geometry into internal `SketchProfile` / `Segment[]`
- creating normal project features from imported shapes
- grouping imported features into a folder named after the source file
- selecting imported features after import
- zooming to the imported geometry after import

The first pass should **not** include:
- interactive placement immediately after import
- in-app source-file preview
- text import
- hatch/fill import
- block/insert expansion beyond the parser’s basic resolved output
- AI classification of imported geometry
- STL / STEP / image trace

## Confirmed Decisions
### 1. No special post-import placement mode in v1
Imported geometry should land at source coordinates.

After import:
- create the features
- select them
- zoom to them

If the user needs to reposition the batch, they can use the normal feature move workflow.

Reason:
- lower implementation cost
- reuses the existing move/edit system
- avoids a one-off import-only interaction mode

### 2. Imports are adapters into the existing feature model
The importer should not create special “imported object” entities.

Everything should become normal:
- `SketchFeature`
- `SketchProfile`
- `Segment[]`
- feature folder entries

Reason:
- keeps downstream code unchanged
- toolpaths, 3D preview, feature editing, and save/load all continue to work normally

### 3. Shared import pipeline
Both SVG and DXF should feed one shared normalized import model before feature creation.

Recommended intermediate type:
```ts
interface ImportedShape {
  name: string
  sourceType: 'svg' | 'dxf'
  layerName: string | null
  closed: boolean
  profile: SketchProfile
}
```

Reason:
- avoids duplicating feature-creation rules
- keeps format-specific parsing isolated
- makes future imports (STEP/STL/image trace) easier to add later

### 4. Use exact profiles when possible, safe fallbacks otherwise
Preferred conversions:
- exact line segments stay `line`
- exact circular arcs stay `arc`
- bezier-capable geometry stays `bezier`

Fallback:
- if a source primitive cannot be represented exactly in the current schema, convert it to a safe bezier or segmented profile

Reason:
- preserve as much editability and geometric quality as practical
- avoid blocking v1 on perfect format coverage

### 5. Imported geometry defaults to ordinary subtract features
Closed imported shapes should default to:
- `operation: 'subtract'`
- `z_top = project.stock.thickness`
- `z_bottom = 0`

Open imported shapes should become open features usable for line-follow style workflows later.

Reason:
- this matches the most common CAM import use case
- users can change feature operation/depth after import

### 6. Imported features should default to `composite` unless clearly primitive
Import should not over-classify aggressively.

Recommended rule:
- run through the current `inferFeatureKind(profile)`
- accept exact `rect`, `circle`, `polygon`, `spline` where it already fits
- otherwise use `composite`

Reason:
- keeps the imported result truthful to source geometry
- avoids forcing arbitrary imported curves into the wrong feature kind

## File / Module Structure
Recommended new modules:
- `src/import/types.ts`
- `src/import/normalize.ts`
- `src/import/svg.ts`
- `src/import/dxf.ts`
- `src/import/index.ts`

Recommended store integration:
- add one store action that imports already-normalized shapes into features/folders

Example:
```ts
importShapes(input: {
  fileName: string
  sourceType: 'svg' | 'dxf'
  shapes: ImportedShape[]
}): string[] // returns created feature ids
```

## Geometry / Coordinate Rules
### 1. Coordinate conversion
Imported coordinates must be converted into project sketch coordinates.

At minimum:
- preserve source scale as imported units
- convert Y direction as needed to match CAMCAM project-space convention

This must be explicit per format rather than assumed globally.

### 2. Units
SVG:
- SVG is unit-ambiguous in practice
- first pass should assume document/user units map directly into project units
- if explicit units are present (`mm`, `in`, etc.), convert them

DXF:
- read header/document units when available
- if units are absent or ambiguous, fall back to project units
- later we may add a unit-override prompt, but first pass can stay simple

### 3. Closed/open shape handling
Closed shape:
- create a closed `SketchProfile`
- create a normal feature

Open shape:
- create an open `SketchProfile`
- create a normal feature with open profile semantics

### 4. Import tolerances
The shared pipeline should define:
- endpoint join tolerance
- curve flattening fallback tolerance
- duplicate/near-zero segment rejection threshold

These can be constants in first pass, but they should live in one place.

## SVG Import
### First-pass supported elements
- `path`
- `rect`
- `circle`
- `ellipse`
- `polygon`
- `polyline`
- `line`

### SVG parsing approach
Use browser-native parsing:
- `DOMParser`
- per-element extraction
- parse transforms before geometry conversion

### SVG element mapping
- `rect` -> `rectProfile`
- `circle` -> `circleProfile`
- `ellipse` -> bezier approximation unless we later add true ellipse support
- `polygon` -> closed line profile
- `polyline` -> open line profile
- `line` -> open line profile
- `path`
  - `M/L/H/V/Z` -> line segments
  - `C/S/Q/T` -> bezier segments
  - `A` -> arc if truly circular and representable, otherwise bezier approximation

### SVG first-pass exclusions
- text
- clipping/masking
- fills/strokes as semantic operations
- CSS-driven geometry effects

## DXF Import
### Recommended parser
Use `dxf-parser`.

### First-pass supported DXF entities
- `LINE`
- `LWPOLYLINE`
- `POLYLINE`
- `ARC`
- `CIRCLE`
- `SPLINE`

### DXF entity mapping
- `LINE` -> line segment
- `LWPOLYLINE` / `POLYLINE` -> line or arc segments
- bulge values -> arc conversion
- `ARC` -> arc segment
- `CIRCLE` -> `circleProfile`
- `SPLINE` -> bezier if practical, otherwise sampled polyline in fallback mode

### DXF first-pass exclusions
- `TEXT`
- `MTEXT`
- `HATCH`
- dimensions/annotations
- advanced block/reference workflows
- 3D entities

## UI / Workflow
### Entry point
Best first-pass location:
- add `Import` to the main file/project action group

This should open a file picker and detect format from extension.

### First-pass flow
1. User chooses `.svg` or `.dxf`
2. Parse file
3. Convert to shared `ImportedShape[]`
4. Normalize into features
5. Create a folder using the source filename
6. Insert imported features into that folder
7. Select imported features
8. Switch to sketch view and zoom to imported geometry

### Error handling
Need clear error states for:
- invalid file
- unsupported element/entity only
- empty import result
- partial import with unsupported geometry skipped

Warnings should be shown in a compact import result message/dialog later, but first pass can start with alerts or a simple status message.

## Store / State Changes
Recommended additions:
- `addImportedFeatureFolder(name: string): string`
- `importShapes(...)`

Behavior:
- create one folder per import
- append created features
- preserve undo/redo as one history action per import

## Implementation Phases
### IM1. Shared import model
- `[x]` add `ImportedShape` type
- `[x]` add shared normalization helpers
- `[x]` add shared feature-creation pipeline from imported shapes

### IM2. Store integration
- `[x]` add one store action to import a batch of shapes
- `[x]` create/select target folder for imported geometry
- `[x]` ensure one undo step per import

### IM3. SVG parser
- `[x]` parse supported SVG elements into `ImportedShape[]`
- `[x]` support basic element transforms
- `[x]` support open and closed geometry
- `[x]` skip unsupported elements cleanly with warnings

### IM4. DXF parser
- `[>]` add `dxf-parser` dependency
- `[~]` parse supported DXF entities into `ImportedShape[]`
- `[~]` support polyline bulge -> arc conversion
- `[x]` skip unsupported entities cleanly with warnings

### IM5. UI entry point
- `[x]` add import action to the toolbar/file controls
- `[x]` detect file type and route to the correct importer
- `[x]` show basic error feedback for parse/import failures

### IM6. Post-import UX
- `[x]` create a source-named folder
- `[x]` select created features after import
- `[x]` zoom to imported geometry
- `[x]` switch to sketch view after successful import

### IM7. Validation / cleanup
- `[ ]` reject zero-length/degenerate geometry
- `[ ]` apply endpoint join tolerance where needed
- `[ ]` confirm imported geometry survives save/load and edit workflows

## Current Status
- `[~]` first pass in progress
- SVG import path is implemented
- DXF import is implemented only as a limited built-in parser for common entities; deeper DXF coverage still needs work

## Risks / Edge Cases
### 1. Unit ambiguity
Some SVGs and DXFs do not clearly encode real-world units.

Mitigation:
- use file units when explicit
- otherwise default to project units in first pass
- add unit override later if needed

### 2. Y-axis mismatch
Different source formats use different coordinate conventions.

Mitigation:
- keep coordinate conversion centralized per importer
- verify with a known square/circle fixture file for both formats

### 3. Fragmented DXF geometry
DXF files often contain disconnected line segments that conceptually form one loop.

Mitigation:
- use endpoint-join tolerance in normalization
- keep first pass conservative rather than inventing aggressive healing

### 4. Ellipses and non-circular arcs
These do not map cleanly to the current line/arc/bezier schema as true primitives.

Mitigation:
- convert to bezier approximation in first pass

### 5. Over-classification
Trying to guess primitive types too aggressively can damage editability.

Mitigation:
- prefer `composite` fallback
- only accept primitive kinds when the profile already matches them exactly

## Open Questions
### 1. Should import create add or subtract features by default?
Recommendation:
- default to `subtract`
- revisit later if user demand suggests a prompt is needed

### 2. Should imported open shapes become a different entity type?
Recommendation:
- no
- keep them as normal open features

### 3. Should we add an import options dialog in first pass?
Recommendation:
- no
- first pass should be direct file import with sensible defaults

## Exit Criteria
This work is ready when:
1. `.svg` and `.dxf` files can be imported into the current project
2. imported geometry becomes normal editable features
3. imported features are grouped into a folder named after the source file
4. save/load preserves imported geometry without special handling
5. sketch, 3D preview, and toolpath workflows continue to work on imported features
