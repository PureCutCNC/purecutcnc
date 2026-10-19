# INDEX — src/engine/gcode/

Export: turns generated toolpaths into a program for the project's machine.
Despite the folder name, the program is not always G-code — a machine
definition names its **output dialect** (issue #953), and the ShopBot one
exports native part files (`.sbp`). Design reference:
[`planning/G-code_Export_Design.md`](../../../planning/G-code_Export_Design.md).

## How export is split

`runPostProcessor` picks the dialect — dropping a plasma cut on a machine that
is not a plasma table before the emitter sees it (#960), and an operation this
machine's rotary axis cannot run (#393) — and does nothing else.
What the machine is asked to do is decided once, for every dialect, in
`motionPipeline.ts`; a dialect's emitter only spells the result. New behaviour
goes in the pipeline. New syntax goes in an emitter. A dialect is never
special-cased inside another dialect's emitter.

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
  `arcFormat`, the optional `outputDialect`, `machineKind`, `plasma` and
  `rotary` blocks), `resolveOutputDialect`, the rotary helpers `rotaryWord` /
  `rotaryBorrowedAxis` / `rotaryDirection` (which letter the program uses for
  rotation, which project axis a borrowed motor costs, and the sign a positive
  angle is multiplied by),
  `PostProcessorInput`/`Options`/`Result`, and `OperationMotionTrace`.
- `postprocessor.ts` — `runPostProcessor` (the dialect switch, plus dropping a
  plasma cut before a non-plasma machine's emitter with `postPlasmaCutSkipped`,
  #960) and the G-code emitter: templates, modal tracking, canned drill cycles,
  line numbers. Its
  G-code plasma branch blocks a missing, non-finite, non-positive or
  round-to-zero effective drop/cut feed as an error before export (#983), and
  cuts it cannot read a safe height for (`postPlasmaSafeHeightMissing`). It
  tracks whether a touch-off has happened in the program: the safe rapid
  before the first one is in the operator's zero, and every Z after it — the
  retract, and a safe rapid before any later cut or operation — is measured
  from the sheet. A rotary angle (#393) is modal like X/Y/Z: the emitter writes
  it once per angle change under `rotaryWord`, never reduced to 0–360, never on
  a block that also carries Z (a turning rapid turns at the higher of its two Z
  values), and puts
  the program into inverse-time feed (`G93`) around a turning feed move, every
  such move carrying its own `F` on the motion block and the mode restored
  (`G94`) before any block that is not one: a rapid, an operation header or its
  dwell/positioning template, a tool change, a canned cycle, the spindle stop or
  the program end. It refuses a program whose own templates write the machine's
  rotary word, judged on the rendered lines the program actually writes
  (`postRotaryTemplateUsesBorrowedAxis`).
  A program that turned the bar and ends at a non-zero angle gets one closing
  unwind rapid to 0 (#395, rule 5) before the footer; never between operations,
  and none for a program that ends at 0 or that never carried an angle. On a
  square blank it first rapids to the generators' travel height whenever the
  last emitted Z is below it or unknown, because the last operation may have
  descended at a constant angle. A template that can move Z (a Z word, a
  canned cycle, a macro, a tool change) invalidates the tracked Z, and a later
  A word is preceded by a validated retract to that height — a header or
  tool-change `G0 Z-8` cannot hide the cutter below the blank (#1016 C2 M1).
  Canned drill cycles are written only on a machine that borrows no motor and
  for a toolpath with no angle anywhere (#393); otherwise the expanded moves
  are used, as on a machine with canned cycles off.
- `squareSweepGuard.ts` — the square blank's standing-material grid and the
  export guard that walks a whole program's commanded motion through it
  (#1045 slice E). Cells are along-bar bins by angle bins, each the material's
  outer radius above the pivot, initialised from the raw blank (corner envelope
  at every angle, retained ends included) and lowered by every cut in program
  order. A turning cut below the travel height is admitted only when its
  interior engagement — sampled along the **actual commanded** motion, A as
  commanded so A0→A360 is a full revolution, inside the cutter's footprint —
  is within the operation's bound: a rough's `stepdown`, or a finish's
  `stockToLeave` plus the scallop of the strongest earlier rough on the same
  target. A turning rapid, or a turn on an along-mode operation, still refuses.
  Non-turning cuts (an along pass, a plunge) are never refused here but do
  lower the grid, which is what lets an along rough clear material for an
  around finish. This replaced the slice-C licence that one earlier rough on
  the same target proved coverage everywhere.
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
  split of a rapid, carrying a rotary angle so a rotation-only rapid is never
  dropped — the angle rides the XY block when there is one and otherwise a
  block of its own, never a Z block, in either direction of Z), `planStepFeeds` / `inverseTimeFeedValue` and
  `planRotaryRefusals`
  (issue #393: each move's feed word — inverse-time `feed / length` for a
  turning move, where `length` is the true length of the path the tip draws in
  the stock's own frame, in closed form over the move's linear angle change, so
  a move whose tip speed touches zero inside it is exact rather than off by a
  corner — and the reasons an
  operation cannot run on this machine's rotary axis: no axis, no inverse-time
  feed, travel on the borrowed motor's axis beyond the one value the program
  may use across all its operations, a non-bar stock, canned-cycle drill holes
  with no expanded moves, a feed move or arc that carries an angle on one end
  only, a feed move that starts before the program has turned
  the bar to its angle, and the bar lying along the other horizontal axis than
  the machine's rotary (`postRotaryAxisMismatch`, #395); a **square** blank
  (#1016 C2-S4) is judged by the generation guard again before the angle gate:
  only a legitimate rotary rough/finish against a real model on a matching
  Around setup with a supported physical workholding / ordinary-clamp setup may
  post, every angle-bearing square path must be that operation whatever face it
  claims (a synthetic `A` path from a Top/Bottom or wrapped 2D kind is refused),
  the emitted cutter must be the project's own referenced row — the row's `id`
  is what `planProgramSequence` selects the program's tool number from, and its
  normalized `units` label must be the project's, so an entry naming another
  valid row or carrying a foreign unit label is refused even when its shape and
  numbers were spoofed to match; a removed, unusable, differently shaped or
  differently sized cutter fails closed too, rather than letting the guard prove
  one tool clear and the emitter write another), a **turning** square move whose
  cutter's lowest point is below the corner envelope `barPivotZ + barMaxRadius`
  is refused (`postRotarySquareTurnBelowEnvelope`, #1016 C2 M1) unless
  `squareSweepGuard.ts` can show from the program's own standing material that
  the cut takes no more than the operation's bound — see that file below — and
  the inverse-time refusal keeps its own whole-operation turning-feed test,
  independent of the angle tracker, so an unestablished constant-angle feed
  cannot hide a later turning feed and change which refusal a round bar reports
  (#1016 C2 M1 P2), a non-rotary kind or a
  stale wholly-angle-free rotary toolpath is refused, and `rotaryCentreline` returns
  the true pivot (`barPivotZ = side / 2`) whichever bar shape the stock is;
  `planStepFeeds` throws
  when an emitted step no longer pairs with the project move its feed comes
  from), and the emitted-number
  helpers arc validation judges
  with. It is the only caller of `projectToMachinePoint` during export, and
  the only place an operation's machining setup is applied (issue #944): the
  setup's frame is resolved once per operation and passed to the transform,
  for moves and drill cycles alike. `planDrillCycles` takes the operation for
  that reason. `planProgramSetup` (issue #946) decides what a program says
  about its setup, for every dialect: the header comment lines, an error when
  a program holds operations of more than one setup or one its setup refused
  to cut, and a warning for a second setup with no registration. It returns
  nothing for a project with a single setup, except an Around one (#395), which
  is always annotated.
- `setupPrograms.ts` — one program per setup (issue #946):
  `planSetupPrograms` splits an export's operations by setup and names each
  file (`<project>_01_top`; a single-setup project keeps exactly today's
  name), and `setupHeaderLines` / `describeTouchOff` / `describeRegistration`
  build the plain-text header each dialect writes as comments. An Around setup
  (#395) is its own program even when it is the project's only one, and its
  header says `AROUND THE BAR, BAR ALONG <axis>` with the rotary-zeroing line
  in place of registration and, on a borrowed-motor machine, the line telling
  the operator to set the tool over the centreline by hand;
  `setupLacksRegistration` is false for it (a chuck locates the bar).
- `opensbpEmitter.ts` — ShopBot part-file emitter. Its header comment cites
  where the syntax comes from and what was deliberately not consulted; keep it
  accurate when the emitter changes.
- `arcFitting.ts` — export-stage arc fitting: Kasa circle fit, direction
  detection, ≤ 90° splitting, and `resolveEmittedArc` / `applyEmittedArcFallback`,
  which judge an arc by the numbers actually written. A move that turns the
  stock is never part of a run (#393): an arc is one planar circular motion, and
  a rotary axis moving through it is not.
- `gcodeMotionParser.ts` — read-only parser for the emitted G-code (issue
  #356); reconstructs planar motion analytically. Given the definition's rotary
  word and inverse-time commands (issue #393) it reads the angle modally — the
  borrowed motor's letter is the angle, never a linear coordinate — and keeps a
  `G93` F word as inverse time (`inverseTimeFeed`, 1/min) rather than a speed.
  The feed **mode** is modal but that F is not: a feed move (`G1`/`G2`/`G3`) in
  inverse-time mode without a positive F on its own block is what a controller
  rejects, so it takes the parser's existing downgrade path and reports
  `unsupported` rather than verified with a borrowed F; an F on a line of its
  own does not count. A program with no rotary word and no `G93` parses exactly
  as before.
- `sbpMotionParser.ts` — the same for emitted SBP. Understands exactly what
  `opensbpEmitter.ts` writes and reports anything else as `unsupported`.
- `motionDebug.ts` — exported-motion debug helpers (issue #356):
  `parseExportedMotion` (parses in the definition's own dialect, handing the
  G-code parser the definition's rotary word and inverse-time commands),
  eligibility, the exported-vs-source diagnostic — which compares the rotary
  angle at each endpoint as well as X/Y/Z, and does not compare a borrowed
  axis's coordinate the program cannot carry — and the three-layer model
  builder.
- `utils.ts` — number formatting, `projectToMachinePoint` and its inverse
  `machineToProjectPoint`. Both take an optional setup frame
  (`src/engine/setupOrientation.ts`): the point is turned into the setup-local
  frame before the origin offset, and Top passes none. The rotary angle
  (issue #393) goes out multiplied by `rotaryDirection` and comes back divided
  by it; a point with no `a` gains no key in either direction.
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
  height. Cuts with no safe height block the export, and a plasma cut on a
  machine that is not a plasma table is left out before the emitter with
  `postPlasmaCutSkipped` (#960).
- `plasmaGcodeFeedRegression.test.ts` — the #983 drop feed through the real
  store → generation → export path, with no fixture feed override: the example
  torch drops at its own 300 mm/min, so a first export from a new project
  (Add operation importing from the bundled library, which gives the entry
  written in the project's units, as it stands) is not blocked and every
  drop spells it, `F300.000` or `F11.8110`; a torch with no drop feed — cleared
  by the operator, stored without the field or with 0, or imported from a
  library entry that lacks it — still blocks; configuring the tool before or
  after operation creation succeeds, mm/inch conversion including a tool in
  another unit, and every invalid effective feed (missing, NaN, Infinity,
  negative, positive-but-rounds-to-zero) blocks with
  `postPlasmaPlungeFeedMissing` / `postPlasmaCutFeedMissing` while QtPlasmaC
  writes the same program whatever the drop feed.
- `*.test.ts` — `postprocessor.test.ts` (G-code), `motionPipeline.test.ts`
  (sequencing, drill-cycle transform, rapid split, and both emitters checked
  against one sequence), `opensbpEmitter.test.ts` (SBP and the dialect
  switch), `sbpMotionParser.test.ts`, `arcFitting.test.ts`,
  `gcodeMotionParser.test.ts`, `motionDebug.test.ts`,
  `trochoidalArcExport.test.ts`, `rotaryDefinition.test.ts` (the optional
  `rotary` block: bundled definitions gain no key, the block round-trips and
  its refusals, the `rotaryWord` / `rotaryBorrowedAxis` / `rotaryDirection`
  helpers, and the block surviving project save/load and the machine library),
  `setupExport.test.ts` (a Bottom operation
  exports turned for both dialects, the shared origin on and off the flip
  centreline, arc direction reversal, drill cycles, and Top with setups
  byte-identical to a project without them), `setupPrograms.test.ts` (how an
  export is split and named, the touch-off and registration wording, the
  header in G-code, parenthesised and SBP comments, a single-setup program
  byte-identical with no header, and the mixed-setup and refused-operation
  errors), `aroundExport.test.ts` (exporting an Around setup, #395: the Around
  header for both bar axes and both rotary drives, every real generated
  operation — pocket, Engrave, edge route and drilling — exported with no
  refusal, the across coordinate left on the centreline or the borrowed letter
  devoted to the angle, the establishing rapid, `G93`/`G94` with a
  hand-checked inverse-time word, no arc and no canned cycle, the multi-turn
  angle and the single closing unwind, `postRotaryAxisMismatch`, and the
  program read back through `parseGcodeMotion` onto the flat toolpath).
- `squareRotaryOutput.test.ts` — the square blank through generation and the
  real posted program (#1016 C2-S4): both axes, both units, rough/finish and
  own / borrowed / reversed machines post nonempty angle-bearing inverse-time
  motion from the true pivot with no refusal; the round bar is byte-identical
  across the same 24-cell matrix to a fingerprint captured from the base commit,
  with the generated-date comment pinned exactly as `legacyMachineParity.test.ts`
  pins it; axis mismatch, a machine with no rotary, borrowed-axis travel, a
  split-angle feed, a non-rotary square Around path and stale wholly-angle-free
  motion all refuse; the Z12 `A0 -> A45` probe is refused at export by
  `postRotarySquareTurnBelowEnvelope` with no angle posted, a turn just above
  the corner envelope is accepted and posts under `G93`, and the same low turn
  on the round bar of the same box still posts; a manual too-small chuck is
  preserved but refuses generation (no
  motion, `workholdingDiameter` naming the clamp and both diameters in project
  units) and output (no motion posted), hidden workholding still counts,
  axial-disjoint and end-face-touching supports are clear, off-centre and
  wrong-height rows refuse with `workholdingPlacement`, an invalid clamp row
  keeps the generic `postSetupOperationRefused` fallback, an ordinary
  clamp in the swept envelope refuses with `ordinaryClampOverlap` while a
  provably disjoint one passes, and
  a clamp past the blank end but inside the finite cutter-body overhang refuses
  — with an independent analytic cutter-body-vs-clamp witness — while one past
  that overhang is provably clear and passes; a clamp row with a non-positive
  height, a non-finite clearance and a degenerate blank all fail closed, as do a
  missing / empty-ref emitted cutter, a stale larger cutter, a same-radius
  cutter of the other supported shape, an unsupported `v_bit` on either side, an
  emitted row naming another valid tool row (a real tool-change program is
  refused), a normalized row labelled in another unit system, and a body whose
  radius is not half its diameter (with the flat/ball surface difference
  witnessed analytically), while a genuinely converted same-id row still posts;
  Frank's measured UI-test project
  (`squareRotaryChuckSwitch.fixture.camj`, kept out of `test-fixtures/` because the parity corpus requires every fixture there to generate: inch, 2 in square, the
  50 mm round-bar chuck loaded from format 3.3 **without** the shape switch)
  refuses both rotary operations with zero moves and `workholdingDiameter`,
  naming the clamp and both diameters in inches; moving the same chuck off the
  pivot reports `workholdingPlacement`. 40 seeded pure-turn feeds match the
  analytic true-pivot inverse-time word. All sixteen square rough/finish fingerprints were
  re-captured for #1016 C2-F7, which shortens every one (the cutter centre now
  starts and ends one radius inside each stubbed end); the round fingerprints
  did not move then. #1045 slice D re-captures all 24 round fingerprints: the same pull-in now applies to a
  round bar's stubbed ends (a ring or pass on the band edge cut into the retained end), so every fixture's grid
  starts and ends one cutter radius in; the arithmetic, layers and posted words are otherwise unchanged.
- `squareRotaryProgramSafety.test.ts` — square-blank program safety on the
  **emitted text** (#1016 C2 M1 correction): a seeded property test (300
  programs, seed 1016) generates supplied paths with safe turns, constant-angle
  descents, A-only rapids whose endpoints agree while the controller is
  elsewhere, multiple operations, own/borrowed/reversed machines, mm/inch and
  header/operation-header/tool-change/footer templates that move Z. Each whole
  program is posted, then replayed by an independent modal interpreter written
  in the test (G0/G1/G2/G3, the machine's rotary word, Z, G20/G21, G90/G91):
  every accepted program's rotary changes must execute at or above the emitted
  travel height, and every refused program must carry a refusal code. Focused
  cases pin the closing-unwind retract, the template Z-unknown rule, and the
  restored whole-operation turning-feed precedence on a round bar.

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
