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
- `types.ts` — `MachineDefinition` and its zod schema (whose `superRefine` also
  runs `templateRuleViolations`, so a template that breaks its class is refused
  at the boundary; see `templateRules.ts`), covering `motion.arcInterpolation`,
  `arcFormat`, the optional `motion.machineCoordinateCommand` — the block prefix
  for a machine-coordinate rapid, absent meaning G-code's `G53 <rapid>` and
  `null` meaning none — `motion.machineSafeZ`, the machine-coordinate retract
  height in **millimetres**, converted to the program's units at emission,
  default 0 = the top of travel after homing — `outputDialect`,
  `machineKind`, `plasma` and `rotary`
  blocks), `resolveOutputDialect`, `machineCoordinateRapidCommand`, the rotary
  helpers `rotaryWord` / `rotaryBorrowedAxis` / `rotaryDirection` (which letter
  the program uses for rotation, which project axis a borrowed motor costs, and
  the sign a positive angle is multiplied by),
  `PostProcessorInput`/`Options`/`Result`, and `OperationMotionTrace`.
- `templateRules.ts` — the template classes and their allowlists (#1057 slice
  F): which field is a *program header*, *tool change*, *footer* or an *inert*
  in-program template, what each may contain, and the refusal message naming the
  field and the offending word. `types.ts` runs it in the schema's
  `superRefine`, so machine import, the editor and project snapshots all refuse
  a definition that breaks a class. It expands the emitter's `{placeholder}`
  syntax before judging a line, so `{unitsCommand}` is judged by the command it
  becomes and a controller-owned feed expression (`F#<_hal[...]>`) is still a
  feed word. Slice H adds three boundaries: the comment marker pair is an exact
  per-dialect allowlist (`(`+`)`, `;`+empty in G-code, `'`+empty in ShopBot) and
  templates are scanned with the *dialect's* comment syntax, never the
  definition's own field; a numeric placeholder may only be the value of a
  fixed word letter it is safe under (`T`/`H` tool number, `S` RPM, `F` feed,
  `P` material number), never a G/M number and never joined to a word; and a
  single-command field is judged whole, so a newline or semicolon cannot split
  it into separately-valid commands. `templateInjectionSweep.test.ts` runs every
  field against every injection pattern.
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
  A Top or Bottom program of a manual-index rotary bar starts with the bar's
  own turn (#1054 slice 2b): a rapid clear of the bar, then a rapid of the
  rotary word to 0 or 180 through `rotaryDirection`, before any operation's
  moves. The header says the program does it, and X/Y are left unknown
  afterwards so the first operation writes its own position. The clearance
  retract is always a machine-coordinate rapid (#1054 fix 2): the emitter no
  longer infers tool-length compensation from template text (`G43`/`G44`/
  `G49`, including compact spellings the old scan missed), because only the
  machine frame is independent of the work offset and compensation. The height
  is the machine definition's own Safe Z (`motion.machineSafeZ`, stored in
  millimetres and converted to the program's units at emission, default 0 =
  the top of travel after homing, #1054 fix 3/fix 4). It is never derived from
  the project origin, units or Safe Z: `G53` is the machine's zero, which the
  app does not know. A machine with no machine-coordinate move is refused with
  `postRotaryTurnWithoutClearance` rather than turned.
  A program ends where its last move left it (#1091, Frank's 2026-10-22
  decision): there is no closing unwind, so a rotary program's bar stays at its
  last angle — an along rough at A3600 stays there, a Bottom program stays at
  A180. The final motion is the last operation's own retract, exactly as a
  non-rotary program's is; the emitter invents no retract and no turn. The
  operator zeros A for the work and clears it when done, and the controller's
  soft limits handle range. The opening turn of a Top/Bottom bar program is
  unaffected: it still retracts in machine coordinates and states A0/A180
  before the face. On a square blank a template Z move before an A word also
  rapids to the generators' travel height whenever the tracked Z is unknown,
  because the last operation may have descended at a constant angle.
  **Machine templates are restricted by class** (#1057 slice F, Frank's
  decision 2026-10-21). `templateRules.ts` classifies *every string field* of
  the definition schema — `MACHINE_STRING_FIELDS` is the table validation walks,
  and a test enumerates the schema's string paths so a new field without a class
  fails before it can reach an emitter. The schema refuses a definition that
  breaks its class: a *program header* may only set up modals (`G90`, `G17`,
  `G40`, `G49`, `G80`, `G94`, `G92.1`, `G97`, units, work-coordinate select, a
  bare program number, a fully scanned parameter assignment, comments,
  non-moving M codes) with no motion or axis word; the *tool change*, the
  *footer* and the program-end command may do anything; and every template that
  runs inside the program (spindle, coolant, pause, operation header,
  inverse-time, units, canned cycle, plasma torch, material/THC) is inert — no
  motion word, axis word, mode change, O-word or macro expression. The inert
  allowlist is `G4` and the spindle/coolant/pause/end M codes only: `G40`,
  `G49`, `G61`, `G64`, `G80` and `G97` change controller state and are legal
  only in the header, the tool change and the footer. A *single-word command*
  field (rapid/linear/arc words, feed/RPM prefixes, units, the peck word, the
  machine-coordinate retract, the plasma probe/set-zero) is matched whole
  against its own pattern, so `rpmCommand: "G91\nS"` is refused; every other
  placeholder that carries operator text (`{programName}`, `{operationName}`,
  `{operationDescription}`, `{toolName}`) may appear only inside a comment, and
  the emitter strips the dialect's closing marker, `;` and newlines from that
  text. The purpose templates keep exactly their own word (`G93`/`G94`,
  `G20`/`G21`, the torch's `M3`/`M4`/`M5` with an optional `S` and `$` selector,
  the material/THC output commands and parameters). Machine import, the editor
  and project-snapshot loading all go through that schema, so a definition that
  could move from a template is refused before an emitter sees it. The emitter
  therefore no longer carries the per-axis invalidation and re-entry that
  slices B–E added for arbitrary templates; what remains is the restart block
  below.
  **After every emitted tool change** — including the first operation's tool
  load, because a tool-change template may still do anything — the program
  restarts in one block: `G90 G94 G17` (distance, feed and plane modes), the
  units word, one stated rapid to a proven safe Z (a bar Top/Bottom program
  always uses the machine-coordinate Safe Z — on a square blank too, because a
  work height is not proof after a tool change; a square blank that turns in
  any other program uses its travel height; otherwise the operation's own rapid
  clearance, `plannedSafeZ` never a cutting point), then one rapid with X, Y
  and the rotary word, all stated to the exact point that move starts from. A
  bar Top/Bottom program states the setup's own A angle on that block after
  every tool change, not just when the toolpath happens to carry one. A feed or
  an arc that starts the operation gets one more rapid to its own start plane.
  A program written with tool changes off has no tool change and no block, and
  is byte-identical to the base (`templateByteIdentity.test.ts`); it still
  places the start after the opening manual-index turn, before any feed. A
  tool change may have moved the bar without the program restating the angle,
  but the program no longer owes a closing unwind for it (#1091); the last
  stated angle is simply the last angle the toolpath wrote.
  ShopBot's part file writes the equivalent after `C9`: `SA`, a `JZ` to the
  safe Z, then a `J2` to the start.
  Canned drill cycles are written only on a machine that borrows no motor and
  for a toolpath with no angle anywhere (#393); otherwise the expanded moves
  are used, as on a machine with canned cycles off.
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
  coordinates, for a dialect with canned cycles), `plannedSafeZ` (the highest
  Z the operation's own *rapid* steps reach — the clearance the generators set
  for them, or null when the path has none, so a cutting point can never become
  the restart block's height, #1057 slice F), `plannedStepStart` (the point a
  planned step starts from — an arc's own start, the previous step's end, or the
  first toolpath move's `from` — which the restart block states), `splitRapid`
  (the safe-Z split of a rapid, carrying a rotary angle so a rotation-only
  rapid is never dropped — the angle rides the XY block when there is one and
  otherwise a block of its own, never a Z block, in either direction of Z; a
  borrowed motor's letter is the angle, not a coordinate, so it never invents
  an XY block), `planStepFeeds` / `inverseTimeFeedValue` and
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
  one tool clear and the emitter write another), an A-changing square move whose
  cutter's lowest point is below the corner envelope `barPivotZ + barMaxRadius`
  is refused (`postRotarySquareTurnBelowEnvelope`, #1016 C2 M1; the generators
  keep every A-changing move above that envelope, and a turn placed exactly on
  it is within the generator's own tolerance — the emitted Z's half-step), and
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
  about its setup, for every dialect: the header comment lines, the angle a
  manual-index program turns to before its first operation (or null when the
  machine cannot turn it), an error when a program holds operations of more
  than one setup or one its setup refused to cut, and a warning for a second
  setup with no registration. It returns no header for a project with a single
  setup, except an Around one (#395) and a Top/Bottom one of a rotary bar
  (#1054 slices 2 and 2b), which are always annotated.
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
  A Top or Bottom setup of a rotary project on a bar (#1054 slices 2 and 2b)
  carries a header even when it is the only setup, and adds the manual
  indexing. On a machine with no rotary axis it is the operator's own move —
  `ROTARY: SET A TO 0° BEFORE RUNNING` on Top,
  `ROTARY: SET A TO 180° - TURN THE BAR ABOUT ITS AXIS - BEFORE RUNNING` on
  Bottom, and `ROTARY: RETRACT THE SPINDLE CLEAR OF THE BAR BEFORE TURNING A`
  — and no A word is emitted. On a machine with a rotary axis the program
  turns the bar itself, so one line says so instead:
  `ROTARY: THE PROGRAM TURNS <word> TO 0°/180° AFTER RETRACTING - CHECK THE
  BAR IS CLAMPED`, where `<word>` is `rotaryWord` (A, or the borrowed motor's
  letter), and the emitter writes the retract and the turn under it. The
  single-setup file name is unchanged, and `planProgramSetup` warns (naming
  the setup) when a Bottom setup flips about the other axis than the bar lies
  along instead of rewriting it.
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
  own does not count. A `G53` block is a machine-coordinate move, not a work
  position (#1054 fix 4): it is not added to the work-frame trace, it leaves the
  tracked work Z unknown until a later block states one, and the parse reports
  `unsupported` rather than verified. A program with no rotary word and no `G93`
  parses exactly as before.
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
- `*.test.ts` — `postprocessor.test.ts` (G-code), `templateZRetract.test.ts`
  (the restart block after a tool change, #1057 slice F: the exact block per
  bundled dialect — GRBL, LinuxCNC, Mach N-numbers, generic and ShopBot — a
  tool-change template ending at `G0 Z-2` and one switching to `G91`, two-tool
  programs, a feed-first start plane, a rotary angle and the tool-changes-off
  control, plus the mutations that must fail), `templateRestrictions.test.ts`
  (every restricted template field refuses a motion/axis/mode/macro word with a
  message naming field and word; the header's own class; tool change and footer
  accept anything; every bundled definition validates; machine import reports
  the refusal), `templateByteIdentity.test.ts` (a tool-change-free program per
  bundled definition is byte-identical to `origin/integration/0.6.0`),
  `templateReviewFixes.test.ts` (the seven Codex review findings: every schema
  string field is classified, command fields refuse injected words, an
  assignment does not hide a trailing word, operator text is comment-only and
  sanitized, only the header/tool-change/footer may change state, the opening
  turn is followed by the start placement, a bar restart restates the setup
  angle, and a square bar restart uses G53),
  `motionPipeline.test.ts`
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
  angle with no closing unwind, `postRotaryAxisMismatch`, and the program read
  back through `parseGcodeMotion` onto the flat toolpath).
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
  did not move.
- `squareRotaryProgramSafety.test.ts` — square-blank program safety on the
  **emitted text** (#1016 C2 M1 correction): a seeded property test (300
  programs, seed 1016) generates supplied paths with safe turns, constant-angle
  descents, A-only rapids whose endpoints agree while the controller is
  elsewhere, multiple operations, own/borrowed/reversed machines, mm/inch and
  header/operation-header/tool-change/footer templates that move Z. Each whole
  program is posted, then replayed by an independent modal interpreter written
  in the test (G0/G1/G2/G3, the machine's rotary word, Z, G20/G21, G90/G91):
  every accepted program's rotary changes must execute at or above the emitted
  travel height, and every refused program must carry a refusal code. The
  program's last angle in the text must be the last toolpath angle (no closing
  unwind). Focused cases pin the template Z-unknown rule, the restored
  whole-operation turning-feed precedence on a round bar, and the program
  ending on its own retract (#1091).

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
