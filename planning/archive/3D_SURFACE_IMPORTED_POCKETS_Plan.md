---
status: Done
created: 2026-05-20
---

# 3D Surface Imported Pockets Plan

## Goal

Fix imported-mesh 3D operation path generation for vertical-walled block/pocket models and organic imported models. The user-visible outcome is that `work/3d-operations-on-block.camj` produces roughing cuts over the top deck, pockets, and outside walls, waterline finish includes pocket-wall contours instead of only the outside wall, and `work/Oldman-splash-final.camj` produces a roughing path instead of an empty one.

## Approach

- Reproduce the failures with `work/3d-operations-on-block.camj` and `work/Oldman-splash-final.camj`, and add focused synthetic regression coverage so the build catches these imported-mesh roughing/waterline cases.
- Update rough surface generation so closed mesh slices with internal pocket/opening contours are converted into machinable stock regions correctly, instead of treating the accumulated slice shadow as a single fully protected footprint that removes all roughing area.
- Add horizontal exposed-surface rough cleanup so roughing covers top decks and pocket floors, while preserving wall/pocket roughing and model gouge protection.
- Update waterline finish contour extraction/offsetting so internal pocket-wall rings survive as waterline targets while existing outside-wall behavior, clamp/tab protection, and region-mask filtering continue to apply.
- Keep parallel finish semantics as-is for now: it samples top/floor surfaces and does not attempt vertical-wall finishing.

## Files affected

- `src/engine/toolpaths/roughSurface.ts` — revise how per-level mesh slices become protected/model-vs-clearable regions for vertical walls, pockets, top decks, pocket floors, and organic imported models.
- `src/engine/toolpaths/finishSurfaceWaterline.ts` — preserve and emit internal pocket-wall contour rings during waterline finishing.
- `src/engine/toolpaths/modelProtection.ts` — add shared slice-contour helpers needed by roughing and waterline.
- `src/engine/toolpaths/roughSurface.test.ts` — add regressions for vertical-walled imported blocks and organic/no-empty roughing behavior.
- `src/engine/toolpaths/finishSurface.test.ts` — strengthen waterline pocket-block assertions so they require pocket-wall cuts, not merely any waterline cuts; add/keep parallel characterization without changing expected behavior.
- `src/engine/toolpaths/INDEX.md` — update only if helper ownership or file purpose changes materially.

## Tests

- Run `npx tsx src/engine/toolpaths/roughSurface.test.ts`.
- Run `npx tsx src/engine/toolpaths/finishSurface.test.ts`.
- Run ad hoc checks against `work/3d-operations-on-block.camj` confirming:
  - `3D Surface rough` has cuts on the top deck, outside wall, and both pockets.
  - `3D Surface finish` / parallel remains non-empty and continues to cover top/pocket floors.
  - `3D Surface finish 2` / waterline has cuts around both outside walls and pocket-wall contours.
- Run an ad hoc check against `work/Oldman-splash-final.camj` confirming `3D Surface rough` has cut moves.
- Run `npm run build` before completion.

## Open questions / risks

- Roughing semantics for a final model whose top surface is also the stock top are currently under-specified. I will treat roughing as allowed to generate level-based clearing over accessible top/floor/pocket regions, while still respecting the mesh as gouge protection and axial stock-to-leave.
- Vertical walls with a tool radius larger than a pocket opening may legitimately produce no internal wall cuts; tests will use a pocket that has clear tool access.

## Out of scope

- Changing parallel finish to machine vertical walls.
- Adding new UI options or operation kinds.
- Changing G-code export, simulation, or imported mesh storage format unless a toolpath fix exposes a direct bug there.

## TODO
- None. Both planned fixes are complete.
