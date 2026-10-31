# Slice rt6-d: Move for the rotary canned kinds, Turn included, locked to the bar (item 42)

Frank (2026-10-31): Hex (Polygon) and Thread can be moved like any feature afterwards, which is good, but the Move preview lets them go off the bar's axis and the finished move then brings them back; and a Turn cannot be moved at all. "why not allow the move to work on turn too?"

The four rotary canned kinds (`turn`, `polygon`, `thread`, `flutes`, `src/cannedShapes/generators/kinds.ts`) store their band as start/length from the chuck end (`src/store/helpers/rotarySolids.ts`, `rotaryPatterns.ts`, `cannedShapes/generators/rotarySolidParams.ts`/`rotaryPatternParams.ts`). Find where a committed move is projected back onto the bar for Polygon/Thread, and where Turn is excluded from Move (grep `pendingMove`, the move workflow under `src/components/canvas/`, feature-tree/context-menu gating, `canChangeAuthoringFace`/`movable` in `src/store/helpers/activeFace.ts`).

- **Turn moves too:** Move (toolbar, context menu, keyboard/typed distance — whatever Polygon/Thread already get) works for a Turn on every face that offers it for Polygon.
- **The preview is the result:** while dragging (and for a typed move), the displacement of these four kinds is projected onto the bar axis, in the preview exactly as on commit, so what is drawn at release is what is stored. Thread/Flutes on the Around sheet: if a move across the sheet (around the bar) is already kept on commit, keep it in the preview too; if it is discarded on commit, lock the preview the same way. Do not change what a commit stores today except for the Turn becoming movable.
- **Everything that depends on the band follows:** the stored start (so Edit Turn…/Edit Thread… shows the new start), the regenerated model, linked copies as they behave for a Polygon today, and Thread/Flutes rows that follow the moved Turn (the existing `syncRotaryPatternSurfaces` should do this; add a test that it does). A move that would put the band past the bar's ends is refused or clamped exactly like the existing Polygon rule.
- One undo step per move.

Tests: unit — Turn move updates start, mesh span and a following Thread's span; the move projection used by the preview equals the commit's for all four kinds (off-axis drag → on-axis result). Mutations: preview without the projection; leave the following Thread behind. e2e (not the "CAM and interaction" lane): drag a Turn diagonally on Top, check the preview outline during the drag is on the axis and the stored start moved by the along-component only; undo restores it.

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

