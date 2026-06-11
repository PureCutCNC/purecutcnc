# INDEX — src/engine/operationBooklet/

Per-operation setup-sheet/booklet export logic. This folder stays DOM-free so report and PDF generation can be tested without a browser canvas.

## Files

- `types.ts` — report and input types for operation booklet export.
- `report.ts` — converts project/operation/tool/toolpath data into a printable report model.
- `pdf.ts` — builds a PDF byte array from the report model and optional snapshot image.
- `index.ts` — public exports for the booklet engine.
