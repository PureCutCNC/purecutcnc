---
status: Done
created: 2026-05-20
---

# Chrome STL Render Fix Plan

## Goal

The design 3D viewport (`Viewport3D` → `buildFeatureMesh` → `loadPersistedBufferGeometry`) renders imported STL features (`feature.kind === 'stl'`) as an exploded "spike mountain" of disconnected triangles in Chrome on macOS, while Safari renders them correctly. The 2D sketch silhouette is unaffected, and the simulation viewport was already fixed in PR #90 (`81f4597`) using the same workaround.

The bug is Chrome/macOS mis-rendering large `THREE.BufferGeometry` instances whose element index is a `Uint32Array` (i.e. vertex count >65535). The fix is to mirror what `gpuMesh.ts` already does for the simulation viewport: emit `Uint16` indices for small meshes, and chunk the geometry into multiple ≤65535-vertex sub-meshes for large ones.

User-visible outcome: imported STL meshes render correctly in Chrome with no change in appearance in Safari.

## Approach

1. In `src/engine/importedMesh.ts`, change `triangleMeshToBufferGeometry` so that:
   - When `vertexCount <= 65535`, set the index attribute as `Uint16Array`.
   - When `vertexCount > 65535`, build a `THREE.Group` of chunked `THREE.BufferGeometry` objects. Each chunk owns ≤65535 vertices, is indexed with `Uint16Array`, and carries its own per-chunk `position` attribute (vertices are partitioned per chunk so the same vertex referenced by triangles in two chunks is duplicated). Triangles are assigned to chunks greedily by walking `mesh.index` and starting a new chunk when adding the next triangle would exceed 65535 unique vertices.
   - Return a new union type `ImportedMeshObject = THREE.BufferGeometry | THREE.Group` (or simpler: always return `THREE.BufferGeometry[]` and let callers decide how to wrap). To minimise caller churn, I'll introduce a new exported function `triangleMeshToBufferGeometryChunks(mesh, mergeVertices): THREE.BufferGeometry[]` and keep `triangleMeshToBufferGeometry` as a thin wrapper that throws when the result needs chunking (so we catch any stragglers). The new function is what `buildFeatureMesh` will use.
   - `mergeVertices` is applied per chunk after the per-chunk geometry is built (the chunker partitions on the raw index, so merging only removes intra-chunk duplicates — that matches today's behaviour for STLs, which generally pass `mergeVertices=false` in the design viewport path).
2. Add `loadPersistedBufferGeometryChunks(mesh, mergeVertices): THREE.BufferGeometry[] | null` alongside the existing `loadPersistedBufferGeometry`. It caches the chunk array the same way the single-geometry path does (cloning each chunk on get/set). The single-geometry function is kept for any non-rendering callers (none today, but `loadStlBufferGeometry` returns a single BufferGeometry for the STL loader path used elsewhere — that path is not affected by the bug because it's not used in `buildFeatureMesh`).
3. In `src/engine/csg.ts` → `buildFeatureMesh`, change the STL branch to:
   - Call `loadPersistedBufferGeometryChunks`.
   - Build a `THREE.Group`, attach a `THREE.Mesh` per chunk (one shared `MeshStandardMaterial`).
   - Apply *all* transforms (scale, z-fit translate/scale, rotateZ, sketch-origin translate, rotateX(-π/2), `scale.z = -1`) to the `Group` via its `position` / `rotation` / `scale` properties rather than baking them into each geometry. The current code uses `geometry.scale/translate/rotateX` to bake transforms into the buffer; switching to Group-level transforms is equivalent for rendering and avoids per-chunk redundant work.
   - To compute the z-fit (needs the mesh's untransformed bounding box for `meshHeight`), compute the union bounding box across chunks once. The chunks come from `mesh.bounds` on the persisted mesh, so use `asset.bounds` directly — that's already the right untransformed bound, no recompute needed.
   - Change `buildFeatureMesh`'s return type from `THREE.Mesh` to `THREE.Object3D` and update the `featureMeshes: Map<string, THREE.Mesh>` map type in `csg.ts` (around line 892) to `Map<string, THREE.Object3D>`.
4. In `src/components/viewport3d/Viewport3D.tsx`, update the two cleanup loops (around lines 905 and 931) that iterate `featureMeshes` and call `featureMesh.geometry.dispose()` / `disposeObjectMaterial(featureMesh.material)`. Replace with a helper that traverses the object and disposes geometry + material on each descendant Mesh. The materials inside a Group share the same instance, so dispose once per unique material (or just dispose per-mesh — `Material.dispose()` is idempotent).
5. The chunker is straightforward: walk triangles in order, maintain a `Map<oldIndex, newIndex>` for the current chunk. When adding a triangle would push new-vertex count over 65535, close the current chunk and start a fresh one. Each chunk emits its own `Float32Array` positions and `Uint16Array` indices.

Non-STL features (Extrude/Wall geometries) are bounded in size by sketch complexity and do not hit the bug; they keep returning a single `THREE.Mesh`. The STL branch is the only one that emits Groups.

## Files affected

- `src/engine/importedMesh.ts` — rewrite `triangleMeshToBufferGeometry` to choose Uint16 indices; add `triangleMeshToBufferGeometryChunks` and `loadPersistedBufferGeometryChunks`. Extend the persisted-geometry cache to store `THREE.BufferGeometry[]` per key (separate cache map from the existing single-geometry one, to avoid breaking the legacy function).
- `src/engine/csg.ts` — `buildFeatureMesh` (around line 425) rewires the STL branch to build a `THREE.Group` from chunked geometries with Group-level transforms; change return type to `THREE.Object3D`. Update the `BuiltSceneObjects` type and `featureMeshes` map at lines 892, 910, 928, 937, 970 to use `THREE.Object3D`.
- `src/components/viewport3d/Viewport3D.tsx` — update the two cleanup blocks at ~lines 901–916 and ~931–934 to traverse `Object3D` descendants for geometry/material disposal. Same for the line where `featureMesh` is added to the scene (no change needed there — `scene.add` accepts any Object3D).
- `src/engine/importedMesh.test.ts` — extend with chunker invariant tests (see Tests). Adds shared `assertWebGLSafe(root)` helper, exported from this file or a new `src/engine/__test_helpers__/webglSafe.ts`.
- `src/engine/simulation/gpuMesh.test.ts` — extend with `createStockPlaneGeometries` / `createDynamicProfileBoundaryGeometries` invariant tests (regression-guards PR #90).
- *(new)* `scripts/run-tests.ts` — recursive `src/**/*.test.ts` discoverer + runner via `tsx`. Exits non-zero on first failure.
- `package.json` — add `"test": "tsx scripts/run-tests.ts"`; change `"build"` to `node scripts/convert-camj-to-icons.js && tsc -b && npm test && vite build`.
- `AGENTS.md` — short note under "Build & Verify" that `npm test` runs the structural test suite and is now part of `npm run build`.

## Tests

Goal: structurally guarantee the "Uint32 indices on big meshes" bug class cannot recur — for both the design viewport (STL chunker) and the simulation viewport (PR #90 chunker). Tests are pure JS-level invariant checks; they do not render, so they're deterministic and fast.

A shared helper will live alongside one of the test files:

```ts
// Walks the object tree, asserts every BufferGeometry has Uint16 indices and ≤65535 vertices.
function assertWebGLSafe(root: THREE.Object3D | THREE.BufferGeometry | THREE.BufferGeometry[]): void
```

### STL chunker tests — extend `src/engine/importedMesh.test.ts`

1. **Small mesh: single Uint16 chunk.** Build an `ImportedTriangleMesh` with 1000 vertices, 500 triangles. Assert `triangleMeshToBufferGeometryChunks` returns one chunk with `Uint16Array` index and vertex count 1000.
2. **Large mesh: multiple ≤65535-vertex Uint16 chunks.** Build ~100 000 vertices / ~33 334 triangles, each triangle using three fresh vertices (forces splits). Assert: ≥2 chunks, every chunk ≤65535 verts and `Uint16Array` indexed, total triangle count preserved, and the union of chunk-decoded triangles equals the input triangle set (multiset).
3. **Vertex-shared triangles.** ~80 000 vertices with many shared-vertex triangles. Assert chunker still respects 65535 per chunk while preserving the triangle set.
4. **`mergeVertices=true` welds duplicates within a chunk.** Small mesh with co-located dupes — vertex count after merge < before.
5. **`buildFeatureMesh` invariant (integration).** Construct a minimal `Project` + STL `SketchFeature` with a >65535-vert persisted mesh. Call `buildFeatureMesh`, then `assertWebGLSafe(result)` — guards the call site, not just the chunker.

### Simulation chunker tests — extend or add `src/engine/simulation/gpuMesh.test.ts`

These regression-guard PR #90 at the same time.

6. **`createStockPlaneGeometries` invariant.** For a small grid (e.g. 32×32) assert one chunk, Uint16; for a large grid (e.g. 512×512, ≥263 000 verts) assert ≥2 chunks, every chunk ≤65535 verts and `Uint16Array` indexed.
7. **`createDynamicProfileBoundaryGeometries` invariant.** Same shape: small grid → single chunk Uint16; large grid → chunked Uint16. (For the large case, fill `grid.topZ` with a value above `stockBottomZ + eps` so the boundary actually emits geometry.)

### Build wiring

- Add a new `scripts/run-tests.ts` (or `.mjs`) that discovers every `src/**/*.test.ts` file and runs them through `tsx`, exiting non-zero on the first failure. Discovery via `fs.readdirSync` recursion, glob-free, so no new dependency.
- Add `"test": "tsx scripts/run-tests.ts"` to `package.json`.
- Change the build script to `node scripts/convert-camj-to-icons.js && tsc -b && npm test && vite build` so `npm run build` fails if any structural test fails.
- All test files, fixtures, and the runner script are checked into git as part of this PR.

Trade-off: build time grows by the test runtime (today's existing tests run in well under a second; the new ones build small Float32Arrays and traverse them, so still sub-second). Acceptable for the safety it buys.

## Open questions / risks

- **Material sharing inside the Group:** if one material instance is shared by all chunks, hover/select state changes (which today re-call `buildFeatureMesh` with new `selected`/`hovered` flags) still work because the whole Object3D is rebuilt. No change to hover logic needed.
- **Caching cost:** the persisted-geometry cache currently stores one `THREE.BufferGeometry` per key and clones on get/set. For chunked meshes it'll store an array and clone each chunk. With `GEOMETRY_CACHE_LIMIT = 6` this is bounded; memory rise is proportional to the total geometry size which we'd be paying anyway.
- **Disposal correctness:** ensure no chunk leaks geometry on the cancellation path (the `if (cancelled || ...)` block in `Viewport3D.tsx`). I'll write the traversal helper as `disposeObject3D(obj: THREE.Object3D)` and reuse it in both the cancellation cleanup and the regular `clearRenderedObjects` flow.
- **Type ripple:** changing `featureMeshes: Map<string, THREE.Mesh>` to `Map<string, THREE.Object3D>` ripples through any `.geometry`/`.material` direct access. I'll grep for those and adjust. Initial scan shows the only direct `.geometry`/`.material` access is inside the cancellation cleanup loops, which I'm already rewriting.
- **Out-of-design-viewport STL consumers:** `loadStlBufferGeometry` is also used (e.g. STL export path). That path returns a single `BufferGeometry` and doesn't render in Chrome's WebGL — it feeds STL serialization or other engines. I'm not touching it. Only the persisted-geometry render path used by `buildFeatureMesh` is changed.

## Out of scope

- Multi-body STL splitting (`splitMeshByConnectedComponents`) and the work on branch `eloquent-borg-8172f2` — separate PR.
- Other Chrome/macOS WebGL workarounds (e.g. for OBJ, for non-STL features). Not affected by this bug; if any surface in the future, treat as separate plans.
- Refactoring the persisted-mesh / triangle-mesh cache layer beyond adding the new chunked-geometry cache.
- Any changes to `loadStlBufferGeometry` or the STL export pipeline.
