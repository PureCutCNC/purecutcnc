# Slice rt2-d: Turn and Polygon visible on Top and Bottom (item 19)

Today nothing created on Around is drawn on Top/Bottom (`src/components/canvas/faceOverlay.ts:136`, issue #395: the sheet and a flat face share no plane). That is right for sheet features, but Turn and Polygon are solids around the bar axis whose side view on Top is exact.

- On Top and Bottom, draw each visible Turn and Polygon as a dashed, read-only side-view outline in the ghost style: Turn = its profile mirrored about the bar axis over its start/length; Polygon = its across-corners/across-flats silhouette as seen from that face (use its rotation) over its length. Bar axis X or Y; round and square bars; mm and inch. Bottom view mirrored like other Bottom drawing.
- Clicking the outline selects the model (Properties, Edit {shape}…); no canvas editing (no handles, no drag). Hover highlight as for ghost features if they have one.
- Sheet features from Around stay hidden on flat faces.
- Follows the "show other side" toggle only if the existing ghosts do for the same reason; otherwise always shown. State which in the report.

Tests: silhouette geometry for Turn (stepped profile, asymmetric) and Polygon (hex, rotated) on X and Y axes, Top and Bottom; hit-test selects the model; sheet features still not drawn. Mutations: draw sheet features on Top; forget the Bottom mirror.

Off limits: `CanvasCreationPanel.tsx`/creation panels (rt2-b), `CreationActions.tsx` (rt2-c), simulation engine (rt2-e).
## Rules for every slice (issue #1112, PR #1126, Frank's test round 2)

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
