# Slice rt4-c: 3D view drops Turn/Hex when an Around sheet feature is visible (item 36)

File (read only, don't commit): `/home/frankp/Projects/purecutcnc/work/thread-on-turn-test-01.camj` — round bar Ø1.5 in along X, Turn (f0002) and Turn 2 (f0018), Thread, Thread 2, Flutes, and an Around pocket `Rect 6` (f0020, subtract). With `Rect 6` hidden, the 3D view correctly shows the turned sections. With it visible, the bar is drawn at full diameter and both Turns are gone (thread lines still drawn). Slice rt3-c (item 29) fixed only the Thread case.

- Find where the 3D build (`src/engine/csg.ts` `buildScene` and the bar boolean fold around `:1160`, `src/engine/aroundFeatureSolid.ts`, `src/components/viewport3d/Viewport3D.tsx`) takes a different path when a closed Around sheet feature is visible, and why that path leaves out Model rows (Turn/Polygon meshes).
- Fix it generally: the bar in 3D is the ordered result of the stock, the Turn/Polygon models and every visible Around sheet feature (subtract and add pockets, text, canned outline shapes, open lines), whatever mix is visible. Don't special-case pockets.
- Square bars: Around sheet features are still disabled there (item 22), so only check that models still show.
- Selection, hover, highlight and the no-effect ⚠ keep working on both the models and the sheet features.

Tests: scene-build tests for Turn + Polygon + each sheet kind visible (pocket subtract, add, text, gear outline, line), on a round bar, asserting the model meshes and the sheet result are both present; hiding/showing one feature doesn't drop the others. Mutations: skip Model rows when sheet solids exist; drop the sheet result when a model exists.

Off limits: everything else.

## Rules for every slice (issue #1112, PR #1126, tablet pass)

- You work in your own worktree, based on the previous slice's branch. Read `INDEX.md`, `AGENTS.md`, and the `INDEX.md` of every folder you touch. Do exactly what this handoff asks, nothing wider: if something here is wrong or needs a decision, say so in RISKS and do the closest correct thing.
- `gh` may be blocked in your sandbox; everything you need is here.
- Leave edits uncommitted and report `COMMIT: none`; the dispatcher commits.
- Project format stays 3.3 (additive optional fields only, migration keys on missing fields). Exported programs and toolpaths stay byte-identical unless the item says otherwise.
- Locale changes: every new or changed key in `en` and in every other locale folder under `src/i18n/locales/`, same position as `en`, real translations. No other existing value changes. Run `npm run check:i18n`.
- Tests must bite: for each behaviour, break the code on purpose, confirm a test fails, restore from a `cp` backup (never `git checkout`). Report each mutation and whether it was caught.
- React/browser-global unit tests must pass with `NODE_OPTIONS=--no-experimental-global-navigator`.
- You cannot run a browser. Update any `e2e/` spec that asserts what you change (grep labels, selectors, test ids) without weakening assertions, and list it in RISKS.
- Run and report with exit codes: `npm run build:gates`, each changed or new test file directly, `npm run check:i18n` if locales changed.
- Report: changes per file; tests added; each mutation and whether it was caught; commands with exit codes; RISKS.

