# Slice F2: feature context menu for canned shapes and other faces (items 4, 5, 6, 10)

Files: `src/components/feature-tree/FeatureContextMenu.tsx`, the canvas context menu in `src/components/canvas/SketchCanvas.tsx`, their CSS, locale files `sketch.ts` / `featureTree.ts`. Both menus (tree and canvas) must behave the same; if they share a builder, change it once.

4. **Menu too wide.** Disabled items show their reason on a second line and stretch the menu. Cap the menu width (about 280 px, `max-width`, reasons `white-space: normal` so they wrap; labels stay one line). Shorten the canned-shape reason (en "Expand this generated shape to features first" and the variant ending "…to edit its sketch") to "Expand to features first" in every locale (one key if both say the same thing now). Tablet/touch menu same rule.
5. **Add "Expand to features"** to the menu for a canned shape, in the edit group right after Edit sketch, calling the same action Properties uses (`featureTree.properties.canned.*`). Hidden for model kinds (Turn, Polygon), as in Properties.
6. **Add "Edit {shape}…"** (reuse key `featureTree.properties.canned.edit`, shape name as Properties fills it) at the top of the edit group, above Expand to features, for every canned kind including Turn and Polygon, wherever Properties offers it. It opens the same editor as Properties.
10. **Other-face features.** On the Around face (square bar with a Polygon "Hex" and a Turn), right-click on either shows only the hint "Switch to top face to edit" (`featureTree.face.switchToTopToEdit`) instead of a menu, so no operation can be created there. Show the normal menu: Create operation lists the operations valid for that feature on the current face (the same filter the Add menu uses for that face and stock), Add to / Remove from operation work, Copy/Add to folder behave as now; every editing item (Edit {shape}, Expand, Edit sketch, constraints, Move, Resize, Rotate, Mirror, Offset, Join, Cut, Delete, Change authoring face) is disabled with the switch-face reason. Applies to any feature authored on another face that the current face's operations can target. Where the hint was shown as a tooltip, keep it as the disabled reason.

## Tests that must bite
- Canned shape menu: Edit {shape} present for every kind; Expand present for outline kinds, absent for Turn/Polygon; reasons use the new short text.
- Other-face feature: menu shown, Create operation offers exactly what the Add menu offers on that face, editing items disabled with the switch-face reason.
- Mutations: show Expand for Turn; drop the face check so editing items are enabled; use an unfiltered operation list.
- e2e specs that assert these menus or the old reason text: update and list.

## Off limits
`CannedShapeEditPanel.tsx` (F1), simulation files and `FaceSwitch`/`FaceBanner`/`AppShell` (F3), CAM panel (F4), `Viewport3D.tsx` (F5).
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
