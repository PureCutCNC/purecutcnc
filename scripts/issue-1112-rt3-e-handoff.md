# Slice rt3-e: chuck presets use the full gripping range (item 28)

Frank: a 4" chuck holds a 1.5" bar easily; the default must be 4". Today `src/store/helpers/roundWorkholding.ts` (presets ~line 50-66) uses only the first jaw step (`d1`) as each preset's range, so a 4" claims max 1.30" and the default Ø40 mm bar moves up to 5".

Use the full external gripping range from the same catalogue (Codex looked these up, 2026-10-29; BISON 3204, inch p142 of https://www.bison-america.com/pdf/Chapter_1/Specs_1_1.pdf, metric p132 of https://store.bison-chuck.com/uk/en/amfile/file/download/file/1272/product/3115/). Min is `d1`, max is `d3` (larger external step, OD jaw set). Published inch / mm values (independently rounded in the catalogue; keep both as published, don't convert one into the other):

| size | min in / mm | max in / mm |
|---|---|---|
| 3" | 0.08 / 2 | 2.80 / 71 |
| 4" | 0.12 / 3 | 3.66 / 93 |
| 5" | 0.12 / 3 | 4.92 / 125 |
| 6" | 0.12 / 3 | 6.30 / 160 |
| 8" | 0.16 / 4 | 7.87 / 200 |

- Update the presets' `minIn`/`maxIn` (and wherever the mm range is stored, `clampingRangeMm`) to these values. Update the code comment: source pages, that the max is the `d3` step (OD jaws), and that for 4 jaws the same ranges are used: BISON 3604 self-centering 4-jaw publishes identical ranges at 5-8"; 3"/4" 4-jaw ranges aren't published reliably, so the 3-jaw values are used (manager's decision, 2026-10-29).
- The default chuck rule from rt2-f stays (4" unless the bar doesn't fit, then the smallest that fits; re-chosen on stock change unless set by hand). With the new ranges a Ø40 mm and a 1.5" bar both get 4".
- Saved projects keep their stored chuck and range (no migration of stored values).

Tests: each preset's range; default for Ø40 mm, 1.5", 3.5" (fits 4"), 4" (moves to 5") round bars and a square bar in a 4-jaw (across flats); a saved project's stored range is unchanged on load. Mutation: revert one preset's max to its d1 value.

Off limits: everything the other rt3 slices changed.
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
