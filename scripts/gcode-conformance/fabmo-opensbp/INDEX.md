# INDEX — scripts/gcode-conformance/fabmo-opensbp/

- [`validate.ts`](validate.ts) — CLI and pure adapter to the externally built FabMo grammar; exact units-error MSGBOX exception, pin check and original line errors.
- [`validate.test.ts`](validate.test.ts) — corpus coverage and exception boundaries without a parser; real-parser and exported CG/MS mutation checks when installed.

Run through `npm run check:gcode`. Setup and limitations are documented in
[`../README.md`](../README.md#shopbot-fabmo-opensbp-syntax). No FabMo code is
vendored here; the external build lives in `.gcode-conformance/validators/`.
