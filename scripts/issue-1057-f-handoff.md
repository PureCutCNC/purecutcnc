# #1057 slice F — restricted templates and one restart block after a tool change

Base: the #1057 branch (slices A–E merged; read `scripts/issue-1057-handoff.md`). Read `src/engine/gcode/INDEX.md`, `src/engine/gcode/types.ts` (MachineDefinitionSchema and its templates), `postprocessor.ts`, `motionPipeline.ts`, `opensbpEmitter.ts`. Off limits: `src/engine/toolpaths/**`.

## Decision (Frank, 2026-10-21)
"Restrict templates: no motion or modal changes except in the tool-change and end-of-program templates; after a tool change emit one full restart block; refuse definitions that break the rule."

Why: five review rounds each found another way an arbitrary template string could leave the controller in an unexpected state (stale XY/Z/A, motion mode, incremental mode, torch state). Real post-processors constrain templates instead. All bundled definitions already comply: their templates contain only start-of-program modal setup (`G90 G17 G40 G49 G80 G94`, units) and the grblHAL footer `G0 G53 Z0`.

## Build
1. **Template classes** (find every template field in the schema and list it in your report):
   - *Program header* (start of program, before any motion): modal setup allowed (G90, G17, G40, G49, G80, G94, G92.1, G97, units, comments, M-codes that do not move). No motion words or axis words.
   - *Tool change* and *end of program (footer)*: anything allowed (motion, G53, G28/G30, M6, O-word calls, macros).
   - *Every other template* (spindle on/off, coolant, inverse-time on/off, canned-cycle mode, plasma torch on/off, material/THC, operation headers, pauses, dwell…): **inert only** — no motion words (G0–G3, G28/G30/G53, G81–G89 as motion), no axis words (X Y Z A B C I J K R), no distance/units/plane/feed-mode changes (G90/G91, G20/G21, G17–G19, G93/G94/G95) except where the template's own purpose is that mode (the inverse-time on/off templates may contain only their G93/G94; units templates only their G20/G21), no O-words/subroutine calls/macros/parameters (`O`, `#`, `[`, `]`, `$`, `=`). Comments and allowlisted M/G codes are fine. Plasma torch-on/off may contain only the dialect's torch commands (say exactly what you allow, e.g. M3/M5 with spindle number, M62–M65, QtPlasmaC's documented words).
2. **Validation:** the schema (`MachineDefinitionSchema` superRefine) refuses a definition whose templates break the class rules, with a message naming the template field and the offending word; machine import and the machine editor show it. Bundled definitions must pass unchanged.
3. **Restart block after a tool change** (G-code family): after the tool-change template (and its compensation `G43` where emitted today), write: `G90 G94 G17`, the units word, then `G0` to safe Z (machine-coordinate `G53 G0 Z<machineSafeZ>` for bar Top/Bottom programs as #1054 does; otherwise the program's safe Z), then `G0` with X, Y (and the rotary word if the machine has one) all stated to the next move's start, then the operation's normal approach. ShopBot: the equivalent (after its tool change: absolute mode command, JZ safe, J2/J4 to the start). Plasma (no tool changes) is unaffected except through the inert rule.
4. **Simplify:** with templates restricted, remove the per-axis invalidation/recovery machinery from slices B–E that only exists to handle non-inert non-tool-change templates (keep what the tool-change restart and footer need). Keep the rotary unwind retract rules. Programs whose templates are all inert (every bundled definition) must post **byte-identical** to `origin/integration/0.6.0` except the restart block after tool changes (say exactly which lines change for each bundled dialect with tool changes enabled).
5. Tests: schema refusals for each class (a motion word in spindle-on, `G91` in coolant, `o<x> call` in inverse-time on, axis word in torch-on, `G0 X0 Y0` in an operation header) and acceptance of all bundled definitions; restart block content per dialect after a tool change (including a tool-change template that ends at `G0 Z-2` and one that switches to G91 — the restart restores G90); two-tool programs; byte-identity of single-tool programs per bundled definition. Mutations (restore from `cp` backup): accept a motion word in a non-tool-change template → fails; omit G90 from the restart → fails; omit the XY restatement → fails.

## Checks
`npx tsx` on every `src/engine/gcode/*.test.ts`, `src/machine/*.test.ts`; `npm run check:gcode`; `npm run check:i18n` (new messages, five locales); `npx tsc -p tsconfig.app.json --noEmit`; `npm run lint`; exit codes.

## Report
`STATUS`, `COMMIT: none`, `CHANGED_FILES`, the template field list with its class, what was removed, the restart block per dialect (exact lines), byte-identity evidence, mutations, commands with exit codes, `RISKS`.
