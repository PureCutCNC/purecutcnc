---
status: Done
created: 2026-05-25
---

# Waterline Parameters And Quality Controls Plan

## Goal

Make imported-mesh waterline finish parameters predictable, unit-correct, and user-tunable. The user-visible outcome is that waterline quality controls give the operator direct control over adaptive refinement density and limits, explain the difference between coarse waterline slicing and projected adaptive passes, and keep internal numeric guards consistent in inch and metric projects.

## Approach

- Audit current `finish_surface` waterline parameter usage and document the actual behavior:
  - `stepdown` controls coarse Z waterline slice spacing and should primarily affect steep/near-vertical finish quality.
  - `stepover` currently acts as a ratio multiplied by tool diameter and is reused as adaptive micro-offset spacing.
  - radial/axial stock-to-leave, cut direction, regions, intersecting adds, tabs, and clamps keep their existing meanings.
- Replace hard-coded project-unit epsilons with unit-normalized internal constants:
  - remove direct use of `MIN_Z_STEP = 0.01` as a project-unit value
  - define the internal minimum waterline epsilon in mm and convert to project units at runtime
  - rename the local variable to reflect that it is a general waterline length epsilon, not only a Z step
- Add explicit waterline quality controls, shown only for `finish_surface` + `waterline`:
  - `waterlineAdaptiveRefinement` boolean:
    - default missing value to `true`, preserving the current adaptive-refinement behavior
    - `false` keeps coarse waterline rings only, useful when the operator wants predictable constant-Z wall finishing without projected shallow-slope fills
  - `waterlineMicroStepover` optional project length:
    - default/unset/zero means auto, preserving current behavior: `operation.stepover * tool.diameter`
    - positive value overrides projected adaptive band/cap spacing directly
  - `waterlineRefinementThreshold` optional project length:
    - default/unset/zero means auto: refine when the observed XY gap is greater than the resolved adaptive micro stepover
    - positive value lets the operator decide how large a shallow-slope gap must be before extra projected rings are inserted
  - `waterlineMaxRingsPerBand` optional positive integer:
    - default/unset/zero means the existing internal per-band cap
    - positive value limits projected rings generated for any one band/tip, giving a direct runtime/path-density safety control
    - keep the total-operation cap internal as a hard safety guard
- Clarify UI labels/help text for waterline:
  - keep `Stepdown` as length
  - label normal stepover as tool-diameter-relative for waterline, not as a project length
  - present waterline controls as a compact quality block in the operation properties panel:
    - Adaptive refinement: checkbox
    - Adaptive spacing: length input, `0` = auto
    - Refinement trigger gap: length input, `0` = auto
    - Max rings / band: numeric integer input, `0` = auto
  - use concise field labels and existing tooltip/title affordances rather than long visible explanatory copy
- Keep advanced topology heuristics internal for now:
  - overlap thresholds, parent area ratios, cap inside ratios, and the total ring cap remain implementation safety guards
  - debug warnings should report resolved adaptive values and when caps or limits are hit
  - do not expose topology-specific thresholds as ordinary user controls

## Files affected

- `src/types/project.ts` — add optional operation fields for waterline adaptive enablement, micro stepover, refinement threshold, and per-band ring cap.
- `src/store/projectStore.ts` — default and normalize the new fields without breaking older `.camj` files.
- `src/utils/units.ts` — convert new waterline length fields during project unit conversion while leaving boolean/integer controls unchanged.
- `src/components/cam/CAMPanel.tsx` — expose the waterline-only quality control and improve labels/help text.
- `src/engine/toolpaths/finishSurfaceWaterline.ts` — use unit-normalized epsilon plus the new adaptive enablement, spacing, trigger, and per-band cap controls.
- `src/engine/toolpaths/finishSurface.test.ts` — add tests for auto/default controls, explicit controls, and unit-normalized epsilon behavior.
- `src/engine/toolpaths/INDEX.md` — update description if the parameter behavior is documented there.
- `planning/WATERLINE_ADAPTIVE_REFINEMENT_Plan.md` — cross-reference this plan if implementation affects the active adaptive-refinement work.

## Tests

- Add/adjust finish-surface waterline tests covering:
  - default behavior remains compatible when new waterline fields are missing or `0`
  - disabling adaptive refinement emits coarse waterline output only
  - explicit micro stepover changes projected pass density independently of the normal stepover ratio
  - explicit refinement threshold changes when projected passes are inserted without changing their spacing
  - explicit max rings per band limits projected rings and reports a debug warning/metric when hit
  - inch and mm projects use equivalent internal waterline epsilon after unit conversion
  - old projects normalize without losing existing operations
  - UI/store updates preserve the values through project normalization and unit conversion
- Run `npm run build` after implementation.

## Open questions / risks

- Naming: use waterline-specific names (`waterlineMicroStepover`, `waterlineRefinementThreshold`, `waterlineAdaptiveRefinement`, `waterlineMaxRingsPerBand`) so these fields are not confused with normal `stepover`.
- UI semantics: keep normal `stepover` as a ratio for compatibility, but this is confusing for waterline because micro stepover is a length. The UI should make the distinction explicit.
- Defaults: `waterlineAdaptiveRefinement` should default to `true` for missing/legacy operations so existing files retain the current adaptive behavior; numeric `0` or missing should mean auto for the new length/cap controls.
- Existing files may have operation objects without the new field; normalization must keep them valid.
- Exposing too many waterline internals will make the UI noisy. Limit the first pass to controls an operator can reason about from the generated path density: adaptive on/off, spacing, trigger gap, and per-band cap.

## Follow-up: adaptive spacing UI

`WATERLINE_ADAPTIVE_SPACING_UI_Plan.md` refined the UI semantics after implementation: waterline hides the generic tool stepover ratio and shows adaptive spacing as the visible project-length control. Legacy `0` spacing remains supported internally as a fallback to `operation.stepover * tool.diameter`.

## Follow-up: trigger gap UI and cap

`WATERLINE_TRIGGER_GAP_UI_Plan.md` removed the `Trigger Gap` control from the normal waterline UI because values below adaptive spacing do not increase density. The engine field remains for compatibility/manual data, and the internal total projected-ring cap was raised from `512` to `1000`.

## Out of scope

- Reworking the cap/top cleanup algorithm itself.
- Renaming the whole operation or replacing waterline with constant-scallop finishing.
- Exposing topology heuristics such as bbox overlap, parent area ratio, cap inside ratio, or total-operation ring caps as normal UI controls.
- Changing parallel finish parameters.
