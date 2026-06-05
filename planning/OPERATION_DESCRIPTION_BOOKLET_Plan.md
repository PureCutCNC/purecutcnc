---
status: In progress
created: 2026-06-04
---

# Operation Description + Booklet Export Plan

## Goal

Add richer operation documentation to PureCutCNC by storing a freeform operation description, making that description available to machine-definition G-code templates, and exporting a per-operation PDF booklet that captures the operation setup, selected tool, target features, warnings, and a static sketch-style image of the target geometry with the operation toolpath overlaid.

## Approach

- Add an `Operation.description` field to the project schema, operation defaults, normalization path, duplicate/import flows, and selected-operation UI.
- Extend machine definitions with a per-operation header template block, distinct from the program-level header that is emitted once per file.
- Add operation template variables for G-code output: operation name, description, index, kind, pass, target summary, tool number/name, feed/plunge/rpm, and formatted setup values where practical.
- Sanitize multi-line operation descriptions into controller-safe comment lines using the machine definition comment syntax.
- Update bundled machine definitions so each operation emits a concise header comment that can include `{operationDescription}`.
- Add an operation booklet export action from the operations panel.
- Build a report model from the existing project, operation, tool, generated toolpath, stock envelope, and target feature data.
- Add a static operation snapshot renderer that reuses existing canvas drawing primitives where possible, especially toolpath rendering, origin markers, tabs, and clamps, but avoids coupling the booklet export to interactive `SketchCanvas` state.
- Generate a real PDF file using a small client-side PDF dependency, most likely `pdf-lib`, embedding the operation snapshot image and tabular operation/tool/settings data.
- Include setup-critical text in the PDF overview, including origin Z level and locally generated date/time with timezone offset.
- Estimate feed-controlled operation time from toolpath move distances and operation feed/plunge definitions, while calling out untimed G0 rapid travel separately because controller rapid speed is not currently modeled.
- Flow the PDF body in two columns after the header/snapshot to reduce page count while keeping the operation image full-width.
- Save/export the PDF through the existing platform abstraction, adding binary/blob save support where needed for browser and Tauri desktop.

## Files affected

- `package.json` / `package-lock.json` — add the PDF generation dependency if `pdf-lib` is selected.
- `src/types/project.ts` — add `Operation.description`.
- `src/store/projectStore.ts` — default and normalize operation descriptions, preserve them through duplicate/rest/import paths.
- `src/store/types.ts` — no API shape change expected unless booklet export needs store actions; update if needed.
- `src/components/cam/CAMPanel.tsx` — add the operation description editor and per-operation booklet export action.
- `src/components/cam/*.css` or nearby CSS — style the multiline description field and booklet action if existing classes are insufficient.
- `src/engine/gcode/types.ts` — extend machine definition schema with optional `program.operationHeader`.
- `src/engine/gcode/postprocessor.ts` — emit per-operation header templates with operation context and safe comment handling.
- `src/engine/gcode/definitions/*.json` — add operation header templates to bundled machine definitions.
- `src/engine/gcode/*.test.ts` or new tests — cover operation description/header substitution, multiline comments, and legacy definitions without `operationHeader`.
- `src/components/export/` — add booklet export dialog or helper surface if it does not fit cleanly in `CAMPanel`.
- *(new)* `src/engine/operationBooklet/` or `src/export/operationBooklet/` — report model, PDF builder, formatting helpers, and snapshot coordination.
- *(new or refactored)* `src/components/canvas/operationSnapshot.ts` — render static target geometry + toolpath image to an offscreen canvas using shared drawing primitives.
- `src/components/canvas/previewPrimitives.ts` — factor reusable drawing utilities only if needed for static snapshot rendering.
- `src/platform/api.ts`, `src/platform/browser.ts`, `src/platform/tauri.ts` — add binary/blob file export support for PDF.
- `src/INDEX.md`, `src/engine/INDEX.md`, `src/components/INDEX.md` — update nearby indexes for any new files/folders.

## Tests

- Add G-code postprocessor tests for:
  - `{operationDescription}` replacement in per-operation headers.
  - Empty descriptions producing clean output.
  - Multi-line descriptions emitting safe comment lines.
  - Legacy/custom machine definitions without `operationHeader` still working.
- Add operation normalization tests or extend existing project-store tests to confirm old operations receive `description: ''`.
- Add report-model tests for target feature names, tool details, core operation settings, and warning inclusion.
- Cover generated timestamp, stock size, target feature-name summaries, origin Z summary, and feed-time estimate formatting in report-model tests.
- Add PDF builder smoke tests where practical, validating a non-empty PDF byte output and expected metadata/text markers if the library supports inspection.
- Run `npm run build` before completion.

## Open questions / risks

- The PDF dependency choice should be confirmed during implementation. `pdf-lib` is the likely default because it can generate PDFs in browser and desktop contexts without a server.
- The static sketch-style image should prioritize reliability over perfect parity with the interactive canvas. Exact visual matching may require factoring additional drawing helpers out of `SketchCanvas`.
- Very large toolpaths can create dense snapshot images and large PDFs. The first implementation should cap image resolution and draw density enough to keep export responsive.
- G-code program headers are global while operation descriptions are per-operation, so `{operationDescription}` belongs in a new per-operation header block rather than the existing global `program.header`.

## Out of scope

- Combined shop travelers for all operations in one multi-operation booklet.
- Editing machine definitions through a dedicated UI beyond whatever existing project settings already support.
- 3D-rendered PDF snapshots from the Three.js preview.
- Setup-sheet fields not already represented in the project model, such as clamps/workholding notes independent of operations.
- Versioned `.camj` migration beyond normal load-time normalization.
