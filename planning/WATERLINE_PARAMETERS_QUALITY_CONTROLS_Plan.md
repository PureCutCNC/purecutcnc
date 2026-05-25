---
status: Draft
created: 2026-05-25
---

# Waterline Parameters And Quality Controls Plan

## Goal

Make imported-mesh waterline finish parameters predictable, unit-correct, and user-tunable. The user-visible outcome is that waterline quality controls explain what they affect, adaptive micro-offset spacing can be adjusted directly, and internal numeric guards behave consistently in inch and metric projects.

## Approach

- Audit current `finish_surface` waterline parameter usage and document the actual behavior:
  - `stepdown` controls coarse Z waterline slice spacing and should primarily affect steep/near-vertical finish quality.
  - `stepover` currently acts as a ratio multiplied by tool diameter and is reused as adaptive micro-offset spacing.
  - radial/axial stock-to-leave, cut direction, regions, intersecting adds, tabs, and clamps keep their existing meanings.
- Replace hard-coded project-unit epsilons with unit-normalized internal constants:
  - remove direct use of `MIN_Z_STEP = 0.01` as a project-unit value
  - define the internal minimum waterline epsilon in mm and convert to project units at runtime
  - rename the local variable to reflect that it is a general waterline length epsilon, not only a Z step
- Add explicit waterline quality controls:
  - add an optional waterline-only adaptive micro stepover field, stored as a project length
  - default/unset/zero means auto, preserving current behavior: `operation.stepover * tool.diameter`
  - positive value overrides the adaptive micro-offset spacing directly
  - expose this in the CAM operation panel only for `finish_surface` + `waterline`
- Clarify UI labels/help text for waterline:
  - keep `Stepdown` as length
  - clarify that current `Stepover Ratio` is tool-diameter-relative
  - add short helper text for adaptive micro stepover: smaller is smoother/denser, larger is faster/coarser
- Keep advanced topology heuristics internal for now:
  - overlap thresholds, parent area ratios, cap inside ratios, and ring-count caps remain implementation safety guards
  - debug warnings can report when caps or limits are hit, but these should not be ordinary user controls yet

## Files affected

- `src/types/project.ts` — add optional operation field for waterline adaptive micro stepover.
- `src/store/projectStore.ts` — default and normalize the new field without breaking older `.camj` files.
- `src/utils/units.ts` — convert the new length field during project unit conversion.
- `src/components/cam/CAMPanel.tsx` — expose the waterline-only quality control and improve labels/help text.
- `src/engine/toolpaths/finishSurfaceWaterline.ts` — use unit-normalized epsilon and the new adaptive micro stepover override.
- `src/engine/toolpaths/finishSurface.test.ts` — add tests for auto micro stepover, explicit micro stepover, and unit-normalized epsilon behavior.
- `src/engine/toolpaths/INDEX.md` — update description if the parameter behavior is documented there.
- `planning/WATERLINE_ADAPTIVE_REFINEMENT_Plan.md` — cross-reference this plan if implementation affects the active adaptive-refinement work.

## Tests

- Add/adjust finish-surface waterline tests covering:
  - default behavior remains compatible when `waterlineMicroStepover` is missing or `0`
  - explicit micro stepover changes projected pass density independently of the normal stepover ratio
  - inch and mm projects use equivalent internal waterline epsilon after unit conversion
  - old projects normalize without losing existing operations
  - UI/store updates preserve the value through project normalization and unit conversion
- Run `npm run build` after implementation.

## Open questions / risks

- Naming: `waterlineMicroStepover`, `adaptiveStepover`, or `waterlineAdaptiveStepover`. The stored field should be specific enough to avoid confusion with normal `stepover`.
- UI semantics: keep normal `stepover` as a ratio for compatibility, but this is confusing for waterline because micro stepover is a length. The UI should make the distinction explicit.
- Existing files may have operation objects without the new field; normalization must keep them valid.
- Exposing too many waterline internals will make the UI noisy. Start with one direct quality knob and keep topology heuristics internal.

## Out of scope

- Reworking the cap/top cleanup algorithm itself.
- Renaming the whole operation or replacing waterline with constant-scallop finishing.
- Exposing topology heuristics such as bbox overlap, parent area ratio, cap inside ratio, or ring caps as normal UI controls.
- Changing parallel finish parameters.
