# INDEX — src/engine/operationBooklet/

Per-operation setup-sheet/booklet export logic. This folder stays DOM-free so report and PDF generation can be tested without a browser canvas.

## Files

- `types.ts` — report and input types for operation booklet export.
- `report.ts` — converts project/operation/tool/toolpath data into a localized printable report model through the non-React i18n seam. Every conditional row is gated on the ENGINE's own predicate rather than a copy of the panel's, so the sheet can never claim a setting the generator ignores: `supportsXyLead` for the XY approach, `supportsEntryStrategy`/`resolvedEntryStrategy` for the Z entry (issue #708), `usesTangentLinks`/`takesPocketPattern`/`clearingControlApplies` for the clearing controls. A row that only reports a non-default prints nothing at its default, which is what keeps existing sheets unchanged when a new row lands.
- `pdf.ts` — builds a PDF byte array from the report model and optional snapshot image; dynamically embeds the bundled CJK regular and bold fonts only when Helvetica cannot encode booklet content, retrying a failed font load on the next export.
- `index.ts` — public exports for the booklet engine.
