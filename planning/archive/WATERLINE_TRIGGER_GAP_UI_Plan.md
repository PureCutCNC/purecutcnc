---
status: Done
created: 2026-05-25
---

# Waterline Trigger Gap UI Plan

## Goal

Remove the confusing `Trigger Gap` control from the normal waterline finish UI and modestly raise the internal projected-ring budget. The user-visible outcome is that adaptive waterline has one primary density control, `Adaptive Spacing`, while the internal trigger threshold defaults to that same spacing unless a legacy file already carries an explicit value, and detailed models are less likely to stop early at the total insert cap.

## Approach

- Hide `Trigger Gap` for `finish_surface` + `waterline` in the CAM operation properties panel.
- Keep the existing `waterlineRefinementThreshold` schema field and engine support for compatibility.
- For ordinary UI-created/edited waterline operations, leave the field unset/zero so the generator uses the existing default: trigger threshold equals resolved adaptive spacing.
- Increase `WATERLINE_PROJECTED_MAX_TOTAL_RINGS` from `512` to `1000`:
  - this is still a hard bound, not an unbounded refinement loop
  - debug warnings continue to report when the cap is hit
  - `Max Rings / Band` remains separate and still limits any single band/tip
- Do not change the adaptive topology algorithm in this pass. Remaining unfilled cap/band gaps are algorithmic follow-up work, not a parameter-labeling issue.
- Add a short archived-plan note documenting that `Trigger Gap` was removed from normal UI because values below adaptive spacing do not increase pass density.

## Files affected

- `src/components/cam/CAMPanel.tsx` — remove the `Trigger Gap` field from the waterline adaptive controls.
- `src/engine/toolpaths/finishSurfaceWaterline.ts` — raise the internal total projected-ring cap to `1000`.
- `src/engine/toolpaths/finishSurface.test.ts` — keep existing engine coverage for explicit threshold behavior; no broad algorithm changes.
- `planning/archive/WATERLINE_PARAMETERS_QUALITY_CONTROLS_Plan.md` — add note about the UI follow-up.

## Tests

- Run `npm run build`.
- Keep existing waterline threshold tests to preserve compatibility for legacy/debug/manual project data.
- Keep existing cap tests passing with the higher total cap.

## Open questions / risks

- None for the UI change. The larger issue, remaining visible gaps in complex topology, should be handled in a separate adaptive-refinement algorithm plan.

## Out of scope

- Adding debug visualization for skipped bands/caps.
- Reworking cap detection, split/merge matching, or true constant-scallop finishing.
