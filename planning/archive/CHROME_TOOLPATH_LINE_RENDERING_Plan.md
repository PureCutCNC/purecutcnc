---
status: Done
created: 2026-05-27
---

# Chrome Toolpath Line Rendering Plan

## Goal

Fix Chrome-on-macOS rendering of dense 3D toolpath overlays where ANGLE's Metal backend draws rough/waterline cut lines in an incorrect upright plane, while the generated toolpath data remains correct and Safari/Firefox render correctly.

## Approach

- Keep CAM/toolpath generation unchanged; the rough and finish move bounds are already correct.
- Change the 3D viewport toolpath overlay submission so dense cut layers are broken into bounded `THREE.LineSegments` geometries instead of one very large line buffer per layer.
- Factor the toolpath line-buffer construction into a small helper that can be unit-tested without WebGL.
- Preserve existing visibility toggles, colors, opacity, direction arrows, and endpoint markers.
- Prefer a conservative chunk size that avoids the Chrome ANGLE Metal corruption without adding excessive Three objects.

## Files affected

- `src/components/viewport3d/Viewport3D.tsx` — chunk dense toolpath line segment buffers and optionally factor buffer construction helpers.
- `src/components/viewport3d/Viewport3D.test.ts` *(new, if practical with existing test runner)* — verify chunked line-buffer bounds and segment counts for synthetic toolpaths.
- `src/components/INDEX.md` — update only if a new test/helper file changes the folder map.

## Tests

- Add a focused unit test for chunking/bounds logic if the helper can stay independent of DOM/WebGL.
- Run `npm run build` before considering the fix complete.
- Manually verify `work/Old-man-simple.camj` in Chrome ANGLE Metal with only rough cuts visible and with finish adaptive refinement enabled.

## Open questions / risks

- The optimal chunk size may need one Chrome test pass on the affected AMD/Metal machine.
- If chunking does not solve the ANGLE Metal corruption, the fallback is a different rendering path for toolpath cuts, such as generated tube/quad meshes or thicker line primitives.

## Out of scope

- Changing rough surface or waterline CAM algorithms.
- Changing simulation rendering.
- Adding browser/GPU detection UI.
