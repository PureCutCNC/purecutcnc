# Slice rt3-c: 3D view with a Thread and Turn/Hex (items 29, 30)

29. Round bar Ø1.5 in (inch), Hex + Turn (start 1.5, length 2, Ø1) + Thread on Around (5 TPI, depth 0.122, length 2). (a) Thread start 2: with the Thread visible, the 3D view shows the plain bar with the thread but no Hex or Turn; hiding the Thread brings them back. (b) Thread start 1.5 (same span as the Turn): the Thread's helix lines aren't drawn and Hex/Turn are missing too. Thread lines are drawn on the bar surface, so this is a 3D build problem, not a cutting one. Find where the 3D build (`src/components/viewport3d/Viewport3D.tsx`, `src/engine/csg.ts`, the wrapped Around display) drops the models or the thread when sheet work is present (F5's model-only rule and rt2-d are candidates) and fix it: Thread, Hex and Turn all show in both cases. Build the fixture in a test from these numbers.
30. Reword the warning shown when a Thread (or Flutes) crosses a Turn's end. Today: "The depth is measured from the bar surface: this pattern crosses more than one diameter." New text in plain words, naming the Turn, e.g. "This thread crosses the end of Turn, where the bar's diameter changes." (all locales). Refusing to save the edit while it shows stays as is (Frank: that's fine).

Tests: the 3D scene for both cases contains the Hex mesh, the Turn mesh and the Thread lines; the warning text. Mutations: drop models when sheet work is present; skip the thread over a Turn.

Off limits: Cuts list/tree (rt3-a), simulation (rt3-b), drawer/icons (rt3-d), `roundWorkholding.ts` (rt3-e).
## Rules for every slice (issue #1112, PR #1126, Frank's test round 3)

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
