# Slice F1: canned shapes update live while their parameters are edited (item 1)

Frank: "while editing a canned operation's parameters its shape does not get updated. I did not test all of them but rounded rect for example does not do it. please check all other ones."

## What to build
- The canned-shape editor (`src/components/canvas/CannedShapeEditPanel.tsx`, opened by "Edit {shape}…" in Properties) must show the edited shape in the sketch and 3D views as each value changes, for every canned kind: ellipse, slot, n-gon, rounded rectangle, chamfered rectangle, gear, thread, flutes, Turn, Polygon (`src/cannedShapes/`).
- Find why it does not. Likely: the panel keeps a local draft and only writes on OK, or a live preview exists but is keyed on something the edit does not change (cached generated outlines: the cache key must include every parameter). Fix the cause, not each kind separately.
- Live edits are a preview: Cancel/Escape restores the original shape exactly, and OK makes one undo step (one Ctrl+Z restores the shape from before the editor opened). An invalid value (a field the validator refuses) keeps the last valid preview and shows the existing error.
- If the outline cache is the cause, check every parameter of every kind reaches the cache key (a test that changes each parameter in turn and asserts the generated outlines/mesh change).

## Tests that must bite
- For each canned kind: changing each parameter in the editor's draft changes the previewed outlines (or mesh for Turn/Polygon). Use asymmetric values.
- Cancel restores byte-equal feature definition; OK + one undo restores it.
- Mutations: drop one parameter from the cache key (or the preview wiring); make Cancel skip the restore.

## Off limits
Context menus (`FeatureContextMenu.tsx`, `SketchCanvas.tsx` menu code), simulation files, `CAMPanel.tsx`/`SetupPropertiesDialog.tsx`, `Viewport3D.tsx` mesh drawing (later slices).
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
