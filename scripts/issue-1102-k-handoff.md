# #1102 slice K — New project dialog without scrolling (Frank's test, item 4)

Frank, testing the branch: "new project dialog now forces scrolling. we still have lots of empty space in the right side that never gets populated. How about we shrink that and make 'TEMPLATE' section as 2x2 grid?"

Files: `src/components/project/NewProjectDialog.tsx` (layout only), the new-project rules in `src/styles/dialog.css` (`.dialog--new-project`, `.project-template-list*`, `.project-template-card*`, `.dialog-preview-container`, `.project-template-preview*`, and the dialog body grid they live in). No locale changes expected.

Today the dialog body is two columns: left = Project type (three tiles, added by slice G), Project name, Template (four cards stacked: Blank metric, Blank imperial, Current project, Template file), and right = "Template preview" (units, stock fields, counts, machine). Below both: "Or open an example" (three example cards) and the footer. Adding the project-type row made the body taller than the dialog at 1440×900, so it scrolls, while the right column has a lot of empty space under the preview.

## Build
1. **Template as a 2×2 grid:** Blank metric | Blank imperial / Current project | Template file. Same cards, same handlers, same active state. The hidden file input and the error message stay where they are.
2. **Shrink the preview column:** give the left column the larger share (about 60/40 instead of today's split; read the current grid), and size the preview card to its content (no stretching to fill the column height). The bar-stock fields the preview shows for a rotary blank (shape, diameter/side, length, axis) must still fit without overflow. Check `usesBarStock` and the fields after it.
3. **Goal:** at 1440×900 (and at 1280×800) the whole dialog, examples row and footer included, fits without a vertical scrollbar for the Milling and the Rotary choice. At the tablet width (1024×768) it may scroll, but must not scroll sideways. Below roughly 700 px wide, the columns stack as they do today. Reason it out from the CSS (heights of rows, gaps) and state your arithmetic in the report; the manager checks with screenshots.
4. Keep the project-type tiles row from slice G exactly as it is (radio semantics, arrow keys), apart from sizing that follows from the column width.
5. Test: there is no new logic; say so. Do not invent a test.

## Checks
tsc, eslint on the changed TSX, `npx tsx src/components/project/newProjectProjectType.test.ts`, any other tests in `src/components/project/`.

## Rules for every #1102 slice

Issue #1102 (approved by Frank; these follow-up slices come from his hands-on test of the branch, 2026-10-24): UI-only cleanup of the setup and CAM panels before 0.6.0 ships. Hobby scope: no new options, each item removes, hides, shrinks or moves an existing control. No change to toolpaths, G-code, machine profiles or the project file format; a saved project opens and exports exactly as before. Read `INDEX.md`, `AGENTS.md` (Coding Standards), then the files named below on this branch (it is based on `integration/0.6.0`, which differs from `main`).

- **Off limits:** every file not named in your slice. Slices A–G of #1102 are already merged into this branch; read their code as it is now. Other slices running at the same time: I (`CAMPanel.tsx`, `App.tsx`, `CamSetupSectionView.tsx`, `src/components/cam/` helpers), J (`FaceSwitch.tsx`, `FaceBanner.tsx`, the face-switch block of `src/styles/face.css`), K (`NewProjectDialog.tsx`, the new-project block of `src/styles/dialog.css`). Shared files you may edit only in the block that belongs to your slice: `src/styles/face.css`, `src/styles/layout.css`, `src/styles/dialog.css`, and the locale modules.
- **Do not touch `e2e/**`.** The manager runs and fixes the browser specs. In the report, list every user-visible label, aria-label, title or class you changed, removed or renamed, so the manager can update the specs.
- **Keep accessible names stable where the issue does not change them** (aria-labels used by tests and screen readers), even when the visible text gets shorter.
- **Locales:** five packs, `src/i18n/locales/{en,de,fr,es,zh-CN}/`. Add each new key to all five, in the same position as in `en`, with a real translation (see `src/i18n/GLOSSARY.md`). Remove each key your change leaves unused from all five. Never change an existing value you did not mean to change. Run `npx tsx scripts/check-i18n-format.ts`.
- **New files** get the Apache license header copied from a neighbouring file. No `any`. No `process.` or `globalThis`.
- **Tests must bite.** Put every rule (what shows when) in a small pure function next to the component, with a `*.test.ts` using `node:assert/strict` like `src/components/cam/setupTargetHints.test.ts`. Run each mutation listed below by hand: back up with `cp`, break the line, run the test, confirm it fails, restore. Report each one.
- **This laptop is shared.** Do NOT run `npm test`, `npm run build`, `build:gates` or any Playwright/e2e command. Run only: `npx tsc -p tsconfig.app.json --noEmit`, `npx eslint <the files you changed>`, `npx tsx <each test file you added or changed, plus existing tests of the files you changed>`, and the i18n check. Give their exit codes.
- Leave the edits uncommitted; the dispatcher commits them.

## Report format
`STATUS`, `COMMIT: none`, `CHANGED_FILES`, per item what you built, the locale keys added and removed, the labels / aria-labels / classes changed for the e2e specs, each mutation and whether it was caught, commands with exit codes, `RISKS` (anything you were unsure of or left out).
