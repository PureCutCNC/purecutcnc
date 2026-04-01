# G-code Export Design

> **Status:** Design spec — pre-implementation
> **Scope:** Post-processor architecture, machine definition library, origin model, export UI
> **Last updated:** 2026-03-31

---

## 1. Overview

G-code export translates the internal toolpath language (`ToolpathMove[]`) into
machine-specific G-code by applying a **machine definition** — a declarative
JSON description of how a particular controller works.

The system has two distinct layers:

```
ToolpathResult[]  +  Project  +  MachineDefinition
        │
        ▼
  PostProcessor  (TypeScript engine — generic, no machine knowledge)
        │
        ▼
   G-code string  (.nc / .gcode / .tap / ...)
```

**Layer 1 — Machine Definition (JSON):** declarative, serialisable, shippable
as a bundled library, user-editable. Describes *what* to emit for each
situation.

**Layer 2 — Post-Processor Engine (TypeScript):** generic, reads any valid
definition, drives the output. Contains no machine-specific knowledge.

---

## 2. Machine Origin

### 2.1 Concept

The origin defines the **relationship between project coordinates and machine
coordinates**. Every coordinate in the generated G-code is expressed relative
to this point.

Important distinction:
- **Project coordinates** are internal application coordinates used for sketch
  editing, rendering, and geometric computation.
- **Machine coordinates** are the user-facing coordinates implied by the chosen
  work zero.

The user should think of origin as **"where machine X0 Y0 Z0 is"**, not as a
raw set of internal project-space numbers. The internal coordinate system is an
implementation detail and should stay hidden anywhere we can avoid exposing it.

Origin is a **first-class object in the project tree**, alongside Grid and
Stock:

```
Project
├── Grid
├── Stock
├── Origin          ← project-level setup object
├── Features
│   └── ...
├── Tabs
├── Clamps
└── Operations
```

### 2.2 Schema

```typescript
interface MachineOrigin {
  // Stored in internal project coordinates.
  // These values are persistence details, not user-facing machine coordinates.
  x: number
  y: number
  z: number

  // Human label shown in the tree and G-code header comment.
  name: string

  // Visual display in sketch and 3D view.
  visible: boolean
}
```

WCS slot selection (`G54`, `G55`, etc.) is **not** part of the origin — it
belongs in the machine definition (see §3.6). The origin is purely a
point in project space that defines machine zero after export-time conversion.

### 2.3 Coordinate Transform

Every toolpath point is transformed before formatting:

```
machine_X = project_X - origin.x
machine_Y = origin.y - project_Y
machine_Z = project_Z - origin.z
```

`X` and `Z` use direct origin-relative subtraction.

`Y` is inverted during export because CAMCAM's internal 2D project space uses a
screen-friendly downward-increasing Y axis, while machine coordinates are
user-facing setup coordinates that increase upward from the selected origin.

The post-processor applies this project-space → machine-space conversion to
every `ToolpathMove` before emitting numbers. The axis remapping defined in the
machine definition (§3.3) is applied after this conversion.

### 2.4 Default Origin

```typescript
function defaultOrigin(stock: Stock): MachineOrigin {
  const bounds = getStockBounds(stock)
  return {
    name: 'Origin',
    x: bounds.minX,
    y: bounds.maxY,
    z: stock.thickness,   // top surface, bottom-left machine corner
    visible: true,
  }
}
```

### 2.5 Quick-Set Presets

The properties panel provides one-click presets for the three most common
reference points. These are **bounding-box-based setup shortcuts** for the
current stock profile, not statements about the app's internal coordinate
origin:

| Preset | x | y | z | Typical use |
|---|---|---|---|---|
| Stock top-left | minX | minY | thickness | Common top-of-stock setup |
| Stock center top | centerX | centerY | thickness | Symmetric parts |
| Stock bottom-left | minX | maxY | 0 | Referencing off spoilboard |

As stock becomes fully arbitrary-profile rather than just rectangular, these
remain convenience presets derived from the stock bounds. They are not the only
valid origin locations.

### 2.6 Visual Representation

In sketch view and 3D view the origin renders as a small **axis triad** —
X (red), Y (green), Z (blue) arrows — at the defined position. This gives
immediate feedback about where the machine will consider (0, 0, 0) to be.

Primary origin interaction should be visual placement on the sketch
(`Move/Place Origin` → click location), not manual entry of raw internal
coordinates. Numeric fields can exist as an advanced fallback, but should not
be the main setup workflow.

### 2.7 Project File

The origin is stored in the `.camj` file at the project root:

```json
{
  "origin": {
    "name": "Origin",
    "x": 0,
    "y": 0,
    "z": 20,
    "visible": true
  }
}
```

Existing files without an `origin` field receive the default on load (same
pattern as `grid` and other fields added post-v1).

The stored `origin.x/y/z` values are internal project-space persistence data.
They should not be shown in export UI as if they were already machine-space
coordinates.

### 2.8 Multi-Setup (Future)

v1 supports one origin only. When multi-setup support is added, `origin`
becomes `origins: MachineOrigin[]` with an index identifying the active setup.
This is a non-breaking extension.

---

## 3. Machine Definition

### 3.1 Purpose

A machine definition is a JSON document that fully describes how a specific
CNC controller dialect works. Adding a new machine requires only adding a JSON
file — no engine code changes.

### 3.2 Full Schema

```typescript
interface MachineDefinition {
  // ── Identity ────────────────────────────────────────────
  id: string           // "grbl", "linuxcnc", "mach3", "smoothieware"
  name: string         // "GRBL 1.1"
  description: string
  vendor?: string
  fileExtension: string  // "nc", "gcode", "tap"

  // ── Coordinate system ────────────────────────────────────
  // Maps already-converted machine-space axes to controller output words.
  // This exists for real machine/controller differences only.
  // It must not encode CAMCAM's internal project-space quirks.
  coordinateSystem: {
    xAxis: 'X' | 'Y' | 'Z' | '-X' | '-Y' | '-Z'
    yAxis: 'X' | 'Y' | 'Z' | '-X' | '-Y' | '-Z'
    zAxis: 'X' | 'Y' | 'Z' | '-X' | '-Y' | '-Z'
  }

  // ── Number formatting ─────────────────────────────────────
  numberFormat: {
    decimalPlaces: number      // 3 for mm, 4 for inch
    trailingZeros: boolean     // true = "1.000", false = "1"
    leadingZero: boolean       // true = "0.5", false = ".5"
  }

  // ── Units ─────────────────────────────────────────────────
  units: {
    mmCommand: string | null   // "G21" — null = no units command
    inchCommand: string | null // "G20"
  }

  // ── Program structure ──────────────────────────────────────
  program: {
    // Lines emitted before any motion.
    // Template variables: {programName} {date} {units} {unitsCommand} {wcsCommand}
    header: string[]
    // Lines emitted after all motion.
    footer: string[]
    // Comment syntax.
    commentPrefix: string    // ";" for GRBL, "(" for Mach3
    commentSuffix: string    // "" for ;-style, ")" for ()-style
    // Line numbers (N10, N20...).
    lineNumbers: boolean
    lineNumberIncrement: number  // 10 is conventional
  }

  // ── Work coordinate system ─────────────────────────────────
  // The WCS command to select before motion begins.
  // null = omit (GRBL default, simple setups).
  workCoordinates: {
    selectCommand: string | null   // "G54", "G55", etc.
  }

  // ── Motion commands ────────────────────────────────────────
  motion: {
    rapidCommand: string    // "G0"
    linearCommand: string   // "G1"
    cwArcCommand: string    // "G2"
    ccwArcCommand: string   // "G3"
    // How arcs are specified: I/J centre offsets or R radius.
    arcFormat: 'ij' | 'r'
    // Modal: only emit motion command when it changes.
    // Non-modal: repeat on every line.
    modalMotion: boolean
  }

  // ── Feed and speed ─────────────────────────────────────────
  feedSpeed: {
    feedCommand: string         // "F"
    rpmCommand: string          // "S"
    spindleOnCW: string         // "M3"
    spindleOnCCW: string        // "M4"
    spindleOff: string          // "M5"
    // Emit F and S on the same line as the motion command.
    inlineWithMotion: boolean
    // Modal: only re-emit F/S when value changes.
    modalFeedSpeed: boolean
  }

  // ── Tool change ────────────────────────────────────────────
  // Template variables in commands: {toolNumber} {toolName}
  toolChange: {
    commands: string[]
    stopSpindleFirst: boolean
    pauseAfterChange: boolean
    pauseCommand: string        // "M0" = mandatory pause, "M1" = optional stop
  }

  // ── Canned drill cycles (optional) ────────────────────────
  // If null, drill cycles are expanded as explicit plunge/retract moves.
  cannedCycles: {
    drillCommand: string | null          // "G81"
    drillWithDwellCommand: string | null // "G82"
    peckDrillCommand: string | null      // "G83"
    peckStepWord: string                 // "Q" (peck depth word)
    retractMode: 'G98' | 'G99' | null   // initial/R-plane retract
  } | null

  // ── Coolant (optional) ─────────────────────────────────────
  coolant: {
    floodOnCommand: string      // "M8"
    mistOnCommand: string       // "M7"
    coolantOffCommand: string   // "M9"
  } | null

  // ── Program end ────────────────────────────────────────────
  stop: {
    programEndCommand: string   // "M30", "M2", "%"
  }
}
```

### 3.3 Coordinate System Mapping

The post-processor first converts internal project coordinates into canonical
machine-space coordinates using the selected origin:

```
// Canonical machine-space point after origin conversion:
//   dx = project.x - origin.x
//   dy = origin.y - project.y
//   dz = project.z - origin.z
```

The `coordinateSystem` field then maps those machine-space axes to controller
output word letters:

```
// Controller output (example: standard XYZ machine):
//   X word = dx   (xAxis = 'X')
//   Y word = dy   (yAxis = 'Y')
//   Z word = dz   (zAxis = 'Z')

// Controller output (example: Y/Z swapped router):
//   X word = dx   (xAxis = 'X')
//   Y word = dz   (yAxis = 'Z')   ← project Z becomes machine Y
//   Z word = dy   (zAxis = 'Y')   ← project Y becomes machine Z
```

Negative axis values negate the coordinate:

```
// xAxis = '-X' → machine X = -dx
```

---

## 4. Bundled Definition Library

Definitions ship as JSON files alongside the engine:

```
src/engine/gcode/
  definitions/
    grbl.json           GRBL 1.1 (most common hobby controller)
    linuxcnc.json       LinuxCNC / EMC2
    mach3.json          Mach3
    mach4.json          Mach4
    smoothieware.json   Smoothieware
    tormach.json        Tormach PathPilot (LinuxCNC-based)
    reprap.json         Marlin / RepRap (CNC routers running Marlin)
    index.ts            exports all definitions as a typed array
  postprocessor.ts      the engine
  types.ts              MachineDefinition and related types
  index.ts              public surface
```

### 4.1 Example: GRBL 1.1

```json
{
  "id": "grbl",
  "name": "GRBL 1.1",
  "description": "GRBL 1.1 — common hobby CNC controller (Arduino-based)",
  "fileExtension": "nc",
  "coordinateSystem": {
    "xAxis": "X",
    "yAxis": "Y",
    "zAxis": "Z"
  },
  "numberFormat": {
    "decimalPlaces": 3,
    "trailingZeros": false,
    "leadingZero": true
  },
  "units": {
    "mmCommand": "G21",
    "inchCommand": "G20"
  },
  "program": {
    "header": [
      "; {programName}",
      "; Generated by CAMCAM on {date}",
      "G90",
      "G17",
      "{unitsCommand}"
    ],
    "footer": [],
    "commentPrefix": ";",
    "commentSuffix": "",
    "lineNumbers": false,
    "lineNumberIncrement": 10
  },
  "workCoordinates": {
    "selectCommand": null
  },
  "motion": {
    "rapidCommand": "G0",
    "linearCommand": "G1",
    "cwArcCommand": "G2",
    "ccwArcCommand": "G3",
    "arcFormat": "ij",
    "modalMotion": true
  },
  "feedSpeed": {
    "feedCommand": "F",
    "rpmCommand": "S",
    "spindleOnCW": "M3",
    "spindleOnCCW": "M4",
    "spindleOff": "M5",
    "inlineWithMotion": true,
    "modalFeedSpeed": true
  },
  "toolChange": {
    "commands": ["M5", "M0 ; Tool change: {toolName}"],
    "stopSpindleFirst": true,
    "pauseAfterChange": true,
    "pauseCommand": "M0"
  },
  "cannedCycles": null,
  "coolant": null,
  "stop": {
    "programEndCommand": "M30"
  }
}
```

### 4.2 Example: Mach3

```json
{
  "id": "mach3",
  "name": "Mach3",
  "description": "Mach3 — Windows-based CNC controller",
  "fileExtension": "tap",
  "coordinateSystem": {
    "xAxis": "X",
    "yAxis": "Y",
    "zAxis": "Z"
  },
  "numberFormat": {
    "decimalPlaces": 4,
    "trailingZeros": true,
    "leadingZero": true
  },
  "units": {
    "mmCommand": "G21",
    "inchCommand": "G20"
  },
  "program": {
    "header": [
      "%",
      "O0001 ({programName})",
      "G90 G94 G17 G40 G49 G80",
      "{unitsCommand}",
      "{wcsCommand}"
    ],
    "footer": [],
    "commentPrefix": "(",
    "commentSuffix": ")",
    "lineNumbers": true,
    "lineNumberIncrement": 10
  },
  "workCoordinates": {
    "selectCommand": "G54"
  },
  "motion": {
    "rapidCommand": "G0",
    "linearCommand": "G1",
    "cwArcCommand": "G2",
    "ccwArcCommand": "G3",
    "arcFormat": "ij",
    "modalMotion": true
  },
  "feedSpeed": {
    "feedCommand": "F",
    "rpmCommand": "S",
    "spindleOnCW": "M3",
    "spindleOnCCW": "M4",
    "spindleOff": "M5",
    "inlineWithMotion": true,
    "modalFeedSpeed": true
  },
  "toolChange": {
    "commands": ["M5", "M6 T{toolNumber}", "G43 H{toolNumber}"],
    "stopSpindleFirst": true,
    "pauseAfterChange": false,
    "pauseCommand": "M1"
  },
  "cannedCycles": {
    "drillCommand": "G81",
    "drillWithDwellCommand": "G82",
    "peckDrillCommand": "G83",
    "peckStepWord": "Q",
    "retractMode": "G98"
  },
  "coolant": {
    "floodOnCommand": "M8",
    "mistOnCommand": "M7",
    "coolantOffCommand": "M9"
  },
  "stop": {
    "programEndCommand": "M30"
  }
}
```

### 4.3 Custom Definitions

Users can load a custom definition JSON from disk following the same schema.
This is the escape hatch for machines not in the bundled library (Centroid,
Fanuc, Haas, proprietary dialects).

Custom definitions are stored in the project file under
`meta.customMachineDefinition`. The bundled library definition is referenced
only by ID.

---

## 5. Post-Processor Engine

### 5.1 Public API

```typescript
interface PostProcessorInput {
  project: Project
  // Ordered list of operations to emit, in execution order.
  // Caller is responsible for ordering and filtering (enabled/disabled).
  operations: Array<{
    operation: Operation
    tool: NormalizedTool
    toolpath: ToolpathResult
  }>
  definition: MachineDefinition
  options: PostProcessorOptions
}

interface PostProcessorOptions {
  emitToolChanges: boolean   // emit tool change commands between operations
  emitCoolant: boolean       // emit coolant commands if definition supports them
  programName?: string       // overrides project.meta.name in header
}

interface PostProcessorResult {
  gcode: string
  warnings: string[]
  stats: {
    lineCount: number
    operationCount: number
    moveCount: number
  }
}

function runPostProcessor(input: PostProcessorInput): PostProcessorResult
```

### 5.2 Modal State

The engine tracks modal state to avoid emitting redundant words:

```typescript
interface ModalState {
  motionCommand: string | null   // last G0/G1/G2/G3
  feedRate: number | null
  spindleSpeed: number | null
  spindleOn: boolean
  coolantOn: boolean
  currentToolId: string | null
  lineNumber: number
}
```

Modal emission only applies when `definition.motion.modalMotion = true` and
`definition.feedSpeed.modalFeedSpeed = true` respectively.

### 5.3 Execution Order

For each call to `runPostProcessor`:

```
1. Emit header lines (with template substitution)
2. Emit units command (G20/G21)
3. Emit WCS command if definition.workCoordinates.selectCommand is set
4. For each operation in order:
   a. Emit operation comment (operation name)
   b. If tool changed and emitToolChanges:
      - emit spindle off if stopSpindleFirst
      - emit toolChange.commands (with {toolNumber}/{toolName})
      - emit pause if pauseAfterChange
   c. Emit spindle on + RPM (M3 S{rpm})
   d. For each move in toolpath.moves:
      - convert from internal project coordinates into machine-space coordinates
      - apply axis remap
      - format as G-code line (see §5.4)
   e. Emit spindle off after last move of operation
5. Emit footer lines
6. Emit programEndCommand
```

### 5.4 Move Formatting

```
rapid    → G0 Xx.xxx Yy.xxx Zz.xxx
plunge   → G1 Zz.xxx F{plungeFeed}
cut      → G1 Xx.xxx Yy.xxx Zz.xxx F{feed}
lead_in  → G1 Xx.xxx Yy.xxx Zz.xxx F{feed}   (material-contacting)
lead_out → G1 Xx.xxx Yy.xxx Zz.xxx F{feed}
```

When `modalMotion = true`, the motion word (G0/G1/G2/G3) is omitted if it
matches the last emitted motion word.

When `inlineWithMotion = true`, F and S are placed on the same line as the
first move where they apply. When false, they are emitted as separate lines
before the motion.

### 5.5 Arc Moves (Future)

Currently all toolpath curves are pre-flattened to linear segments. When arc
support is added to `ToolpathMove`, the engine handles both without definition
changes:

```typescript
// Extended move type (future):
interface ToolpathMove {
  kind: ToolpathMoveKind
  from: ToolpathPoint
  to: ToolpathPoint
  arc?: {
    center: ToolpathPoint   // absolute centre point
    clockwise: boolean
  }
}
```

Arc moves emit G2/G3 with I/J offsets (centre relative to `from`) or R
(radius), depending on `definition.motion.arcFormat`.

### 5.6 Template Variables

Header and tool change command strings support the following substitutions:

| Variable | Value |
|---|---|
| `{programName}` | `options.programName ?? project.meta.name` |
| `{date}` | ISO 8601 date at export time |
| `{units}` | `"mm"` or `"inch"` |
| `{unitsCommand}` | `G21` or `G20` per definition |
| `{wcsCommand}` | value of `definition.workCoordinates.selectCommand` or `""` |
| `{toolNumber}` | 1-based index of current tool in project tool list |
| `{toolName}` | `tool.name` |

### 5.7 Warnings

The engine produces warnings (non-fatal) for:

- Operation has no tool assigned
- Tool type not supported for a specific operation kind
- `emitCoolant = true` but definition has `coolant: null`
- `emitToolChanges = true` but two sequential operations share the same tool
  (tool change emitted anyway — caller may want to suppress)
- Definition requests WCS command but `definition.workCoordinates.selectCommand`
  is null (no-op, warn user)

---

## 6. Project Schema Changes

### 6.1 New Fields

```typescript
// In Project:
interface Project {
  // ... existing fields ...
  origin: MachineOrigin           // new — machine coordinate origin
}

// In ProjectMeta:
interface ProjectMeta {
  // ... existing fields ...
  machineId: string | null                       // "grbl", "mach3", etc.
  customMachineDefinition: MachineDefinition | null  // user-provided definition
}
```

### 6.2 Load-Time Defaults

Files without `origin` receive `defaultOrigin(project.stock)` on load.
Files without `meta.machineId` receive `null` (user selects before export).

---

## 7. Export UI

### 7.1 Export Dialog Flow

The export dialog opens from a toolbar button or menu. It does not live as a
persistent panel — it is modal, opened on demand.

```
┌─────────────────────────────────────────────────────┐
│  Export G-code                                 [✕]  │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Machine:  [GRBL 1.1                          ▼]   │
│            [Load custom definition...]              │
│                                                     │
│  Origin:   Using current CAM origin as X0 Y0 Z0    │
│            (place/edit in sketch or project tree)  │
│                                                     │
│  Units:    Inch                                     │
│                                                     │
│  Operations set:                                    │
│  Using visible + enabled operations                │
│  (managed from the Operations panel)               │
│                                                     │
│  Options:                                           │
│  ☑ Emit tool change commands                        │
│  ☐ Emit coolant commands                            │
│                                                     │
│  Warnings:                                          │
│  ⚠ Operation 2 has no tool assigned               │
│                                                     │
├─────────────────────────────────────────────────────┤
│  Preview (first 20 lines):                          │
│  ; My Part                                          │
│  ; Generated by CAMCAM on 2026-03-31               │
│  G90                                                │
│  G17                                                │
│  G21                                               │
│  M3 S18000                                          │
│  G0 Z5.000                                          │
│  G0 X10.000 Y15.000                                 │
│  G1 Z-3.000 F400                                    │
│  G1 X12.500 Y15.000 F800                            │
│  ...                                                │
├─────────────────────────────────────────────────────┤
│                    [Cancel]  [Download .nc]         │
└─────────────────────────────────────────────────────┘
```

### 7.2 Machine Picker

The machine picker lists bundled definitions by name. It remembers the last
used machine per project (`meta.machineId`). The "Load custom definition..."
option opens a file picker for a `.json` file.

### 7.3 Operations Set

For v1, export uses the same active operation set as simulation:
- operation must be `enabled`
- operation must have `showToolpath = true`

This keeps preview, simulation, and export aligned around one shared
operation-selection model.

Notes:
- `enabled` means the operation participates in machining at all
- `showToolpath` means it is part of the active preview/export/simulation set
- no separate export checklist is needed in the first pass

### 7.4 Preview

The preview regenerates as options change (debounced 300ms). It shows the
first 20–30 lines of the output. A "Copy all" button copies the full G-code to
the clipboard without downloading.

The dialog should describe origin in setup terms ("current CAM origin is used
as machine zero") rather than exposing raw internal origin coordinates.

---

## 8. File Location

```
src/engine/gcode/
  definitions/
    grbl.json
    linuxcnc.json
    mach3.json
    mach4.json
    smoothieware.json
    tormach.json
    reprap.json
    index.ts            re-exports all definitions as MachineDefinition[]
  types.ts              MachineDefinition, MachineOrigin, PostProcessor* types
  postprocessor.ts      runPostProcessor()
  index.ts              public surface

src/components/export/
  ExportDialog.tsx      export UI component
```

---

## 9. Implementation Phases

### G1 — Schema and origin
- Add `MachineOrigin` to project schema
- Add `defaultOrigin()` helper
- Show origin in project tree (read-only first)
- Apply origin offset in post-processor input preparation

### G2 — Machine definition types and bundled library
- Define `MachineDefinition` TypeScript interface
- Author GRBL, LinuxCNC, Mach3, Mach4 definitions
- Export `BUNDLED_DEFINITIONS` array from `index.ts`
- Validate definitions against schema at load time

### G3 — Post-processor engine
- Implement `runPostProcessor()`
- Modal state tracking
- Template variable substitution
- Move formatting (rapid, plunge, cut, lead_in, lead_out)
- Tool change sequencing
- Warning collection

### G4 — Export dialog
- Machine picker (bundled + custom JSON load)
- Operations checklist
- Options (tool changes, coolant)
- Live G-code preview with debounce
- Download button

### G5 — Origin editing
- Full origin properties panel (X, Y, Z, name, visible)
- Quick-set presets (stock top-left, stock center top, stock bottom-left)
- Axis triad visual in sketch and 3D view
- Sketch placement interaction so the user can place origin directly on the canvas

### G6 — Arc support (when toolpath engine produces arcs)
- Extend `ToolpathMove` with optional `arc` field
- Handle G2/G3 in post-processor with I/J and R modes

---

## 10. Out of Scope (v1)

- Multiple origins / multi-setup WCS
- Canned drill cycles (expanded to explicit moves instead)
- Toolpath gouge detection / safe-zone validation
- Machine limits / travel range checking
- Feed rate optimisation
- DXF/SVG toolpath export (G-code only)
- Direct machine connection / streaming

---

## 11. Tracking Checklist

Legend:
- `[ ]` not started
- `[~]` in progress / partial
- `[x]` complete
- `[>]` deferred / moved to backlog

### G1. Schema and origin
- `[x]` add `MachineOrigin` to project schema
- `[x]` add `defaultOrigin()` helper
- `[x]` show origin in project tree
- `[x]` apply origin offset in post-processor input preparation

### G2. Machine definition types and bundled library
- `[x]` define `MachineDefinition` TypeScript interface
- `[x]` author bundled GRBL definition
- `[x]` author bundled Mach3 definition
- `[x]` add validation for machine definitions at load/import time
- `[x]` export bundled definitions from the G-code engine surface

### G3. Post-processor engine
- `[x]` implement `runPostProcessor()`
- `[x]` modal state tracking
- `[x]` template variable substitution
- `[x]` linear move formatting (`rapid`, `plunge`, `cut`, `lead_in`, `lead_out`)
- `[x]` tool change sequencing
- `[x]` warning collection

### G4. Export dialog
- `[x]` machine picker (bundled + custom JSON load)
- `[x]` origin summary display
- `[x]` options (`emitToolChanges`, optional coolant support if retained)
- `[x]` live G-code preview with debounce
- `[x]` download output

### G5. Origin editing and visualization
- `[x]` full origin properties panel
- `[x]` quick-set presets
- `[x]` axis triad in sketch view
- `[x]` axis triad in 3D view

### G6. Arc support (future)
- `[>]` extend `ToolpathMove` with optional arc payload
- `[>]` emit `G2/G3` with `I/J` or `R`

### G7. Deferred / backlog items
- `[>]` axis remapping beyond standard XYZ
- `[>]` canned drill cycles
- `[>]` multiple origins / multi-setup WCS
- `[>]` machine travel / limit validation
- `[>]` direct machine connection / streaming
