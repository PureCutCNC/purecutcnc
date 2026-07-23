---
status: current
authoritative-for: machine origin, machine definitions, postprocessing, and G-code export
last-verified: 2026-07-23
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

- Only constant-Z `cut` runs with consistent feed and source participate.
- Fitting uses a Kasa algebraic circle (linear least squares) with a
  conservative 0.01 mm (project-unit-equivalent) residual tolerance.
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

## Current limits and future work

- Multi-setup/fixture workflows require a separate setup model rather than
  overloading one machine origin.
- Postprocessors do not supply authoritative feeds, speeds, or machine limits.

## Verification

Changes require focused postprocessor fixtures for affected controllers and
move types, export-selection coverage, warning assertions, and `npm run build`.
Rendered export-dialog wiring should add or extend browser e2e coverage.
