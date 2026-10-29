# Slice rt2-c: square blank Around drawer (item 22)

Frank approved (may adjust after seeing it). On Around with a square blank, the drawer shows only Turn and Polygon; the plan (#1112 decision 17) says other entries stay visible and disabled with a reason, not hidden.

- Show every drawer entry on Around with a square blank (`src/components/layout/toolbar/CreationActions.tsx`, `RotaryPatternActions.tsx`, related helpers; find where they are filtered out).
- **Allowed:** regions and construction lines (they don't cut; regions limit rotary operations per #1096; check a region drawn there limits Rotary rough/finish on a square blank as on a round bar).
- **Disabled with a reason:** shapes that would be cut on the sheet (lines/outlines for engraving or pockets, text, canned outline shapes, Thread/Flutes). Reason text: "Not available on a square bar yet" (translated); do not use "Needs a round bar" here, and replace it where it is shown for these entries. (Sheet work on a turned section is issue #1128, later.)
- Turn and Polygon unchanged. Round bars unchanged. Existing square-blank authoring/export guards unchanged.

Tests: entry list and enabled/disabled state per entry on Around for square vs round bars; region on a square blank limits a rotary operation. Mutations: hide the disabled entries; enable a cutting shape on square.

Off limits: `faceOverlay.ts` (rt2-d), simulation engine (rt2-e), the canvas panels moved in rt2-b except as needed.
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
