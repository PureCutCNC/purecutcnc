---
status: Done
created: 2026-06-22
---

# Import Tile Formats Plan

## Goal

Make the empty-project "Import a file" tile accurately advertise every supported import format by adding OBJ and the native CAMJ project format to its visible copy.

## Approach

- Change only the import tile metadata in `EmptyStateOverlay`.
- Replace the current SVG/DXF/STL-only text with `SVG, DXF, OBJ, STL, or CAMJ files`.
- Do not change the tile's action, file-picker filters, import behavior, layout, or styles.

## Files affected

- `src/components/onboarding/EmptyStateOverlay.tsx` — update the one import-format label.

## Tests

- Run `npm run build`.
- Manager review verifies the diff changes only the intended visible copy.
- Final user review confirms the empty-project tile reads correctly on desktop; no tablet-specific interaction change is expected because this is static text in the shared overlay.

## Open questions / risks

- None. The native format is named `.camj` in the codebase, so the UI copy will say `CAMJ` rather than the ambiguous `CAM`.

## Out of scope

- Changes to supported file formats, import parsing, file filters, import dialog copy, or onboarding layout.
