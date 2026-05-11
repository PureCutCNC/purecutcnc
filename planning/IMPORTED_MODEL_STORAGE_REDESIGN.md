# Imported Model Storage Redesign

## 1. Problem

Imported 3D models are currently treated as source-file-backed features:

- STL/OBJ file contents are stored in `feature.stl.fileData`.
- Runtime geometry is parsed from that payload through `loadImportedBufferGeometry(...)` / `loadImportedTriangleMesh(...)`.
- Toolpaths use transformed internal mesh arrays, but those arrays are derived from the persisted source payload on cache miss or project reload.
- `.camj` save writes the full project with `JSON.stringify(...)`.
- Undo/redo history uses `structuredClone(project)`, so large embedded model payloads are cloned into history snapshots.

This is acceptable for small STL files but breaks down for large text OBJ files. A 151 MB OBJ can become hundreds of MB as base64/text and then several more copies as parsed arrays, Three.js geometry, transformed mesh data, top-view images, and history snapshots.

The core design issue: **OBJ/STL should be import formats only. They should not remain the persisted model representation.**

## 2. Goals

- Parse STL/OBJ exactly once at import time.
- Persist a compact normalized internal triangle mesh in `.camj`.
- Never require reparsing STL/OBJ after import.
- Keep legacy `.camj` files with `stl.fileData` loadable.
- Use one mesh-backed path for STL, OBJ, and future mesh formats.
- Avoid cloning large immutable mesh payloads through undo/redo history.
- Keep rough/finish toolpaths, 3D preview, silhouette rendering, and boolean fallback behavior intact.

## 3. Non-Goals

- No full binary `.camj` container in the first pass.
- No external asset sidecar files in the first pass.
- No mesh decimation/simplification in the first pass.
- No split-by-OBJ-object workflow.
- No material/texture persistence.
- No full rename from `kind: 'stl'` to `kind: 'model'` in the first pass, unless the implementation scope explicitly includes migration of all call sites.

## 4. New Mental Model

There are three separate concepts:

1. **Source import format**
   - Examples: `stl`, `obj`.
   - Used only while reading the selected file.

2. **Persisted model asset**
   - The normalized triangle mesh saved in `.camj`.
   - Format-independent.
   - Reloads without STL/OBJ parsing.

3. **Runtime model geometry**
   - Typed arrays, Three.js `BufferGeometry`, Manifold meshes, transformed toolpath arrays, and slice caches.
   - Derived from the persisted model asset.
   - Cached in memory.

The feature can keep the legacy `stl` property name during migration, but the data inside it should move from source-file-backed to mesh-backed.

## 5. Proposed Data Model

### 5.1. Project Types

Add a new persisted internal mesh type:

```ts
export type ImportedModelSourceFormat = 'stl' | 'obj'

export interface ImportedMeshBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
}

export interface PersistedImportedMesh {
  storage: 'mesh-v1'
  sourceFormat?: ImportedModelSourceFormat
  vertexCount: number
  triangleCount: number
  positions: string // base64 Float32Array bytes, little-endian platform representation
  indices: string // base64 Uint32Array bytes
  bounds: ImportedMeshBounds
}

export interface STLFeatureData {
  /**
   * Legacy source import format. Missing means legacy STL.
   * Retained for old files and source attribution.
   */
  format?: ImportedModelSourceFormat

  /**
   * New normalized persisted mesh. Preferred for all new imports.
   */
  mesh?: PersistedImportedMesh

  /**
   * Legacy embedded source file. Only used for old .camj migration.
   * New imports should not write this field.
   */
  fileData?: string

  scale: number
  axisSwap?: 'none' | 'yz' | 'xz' | 'xy'
  silhouetteDataUrl?: string
  silhouettePaths?: Point[][]
  topViewDataUrl?: string
}
```

Notes:

- `positions` stores the original imported model coordinates after import-unit scaling and axis orientation have been applied.
- `indices` stores the triangulated mesh.
- `bounds` are for the stored mesh coordinates.
- `scale` should become a feature transform scale, not the import-unit conversion. For newly imported mesh-backed models, set `scale: 1` after baking import units into positions.
- `axisSwap` is retained for legacy source-backed files. For new mesh-backed imports, axis orientation should be baked into positions and `axisSwap` should be `'none'` or omitted.

### 5.2. Why Base64 Typed Arrays

Plain JSON cannot store typed arrays compactly. Numeric JSON arrays are much worse for large meshes because every float/index becomes decimal text.

Base64 typed-array bytes are still larger than raw binary, but they are:

- much smaller than OBJ text for typical indexed meshes,
- faster to decode than reparsing OBJ/STL,
- compatible with current `.camj` JSON save/load,
- straightforward to migrate later into a zipped/binary project format.

Expected sizes:

- positions: `vertexCount * 3 * 4` bytes before base64.
- indices: `triangleCount * 3 * 4` bytes before base64.
- base64 overhead: roughly 33%.

This will still be large for high-poly models, but it removes OBJ text parsing and reduces duplicate source-file storage.

## 6. Import Pipeline

New flow:

1. User selects `.stl` or `.obj`.
2. Importer parses the source once into `ImportedTriangleMesh`.
3. Apply source unit conversion and selected axis orientation directly to the mesh positions.
4. Optionally merge duplicate vertices if needed for STL.
5. Compute bounds from the normalized positions.
6. Generate silhouette paths and sketch profile from the normalized mesh.
7. Generate top-view preview from the normalized mesh, or skip for very large meshes.
8. Store `stl.mesh`.
9. Do not store `stl.fileData` for new imports.

The import format parser should return:

```ts
interface ImportedTriangleMesh {
  positions: Float32Array
  index: Uint32Array
  bounds: ImportedMeshBounds
}
```

Then a serializer converts that into `PersistedImportedMesh`.

## 7. Loader API

Replace source-file-first APIs with mesh-first APIs.

### 7.1. Current Problem APIs

```ts
loadImportedBufferGeometry(format, fileData, axisOrientation, mergeVertices)
loadImportedTriangleMesh(format, fileData, axisOrientation)
```

These force callers to have the source file.

### 7.2. New APIs

```ts
parseImportedSourceToMesh(format, sourceData, options): ImportedTriangleMesh | null

serializeImportedMesh(mesh, sourceFormat): PersistedImportedMesh
deserializeImportedMesh(mesh): ImportedTriangleMesh | null

loadFeatureImportedMesh(feature): ImportedTriangleMesh | null
loadFeatureBufferGeometry(feature, mergeVertices): THREE.BufferGeometry | null
```

`loadFeatureImportedMesh(feature)` behavior:

1. If `feature.stl.mesh` exists, decode it.
2. Else if legacy `feature.stl.fileData` exists, parse source file and optionally migrate in memory.
3. Else return null.

The legacy path should be isolated and clearly marked as migration compatibility.

## 8. Transform Model

Separate import normalization from user transforms.

### 8.1. Baked Into Persisted Mesh

- source units to project units,
- import axis orientation,
- triangulation,
- vertex merging if performed,
- raw mesh bounds.

### 8.2. Feature Transform

- `sketch.origin.x/y`,
- `sketch.orientationAngle`,
- feature scale if still needed,
- `z_top` / `z_bottom` vertical fitting.

Toolpath transforms should start from the decoded persisted mesh, not from reparsed source geometry.

## 9. Toolpaths and Preview

### 9.1. Rough/Finish Surface

`loadSTLTransformedGeometry(...)` should be renamed or wrapped as:

```ts
loadModelTransformedGeometry(feature, project): ModelTransformedData | null
```

It should:

1. Get the persisted/internal mesh via `loadFeatureImportedMesh(feature)`.
2. Apply feature transforms to produce the existing `positions` and `index` runtime data.
3. Cache by stable mesh id/version plus feature transform fields.

The path algorithms should not care whether the model came from STL, OBJ, or future mesh import.

### 9.2. 3D Preview

`buildFeatureMesh(...)` should create `BufferGeometry` from the persisted/internal mesh, not from source file data.

### 9.3. Boolean Solid

`buildFeatureSolid(...)` should build Manifold mesh from the persisted/internal mesh. If Manifold rejects it, the fallback silhouette extrusion behavior remains.

## 10. Caching

Add stable identity for persisted mesh:

```ts
meshId: string
meshVersion: number
```

Options:

- Use a generated UUID at import time.
- Include `meshVersion: 1`.
- Cache keys use `meshId`, `meshVersion`, vertex/triangle counts, and transform fields.

Avoid using huge `fileData` strings as cache identity.

Caches:

- decoded mesh cache: `meshId -> ImportedTriangleMesh`
- BufferGeometry cache: `meshId + mergeVertices`
- transformed geometry cache: `meshId + origin + angle + zTop + zBottom + scale`
- slice index cache remains attached to transformed data.

Cache entries should not retain the legacy source file.

## 11. Undo/Redo History

This is a separate but related memory issue.

Current `cloneProject(project)` uses `structuredClone(project)`. With mesh base64 in project state, history still duplicates large model strings across up to 100 snapshots.

Recommended first pass:

- Store imported meshes in a project-level asset table by id.
- Features reference assets by id.
- History snapshots include feature references, not duplicated mesh payloads.

Example:

```ts
interface Project {
  modelAssets?: Record<string, PersistedImportedMesh>
  features: SketchFeature[]
}

interface STLFeatureData {
  meshAssetId?: string
  // legacy/inlined fallback:
  mesh?: PersistedImportedMesh
  fileData?: string
}
```

This is a bigger data model change but is the right direction.

Pragmatic phase:

1. First implement `mesh` inline on the feature to stop reparsing and source persistence.
2. Then move large meshes into `project.modelAssets` to stop history duplication.

If doing both together is acceptable, prefer going straight to `modelAssets`.

## 12. Save/Load Compatibility

### 12.1. New Files

New imports should save:

- `mesh` or `meshAssetId`,
- source attribution `format`,
- silhouette paths,
- top-view data URL if generated,
- feature transform fields.

New imports should not save:

- original OBJ/STL `fileData`,
- source `filePath` unless it is just advisory metadata.

### 12.2. Legacy Files

When opening old `.camj` files:

- If `stl.mesh`/`meshAssetId` exists, use it.
- Else if `stl.fileData` exists:
  - keep the feature loadable,
  - parse source through the legacy path,
  - optionally migrate to mesh-backed storage immediately,
  - mark project dirty if migration changes persisted data.

Migration can initially happen lazily on first geometry load, but save should write mesh-backed data after migration.

## 13. Large Model Guardrails

Even with mesh-backed storage, very large models can still be too expensive.

Add import warnings:

- source file > 50 MB,
- decoded mesh > configurable vertex/triangle threshold,
- projected silhouette union expected to be expensive,
- top-view preview skipped because model is too large.

Add hard or soft limits:

- Ask for confirmation above a threshold.
- Skip `topViewDataUrl` generation above a threshold.
- Consider disabling history snapshot for the import payload itself when using project-level assets.

## 14. Implementation Phases

### Phase 1: Persisted Mesh Format

- [ ] Add `PersistedImportedMesh` and source-format types.
- [ ] Add typed-array base64 encode/decode helpers.
- [ ] Add serialize/deserialize tests.
- [ ] Extend `STLFeatureData` with `mesh?: PersistedImportedMesh`.

### Phase 2: Import-Time Conversion

- [ ] Change STL import to parse once and store `mesh`.
- [ ] Change OBJ import to parse once and store `mesh`.
- [ ] Bake unit conversion and axis orientation into positions.
- [ ] Stop writing `fileData` for new imports.
- [ ] Generate silhouette/top-view from the parsed mesh without reparsing.

### Phase 3: Runtime Loader Refactor

- [ ] Add `loadFeatureImportedMesh(...)`.
- [ ] Update 3D preview to load from persisted mesh.
- [ ] Update transformed geometry/toolpath loader to load from persisted mesh.
- [ ] Update Manifold solid path to load from persisted mesh.
- [ ] Keep source-file parsing only as legacy fallback.

### Phase 4: Compatibility and Migration

- [ ] Load old `.camj` files with `fileData`.
- [ ] Migrate legacy `fileData` to `mesh` on save or first use.
- [ ] Add tests for legacy STL default format.
- [ ] Add tests for OBJ mesh-backed save/load.

### Phase 5: Project Asset Table

- [ ] Add `project.modelAssets`.
- [ ] Store large meshes by asset id.
- [ ] Make model features reference `meshAssetId`.
- [ ] Update history cloning to avoid duplicating unchanged model assets.
- [ ] Add asset garbage collection when model features are deleted.

## 15. Acceptance Criteria

1. New STL imports do not store original STL source in `.camj`.
2. New OBJ imports do not store original OBJ source in `.camj`.
3. Saving and reopening a project does not reparse STL/OBJ.
4. 3D preview, rough surface, and finish surface use decoded persisted mesh data.
5. Legacy projects with `stl.fileData` still open and work.
6. History no longer duplicates large model source payloads for new imports after the asset-table phase.
7. `npm run build` passes.

## 16. Decision

Proceed with mesh-backed persistence. Treat STL/OBJ as one-time import formats. Keep legacy source-file support only for old project compatibility.
