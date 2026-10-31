# Slice rt5-b: reach cards only where they mean something, explained (item 38)

The operation panel's setup section (`src/components/cam/setupSections.ts` and its component, `src/engine/setupReach.ts`, locale keys `cam.setup.*`: `checkReach`, `depthTop`, `depthBottom`, `depthAround`, `singleSide`, `unverified`, `stockReach`, `meets`, `gap`) shows a card per target with "Depth from top: …", "Unverified: current toolpaths have not been measured on both sides.", "Targeted from this side only." and a "Check generated reach" button. Frank: for one-sided targets this is noise, and the purpose isn't explained.

- Show the reach cards and the check button only for targets cut from both Top and Bottom (a through-feature whose operations are split between the two setups). For a one-sided target show nothing (at most its depth range in one line); drop "Targeted from this side only." and the "Unverified … both sides" line there.
- Where the cards do show, explain in plain words with one line above them, e.g. "This feature is cut from both sides. Check that the two passes meet in the middle." The button reads as an action with a result, e.g. "Check the passes meet"; results stay "Meets the other pass · overlap …" / "Gap between passes: …" (clarify wording if needed). The "Unverified" line shows on two-sided targets only until the check has run.
- Around (rotary) depth line unchanged unless it falls under the same one-sided rule.
- All locales, real translations; remove keys nothing uses any more.

Tests: one-sided target shows no reach card or button; two-sided shows the explanation, button, and the meets/gap result after the check. Mutation: show cards for one-sided targets. Update e2e specs asserting the old text (grep the strings).

Off limits: everything else.

## Rules for every slice (issue #1112, PR #1126, Frank's test round 5)

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

