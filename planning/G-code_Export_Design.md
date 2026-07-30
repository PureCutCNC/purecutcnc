---
status: current
authoritative-for: machine origin, machine definitions, postprocessing, and G-code export
last-verified: 2026-07-30
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
diagnostic overlay that verifies the motion *written to the `.nc` file* still
represents the intended path. It opens from the Export dialog when exactly one
eligible operation is selected, and overlays three planar layers in project
coordinates:

- **Generated** — the raw toolpath before adjacent-collinear cut moves are merged
  (captured at the `optimizeLinearMoves` seam in `src/app/useToolpathGeneration.ts`
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
