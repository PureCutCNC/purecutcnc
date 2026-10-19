# #1048 — part-played wrapped move cuts a moving slot (simulation playback)

Base: `integration/0.6.0`. Read `INDEX.md`, `AGENTS.md`, `src/engine/simulation/INDEX.md`, then this file. `gh` may be blocked: the issue is copied here. Another worker is changing `src/engine/toolpaths/rotaryModel.ts` and `src/engine/gcode/motionPipeline.ts` on another branch: off limits. Off limits too: `src/components/**`.

## Issue
Frank: "thread cutting (engrave) shows an artifact which keeps moving." During playback of a thread (Follow line, V-bit, Around face, round bar) a short slot along the bar appears beside the tool and travels with it. Reproduced on Frank's project, copied to `scripts/fixtures-1048/rotary-thread-01.camj` (round bar Ø0.75 × 4 in, operation "Thread Engrave", 30° V-bit): Simulation → Around → select the operation → Play tool → play; at 2 % and 6 % (A ≈ 364° and 923°) the notch is visible beside the tool. Batch replay (whole moves) looks right.

Suspected cause (manager, reading only — confirm or refute first): `applyWrappedMoveKernel` in `src/engine/simulation/replay.ts` (#1016 C2 F8b) cuts every cell inside the *applied piece's* footprint to the depth of the *source move's* closest approach over all its periodic images. A thread move runs several turns, so another turn's image passes through cells the current piece's footprint covers, and they are cut early. Playback (`src/engine/simulation/playback.ts`, the partial branch that calls `applyMoveToGrid` with `this.parents[this.moveIndex]` as the sweep) is the only caller that applies partial pieces.

## Build
- First write the failing test (below) and show it fails on the base.
- Fix so a part-played move removes only what the cutter has actually swept so far — the applied piece's own motion (its periodic images included) — while the **finished** playback still equals the batch replay (F8b's guarantee; keep its fixed-point/idempotence property). Prefer the smallest change in the kernel's depth source for partial pieces; explain why the fixed point still holds.
- Check Flutes (twisted, multi-turn) and an around-the-bar ring (A sweeping 0→360 at fixed along; build one by hand) with the same test.
- Batch replay output must stay byte-identical (existing replay tests unchanged).

## Tests that must bite (new `src/engine/simulation/wrappedPlayback.test.ts`)
- Independent oracle: for a multi-turn wrapped move on a round bar (thread: along advancing one pitch per 360°, ≥ 3 turns) with ball, flat and V-bit tools, the playback grid at fractions t ∈ {0.1, 0.25, 0.5, 0.75, 0.9} equals the batch replay of the toolpath truncated at t (earlier moves whole, the current one ending at t), cell by cell within one cell-height tolerance; and at t = 1 equals the full batch replay exactly.
- Same for a Flutes-like twisted line and an around-the-bar ring.
- Load Frank's fixture through the normal project/toolpath path, play to 2 % and 6 %, and assert no cell beyond the truncated replay is lowered.
- Mutations (restore from `cp` backup): restore the source-move depth for partial pieces → fails; drop the periodic images for partial pieces → fails.

## Checks
`npx tsx` on the new test and every `src/engine/simulation/*.test.ts`; `npx tsc -p tsconfig.app.json --noEmit`; eslint on changed files; exit codes. Report playback cost per frame before/after on Frank's fixture.

## Report
`STATUS`, `COMMIT: none`, `CHANGED_FILES`, the cause (confirmed?), the fix and why finished playback still equals batch replay, timings, mutations and results, commands with exit codes, `RISKS`.
