# Slice F5: Turn and Polygon drawn twice in 3D (item 9)

Frank (screenshots, square bar in a chuck): a Polygon (hex) and a Turn show their correct turned/hex shape, but each sits inside an extra green box, and the real shape flickers through it. So a canned model is drawn twice: as its generated mesh and as a box (probably its outline extruded like a flat feature, or its bounding block).

- In `src/components/viewport3d/Viewport3D.tsx` and the feature-solid building it uses, draw a canned model (Turn, Polygon: the kinds stored as meshes in `src/cannedShapes/`) only as its mesh. Remove the box. Selection, hover, highlight, the no-effect ⚠ and visibility toggles must work on the mesh alone.
- Check the same in the Sketch tab's 3D preview if it has its own path, and on round and square bars, along X and Y, mm and inch.
- Outline kinds (ellipse, slot, …) keep their extruded solids.

## Tests that must bite
- For a project with a Turn and a Polygon: the 3D scene builder yields exactly one solid per model feature, and it is the mesh (vertex count / bounds match the generated mesh, not the outline extrusion).
- Mutation: re-add the extrusion for model kinds.
- e2e specs that count meshes or screenshot these models (`e2e/aroundModel.smoke.spec.ts`, `rotaryModel.smoke.spec.ts`, `around3d.smoke.spec.ts`): update and list.

## Off limits
Context menus (F2), simulation and face control (F3), CAM panel (F4), `CannedShapeEditPanel.tsx` (F1).
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
