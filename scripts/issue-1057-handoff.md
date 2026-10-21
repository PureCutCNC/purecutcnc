# #1057 — Export: a rapid after a Z-moving template trusts a stale Z

Base: `integration/0.6.0` (includes #1054). Read `INDEX.md`, `AGENTS.md`, `src/engine/gcode/INDEX.md`, then this file. `gh` may be blocked. Off limits: `src/engine/toolpaths/**`; another branch (#1045) changes the square around-mode parts of `src/engine/gcode/motionPipeline.ts` — keep your change to the shared sequencing and `splitRapid`, and say if you must touch anything square-rotary.

## Issue (found by the Codex review of #1054; predates it, unreleased — came with #953's shared sequencing)
"postprocessor.ts:1134. With two Bottom tools and a change template ending `G0 Z-2`, operation two skips its planned Z5 retract and rapids XY at Z−2. `splitRapid` (motionPipeline.ts:1407) trusts the stale position despite Z being marked unknown."

A tool-change (or other) template that can move Z leaves the tracked position stale; the next operation's first rapid is split as if the tool were still where the previous operation left it, so its retract is dropped and the XY rapid runs at the Z the template left.

## Build
- After any template that can move Z — the same rule the rotary unwind already uses (#1016 C2 M1: a Z word, a canned cycle, a macro, a tool change) — the tracked Z is unknown, and the next rapid must first go to its safe/clearance height before any XY or rotary motion. Never trust a tracked Z after such a template, in any dialect (G-code family and ShopBot) and any project type.
- Programs without Z-moving templates: byte-identical posted text.

## Tests (must bite)
- Codex's repro (two tools, Bottom setup, change template ending `G0 Z-2`) — G-code and ShopBot: the retract precedes the XY rapid; also a Top setup and a single-tool program with a Z-moving start template.
- Existing export fixtures and the conformance corpus byte-identical where no Z-moving template is present.
- Mutation (restore from `cp` backup): trust the tracked Z again → the repro test fails.

## Checks
`npx tsx` on every `src/engine/gcode/*.test.ts` and `src/machine/*.test.ts`; `npm run check:gcode`; `npx tsc -p tsconfig.app.json --noEmit`; `npm run lint`; exit codes.

## Report
`STATUS`, `COMMIT: none`, `CHANGED_FILES`, the exact posted lines before/after for the repro, mutation result, commands with exit codes, `RISKS`.
