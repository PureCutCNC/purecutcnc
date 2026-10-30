# Slice rt3-b: Simulation, square bar: a thin slab under the uncut ends (item 26)

Frank's project (read only, do not commit): `/home/frankp/Projects/purecutcnc/work/turn-on-square-block-test-01.camj` — square blank, turned with a profile, both square ends left uncut. In the Simulation tab, under each uncut square end there is a thin flat plate, narrower than the block and offset below it, as if a second thinner box were drawn under the stock. The turned section looks right.

- Find which mesh it is: the simulated heightfield, the static bar/end meshes of the simulation's bar display (`SimulationBar`, `src/components/simulation/`), a clamp/jaw stand-in, or the flat-round-bar lower-half display (`flatRoundBar`) mounted where it doesn't belong. Explain the cause in the report.
- Remove it so it doesn't show. Square and round bars, axis X and Y, mm and inch; nothing else in the Simulation display changes (heightfield results identical).
- A unit test on the scene/mesh builder asserts no such extra mesh for this case; if a screenshot is the only way to see it, write a scratch E2E spec the manager can run and list it in RISKS.

Off limits: Cuts list/tree (rt3-a), `Viewport3D.tsx`/`csg.ts` 3D view (rt3-c), drawer/icons (rt3-d), `roundWorkholding.ts` (rt3-e).
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
