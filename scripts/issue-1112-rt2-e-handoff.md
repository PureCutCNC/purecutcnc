# Slice rt2-e: square blank simulation speed (item 21)

Frank: "simulation view for a square block seems to take some time, even on this new laptop. something to look at and see if there is an easy fix".

- Measure where the time goes when opening Simulation for an Around setup on a square bar (setup input `src/app/simulationSetup.ts` / `simulationBuild.ts` / `simulationCompute.ts`, square grid initialisation, playback base, replay in `src/engine/simulation/`), against the round-bar path on the same project size. Use a fixture with a Turn plus Rotary rough and finish on a square bar (and the same on a round bar). Time each stage serially, one process at a time, not under load; print timings at the end.
- Take only easy wins: redundant work, repeated grid builds, missing caching, avoidable copies. No change to the simulated result: assert a byte-equal heightfield (or equal arrays) before and after on the fixtures, square and round.
- If there is no easy fix, change nothing in product code and report the numbers and the likely cause. Overlaps issue #1115 (around-the-bar performance).
- No `process.`/`globalThis` in engine code.

Report: stage timings before/after (ms, square and round), what changed, equality evidence.

Off limits: all UI files (other slices).
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
