# #1054 slice 2 — manual indexing stated in programs and setup sheets; Bottom flip follows the bar

Base: `integration/0.6.0`. Read `INDEX.md`, `AGENTS.md`, `src/engine/gcode/INDEX.md`, then this file. `gh` may be blocked.

Off limits (other workers): `src/engine/csg.ts`, feature-role/validation code (slice 1), `src/engine/toolpaths/**`, `src/engine/gcode/motionPipeline.ts` and `src/engine/gcode/squareSweepGuard*` (#1045).

## Why (Frank, 2026-10-19)
"we leave the indexing to be manual A move by the operator. that would be the interim version till we do 394". Approved plan: "every Top/Bottom program and setup sheet of a bar project says which A the operator sets (Top A0, Bottom A180 about the bar axis) and to retract before turning; the Bottom flip axis follows the bar axis. No automatic A move (that is #394)."

## What the audit found
- Bottom on a bar: provisional Bottom defaults its flip axis to X (`src/store/helpers/provisionalSetup.ts:38`, `src/store/helpers/setups.ts:248`); only empty Around setups follow `stock.axis`. A bar along Y would flip about the wrong axis for "A180 about the bar".
- Programs: flat headers say Top face up / Bottom face up, flip about X or Y; no A instruction (`src/engine/gcode/setupPrograms.ts:51,105,251`). A single flat setup can omit the setup header entirely. Booklet setup rows likewise (`src/engine/operationBooklet/report.ts:162`).

## Build
1. In a rotary project with bar stock, a Bottom setup's flip axis is the bar's axis (new and provisional setups; an existing setup whose flip axis disagrees gets a warning naming the setup, not a silent change — say what you chose and why).
2. Every program of a Top or Bottom setup in a rotary bar project carries a setup header **even for a single setup**, with an operator line: Top — "Set A to 0° before running"; Bottom — "Set A to 180° (turn the bar about its axis) before running"; plus "Retract the spindle clear of the bar before turning A". Comment syntax per dialect, exactly as the existing headers do (G-code and ShopBot). No A word is emitted.
3. The booklet's setup section shows the same instruction for those setups.
4. Five locales for any new user-visible strings (`en`, `de`, `fr`, `es`, `zh-CN`), same position as `en`, real translations, each file's own quote style.
5. Non-rotary projects and Around programs: byte-identical posted text.

## Tests (must bite)
- Posted text of a rotary round bar along X and along Y, Top and Bottom, single and multiple setups, G-code and SBP: the header lines are present and exact; no A word.
- Milling project posted text byte-identical to the base for the existing setup export fixtures; Around programs unchanged.
- Flip axis: a new Bottom setup on a Y bar flips about Y.
- Mutations (restore from cp backup): omit the header for a single setup → fails; flip about X on a Y bar → fails.

## Checks
`npx tsx` on `src/engine/gcode/setupPrograms.test.ts`, `setupExport.test.ts`, booklet tests, setup helper tests; `npm run check:gcode`; `npm run check:i18n`; `npx tsc -p tsconfig.app.json --noEmit`; `npm run lint`; exit codes.

## Report
`STATUS`, `COMMIT: none`, `CHANGED_FILES`, per-file changes, the exact header lines, mutations and results, commands with exit codes, `RISKS`.
