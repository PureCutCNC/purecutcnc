# OBJ Import - Implementation Plan

## 1. Overview

Add support for importing Wavefront OBJ (`.obj`) files as 3D model features. OBJ should enter the same mesh-backed workflow currently used by STL: parse file data into a triangle mesh, derive a top-down silhouette for sketch view, render the full mesh in the 3D viewport, and make the model available to rough/finish surface operations.

This is a mesh import feature, not a general OBJ scene/material import feature. The first implementation should deliberately ignore materials, textures, lights, cameras, curves, and animation-like scene concerns.

## 2. Goals

- Import common OBJ files exported from Blender, CAD-adjacent mesh tools, sculpting tools, and model libraries.
- Reuse the existing imported mesh path as much as possible:
  - `src/engine/importedMesh.ts`
  - `src/import/stl.ts` silhouette/top-view logic, generalized where useful
  - model feature rendering in `src/engine/csg.ts`
  - import UI in `src/components/project/ImportGeometryDialog.tsx`
- Preserve existing `.camj` files with legacy STL model features.
- Keep the first pass focused on reliable geometry import.

## 3. Non-Goals

- No `.mtl` material parsing in the first pass.
- No texture loading.
- No OBJ freeform curves or NURBS surfaces.
- No multi-object editing UI.
- No automatic unit detection. OBJ does not reliably encode units.
- No dependency on external files referenced by `mtllib` or texture paths.
- No support for zipped OBJ packages.

## 4. Current Architecture Fit

The current code is already close to a generic imported mesh pipeline:

- `STLFeatureData.format?: 'stl'` exists, with missing format treated as legacy STL.
- `ImportedModelFormat` exists, but is currently only `'stl'`.
- `loadImportedBufferGeometry(...)` and `loadImportedTriangleMesh(...)` dispatch by format.
- `extractStlProfileAndBounds(...)` works from `loadImportedTriangleMesh(...)` and is mostly format-agnostic after parsing.
- `renderStlTopViewToDataUrl(...)` also works from `loadImportedTriangleMesh(...)` and can be generalized.
- `loadSTLTransformedGeometry(...)` in `src/engine/csg.ts` is named for STL but already asks `importedModelFormat(feature.stl)`.

The implementation should avoid creating a parallel OBJ feature kind. OBJ is another imported mesh format, not a new modeling primitive.

## 5. Data Model

### 5.1. Extend Existing Model Feature Data

Keep `SketchFeature.kind === 'stl'` for imported mesh features for now to avoid broad UI and project compatibility churn. Treat the name as legacy/internal terminology until a later cleanup can rename it to `model`.

Update:

```ts
export type ImportedModelFormat = 'stl' | 'obj'

export interface STLFeatureData {
  /** Imported model file format. Missing means legacy STL. */
  format?: 'stl' | 'obj'
  filePath?: string
  fileData?: string
  scale: number
  axisSwap?: 'none' | 'yz' | 'xz' | 'xy'
  silhouetteDataUrl?: string
  silhouettePaths?: Point[][]
  topViewDataUrl?: string
}
```

Compatibility rules:

- Missing `format` means `'stl'`.
- Existing `kind: 'stl'` remains valid for both STL and OBJ-backed model features.
- UI labels should say "model" or "imported model" where possible, but code renaming can be deferred.

### 5.2. File Data

For consistency with STL, store OBJ file contents in `fileData` as a data URL or base64 payload.

Recommendation:

- Allow `data:text/plain;base64,...` or bare base64 internally.
- Decode OBJ as UTF-8 text before parsing.
- Keep import cache keys based on format, axis orientation, merge mode, and file data length/content guard as the existing STL path does.

## 6. OBJ Parser Scope

### 6.1. Supported Records

Support:

- `v x y z`
- `vt ...` accepted and ignored.
- `vn ...` accepted and ignored for CAM geometry, optionally used by Three.js geometry later only if easy.
- `f ...`
- `o name` and `g name` accepted as optional metadata, but not required for v1 behavior.
- `s ...`, `usemtl ...`, `mtllib ...` accepted and ignored with warnings only when useful.
- Blank lines and `#` comments.
- Line continuations with trailing `\` if practical. If not implemented initially, fail clearly or add a warning.

Reject or ignore:

- `p`, `l`, `curv`, `curv2`, `surf`, `parm`, `trim`, `hole`, and other freeform records.
- Faces with fewer than 3 valid vertices.
- Non-finite coordinates.

### 6.2. Face Syntax

Support the common OBJ face variants:

```txt
f v1 v2 v3
f v1/vt1 v2/vt2 v3/vt3
f v1//vn1 v2//vn2 v3//vn3
f v1/vt1/vn1 v2/vt2/vn2 v3/vt3/vn3
```

Index handling:

- OBJ indices are 1-based.
- Negative indices are relative to the current end of the vertex list.
- Index `0` is invalid.
- Texture/normal indices can be parsed enough to skip them.

### 6.3. Triangulation

OBJ faces may be triangles, quads, or n-gons. Convert faces to triangles with fan triangulation:

```txt
f a b c d e -> (a b c), (a c d), (a d e)
```

This is sufficient for the first pass and works well for common convex or mostly planar faces. It can produce incorrect triangles for concave n-gons, but those are uncommon in manufacturing mesh exports and should be documented as a limitation.

Future improvement: use a polygon triangulation library or project each n-gon to its best-fit plane and triangulate concave polygons. Do not block v1 on that.

### 6.4. Multiple Objects and Groups

For v1, merge all OBJ objects/groups into one imported model feature.

Rationale:

- The current model feature pipeline expects one mesh and one silhouette.
- CAM rough/finish operations target one imported model as the surface.
- Most users importing OBJ for CNC relief/surface work expect the visible combined model.

Future improvement: optional "split by object/group" import mode that creates one model feature per OBJ object.

## 7. Geometry Pipeline

### 7.1. Shared Mesh Loader

Update `src/engine/importedMesh.ts`:

- Extend `ImportedModelFormat` to `'stl' | 'obj'`.
- Add `loadObjBufferGeometry(fileData, axisOrientation, mergeVertices)`.
- Add `loadObjTriangleMesh(fileData, axisOrientation)`.
- Route `loadImportedBufferGeometry(...)` and `loadImportedTriangleMesh(...)` through the new OBJ loaders.

The OBJ loader should produce the same core shape as STL:

```ts
export interface ImportedTriangleMesh {
  positions: Float32Array
  index: Uint32Array
  bounds: ImportedMeshBounds
}
```

Implementation detail:

- Prefer a small local parser over adding a heavy dependency.
- Build indexed geometry directly from parsed vertices and triangulated faces.
- Apply axis orientation after parsing, using the existing `applyAxisOrientationToPositions(...)`.
- Call `BufferGeometryUtils.mergeVertices(...)` only for `BufferGeometry` callers when requested.

### 7.2. Generalize STL Import Helpers

Create format-neutral helpers, then keep STL wrappers for compatibility:

```ts
extractImportedModelProfileAndBounds(format, base64Data, scale, axisSwap, onProgress?)
renderImportedModelTopViewToDataUrl(format, base64Data, scale, axisSwap)
```

Then:

```ts
extractStlProfileAndBounds(...) {
  return extractImportedModelProfileAndBounds('stl', ...)
}

renderStlTopViewToDataUrl(...) {
  return renderImportedModelTopViewToDataUrl('stl', ...)
}
```

OBJ import should call the generic helpers with `'obj'`.

### 7.3. Silhouette Extraction

Use the existing projection behavior:

1. Load triangle mesh.
2. Build a `manifold-3d` mesh.
3. Attempt `Manifold.project()`.
4. If Manifold rejects the mesh as non-manifold, fall back to projecting all triangles to 2D and unioning with Clipper.
5. Filter tiny silhouette artifacts through `significantSilhouettePaths(...)`.
6. Store:
   - largest path as `sketch.profile`
   - significant paths as `stl.silhouettePaths`

OBJ files are often not watertight, so the Clipper projection fallback should be considered normal, not exceptional.

### 7.4. 3D Rendering and CSG

Existing rendering and transformed geometry paths should continue to work after `loadImportedBufferGeometry(...)` and `loadImportedTriangleMesh(...)` support OBJ.

Rename only where it reduces confusion and blast radius is low:

- Low-risk: warning text from "STL" to "model".
- Defer: `loadSTLTransformedGeometry`, `STLFeatureData`, `kind: 'stl'`.

## 8. Import UI

Update `ImportGeometryDialog`:

- Detect `.obj`.
- Include OBJ in the file input accept list if present.
- Read OBJ as text or data URL. Prefer data URL for consistency with STL persistence.
- Use the same units selector and axis orientation selector as STL.
- Default source units to project units, because OBJ has no reliable unit metadata.
- Summary text: `OBJ file - 3D mesh imported by top-down silhouette projection`.
- Import name: strip `.obj` extension.
- Store `stl.format: 'obj'`.

Error and warning behavior:

- If the file has vertices but no faces, show "OBJ has no polygon faces to import."
- If unsupported records are present, do not fail by default. Warnings can be surfaced later; first pass can silently ignore materials/curves.
- If all faces are invalid after parsing, fail import.

## 9. Units and Coordinates

OBJ has no reliable unit metadata. The import dialog should treat source units exactly like STL:

- Default to project units.
- Let the user choose `mm` or `inch`.
- Convert using the same scale rule:
  - project `mm`, source `inch`: `25.4`
  - project `inch`, source `mm`: `1 / 25.4`
  - same units: `1`

Coordinate handling:

- Preserve OBJ X/Y/Z by default.
- Apply the existing axis orientation option after parsing and before bounds/silhouette extraction.
- Do not invert Y during import. The app's existing machine-coordinate conversion handles G-code Y inversion.

## 10. Performance

Initial performance targets:

- Small files under 100k triangles should import without noticeable delay.
- Large files should use existing progress reporting during silhouette union.
- Parser should avoid per-line regular expression work where simple splitting is enough.

Potential issues:

- OBJ text files can be much larger than equivalent binary STL.
- Non-manifold OBJ files may hit the slower Clipper projection fallback.
- Concave n-gons fan-triangulated incorrectly may create bad silhouettes.

Future improvement:

- Move OBJ parsing and silhouette generation into a worker with cancellation.
- Add a triangle-count warning threshold.
- Add optional decimation/simplification before top-view preview generation.

## 11. Testing Plan

### 11.1. Parser and Mesh Tests

Add tests to `src/engine/importedMesh.test.ts` or a new `src/engine/objMesh.test.ts`:

- Parses triangle OBJ with `v` and `f`.
- Parses quad and triangulates to two triangles.
- Parses n-gon and triangulates to `n - 2` triangles.
- Supports `v/vt`, `v//vn`, and `v/vt/vn` face tokens.
- Supports negative indices.
- Rejects invalid index `0`.
- Ignores comments, blank lines, `o`, `g`, `s`, `usemtl`, and `mtllib`.
- Computes bounds correctly.
- Applies all axis orientation modes correctly.
- Generic `loadImportedTriangleMesh('obj', ...)` dispatch works.
- Buffer geometry cache returns clones for mutable callers.

### 11.2. Import Extraction Tests

Add tests beside `src/import/stl.test.ts` or generalize it:

- Extracts profile and Z bounds from a simple OBJ box/frustum.
- Produces at least one silhouette path.
- Filters tiny projected artifacts the same way STL import does.
- Handles a non-manifold open OBJ mesh through the Clipper fallback.

### 11.3. UI/Project Flow Tests

Manual verification:

- Import `.obj`.
- Verify 2D silhouette appears.
- Verify top-view image appears in sketch view if generated.
- Verify 3D viewport shows the mesh.
- Move, rotate, scale, copy, delete.
- Save `.camj`, reload, and verify the OBJ model persists.
- Generate rough surface and finish surface operations against the OBJ model.
- Existing STL import still works.

## 12. Implementation Phases

### Phase 1: Core OBJ Mesh Support

- [ ] Extend `ImportedModelFormat` to include `'obj'`.
- [ ] Add base64/data URL text decode helper for OBJ.
- [ ] Implement OBJ parser for `v` and `f`.
- [ ] Triangulate faces.
- [ ] Add OBJ triangle mesh and buffer geometry loaders.
- [ ] Add parser/dispatch unit tests.

### Phase 2: Generic Imported Model Helpers

- [ ] Add `extractImportedModelProfileAndBounds(...)`.
- [ ] Add `renderImportedModelTopViewToDataUrl(...)`.
- [ ] Keep STL wrapper exports for existing callers.
- [ ] Add OBJ extraction tests.

### Phase 3: UI Wiring

- [ ] Add `obj` to `ImportSourceType`.
- [ ] Add `.obj` detection and accepted file types.
- [ ] Read OBJ files and import as `kind: 'stl'` with `stl.format: 'obj'`.
- [ ] Update import dialog copy and errors.
- [ ] Verify save/load behavior.

### Phase 4: Terminology Cleanup

- [ ] Change user-facing rough/finish warnings from "STL" to "model".
- [ ] Audit labels/tooltips for "STL" where "model" is more accurate.
- [ ] Consider later renaming internal types/functions from STL-specific names to model/imported-mesh names.

## 13. Acceptance Criteria

1. `.obj` files can be selected from the existing import dialog.
2. Imported OBJ files create a model feature using the existing mesh-backed feature path.
3. Triangle, quad, and common indexed face syntaxes import correctly.
4. Imported OBJ models render in 2D and 3D.
5. Rough surface and finish surface operations can use OBJ model features.
6. `.camj` save/load preserves imported OBJ models.
7. Existing STL imports and legacy STL project files still work.
8. `npm run build` passes.

## 14. Backlog

- Material/color preview from `.mtl`.
- Split import by OBJ object/group.
- Better triangulation for concave n-gons.
- Worker-based parsing/projection with cancellation.
- Import-time mesh validation and repair hints.
- Optional mesh simplification for very large OBJ files.
- Rename internal `stl` feature terminology to `model` after format support is stable.
