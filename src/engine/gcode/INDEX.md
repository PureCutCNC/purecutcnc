# INDEX — src/engine/gcode/

Export: turns generated toolpaths into a program for the project's machine.
Despite the folder name, the program is not always G-code — a machine
definition names its **output dialect** (issue #953), and the ShopBot one
exports native part files (`.sbp`). Design reference:
[`planning/G-code_Export_Design.md`](../../../planning/G-code_Export_Design.md).

## How export is split

`runPostProcessor` picks the dialect and does nothing else. What the machine
is asked to do is decided once, for every dialect, in `motionPipeline.ts`; a
dialect's emitter only spells the result. New behaviour goes in the pipeline.
New syntax goes in an emitter. A dialect is never special-cased inside another
dialect's emitter.

That covers sequencing as well as motion. Whether the tool changes, when the
spindle starts, is restated at a new speed and stops, and when coolant comes
on are one decision (`planProgramSequence`), because two copies of it drift:
the first ShopBot emitter kept its own and dropped a spindle-speed change that
the G-code emitter restated. An emitter keeps only what it has written so far
(modal words, position, speeds).

| Dialect | Emitter | Motion parser (debug view, round-trip tests) |
| --- | --- | --- |
| `gcode` (default; every definition without the field) | `postprocessor.ts` | `gcodeMotionParser.ts` |
| `opensbp` | `opensbpEmitter.ts` | `sbpMotionParser.ts` |

## Files

- `index.ts` — public API.
- `types.ts` — `MachineDefinition` and its zod schema (`motion.arcInterpolation`,
  `arcFormat`, the optional `outputDialect`, `machineKind` and `plasma` block), `resolveOutputDialect`,
  `PostProcessorInput`/`Options`/`Result`, and `OperationMotionTrace`.
- `postprocessor.ts` — `runPostProcessor` (the dialect switch) and the G-code
  emitter: templates, modal tracking, canned drill cycles, line numbers.
- `motionPipeline.ts` — the dialect-neutral half of export:
  `planProgramSequence` (tool changes, spindle start/restate/stop, coolant,
  feed and speed fallbacks, pending plasma output and unexecutable tool-change
  warnings), `planOperationMotion`
  (project → machine transform, arc fitting, the emitted-arc fallback and its
  warnings, the motion trace), `planDrillCycles` (drill cycles in machine
  coordinates, for a dialect with canned cycles), `splitRapid` (the safe-Z
  split of a rapid), and the emitted-number helpers arc validation judges
  with. It is the only caller of `projectToMachinePoint` during export, and
  the only place an operation's machining setup is applied (issue #944): the
  setup's frame is resolved once per operation and passed to the transform,
  for moves and drill cycles alike. `planDrillCycles` takes the operation for
  that reason.
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
  `machineToProjectPoint`. Both take an optional setup frame
  (`src/engine/setupOrientation.ts`): the point is turned into the setup-local
  frame before the origin offset, and Top passes none.
- `definitions/` — bundled machine definitions (`BUNDLED_DEFINITIONS`) and
  `getActiveMachineDefinition`, the export boundary. `shopbot.json` is the one
  non-G-code definition; see the note below. `qtplasmac.json` adds the experimental
  plasma table metadata, with controller-owned piercing and no torch emission;
  `grbl-plasma.json` is the G-code-owned counterpart (per-cut touch-off, #983),
  also metadata only.
- `legacyMachineParity.test.ts` + `legacyMachineParity.json` — 42 frozen pre-#956 output cases across every existing machine, both units, arcs, tool changes and drilling; only the clock date is normalized.
- `*.test.ts` — `postprocessor.test.ts` (G-code), `motionPipeline.test.ts`
  (sequencing, drill-cycle transform, rapid split, and both emitters checked
  against one sequence), `opensbpEmitter.test.ts` (SBP and the dialect
  switch), `sbpMotionParser.test.ts`, `arcFitting.test.ts`,
  `gcodeMotionParser.test.ts`, `motionDebug.test.ts`,
  `trochoidalArcExport.test.ts`, `setupExport.test.ts` (a Bottom operation
  exports turned for both dialects, the shared origin on and off the flip
  centreline, arc direction reversal, drill cycles, and Top with setups
  byte-identical to a project without them).

## Adding a dialect

1. Add its id to `OUTPUT_DIALECTS` in `types.ts`.
2. Write an emitter that calls `planProgramSequence`, `planOperationMotion`
   and `splitRapid` and returns a `PostProcessorResult`; add its case to
   `runPostProcessor`, and its events to
   `testBothDialectsWriteTheSameSequence`.
3. Write a motion parser returning `ParsedGcodeMotion`; add its case to
   `parseExportedMotion`. Use it as the round-trip oracle in the emitter tests.
4. Add the bundled definition, and decide what a build that predates the
   dialect would write for it (next section).
5. Give it wording in `src/components/export/exportDialectLabels.ts`; the
   record there does not compile until every dialect has some.

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

The machine editor does not show those fields for an `opensbp` machine
(`MachineDefinitionEditorDialog`): editing them would change nothing. The
fields it does read are reachable under Advanced.

## Checks

- `npm test` runs every `*.test.ts` here.
- `npm run check:gcode` runs real controller parsers over a G-code corpus
  (`scripts/gcode-conformance/`). It covers G-code definitions only: there is
  no ShopBot interpreter to run, so SBP relies on the round-trip tests.
- `npm run check:gcode:qtplasmac` runs plasma programs through LinuxCNC's
  QtPlasmaC simulator in a container
  (`scripts/gcode-conformance/qtplasmac/`, #954). It holds hand-written
  reference programs today; the plasma post output (#959) adds its exported
  programs to that corpus and must keep it green.
