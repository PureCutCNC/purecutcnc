# #1049 — simulation: round bar drawn as a block on Top/Bottom setups

Base: `integration/0.6.0`. Read `INDEX.md`, `AGENTS.md`, `src/engine/simulation/INDEX.md`, then this file. `gh` may be blocked: the issue is copied here.

Another worker is changing `src/engine/simulation/replay.ts` and `src/engine/simulation/playback.ts` (#1048) and another `src/engine/toolpaths/rotaryModel.ts` / `src/engine/gcode/**` (#1045): all off limits. Off limits too: `src/components/**` unless the renderer needs a change (say so first).

## Issue (Frank, 2026-10-19)
"simulation shows round stock as square when in top/bottom view." A rotary project's round bar simulated on a Top or Bottom setup is drawn as a rectangular block. Today a flat face simulates through the top-down heightfield seeded from the stock's bounding box (`src/app/simulationSetup.ts`: flat faces use `flatFaceProject` and the ordinary grid; see `createSimulationGrid` and `seedSquareTopZ` in `src/engine/simulation/grid.ts`). A rotary project keeps Top/Bottom setups.

## Build
- Seed the flat-face heightfield from the bar's real profile as seen from that face. Round bar along X: each cell's material top is `pivot + sqrt(R² − d²)` (`barPivotZ`, radius from `src/types/barStock.ts`), `d` = the cell centre's distance across the bar from its centreline; cells with `|d| ≥ R` start with no material (the grid's empty value, whatever the renderer treats as no stock). Along Y the same with axes swapped. A Bottom setup sees the same profile (the bar is symmetric about its axis) — check how the Bottom transform reaches the grid and say what you did.
- A square blank and a block stay byte-identical to today.
- No kernel change: replay and playback cut the seeded surface as they cut a block.
- Comment the limit: a top-down heightfield shows the bar's upper half; nothing below the equator is represented (a cutter from above cannot reach it).

## Tests (new `src/engine/simulation/flatRoundBar.test.ts` or beside the grid tests)
- The seeded grid of a round bar matches the analytic profile cell by cell (axis X and Y, mm and inch, Top and Bottom), computed independently in the test.
- Block and square-blank grids deep-equal the base output.
- A pocket on Top of a round bar: after replay, cells are lowered only where the cutter reaches the curved surface; cells the cutter's footprint covers outside the bar (|d| ≥ R) stay empty, never raised.
- Mutations (restore from `cp` backup): seed with the bounding box again; swap the axis; drop the empty-outside-the-bar rule — each fails.

## Checks
`npx tsx` on the new test and every `src/engine/simulation/*.test.ts` and `src/app/*simulation*.test.ts`; `npx tsc -p tsconfig.app.json --noEmit`; eslint on changed files; exit codes.

## Report
`STATUS`, `COMMIT: none`, `CHANGED_FILES`, what changed and why block/square are unchanged, how Bottom is handled, mutations and results, commands with exit codes, `RISKS` (include whether the renderer needed anything and anything you saw that would look wrong on screen).
