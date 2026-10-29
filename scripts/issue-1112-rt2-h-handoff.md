# Slice rt2-h: delay opening Simulation with a rotary operation selected (item 21, follow-up)

Frank: "there is a delay when switching to the simulation view when rough operation is selected (finish too)". It was slower before rt2-e; now it is still noticeable.

Frank's project (read it from this absolute path, do not commit it): `/home/frankp/Projects/purecutcnc/work/turn-shape-test-01.camj` — round bar Ø1.5 in along X, inch units, a drawn spline used as the Turn profile, a Turn, Rotary rough and Rotary finish. Format 3.3.

- Reproduce: load that project, select Rotary rough (then Rotary finish), switch to the Simulation tab. Measure, serially and not under load, where the time goes between the tab switch and the first simulated frame: toolpath generation (is it regenerated, or already cached from the 3D/Sketch view?), setup input, grid initialisation, selected-operation replay, playback base, worker round trips, and anything React does synchronously on the switch. Use the app's real code paths (the hooks/functions the Simulation tab calls), not a hand-written approximation. Print timings at the end.
- Fix what is cheap and safe: work repeated on every switch, a cache keyed too narrowly so the selected operation's paths regenerate, synchronous work that blocks the first paint and could follow it, duplicated replays of the same operation. The simulated result must stay identical (equal heightfields / move counts on this project and the existing fixtures). No new approximations or lower resolution.
- If the remaining time is inherent (the replay itself), say so with numbers and stop.
- No `process.`/`globalThis` in engine code.

Report: a before/after table of the stages on Frank's project (rough selected, finish selected, ms), what changed, equality evidence.

Off limits: UI layout and anything other slices changed, except where the fix requires it.

- Reuse `scripts/issue-1112-rt2-e-simulation-profile.ts` (left by slice rt2-e) if it helps, then delete it: it must not stay in the repo. Any profiling script you write goes under `work/` (gitignored) or is deleted before you finish.
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
