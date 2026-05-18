---
status: Done
created: 2026-05-18
completed: 2026-05-18
---

# README 3D Coverage Plan

## Goal

The README undersells what the app does today. It lists SVG and DXF under "Import geometry" but doesn't mention STL or OBJ, and it lists Surface Rough / Surface Finish in the operation set without telling the reader those operate on an imported 3D mesh. A new user reading README.md would not realize the app handles 3D model import or 3D surface machining at all.

## Approach

Three small additions to `README.md`:

1. **Add a "3D model import" subsection** under "Import geometry", explaining STL/OBJ import, axis orientation, silhouette extraction for 2D representation, and that the mesh participates in surface machining.
2. **Add brief context in the operation list** so Surface Rough / Surface Finish read as "machine an imported 3D mesh (rough / finish passes, parallel and waterline patterns)" rather than bare names.
3. **Tweak the intro** to note that 2.5D is the core focus but the app also handles 3D surface machining of imported meshes (rough + finish). One sentence.

Tone stays factual; no marketing language.

## Files affected

- `README.md` — three localized edits as above. No other files touched.

## Tests

None — documentation only.

## Open questions / risks

- None. The features exist (`stl.ts`, `obj.test.ts`, `roughSurface.ts`, `finishSurface.ts`, `finishSurfaceParallel.ts`, `finishSurfaceWaterline.ts`); we're describing reality, not promising work.

## Out of scope

- Restructuring the README, screenshots, changing the tone of the rest of the doc, or updating any other doc (ARCHITECTURE.md, AGENTS.md). This is README-only.
