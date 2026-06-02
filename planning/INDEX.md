# INDEX — planning/

Active design docs and unfinished work plans. Read the one that matches your area before starting feature work; do not load everything.

Older plans for shipped features and historical bug analyses live in [`archive/`](archive/). Do **not** read files under `archive/` unless you have a specific reason — they are kept for git history and reference, not for ongoing work.

## Workflow (see [AGENTS.md](../AGENTS.md) for the full rule)

Every task: write a plan from [`TEMPLATE.md`](TEMPLATE.md) → register it under **Pending approval** below → get explicit user approval → move to **In progress** and implement → `git mv` to `archive/` and remove the entry before opening the PR.

## Pending approval

- [IMPORTED_MODEL_OUTLINE_COLORS_Plan.md](IMPORTED_MODEL_OUTLINE_COLORS_Plan.md) — add orange outline for imported 3D models in sketch view, add missing region + imported-model entries to feature color legend
- [CHECK_FOR_UPDATES_Plan.md](CHECK_FOR_UPDATES_Plan.md) — user-initiated "Check for Updates" on desktop (native menu item + stable/snapshot channel, opens download page); web gets only a new About dialog (no update check, since web always loads fresh). Desktop native About left untouched.

## In progress

- [WATERLINE_ADAPTIVE_REFINEMENT_Plan.md](WATERLINE_ADAPTIVE_REFINEMENT_Plan.md) — improve imported-model waterline finishing by inserting bounded intermediate contour levels when adjacent bands have small Z separation but large XY drift
- [WATERLINE_CONTAINING_ADD_FIX_Plan.md](WATERLINE_CONTAINING_ADD_FIX_Plan.md) — fix waterline finish emitting no paths when containing/base add features are mistaken for intersecting walls

### Foundational / cross-cutting
- [CAM_App_Design.md](CAM_App_Design.md) — high-level CAM design (feature model, operation model, workflow). The "why" behind the data shapes.
- [REGION_FEATURE_SEMANTICS.md](REGION_FEATURE_SEMANTICS.md) — how regions filter rather than define machining targets. Read before touching operation/region logic.
- [REFACTORING_Plan.md](REFACTORING_Plan.md) — identified hot-spot files and refactoring priorities.

### Export / machine
- [G-code_Export_Design.md](G-code_Export_Design.md) — post-processor architecture and machine-definition model.
- [DESKTOP_Implementation_Plan.md](DESKTOP_Implementation_Plan.md) — Tauri desktop packaging plan (partially in progress via `src-tauri/`).

### V-carve (active area)
- [RECURSIVE_SKELETON_design.md](RECURSIVE_SKELETON_design.md) — core algorithm design for V-carve recursive.
- [VCARVE_ClipperSkeleton_Design.md](VCARVE_ClipperSkeleton_Design.md) — hybrid skeleton algorithm.
- [VCARVE_RECURSIVE_Z_CALCULATION_ANALYSIS.md](VCARVE_RECURSIVE_Z_CALCULATION_ANALYSIS.md) — comprehensive Z-calc reference for the skeleton solver.
- [SAME_CHILD_BRIDGE_Algorithm.md](SAME_CHILD_BRIDGE_Algorithm.md) — V-carve recursive split/bridge algorithm.
- [VCARVE_RECURSIVE_TESTING_SCRIPTS.md](VCARVE_RECURSIVE_TESTING_SCRIPTS.md) — testing methodology and diagnostic scripts.
- [DEBUG_MARKER_LEGEND.md](DEBUG_MARKER_LEGEND.md) — legend for V-carve diagnostic markers in the canvas.

### Simulation
- [SIMULATION_GPU_HEIGHTFIELD_Plan.md](SIMULATION_GPU_HEIGHTFIELD_Plan.md) — proposed GPU-based heightfield rendering (CPU mesh rebuild still in use today).

### Tablet / mobile UX
- [TABLET_UX_COMBINED_PLAN.md](TABLET_UX_COMBINED_PLAN.md) — primary tablet design plan; referenced from `ARCHITECTURE.md`. Read before tablet UI work.

## Adding a new plan

1. Copy [`TEMPLATE.md`](TEMPLATE.md) to `<TOPIC>_Plan.md`. Fill it in.
2. Add an entry under **Pending approval** above (one-line summary, link to the file).
3. Ask the user for approval. Do not start implementing until approved.
4. On approval: set `status: Approved`, move the index entry to **In progress**.
5. On completion: `git mv` the plan to `archive/`, set `status: Done`, remove the entry from this index — **before opening the PR**.
