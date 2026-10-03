# INDEX — src/engine/gcode/

Export: turns generated toolpaths into a program for the project's machine.
Despite the folder name, the program is not always G-code — a machine
definition names its **output dialect** (issue #953), and the ShopBot one
exports native part files (`.sbp`). Design reference:
[`planning/G-code_Export_Design.md`](../../../planning/G-code_Export_Design.md).

## How export is split

`runPostProcessor` picks the dialect and does nothing else. What the machine
is asked to do is decided once, for every dialect, in `motionPipeline.ts`; a
dialect's emitter only spells the result. New motion behaviour goes in the
pipeline. New syntax goes in an emitter. A dialect is never special-cased
inside another dialect's emitter.

| Dialect | Emitter | Motion parser (debug view, round-trip tests) |
| --- | --- | --- |
| `gcode` (default; every definition without the field) | `postprocessor.ts` | `gcodeMotionParser.ts` |
| `opensbp` | `opensbpEmitter.ts` | `sbpMotionParser.ts` |

## Files

- `index.ts` — public API.
- `types.ts` — `MachineDefinition` and its zod schema (`motion.arcInterpolation`,
  `arcFormat`, the optional `outputDialect`), `resolveOutputDialect`,
  `PostProcessorInput`/`Options`/`Result`, and `OperationMotionTrace`.
- `postprocessor.ts` — `runPostProcessor` (the dialect switch) and the G-code
  emitter: templates, modal tracking, canned drill cycles, line numbers.
- `motionPipeline.ts` — the dialect-neutral half of export:
  `planOperationMotion` (project → machine transform, arc fitting, the
  emitted-arc fallback and its warnings, the motion trace), `splitRapid`
  (the safe-Z split of a rapid), and the emitted-number helpers arc validation
  judges with.
- `opensbpEmitter.ts` — ShopBot part-file emitter. Its header comment cites
  where the syntax comes from and what was deliberately not consulted; keep it
  accurate when the emitter changes.
- `arcFitting.ts` — export-stage arc fitting: Kasa circle fit, direction
  detection, ≤ 90° splitting, and `resolveEmittedArc` / `applyEmittedArcFallback`,
  which judge an arc by the numbers actually written.
- `gcodeMotionParser.ts` — read-only parser for the emitted G-code (issue
  #356); reconstructs planar motion analytically.
- `sbpMotionParser.ts` — the same for emitted SBP. Understands exactly what
  `opensbpEmitter.ts` writes and reports anything else as `unsupported`.
- `motionDebug.ts` — exported-motion debug helpers (issue #356):
  `parseExportedMotion` (parses in the definition's own dialect), eligibility,
  the exported-vs-source diagnostic, and the three-layer model builder.
- `utils.ts` — number formatting, `projectToMachinePoint` and its inverse
  `machineToProjectPoint`.
- `definitions/` — bundled machine definitions (`BUNDLED_DEFINITIONS`) and
  `getActiveMachineDefinition`, the export boundary. `shopbot.json` is the one
  non-G-code definition; see the note below.
- `*.test.ts` — `postprocessor.test.ts` (G-code), `opensbpEmitter.test.ts`
  (SBP and the dialect switch), `sbpMotionParser.test.ts`, `arcFitting.test.ts`,
  `gcodeMotionParser.test.ts`, `motionDebug.test.ts`,
  `trochoidalArcExport.test.ts`.

## Adding a dialect

1. Add its id to `OUTPUT_DIALECTS` in `types.ts`.
2. Write an emitter that calls `planOperationMotion` and `splitRapid` and
   returns a `PostProcessorResult`; add its case to `runPostProcessor`.
3. Write a motion parser returning `ParsedGcodeMotion`; add its case to
   `parseExportedMotion`. Use it as the round-trip oracle in the emitter tests.
4. Add the bundled definition, and decide what a build that predates the
   dialect would write for it (next section).

## What an `opensbp` definition uses

Read: `coordinateSystem`, `numberFormat`, `fileExtension`,
`motion.arcInterpolation`. Not read: every G-code command word, template,
comment marker, tool-change, canned-cycle, coolant and program-end field. The
schema still requires those, so `shopbot.json` fills them in — with
comment-prefixed words (`' G1`) and `modalMotion: false`. That is deliberate.
A build older than `outputDialect` drops the field and exports through the
G-code path; with these values it writes a file of SBP comments ending in
`END` rather than G-code under a `.sbp` name. `opensbpEmitter.test.ts` holds
that property (`testOlderBuildWritesNoMotion`); do not "tidy" the words.

## Checks

- `npm test` runs every `*.test.ts` here.
- `npm run check:gcode` runs real controller parsers over a G-code corpus
  (`scripts/gcode-conformance/`). It covers G-code definitions only: there is
  no ShopBot interpreter to run, so SBP relies on the round-trip tests.
