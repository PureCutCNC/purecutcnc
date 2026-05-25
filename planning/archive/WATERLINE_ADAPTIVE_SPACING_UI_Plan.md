---
status: Done
created: 2026-05-25
---

# Waterline Adaptive Spacing UI Plan

## Goal

Make waterline adaptive spacing visible and editable as a real project length, without exposing the generic tool stepover ratio in waterline operations. The user-visible outcome is that waterline shows one clear spacing control: the actual adaptive spacing in mm or inches.

## Approach

- Hide the generic `stepover` / `Tool Stepover Ratio` field whenever the selected operation is `finish_surface` with `pocketPattern === 'waterline'`.
- Treat `waterlineMicroStepover` as the primary waterline adaptive spacing control in the UI:
  - show it as a length field in project units
  - initialize new waterline operations from `operation.stepover * selectedTool.diameter` or the selected tool's default stepover ratio and diameter
  - when a waterline operation's tool changes, update `waterlineMicroStepover` to the newly selected tool's default-derived length, matching existing tool-change behavior for feeds/speeds/stepdown/stepover
- Keep generator compatibility for old files:
  - if `waterlineMicroStepover` is missing or `0`, fall back to the existing auto value: `operation.stepover * tool.diameter`
  - normalize legacy operations safely, but avoid showing `0 = auto` as the ordinary new-operation state
- Keep `Trigger Gap` and `Max Rings / Band` as optional/auto controls for now.

## Files affected

- `src/components/cam/CAMPanel.tsx` — hide generic stepover for waterline, show adaptive spacing as the primary length control, and update tool-change behavior.
- `src/store/projectStore.ts` — initialize waterline adaptive spacing for newly created waterline operations when enough tool data is available.
- `src/engine/toolpaths/finishSurfaceWaterline.ts` — keep existing fallback behavior for legacy operations.
- `src/engine/toolpaths/finishSurface.test.ts` — adjust/add tests for explicit adaptive spacing and legacy fallback.
- `planning/archive/WATERLINE_PARAMETERS_QUALITY_CONTROLS_Plan.md` — add a note that this follow-up refined the UI semantics.

## Tests

- Add or update tests covering:
  - explicit `waterlineMicroStepover` continues to control projected pass density
  - `waterlineMicroStepover = 0` still falls back to `operation.stepover * tool.diameter` for old files
  - new waterline operations get a positive adaptive spacing derived from the selected tool
- Run `npm run build` after implementation.

## Open questions / risks

- Existing waterline operations created before this follow-up may still have `waterlineMicroStepover = 0`; the generator fallback keeps them valid, and the UI can show the resolved spacing if needed.

## Out of scope

- Changing the waterline adaptive algorithm itself.
- Removing `operation.stepover` from the project schema.
- Changing parallel or non-waterline operation stepover behavior.
