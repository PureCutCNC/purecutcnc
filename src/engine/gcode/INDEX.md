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
  emitter: templates, modal tracking, canned drill cycles, line numbers. Its
  G-code plasma branch blocks a missing, non-finite, non-positive or
  round-to-zero effective drop/cut feed as an error before export (#983), and
  cuts it cannot read a safe height for (`postPlasmaSafeHeightMissing`). It
  tracks whether a touch-off has happened in the program: the safe rapid
  before the first one is in the operator's zero, and every Z after it — the
  retract, and a safe rapid before any later cut or operation — is measured
  from the sheet.
- `motionPipeline.ts` — the dialect-neutral half of export:
  `planProgramSequence` (tool changes, spindle start/restate/stop, coolant,
  feed and speed fallbacks, and unexecutable tool-change
  warnings; its plasma branch decides skipped operations, the selectable
  QtPlasmaC material range and the material handshake for controller piercing,
  #959, and serves either pierce mode), `planPlasmaPath`
  (torch-off travel and torch-on cuts, #959), `plasmaSafeZ`, `plasmaSheetZ` and
  `planPlasmaGcodeCut` (the G-code pierce safe height in the operator's zero
  and measured from the sheet surface, the stock top mapped like any toolpath
  point, per-cut heights and touch-off, converted to output units at emission,
  #983),
  `foldFullCircleArcs` (a complete
  counter-clockwise circle as one block, so QtPlasmaC's hole handling can
  recognise it), `planOperationMotion`
  (project → machine transform, arc fitting, the emitted-arc fallback and its
  warnings, the motion trace), `planDrillCycles` (drill cycles in machine
  coordinates, for a dialect with canned cycles), `splitRapid` (the safe-Z
  split of a rapid), and the emitted-number helpers arc validation judges
  with. It is the only caller of `projectToMachinePoint` during export, and
  the only place an operation's machining setup is applied (issue #944): the
  setup's frame is resolved once per operation and passed to the transform,
  for moves and drill cycles alike. `planDrillCycles` takes the operation for
  that reason. `planProgramSetup` (issue #946) decides what a program says
  about its setup, for every dialect: the header comment lines, an error when
  a program holds operations of more than one setup or one its setup refused
  to cut, and a warning for a second setup with no registration. It returns
  nothing for a project with a single setup.
- `setupPrograms.ts` — one program per setup (issue #946):
  `planSetupPrograms` splits an export's operations by setup and names each
  file (`<project>_01_top`; a single-setup project keeps exactly today's
  name), and `setupHeaderLines` / `describeTouchOff` / `describeRegistration`
  build the plain-text header each dialect writes as comments.
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
  non-G-code definition; see the note below. `qtplasmac.json` is the experimental
  QtPlasmaC table, controller-owned piercing, whose torch path is written (#959);
  `grbl-plasma.json` is the G-code-owned counterpart (per-cut touch-off, #983),
  whose probe/pierce/dwell/cut sequence is written on the same pipeline.
- `legacyMachineParity.test.ts` + `legacyMachineParity.json` — 42 frozen pre-#956 output cases across every existing machine, both units, arcs, tool changes and drilling; only the clock date is normalized.
- `plasmaOutput.test.ts` — the QtPlasmaC torch path (#959): material handshake order and when it repeats, the selectable material range (0 and 1000000+ block), one torch pair per contour, no Z or numeric F, the small hole folded to one closed G3 with both a straight and the default arc lead-in (and the fold kept off a radius-format machine, where a closed R arc is a controller error), skipped milling operations, the blocking missing-material error, and physical direction under a mirrored axis.
- `plasmaGcodeOutput.test.ts` — the Grbl plasma torch path (#983): safe Z in the
  operator zero, probe → set zero → pierce-height rapid → M3 → dwell → drop at
  the plunge feed → cut at the cut feed → M5 → safe Z for every contour, the
  switch offset applied negatively (absent = 0), mm→inch conversion of the
  touch-off fields at emission, configured heights emitted even when pierce is
  below cut, line and arc leads, mirrored-axis direction, skipped milling
  operations, and no M4. Also the two Z frames around the touch-off, with the
  project Z zero on, below and above the sheet top in both units: only the
  first safe rapid is in the operator's zero, every retract and later safe
  rapid is measured from the sheet, and nothing travels at or below cut
  height. Cuts with no safe height block the export, and a plasma operation
  on a router takes the tool's plunge feed when it has none of its own.
- `plasmaGcodeFeedRegression.test.ts` — the #983 drop feed through the real
  store → generation → export path, with no fixture feed override: unconfigured
  blocks, configuring the tool before or after operation creation succeeds,
  mm/inch conversion including a tool in another unit, and every invalid
  effective feed (missing, NaN, Infinity, negative, positive-but-rounds-to-zero)
  blocks with `postPlasmaPlungeFeedMissing` / `postPlasmaCutFeedMissing` while
  QtPlasmaC stays unaffected.
- `*.test.ts` — `postprocessor.test.ts` (G-code), `motionPipeline.test.ts`
  (sequencing, drill-cycle transform, rapid split, and both emitters checked
  against one sequence), `opensbpEmitter.test.ts` (SBP and the dialect
  switch), `sbpMotionParser.test.ts`, `arcFitting.test.ts`,
  `gcodeMotionParser.test.ts`, `motionDebug.test.ts`,
  `trochoidalArcExport.test.ts`, `setupExport.test.ts` (a Bottom operation
  exports turned for both dialects, the shared origin on and off the flip
  centreline, arc direction reversal, drill cycles, and Top with setups
  byte-identical to a project without them), `setupPrograms.test.ts` (how an
  export is split and named, the touch-off and registration wording, the
  header in G-code, parenthesised and SBP comments, a single-setup program
  byte-identical with no header, and the mixed-setup and refused-operation
  errors).

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
  no ShopBot interpreter to run, so SBP relies on the round-trip tests. Since
  #983 it also holds the generated Grbl plasma programs
  (`grbl-plasma-*` in `CORPUS`, built from `src/test/plasmaExportFixtures.ts`)
  and the sequence verdict in `scripts/gcode-conformance/grbl-plasma/`.
- `npm run check:gcode:qtplasmac` runs plasma programs through LinuxCNC's
  QtPlasmaC simulator in a container
  (`scripts/gcode-conformance/qtplasmac/`, #954). It holds hand-written
  reference programs and, since #959, the exported twin of each
  (`EXPORTED_CASES`, built from `src/test/plasmaExportFixtures.ts`).
