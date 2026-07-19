# INDEX — src/engine/operationBooklet/

Per-operation setup-sheet/booklet export logic. This folder stays DOM-free so report and PDF generation can be tested without a browser canvas.

## Files

- `types.ts` — report and input types for operation booklet export.
- `report.ts` — converts project/operation/tool/toolpath data into a localized printable report model through the non-React i18n seam.
- `pdf.ts` — builds a PDF byte array from the report model and optional snapshot image; dynamically embeds the bundled CJK regular and bold fonts only when Helvetica cannot encode booklet content, retrying a failed font load on the next export.
- `index.ts` — public exports for the booklet engine.
