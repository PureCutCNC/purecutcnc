---
status: Done
created: 2026-05-19
---

# Multi-Body STL Import Plan

## Goal

Fix the STL/OBJ importer so a mesh containing multiple disjoint bodies becomes **multiple sketch features** (one per body) instead of a single feature whose 2D outline and shaded silhouette disagree. Repro path: export a project as STL, re-import it, export again, re-import — the second re-import currently produces one feature whose orange profile covers one body but whose interior shading shows silhouettes of every body. After this change, each disjoint body in the imported mesh becomes its own `SketchFeature` with its own profile, silhouette paths, mesh asset, and Z bounds. Single-body imports keep the current behavior verbatim.

## Approach

1. **Detect connected components on the (welded) triangle mesh.** After the existing `BufferGeometryUtils.mergeVertices(_, 1e-5)` weld in [importedMesh.ts:392](src/engine/importedMesh.ts:392) — extended/mirrored on the normalized `ImportedTriangleMesh` we already operate on — run union-find over triangle edges (each triangle contributes 3 edges; union their endpoint vertex indices). Each connected vertex set defines a body; triangles inherit their component from any of their three vertices.
2. **Split into sub-meshes.** For each component, build a new `ImportedTriangleMesh` containing only its triangles, with vertex indices re-mapped and a recomputed bbox. Reuse [normalizeImportedMeshForStorage](src/engine/importedMesh.ts) shape (positions/indices/bounds).
3. **Run the existing profile pipeline per sub-mesh.** Call `extractImportedMeshProfileAndBounds` on each sub-mesh — no change to its internals, just call it N times. This gives per-body `profile`, `silhouettePaths`, `z_top`, `z_bottom`.
4. **Create N features, one per body.** Each gets its own mesh asset in `project.modelAssets` (separate `meshAssetId` per feature). Naming: `<base>` for the first, `<base> (2)`, `<base> (3)`, … Place all bodies into a new feature folder named after the file so they stay grouped in the tree. Each feature is independently transformable.
5. **Short-circuit when there's one body.** If the connected-component pass yields exactly one component, fall back to today's single-feature code path verbatim — same mesh asset, same `silhouettePaths`, same outputs. No behavior change for single-body imports or for any saved project.
6. **Apply to STL and OBJ.** The split logic lives in the generic `extractImportedModelProfileAndBounds` / `ImportGeometryDialog` model branch, not an STL-only path.

Key design choices to call out:
- **Component detection on the welded mesh, not the raw STL triangles** — STL stores each triangle's 3 vertices independently, so without welding every triangle would look like its own component. The weld tolerance `1e-5` (existing) is reused; not widened.
- **One mesh asset per body**, not a shared asset with triangle-range hints — simpler ownership, lets each feature be independently deleted/moved without dangling references. Storage cost grows linearly with body count, which is acceptable for typical inputs (most STL imports are single-body; round-tripped projects tend to have <10 bodies).
- **No new public API surface in stl.ts**: introduce one new helper (`splitMeshByConnectedComponents`) used inside the import flow. The exported `extractImportedMeshProfileAndBounds` and `extractStlProfileAndBounds` signatures don't change — they still return a single profile, used both by the single-body fast path and by each per-body call.

## Files affected

- [src/engine/importedMesh.ts](src/engine/importedMesh.ts) — new exported function `splitMeshByConnectedComponents(mesh: ImportedTriangleMesh): ImportedTriangleMesh[]` that returns an array of disjoint sub-meshes (length 1 when the input is already a single body). Uses union-find over the index buffer. Recomputes each sub-mesh's `bounds`.
- [src/import/stl.ts](src/import/stl.ts) — no signature changes. May add a small helper that runs `extractImportedMeshProfileAndBounds` for each sub-mesh and returns an array of `{ profile, silhouettePaths, z_bottom, z_top, mesh }` — optional, depends on how cleanly the dialog code reads.
- [src/components/project/ImportGeometryDialog.tsx](src/components/project/ImportGeometryDialog.tsx) — the model-import branch (`isModelSourceType(loadedFile.sourceType)` block, ~lines 234–309) is refactored to:
  1. Split the normalized mesh into bodies.
  2. Loop: per body, project, render top-view, create a feature, register its own `meshAssetId`.
  3. If >1 body, create a `FeatureFolder` named after the file and assign all new features to it.
  4. Naming: `name`, `name (2)`, `name (3)`, …
  5. Progress reporting updated so per-body work scales proportionally (e.g. 70% projection budget divided across N bodies).
- [src/import/stl.test.ts](src/import/stl.test.ts) — add tests (see Tests section).
- [src/engine/importedMesh.test.ts](src/engine/importedMesh.test.ts) — add tests for `splitMeshByConnectedComponents`.
- [src/import/INDEX.md](src/import/) — no current INDEX; not adding one (existing convention skips it). Worth a brief comment update in the file headers if helpful.

No changes to:
- `src/types/project.ts` data model — `STLFeatureData` already supports per-feature `meshAssetId`, and `project.modelAssets` is already a keyed map.
- `src/engine/csg.ts` — already builds one solid per feature.
- The export pipeline (out of scope; that work is in a parallel branch).
- The 3D viewport — already renders each feature's mesh asset independently.

## Tests

All under the existing `npx tsx`-runnable harness pattern (see [src/import/stl.test.ts](src/import/stl.test.ts)). Tests live next to the code they cover.

1. **`splitMeshByConnectedComponents` unit tests** (`src/engine/importedMesh.test.ts`):
   - Single connected mesh (e.g. existing frustum fixture) → returns 1 sub-mesh with identical positions/indices (up to ordering).
   - Two disjoint cubes constructed in test → returns exactly 2 sub-meshes; vertex/triangle counts sum to original; each sub-mesh's bbox matches the corresponding cube; no shared vertex indices across sub-meshes.
   - Three disjoint cubes → returns 3 sub-meshes.
   - Two cubes touching at exactly one vertex (after `1e-5` weld) → returns 1 sub-mesh (documented expectation; weld bridges them).
   - Empty mesh → returns empty array.

2. **Multi-body STL import end-to-end** (`src/import/stl.test.ts`):
   - Construct a binary/ASCII STL with two non-touching cubes positioned, say, at `[0..10]³` and `[20..30]³`.
   - Wire it through `loadImportedTriangleMesh` → `normalizeImportedMeshForStorage` → `splitMeshByConnectedComponents` → `extractImportedMeshProfileAndBounds` per sub-mesh.
   - Assert: 2 results; profile bbox of result[0] matches cube 1 in XY; profile bbox of result[1] matches cube 2 in XY; per-body `z_bottom`/`z_top` match the per-cube Z extents; per-body `silhouettePaths` has exactly one outer contour.

3. **Single-body STL import regression** (`src/import/stl.test.ts`):
   - Existing frustum fixture still produces exactly one feature-equivalent result with the same profile and silhouette as today.

4. **Importing a saved single-body project doesn't change** — covered by (3) since the data shape is unchanged.

`npm run build` must pass.

## Open questions / risks

Resolved with the user:

- **Q1 — Grouping (resolved):** Create a `FeatureFolder` named after the file and place all N bodies inside it. Each body is still independently transformable.
- **Q3 — Body-count cap (resolved):** Cap at **64 bodies**. Above the cap, fall back to today's single-feature behavior and show a post-import warning (`window.alert` style, matching the existing DXF warning pattern in [ImportGeometryDialog.tsx:336](src/components/project/ImportGeometryDialog.tsx)) so the user knows their input exceeded the limit and a single-body import was used instead.
- **Q5 — Model-export branch (resolved):** Export work will be merged into `main` by the time this plan is implemented. This fix is independent of it; rebasing onto main before opening the PR will give a fully reproducible end-to-end fix.

Still flagged as risks but not blocking:

- **Q2 — Touching-but-not-welded bodies.** Two bodies that share a face within the `1e-5` weld tolerance collapse into one component. For round-tripped exports we control, this is exactly what we want (a unioned body stays unioned). For hand-authored inputs with intentionally-touching bodies that the user wants split, this heuristic will fail. Acceptable for v1; documented in code.
- **Q4 — Mesh-asset storage.** Each body becomes its own `PersistedImportedMesh` in `project.modelAssets`. For an N-body file, total bytes are roughly the same as one combined asset (triangles partitioned, not duplicated). No measurable extra storage cost.
- **Q6 — Backward compat with the existing `silhouettePaths` field.** `STLFeatureData.silhouettePaths` is documented as "the first/largest path is mirrored in `sketch.profile`". For per-body features we keep the same invariant: each body's outer contour is the only entry whose silhouette is mirrored as its profile, so the existing canvas rendering at [SketchCanvas.tsx:1278](src/components/canvas/SketchCanvas.tsx:1278) will draw outline-matching-shading correctly. Verify during implementation that the canvas does not rely on `silhouettePaths` being "every projected polygon of the whole mesh".

## Out of scope

- The model-export pipeline (`src/engine/modelExport/`) on its parallel branch — not touched here.
- Repairing non-manifold STLs. The existing fallback chain (manifold → waterline → triangle-projection) is unchanged.
- A "merge bodies" UX action. Users can boolean-union manually if needed.
- Changing exports to write a single welded mesh. Multi-body STL output is standard.
- Widening the global weld tolerance.
- Migrating existing saved projects with multi-body single-feature STL imports. Those keep working as today; users can re-import to get the new split behavior.
