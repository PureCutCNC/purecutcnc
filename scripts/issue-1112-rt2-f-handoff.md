# Slice rt2-f: square bar defaults to a 4-jaw chuck (item 23)

Frank: "we always set 3 jaw chuck on a new project. we should make it 4 jaw for the square block".

- A new project (and a new bar setup) with square bar stock gets a 4-jaw chuck by default; round bar stays 3-jaw. Find where the default chuck is chosen (`src/store/helpers/roundWorkholding.ts` and its callers, new-project / stock creation).
- When the stock changes between round and square, the jaw count follows (3 ↔ 4) unless the user set it by hand. Record "set by hand" in a way that needs no format bump (format stays 3.3: additive optional field, or derive from an existing field), and say how in the report.
- The clamping-range check uses the matching rule for the jaw count (square in a 4-jaw: across flats; otherwise the corner circle), as the #1112 plan says. Verify, fix if not.
- Saved projects keep their stored jaw count on load.

Tests: default per stock shape for new projects; round → square → round follows when untouched, stays when set by hand; range check per jaw count; a saved 3-jaw square project loads unchanged. Mutations: ignore "set by hand"; use the corner circle in a 4-jaw.

Off limits: everything the other rt2 slices changed, except where this item requires it.

Also (Frank): **default chuck size 4" (100 mm)** for new projects and new bar setups, round and square, unless the bar doesn't fit its gripping range; then the smallest preset whose range fits. The same rule applies when the stock size or shape changes and the user hasn't set the chuck by hand. If the bar fits no preset, keep today's behaviour (warning). Test: default 4" for a typical bar; a bar too big for 4" gets the next size up; the hand-set chuck is kept.
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
