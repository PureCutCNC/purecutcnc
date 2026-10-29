# Slice F4: Save disabled when nothing changed (item 7)

Frank: "in the face properties (CAM panel), save button does nothing when there are no changes in the form (but it can still be clicked). we should grey it out if there are no changes."

- `src/components/cam/SetupPropertiesDialog.tsx` (opened from `CAMPanel.tsx`): Save is disabled while every field equals the saved setup, enabled when any field differs, disabled again when values are typed back to the saved ones (compare normalised values, units included). Enter does not submit while disabled.
- Find every other property form/dialog with an explicit Save/Apply button (grep the locale keys for Save/Apply and their components; e.g. machine editor, tool editor, stock, operation dialogs). Apply the same rule where the form has a saved state to compare against; list each one changed and each one skipped with why.
- Use one small shared helper or hook if two or more forms need it.

## Tests that must bite
- Unchanged → disabled; one field changed → enabled; changed back → disabled; unit toggle with equal value → disabled.
- Mutation: compare by reference instead of value; always enable.

## Off limits
Context menus (F2), simulation and face control (F3), `CannedShapeEditPanel.tsx` (F1), `Viewport3D.tsx` (F5).
## Rules for every slice (issue #1112, PR #1126, Frank's test round 1)

- You work in your own worktree, based on the previous slice's branch. Read `INDEX.md`, `AGENTS.md`, and the folder `INDEX.md` of every folder you touch. Do not re-plan; if something in this handoff is wrong, say so in RISKS and do the closest correct thing.
- `gh` may be blocked in your sandbox. Everything you need is in this file.
- Leave edits uncommitted and report `COMMIT: none`; the dispatcher commits.
- Project format stays 3.3. Exported programs and toolpaths stay byte-identical (none of these slices changes generation).
- Locale changes: every new or changed key in `en` and in every other locale (de, fr, es, and any other folder under `src/i18n/locales/`), in the same position as `en`, with a real translation. No existing value changes except the keys this handoff names. Run `npm run check:i18n`.
- Tests must bite: for each behaviour below, break the code on purpose, confirm a test fails, restore with a `cp` backup (never `git checkout`). Report each mutation and whether it was caught.
- A new unit test that renders React or uses browser globals must pass with `NODE_OPTIONS=--no-experimental-global-navigator`.
- You cannot run a browser. If an e2e spec under `e2e/` asserts what you change (grep for the labels and selectors you touch), update it without weakening any assertion, and list it in RISKS so the manager runs it.
- Checks to run and report with exit codes: `npm run build:gates`, then each changed or new test file directly (`npx tsx <file>`), then `npm run check:i18n` if locales changed.
- Report: changes per file; tests added; each mutation and whether it was caught; commands with exit codes; RISKS (anything not done, assumptions, e2e specs the manager must run).
