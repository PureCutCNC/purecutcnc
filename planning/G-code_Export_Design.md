---
status: current
authoritative-for: machine origin, machine definitions, postprocessing, and G-code export
last-verified: 2026-10-03
---

# G-code Export Design

## Purpose

G-code export translates generated toolpath results into controller-specific
text through an explicit machine definition and machine origin. The exporter is
not allowed to infer unknown machine capabilities or silently repair unsafe
project setup.

The original implementation sequence and completed checklist are preserved in
[`archive/G-code_Export_Implementation_History.md`](archive/G-code_Export_Implementation_History.md).

## Architecture

```text
selected ToolpathResult[] + Project + MachineDefinition + export options
                                |
                                v
                    postprocessor preparation
                                |
                                v
                    controller-specific G-code
```

The system has four responsibilities:

1. **Machine origin:** translate internal project coordinates into the chosen
   machine-zero coordinate system.
2. **Machine definition:** describe controller conventions, templates,
   supported commands, file extensions, and formatting.
3. **Postprocessor engine:** walk moves, track modal state, substitute template
   variables, format values, and collect warnings.
4. **Export UI:** choose a machine and operation set, expose warnings and
   options, preview output, and save the result.

Implementation lives under `src/engine/gcode/`, with project/export UI under
`src/components/export/` and machine editing under `src/components/machine/`.

## Coordinate contract

- Internal project coordinates use Y-down screen space.
- Machine coordinates use the machine definition's Cartesian mapping, normally
  Y-up.
- `MachineOrigin` supplies the translation point; export owns the inversion and
  mapping boundary.
- Origin changes do not rewrite sketch geometry.
- Units are taken from the project and formatted through shared unit helpers.
- Every emitted cutting, rapid, drilling, and setup coordinate follows the same
  transform contract.

## Machine definitions

Machine definitions are declarative data validated at the load/import boundary.
Bundled definitions and user-provided definitions use the same runtime contract.
A definition may describe:

- controller identity and output extensions;
- startup and shutdown templates;
- units, precision, comments, and line formatting;
- motion and drilling-cycle capabilities;
- tool-change, spindle, and coolant behavior;
- axis mapping and other controller conventions.

Unknown or invalid capabilities produce validation errors or warnings; they are
not guessed by the exporter.

### Plasma machine metadata (#956)

`machineKind` is optional: absent means `router`, and validation leaves the
field absent on existing definitions. `plasma` holds `torchOnCommand`,
`torchOffCommand`, `materialSelectCommand` (with `{materialNumber}`), optional
`thcOnCommand` / `thcOffCommand`, and `pierceMode`. A plasma machine requires
this block. Only `controller` piercing is supported in 0.6.0; validation
rejects the reserved `gcode` mode. Format remains 3.3, with no injected defaults
or version-based migration.

The bundled **QtPlasmaC (experimental)** machine uses controller-owned pierce
height, delay and THC, following the
[LinuxCNC QtPlasmaC command reference](https://linuxcnc.org/docs/2.9/html/plasma/qtplasmac.html#_qtplasmac_specific_g_codes).
These commands are metadata only: legacy spindle-start words are comments,
spindle-off and tool-change commands are empty, and no torch, material or THC
sequence is emitted by this change.
Plasma sequencing belongs to `motionPipeline.ts` in #959.

The library shows machine kind for every row, including legacy routers and
project-only snapshots. The focused editor exposes kind and the plasma block;
imports, custom storage and project snapshots retain the same validated data.

## Output dialects

A machine definition describes G-code word syntax, and that is not every
machine's language. A definition may therefore name an **output dialect**
(issue #953):

| `outputDialect` | Program | Bundled machine |
| --- | --- | --- |
| absent, or `gcode` | RS-274 G-code driven by the definition's words and templates | every definition but one |
| `opensbp` | native ShopBot part file (`.sbp`) | ShopBot (SBP) |

The field is optional and an absent key means G-code, so every definition and
project that predates it behaves exactly as before, and parsing one adds
nothing to it.

**One pipeline, one emitter per dialect.** `runPostProcessor` chooses the
dialect and delegates. What the machine is asked to do is shared and lives in
`motionPipeline.ts`:

- the program's sequence — whether the tool changes, when the spindle starts,
  is restated at a new speed and stops, when coolant comes on, the feed and
  speed fallbacks, and the warnings for what was asked for but cannot be
  written;
- the machine-coordinate transform, for moves and for drill cycles, including
  the turn of the operation's machining setup (issue #944): a Bottom
  operation's stock-space toolpath is turned into its setup's frame before
  the origin offset, and a Top operation takes the unturned path;
- arc fitting, the emitted-arc fallback and their warnings;
- the safe-Z split of a rapid, and the motion trace.

An emitter contributes line syntax and keeps only what it has written so far.
A later feature that changes what the machine is asked to do (setups, a rotary
axis, another machine kind) changes the pipeline and reaches every dialect; it
does not add branches for one dialect inside another's emitter. Sequencing is
in the pipeline for a concrete reason: the first ShopBot emitter carried its
own copy and dropped a spindle-speed change between two operations on one
tool, which the G-code emitter restated.

**What a ShopBot program contains.**

- Header comments, the units guard, then `SA` (absolute mode).
- The units guard: system variable `%(25)` is 0 when the control software is
  set to inches and 1 for millimetres. A millimetre program starts with
  `IF %(25)=0 THEN GOTO UNIT_ERROR`, an inch program with `%(25)=1`. The
  `UNIT_ERROR` block is a message box and `END`, placed after the program's
  own `END`, so a program never runs in the wrong units.
- Speeds are modal and in units per **second**: `MS,xy,z`, written only when a
  value changes and restated after a tool change. The XY speed follows the
  feed of the move being cut and the Z speed follows the plunge feed, never
  above that move's own feed; an axis a move does not travel on keeps its
  speed. Jog speeds are left to the machine's own settings.
- Rapids are jogs, split like every rapid: `JZ` first, then `J2`. Cuts are
  `M3,x,y,z`. Fitted arcs are `CG,,endX,endY,I,J,T,dir` with `dir` 1 for
  clockwise and -1 for counter-clockwise, and the centre offsets measured from
  the position actually written on the previous line, as for G2/G3.
- Spindle: `TR,rpm` then `C6` to start, and the same pair again when the
  speed changes between two operations that keep the spindle running — the
  counterpart of G-code restating `M3 S…`. `C7` to stop.
- Tool change: `&Tool=N` then `C9`, the standard ShopBot tool-change macro
  (manual or automatic). `C9` moves the machine and may set speeds, so neither
  is assumed afterwards: the next rapid states Z before it travels and the
  next fed move restates `MS`. The G-code path does not restate position after
  `M6`; changing that would change existing G-code output.
- Drilling is written as its expanded moves: there are no canned cycles.
- Coolant is not written, because output wiring differs per machine; asking
  for it raises the same warning as on a G-code machine without coolant.
- No line numbers. Lines end in CRLF, since the control software is a Windows
  program.

**Not covered.** Helical `CG`, the tab and pocket options of `CG`, A/B axes,
converting third-party ShopBot posts, and controller conformance testing
(`npm run check:gcode` has no ShopBot interpreter to run; the emitter is held
by round-trip tests through `sbpMotionParser.ts` instead).

**Sources and licensing.** ShopBot placed the part-file syntax and its
Programming Handbook in the public domain (opensbp.com). Parameter order is
checked against ShopBot's Apache-2.0 FabMo-Engine as a reference only. Autodesk's
`shopbot.cps` and FreeCAD's `opensbp_post.py` are not used. "OpenSBP" is a
ShopBot trademark: the machine is named "ShopBot (SBP)" and no compliance is
claimed. `opensbpEmitter.ts` carries the citations.

**The dialect is not editable in the machine library.** A bundled definition
carries it and a duplicate inherits it. The focused editor form has no field
for it and preserves it. For an `opensbp` machine the editor shows the name
and file extension and a note in place of the G-code command and template
fields, which that machine never reads; the fields it does read (axis mapping,
number format, arc support) are under Advanced.

**Wording follows the dialect.** Everything that names the exported format
names the one the project's machine writes: the export dialog's title and its
"emit tool changes" option ("Export ShopBot part file", "(C9)"), the exported
layer of the debug view ("Exported part file"), the per-operation export button
in the CAM panel, and the desktop app's File menu item. `exportDialectLabels.ts`
maps each dialect to its wording. The native menu is built in Rust and is not
translated, so the app shell passes it an English label through the
`set_export_menu_label` command whenever the wording changes.

**Older builds.** A build that predates the field drops it and exports through
the G-code path, under the definition's `.sbp` extension. Two things address
that. Project format 3.3 exists only so such a build shows its newer-version
warning when it opens the file; that is a warning, not a refusal. And the
bundled ShopBot definition's unused G-code words are comment-prefixed with
non-modal motion, so what the G-code path writes is a file of comments ending
in `END`, never motion. The second also covers a machine JSON imported into an
older build, which no project version can.

## Application library vs project snapshot

Machine definitions live in two clearly separated places, and export only ever
reads one of them.

**The application library** (`src/machine/`) is what the user picks from:
bundled definitions supplied directly by the current build, plus a persistent
app-local **My Machines** list of custom definitions. It is an application
preference — stored in namespaced local storage, never serialized into a
`.camj` file, never part of project undo history, and never a reason to mark a
project dirty. Bundled IDs are reserved; a custom definition that claims one is
rejected on read and re-keyed on import. Because bundled definitions come from
the build, machines added or corrected in a release appear immediately in every
project without any per-project refresh.

**The project snapshot** is the single complete definition selected for that
project. `project.meta.machineDefinitions` holds zero or one entry and
`selectedMachineId` always matches `machineDefinitions[0]?.id ?? null`
(enforced on decode and by the `setProjectMachine` store action). Selecting a
library machine copies a validated snapshot in by value.

`getActiveMachineDefinition(project)` is the export boundary and resolves
**only** the embedded snapshot. Export, preview, exported-motion inspection,
and output file extension therefore stay deterministic for whoever opens the
file: a shared project remains exportable when the recipient has never seen
that machine, and editing or removing a library entry cannot change an
existing project's G-code. No selected machine remains valid for sketching,
toolpaths, preview, and simulation; only G-code export is blocked.

### Update warning contract

On open, the embedded snapshot is compared with the library definition sharing
its ID, over validated functional fields only (the `builtin` ownership flag is
ignored). The comparison is advisory:

- **differs** — a non-blocking notice offers *Review update* (opens the machine
  manager on the comparison), *Keep project copy* (dismiss; snapshot and G-code
  unchanged), and *Update project copy* (explicitly replace the snapshot —
  dirtying and undoable). After dismissal an **Update available** badge remains
  in Project Properties and the machine manager.
- **absent from the library** — **Not in My Machines** is shown instead, the
  embedded copy stays fully usable, and the manager offers *Save to My
  Machines*.

Nothing replaces an embedded snapshot automatically.

### Legacy projects

Files that stored a whole machine library are compacted on decode: the entry
matching `selectedMachineId` is preserved verbatim as the only embedded
snapshot, unselected bundled copies are discarded (the live library supplies
them), and valid custom definitions are merged into My Machines — skipping
semantically identical entries and re-keying ID collisions. An unresolvable
selection is cleared and reported in the load warning. Compacted projects are
marked dirty; the original file is unchanged until saved. The compact
zero-or-one array is valid format 3.0 and stays readable by older builds.

## Postprocessor invariants

- Toolpath generation and G-code formatting remain separate layers.
- Modal suppression must not remove commands required after a tool, units,
  plane, coordinate, or motion-state change.
- Safe-Z, plunge, cut, lead, drilling, tool-change, and spindle sequences retain
  their semantic move type through formatting.
- Unsupported operations or cycles produce actionable warnings.
- Numeric formatting is deterministic and locale-independent.
- Exporting a subset of operations preserves the selected order and required
  setup transitions.
- The preview and saved output are generated from the same result.

## Export UI contract

The export surface must make these inputs visible before saving:

- selected machine definition;
- machine origin and project units;
- included operations and their order;
- output options that materially change setup or commands;
- warnings and validation failures;
- final G-code preview.

No-operation selection and invalid machine/setup state disable export rather
than producing an apparently valid empty or partial file.

## Arc interpolation

Export-stage arc fitting (`src/engine/gcode/arcFitting.ts`) runs between the
project→machine coordinate transform and G-code emission. It does not modify
`ToolpathResult` or affect preview/simulation.

- The core geometry fitting (`findArcRunsInPoints`) lives in
  `src/engine/toolpaths/arcReconstruction.ts` as a shared, reusable partial-run
  arc finder operating on flat `Point[]`. Export adapts its machine-coordinate
  `ToolpathPoint` data into the shared seam and converts the returned arc-run
  indices back into `ArcMoveDescriptor` segments with sub-arc splitting.
- Export owns the move-level predicates: only constant-Z `cut` runs with
  consistent feed and source participate. The shared function does not depend on
  `ToolpathMove` types or G-code concerns.
- Fitting uses a Kasa algebraic circle (linear least squares) with a
  conservative 0.01 mm (project-unit-equivalent) residual tolerance.
- A qualifying cut run may contain a circular sub-run embedded in straight
  lead-in/lead-out geometry. The shared partial-run search finds the circular
  portion; the surrounding straight moves remain as linear G1 output.
- Fitted arcs are split into ≤ 90° sub-arcs. Full circles and arcs > 90° are
  always split.
- Direction (G2/G3) is determined from the chord turns in machine coordinates
  so the Y-inversion boundary is correct.
- Output uses the machine definition's `cwArcCommand` / `ccwArcCommand` and
  `arcFormat` (`ij` or `r`). I/J are centre offsets from the arc start; R is
  the positive radius.
- When `operation.arcFittingEnabled` is `false` (default `true`), no fitting
  is attempted and output is purely linear.
- When the machine definition has `motion.arcInterpolation: false` (legacy
  default), fitting still runs to detect circular segments; if any are found,
  the original G1 moves are emitted alongside a `postArcNoCapability` warning.
- Helical/ramping moves, rapids, plunges, leads, and non-circular runs remain
  linear and never trigger the warning.

## Exported-motion debug inspection

The exported-motion debug view (issue #356, `src/components/export/ExportedMotionDebugDialog.tsx`
backed by `src/engine/gcode/gcodeMotionParser.ts` and `motionDebug.ts`) is a
diagnostic overlay that verifies the motion *written to the exported file* still
represents the intended path. The text is parsed in the definition's own output
dialect (`parseExportedMotion`): G-code through `gcodeMotionParser.ts`, a
ShopBot part file through `sbpMotionParser.ts`. Both return the same motion
shape, so everything after the parse is dialect-independent. It opens from the Export dialog when exactly one
eligible operation is selected, and overlays three planar layers in project
coordinates:

- **Generated** — the raw toolpath before adjacent-collinear cut moves are merged
  (captured at the `optimizeLinearMoves` seam in
  `src/engine/toolpaths/generateOperation.ts`
  into an ephemeral `ToolpathGenerationTrace`; never serialised into `.camj`).
- **Optimized** — the canonical toolpath after always-on line optimization,
  before export arc fitting.
- **Exported G-code** — the path reconstructed by parsing the literal emitted
  G-code text (`parseGcodeMotion`), mapped back to project space via the inverse
  `machineToProjectPoint` transform. Arc sweep direction is inverted when the
  machine's axis mapping is orientation-reversing in the plane (a mirrored `-X`
  or an X/Y swap — see `machineToProjectFlipsArcDirection`), so the layer
  renders the true machine path for mirrored-axis machines.

Invariants:

- The exported layer comes from parsing the literal G-code, not from an internal
  approximation in its place. Arcs are kept analytic in the parsed model and
  tessellate only for SVG display, so partial arcs stay visibly partial.
- The postprocessor exposes its machine-coordinate motion trace
  (`OperationMotionTrace`: transformed moves + fitted descriptors) only when
  `PostProcessorOptions.captureMotionTrace` is set — the normal export path pays
  no cost. The debug view reuses `runPostProcessor` for the single operation
  rather than reimplementing formatting.
- The diagnostic compares the parsed exported trace against the postprocessor
  trace by non-rapid segment endpoint continuity plus arc-centre/direction
  agreement at the configured 0.01 mm tolerance. It surfaces parser-unsupported,
  parser-failed, discontinuity, and tolerance-deviation warnings explicitly and
  never reports `verified` for a partial or unsupported parse.
- The exported-vs-optimized deviation check compares like with like. Linear
  moves are measured against the reference polyline directly; a fitted **arc**
  is measured against the reference **vertices** it spans, which must lie within
  tolerance of the swept arc. That is the arc-fitting contract above (a residual
  bound on the source *points*). Measuring a fitted arc against the reference
  *chords* instead would charge it the sagitta between them — the gap inherent
  to approximating a curve with line segments, which grows with radius
  (≈ 0.00095 × R at the 5° flattening used for source curves and corner
  fillets) and so exceeds the tolerance above roughly 10.5 mm radius no matter
  how well the arc was fitted. The arc is the more accurate path there: the
  machine cuts the true curve rather than the chords standing in for it.
- Both the tolerance the fitter accepts and the tolerance the diagnostic
  verifies come from `exportGeometryTolerance()` in `src/utils/units.ts`, so the
  two cannot drift apart.
- Eligibility is motion-derived, not an operation-name allow-list: a non-empty
  planar cutting trace with discrete constant-Z cutting levels. Variable-Z cuts
  (V-carve, ramping surface paths) and drilling are unavailable, with a reason —
  they are not flattened into a deceptively simple 2D result.

## Current limits and future work

- Multi-setup/fixture workflows require a separate setup model rather than
  overloading one machine origin.
- Postprocessors do not supply authoritative feeds, speeds, or machine limits.

## Verification

Changes require focused postprocessor fixtures for affected controllers and
move types, export-selection coverage, warning assertions, and `npm run build`.
Rendered export-dialog wiring should add or extend browser e2e coverage.
