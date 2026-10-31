# Slice rt6-a: no Z range for the rotary canned kinds (item 39)

Frank (2026-10-31): "what is the purpose of the Z top/bottom for the rotary canned features? it does not seem to make sense." It has none. For the four rotary canned kinds (`thread`, `flutes`, `turn`, `polygon` in `src/cannedShapes/generators/kinds.ts`) the feature's `z_top`/`z_bottom` is derived from the Edit panel's numbers: Turn/Polygon = the regenerated mesh height centred on the bar's pivot (`cannedModelSpan`, `src/cannedShapes/model.ts`); Thread/Flutes = bar surface down by the entered Depth (`rotaryPatternSurfaceSpan*`, used by `src/components/canvas/RotaryPatternPanel.tsx`). Yet `src/components/feature-tree/PropertiesPanel.tsx` shows the generic Z slider for them (the open-line branch for Thread/Flutes with the bottom locked at 0, in flat stock-Z terms; the model branch and `ModelOrientationSection`'s Z for Turn/Polygon), so editing it only fights the regenerate or makes the cut depth disagree with the Edit panel's Depth.

- For a feature of those four kinds, Properties shows **no Z range control** (single selection, and multi-selection: leave such features out of the shared Z editor, so a mixed selection only edits the others' Z; if every selected feature is one of them, no Z editor). In its place one read-only line with the value the Edit panel controls and where to change it, e.g. "Depth 1.20 mm · set in Edit Thread…", "Diameter 30.00 mm · set in Edit Turn…" (Polygon: its across-flats or whatever size its panel calls it; use the panel's own field label and value, in project units, formatted like other lengths).
- `ModelOrientationSection` for Turn/Polygon: hide any Z-span/height inputs it shows for them; keep the rest only if it means something for a generated model, otherwise say what you hid and why in RISKS.
- Nothing else changes: stored `z_top`/`z_bottom` are still written by the Edit panels and read by toolpaths, 3D and simulation exactly as now; output byte-identical. Other canned shapes (ellipse, slot, n-gon, rects, gear) and imported models keep their Z controls.
- All locales, real translations.

Tests: Properties for each of the four kinds shows no Z slider and shows the read-only line with the right value; a plain ellipse and an imported model still show theirs; a mixed multi-selection's Z edit leaves the rotary feature's span untouched. Mutations: show the slider for Thread; include Turn in the multi-select Z write. Update e2e specs that drive those Z controls for these kinds (grep the specs for Z range use on Turn/Polygon/Thread/Flutes).

Off limits: everything else.

## Rules for every slice (issue #1112, PR #1126, Frank's test round 6)

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

