# STL Import Feature - Implementation Plan

## 1. Overview
The goal of this feature is to allow users to import 3D STL files into the PureCutCNC workspace. The imported STL will act as a standard "feature" (specifically an additive feature, fixed as `ADD`). Users will be able to interact with the STL feature in both the 2D and 3D views.

## 2. Core Requirements
- **File Loading:** Support loading binary and ASCII STL files (via Tauri's file system or web file picker).
- **2D Visualization:** Generate and display an **exact 2D silhouette** (top-down projection) of the STL in the 2D workspace view.
- **3D Visualization:** Render the complete 3D mesh of the STL in the 3D viewport.
- **Feature Status:** The loaded STL will be treated as a standard workspace feature with its operation fixed to `ADD`.
- **Feature Operations:** Implement standard manipulation operations:
  - **Move:** Translate the STL along X and Y axes.
  - **Resize:** Scale the STL. *Initial implementation will enforce uniform scaling (maintain aspect ratio).* Independent axis scaling will be deferred to a later phase.
  - **Rotate:** Rotate the STL (initially around the Z-axis for 2D alignment).
  - **Copy & Delete:** Duplicate or remove the STL feature from the workspace.

## 3. Architecture & Data Model

### 3.1. Internal Representation
Given that PureCutCNC relies on `manifold-3d` for its CSG engine and `clipper-lib` for toolpathing:
- **Storage (`.camj`):** Introduce a new `STLFeature` extending the base `SketchFeature` or a new `Feature` base. It will store:
  - `filePath` or raw `fileData` (Base64) to persist the STL.
  - `transform`: Translation (X, Y), Rotation (Z), and Scale (Uniform).
  - `z_bottom` and `z_top` (derived from the mesh bounding box + Z-transform, or explicitly set).
- **In-Memory Geometry (`manifold-3d`):** 
  - The STL will be parsed (likely via Three.js `STLLoader`) and converted into a `Manifold` solid.
  - This `Manifold` object will be cached in the application state. By representing it as a `Manifold`, it becomes fully compatible with the existing CSG engine, allowing it to seamlessly intersect/union with the stock and other features in the 3D preview.
  - For future machining operations, the `Manifold` object can be sliced horizontally (`manifold.slice(z)`) into 2D cross-sections (`clipper-lib` compatible polygons) to generate toolpaths, or used for 3D parallel carving operations.

### 3.2. Geometry Processing pipeline
1. **Parsing:** Use `STLLoader` from Three.js to parse the STL file into a `BufferGeometry`.
2. **Manifold Conversion:** Convert the `BufferGeometry` (vertices and indices) into a `Manifold` object.
3. **2D Silhouette Generation:** 
   - Use the `Manifold.project()` function (or equivalent projection math) to squash the 3D manifold into a 2D `CrossSection`.
   - Extract the outer polygons from the `CrossSection` to draw the exact 2D outline in the SketchCanvas.
4. **Caching:** Cache the `Manifold` object, the Three.js `BufferGeometry`, and the 2D `CrossSection` polygons to ensure UI performance during scaling/moving/rotating.

### 3.3. Rendering
- **2D View (`SketchCanvas`):** Draw the cached 2D silhouette using standard HTML5 Canvas paths. Apply standard 2D transforms (translate, rotate, uniform scale) matching the feature's state.
- **3D View (`Viewport3D`):** Add the Three.js mesh to the scene. Apply the feature's transformation matrix directly to the 3D node.

## 4. Implementation Phasing

### Phase 1: Foundation (Current Scope)
- Focus entirely on getting the STL loaded, converted, and displayed.
- Update `src/types/project.ts` to include `STLFeature` types.
- Implement the STL loading logic (file picker -> ArrayBuffer -> Three.js Geometry -> Manifold).
- Render the 3D mesh in `Viewport3D`.
- Render the exact 2D silhouette in `SketchCanvas`.
- Enable core 2D manipulations: Move, Uniform Resize, Rotate Z, Copy, Delete.

### Phase 2: Advanced Manipulation & 3D Operations (Future Scope)
- Independent axis scaling (X, Y, Z resizing).
- Enable the STL to act as a tool for boolean operations (e.g., Subtract, Intersect) against the base stock.
- Implement Z-axis specific placement (e.g., snapping to the top/bottom of the stock).

### Phase 3: Machining Operations (Future Scope)
- Generate toolpaths against the STL feature.
- Use `Manifold.slice()` to generate 2D toolpaths at various step-downs for roughing.
- Implement 3D parallel finishing toolpaths using Z-buffer/heightmap projection over the mesh.

## 5. Verification Plan
- Load an ASCII and Binary STL file into the application.
- Verify the 3D model appears in the 3D viewport.
- Verify an exact silhouette is drawn in the 2D sketch view.
- Ensure the object can be moved, rotated, uniformly scaled, copied, and deleted.
- Save and reload the `.camj` project file to ensure the STL feature persists correctly.
