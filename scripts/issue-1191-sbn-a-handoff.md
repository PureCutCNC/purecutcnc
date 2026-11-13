# Issue #1191 handoff, slice sbn-a: ShopBot export says SBP output is experimental

Branch `fix/issue-1191-sbp-experimental-note`, based on `integration/0.6.0` at `b9543147`. Frank approved the plan for 0.6.0 (issue #1191). The PR goes into `integration/0.6.0` with `Closes #1191`. **This is a small UI slice: do only this.**

## Task
1. In `src/components/export/exportDialectLabels.ts`, add an optional `experimentalNote?: MessageKey` to `ExportDialectLabels`:
   - leave it unset for `gcode`;
   - set it to `'dialogs.export.opensbpExperimental'` for `opensbp`.
2. In `src/components/export/ExportDialog.tsx` (~:508), use the dialect labels the dialog already resolves. When the active machine's labels have `experimentalNote`, render it as the **first** of the export notes. Copy the existing notes' markup: `<div className="export-setup-note" data-testid="export-experimental-note">`.
3. Add the key `dialogs.export.opensbpExperimental` to all five locales (en, de, es, fr, zh-CN), with real translations of this English text: "Experimental: ShopBot part files have not been tested on a real ShopBot yet. Run the file in air first, and please send feedback."
4. Change nothing else: no engine, export output, or machine definitions.

## Acceptance
- **Unit test** next to the existing dialect-label tests, or a new `exportDialectLabels.test.ts` run with `npx tsx`: only `opensbp` has an `experimentalNote`, and that key exists in every locale.
- **e2e** in `e2e/gcodeExport.smoke.spec.ts`, using its existing ShopBot export setup: with a ShopBot machine, `export-experimental-note` is visible and shows the English text; with a G-code machine, it's absent.
- **Both tests must fail without the change.** Check that, and say how you checked.
- `npm run build` is green.
- Run the spec you touched with `PURECUT_E2E_ISOLATED=1`, a free `PURECUT_E2E_PORT` and `--workers=2`. Never use port 1420.
- Send a short report: the files you changed and what you ran.
