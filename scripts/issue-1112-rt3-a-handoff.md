# Slice rt3-a: Cuts list and feature tree (items 25, 27)

25. **"What it cuts": the Cuts list shows only big × buttons.** In an operation's properties on Around, each Cuts row (slice H, the Cuts list that replaced the target pickers) is a large box with only a centred ×: no feature icon or name, and the remove button fills the row. Expected: one compact row per target with its icon and name, hover highlighting the feature, and a small × at the end of the row. Find whether the name is missing from the data (an unresolved target id: a Turn/Polygon model, a target from another face, a canned shape) or only hidden by the layout/CSS; fix the cause. Every operation kind and face; desktop and tablet widths. The Cuts list E2E spec must assert the name is visible.
27. **Hex and Turn listed under every face in the feature tree.** A canned model (Turn, Polygon) belongs to the bar and is listed once, in the Around section, whichever face it was created from. Frank: on #1123 (`feat/issue-1112-ui-round2`) it was listed under every face, on #1125 (`feat/issue-1112-wave3`) it was correct, and on this branch it is wrong again. Compare the tree's per-face filtering between `feat/issue-1112-wave3` and HEAD (`git diff feat/issue-1112-wave3 HEAD -- src/components/feature-tree src/store/helpers/activeFace.ts ...`) to find what brought it back (F3's face control, rt2-b/rt2-d's Top/Bottom model work are candidates), fix it there, and add a test that fails on the regression. On Top/Bottom the model shows only as the dashed canvas outline (item 19), and clicking it selects the single tree row.

Tests: Cuts row shows name+icon for each target kind; models listed once (Around) on round and square bars, created from Around and from Top. Mutations: drop the name from the row; list models under every face.

Off limits: simulation (rt3-b), `Viewport3D.tsx`/`csg.ts` (rt3-c), creation drawer and icons (rt3-d), `roundWorkholding.ts` (rt3-e).
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
