# #1046 slice A — project type fixed at creation; New project dialog asks for rotary stock

Base: `integration/0.6.0`. Read `INDEX.md`, `AGENTS.md`, `src/components/INDEX.md`, `src/store/INDEX.md`, then this file. `gh` may be blocked: the issue text is copied below.

Another worker is changing rotary toolpaths (`src/engine/toolpaths/rotaryModel.ts`, `src/engine/gcode/**`, `src/components/cam/**`, `e2e/rotaryModel.smoke.spec.ts`): those are off limits.

## Issue #1046 (plan approved to start by Frank, 2026-10-18)
Frank: "we should make the project type selection at the time project is created (in the new project dialog) and lock it. that will simplify things for us and the users" and "the stock definition on the new project dialog does not follow the selection." On round ↔ square inside a rotary project: "that might be good to keep available."

Today: `src/components/project/NewProjectDialog.tsx` has a Project type choice, but the blank template's stock fields are always width × height × thickness, and Rotary converts that block afterwards (`projectWithProjectType`, `src/store/helpers/projectTypeApply.ts`). The type can be changed later from Project properties (`src/components/feature-tree/PropertiesPanel.tsx` → `ProjectTypeChangeDialog.tsx`, store `setProjectType` in `src/store/slices/workpieceSlice.ts`), with the #1028 keep-and-hide rules.

## Build
1. **NewProjectDialog, blank template:** when the type is Rotary, replace width/height/thickness with: Shape (Round bar / Square blank), Diameter (round) or Side (square), Length, Axis (X / Y). Defaults in the template's units (mm: Ø 40 × 200 along X; inch: Ø 1.5 × 8). Build the project's stock directly as that bar (use the existing round/square stock constructors and normalisers in `src/types/project.ts`, `src/types/barStock.ts`, `src/store/helpers/stockShape.ts`), so there is no block intermediate; machine selection and the rest of `projectWithProjectType` still apply. Milling / Plasma keep width × height × thickness. Validation like the existing fields (positive lengths). A file / current-project template keeps today's behaviour.
2. **Lock:** in `PropertiesPanel.tsx` the project type becomes read-only text (same row, the type's label). Delete `ProjectTypeChangeDialog.tsx` and the panel's change path (`pendingTypeChange`, the summary call). Remove `setProjectType` from the store and `src/store/types.ts` if nothing but tests uses it after this; `projectTypeChangeSummary` likewise. If a unit test of the keep-and-hide rules needs a type change, build the changed project with the pure helper (`projectWithProjectType`) in the test instead of the store action. Say in the report what you removed and what you kept and why.
3. **Loaders unchanged:** a loaded file keeps its stored or inferred type and every keep-and-hide rule.
4. **Round ↔ square** inside a rotary project stays switchable exactly as today.
5. **i18n:** new dialog labels in all five locales (`en`, `de`, `fr`, `es`, `zh-CN`), same position as `en`, real translations, each file's own quote style; delete the keys only the removed dialog used (in every locale). `npm run check:i18n` must pass.
6. **e2e:** `e2e/helpers.ts` `setProjectType` switches the type of an open project through the UI, used by `plasmaMode`, `projectType`, `roundStock`, `toolLibraryDialog` specs. Replace it with a helper that creates a new project of that type through the New project dialog (or seeds a project with `meta.projectType` set, where the test is about something else), and rewrite those call sites without weakening any assertion. Tests that exist only to check a mid-project type change are deleted, and you list them. Add a spec for the dialog: Rotary round and square, axis X and Y, mm and inch, and that the Properties type is read-only. You cannot run a browser; write carefully, the manager runs them.

## Tests (unit)
- Creating a rotary project from the blank template yields exactly the typed bar (shape, size, length, axis, units) — round and square, X and Y, mm and inch.
- Milling and plasma blank creation unchanged (deep-equal against the current output for the same inputs).
- Mutations (report each, restore from `cp` backup): swap diameter and length; ignore the axis choice; build a block then convert (the old path) — each must fail a test.

## Checks
Changed unit tests with `npx tsx <file>`, `npm run check:i18n`, `npm run build:gates` (an EPERM on `node_modules/.tmp` from the sandbox is environmental: say so and run `npx tsc -p tsconfig.app.json --noEmit` + eslint on changed files instead). Exit codes captured.

## Report
`STATUS`, `COMMIT: none`, `CHANGED_FILES`, per-file changes, what was removed/kept, deleted e2e tests, mutations and results, commands with exit codes, `RISKS`.
