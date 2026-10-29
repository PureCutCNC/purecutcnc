# Slice F3: one face control (items 2, 3, 8)

2. **Remove the Simulation tab's own Setup dropdown** (`SimulationViewport.tsx` `setupPicker`, from #947; built in `src/app/useSimulationModel.ts` `simulationSetupPicker`, passed from `src/App.tsx`). Today it follows the header face control but changing it does not change the header. Frank agreed to remove it. Simulation then always shows the setup of the face selected in the header face control (`src/components/layout/FaceSwitch.tsx`). Selecting an operation that belongs to another face switches the header face (same as clicking a face heading in the tree), so "selected operation's setup" keeps working through the face control. Around is a face like Top and Bottom. Remove the picker's props, types and locale keys (`viewport.sim.setupLabel`, `setupTitle`) if nothing else uses them; update `simulationSetupModel.test.ts` and `INDEX.md` entries to the new rule.
3. **Move the face control** (`FaceSwitch`, rendered by `FaceBanner.tsx` in `AppShell.tsx`) to the right end of the centre panel's tab bar (the row with Sketch / 3D view / Simulation tabs), right-aligned, same size and 44 px touch target; keyboard order follows the visual order. Same rule for when it shows (`showsFaceSwitch`).
8. **Remove the full-width note bar** "Around is simulated on fresh stock: material removed by other setups is not shown." (and its Top/Bottom variants) under the simulation toolbar. Replace it with a small info icon button at the end of the simulation toolbar, with the same text as its tooltip and accessible name (tap opens it on touch). Shown only when the project has more than one setup, as now. Text unchanged.

## Tests that must bite
- Simulation follows the header face: switching face changes the simulated setup; selecting a Bottom operation switches the face to Bottom and simulates Bottom.
- Info icon present with more than one setup, absent with one.
- Mutations: keep a stale explicit pick after a face switch; show the icon for one setup.
- e2e specs that use the old picker or note (grep `simulation-setup`, `setupLabel`, the note text, `data-simulation-setup`): update and list.

## Off limits
Context menus (F2), `CannedShapeEditPanel.tsx` (F1), CAM panel (F4), `Viewport3D.tsx` (F5).
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
