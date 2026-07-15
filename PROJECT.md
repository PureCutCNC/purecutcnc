# PureCutCNC — Product Contract

## Purpose

PureCutCNC is a browser-first, Tauri-wrapped CAD/CAM workspace for 3-axis CNC
hobbyists, makers, and small shops. It combines sketching, machining intent,
toolpath planning, preview, simulation, and export in one project rather than
forcing users to move between separate CAD and CAM applications.

The central product idea is simple: sketch features carry geometric and
volumetric intent, while CAM operations describe how selected geometry should
be machined. Users should be able to move from an idea to inspectable machine
output without adopting the full complexity of an industrial 3D CAD suite.

## Primary users and jobs

PureCutCNC is designed for people who need to:

- draw or import 2D geometry for a CNC part;
- organize reusable and linked feature geometry;
- define stock, tools, origins, clamps, tabs, and machining operations;
- machine 2.5D features and imported mesh surfaces;
- inspect toolpaths in 2D, 3D, and simulation before export;
- save a self-contained `.camj` project and produce controller-specific G-code.

## Product principles

1. **Sketch and CAM stay connected.** Geometry, feature role, depth, and CAM
   targeting form one understandable workflow.
2. **The project is the source of truth.** Persistent edits flow through the
   project store, participate in history, and serialize through the current
   `.camj` format.
3. **Geometry has explicit roles.** Machinable features, regions, construction
   geometry, open lines, and imported models are not interchangeable.
4. **Machine output must be inspectable.** Toolpaths, warnings, origin
   transforms, and operation selection remain visible before export.
5. **Precision is cross-device.** Desktop, mouse, touch, and pen workflows may
   expose different controls, but they preserve the same project semantics.
6. **Compatibility changes are deliberate.** Schema migrations, units,
   coordinates, and postprocessor behavior are explicit contracts with tests.
7. **Advanced behavior stays explainable.** Prefer focused modules, visible
   workflow state, and durable design references over hidden conventions.

## Supported product surfaces

- **Web:** the primary application architecture and browser fallback for file
  workflows.
- **Desktop:** a Tauri shell provides native file and application integration
  while reusing the same React application and project model.
- **Tablet:** iPad-class landscape tablets are a supported interaction target;
  primary actions must not depend only on hover, right-click, or a keyboard.
- **Compact tablets:** supported by the shell architecture, with additional
  device-specific polish still evolving.
- **Phones:** phone-sized touch devices are intentionally blocked; PureCutCNC is
  not currently a phone CAD/CAM experience.

The application is under active development. A capability documented in a
design reference is not necessarily shipped; current UI and tests determine
implemented behavior.

## Product boundaries

PureCutCNC is not currently:

- a general-purpose solid or direct 3D modeler;
- a lathe, multi-axis, or production-shop scheduling system;
- a cloud collaboration or project-sync service;
- an automatic source of safe feeds, speeds, tooling, or machine setup;
- an in-product AI/MCP agent surface. AI agents are development tools today.

Imported meshes may drive supported surface roughing and finishing operations,
but mesh editing remains outside the core product model.

## CNC safety contract

Preview and simulation are verification aids, not guarantees that a job is safe
to run. The operator remains responsible for the machine, workholding, stock,
tooling, controller setup, and physical test procedure.

Changes touching machine output must preserve these engineering rules:

- never invent feeds, spindle speeds, tool limits, or controller capabilities;
- keep project units and conversions explicit;
- preserve the Y-down project-space to Y-up machine-space boundary;
- treat machine origin and postprocessor selection as safety-sensitive inputs;
- do not suppress export warnings merely to make output appear valid;
- verify operation selection, safe-Z behavior, tool changes, and coordinate
  transforms with focused tests;
- make schema and compatibility consequences visible before destructive saves.

## Canonical terminology

- **Project:** persistent `.camj` document containing stock, definitions,
  instances, tools, operations, machine setup, and related assets.
- **Feature definition:** canonical untransformed geometry and shared feature
  properties.
- **Feature instance:** a placed tree row that references a definition and owns
  per-instance placement and display state.
- **Resolved feature:** derived world-space geometry used by editing, rendering,
  CAM, and export reads.
- **Machinable feature:** geometry that may contribute material or become a CAM
  target.
- **Region:** a machining-area filter; not material and not a cut target by
  itself.
- **Construction geometry:** sketch-only reference geometry excluded from CSG,
  CAM targets, simulation, and export.
- **Operation:** a machining strategy applied to one or more valid targets.
- **Machine origin:** the explicit transform between project coordinates and
  machine coordinates.

## Documentation authority

| Document | Authority |
| --- | --- |
| `PROJECT.md` | Stable product purpose, principles, scope, safety, and terminology |
| `README.md` | Public capability overview and setup |
| `AGENTS.md` | Assigned-work workflow, coding rules, task routing, and verification |
| `ARCHITECTURE.md` | Current technical architecture, data model, and cross-cutting invariants |
| `INDEX.md` and area indexes | Progressive repository navigation |
| `planning/*.md` | Current durable area-specific design references |
| GitHub issue | Approved plan and acceptance criteria for one task |
| `planning/archive/` | Historical context only; never current authority |

When documents disagree, use the source whose stated authority covers the
question. Implementation and tests determine current behavior; update the
owning document in the same change when a contract intentionally changes.
