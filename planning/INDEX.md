# INDEX — planning/

Active design docs and unfinished work plans. Read the one that matches your area before starting feature work; do not load everything.

Older plans for shipped features and historical bug analyses live in [`archive/`](archive/). Do **not** read files under `archive/` unless you have a specific reason — they are kept for git history and reference, not for ongoing work.

## Workflow (see [AGENTS.md](../AGENTS.md) for the full rule)

Every task: write a plan from [`TEMPLATE.md`](TEMPLATE.md) → register it under **Pending approval** below → get explicit user approval → move to **In progress** and implement → `git mv` to `archive/` and remove the entry before opening the PR.

## Pending approval

## Backlog / tech debt

- [LINT_HOOK_TYPING_DEBT_Plan.md](LINT_HOOK_TYPING_DEBT_Plan.md) — **approved design, not yet implemented** — batching of the remaining hook/ref/setState-in-effect debt and production `any` boundaries (shared hooks + typed Clipper/font/segment wrappers)

- [TOOLBAR_REVISIT.md](TOOLBAR_REVISIT.md) — ⚠️ the current always-left toolbar (scroll + portaled popovers) is a **temporary stabilisation**, not the final design; needs a proper UX pass + the `Toolbar.tsx` structural split

## In progress

- [LINT_BATCH_B_EVENT_REF_HYGIENE_Plan.md](LINT_BATCH_B_EVENT_REF_HYGIENE_Plan.md) — Batch B of the typing-debt design: replace render-time callback-ref writes (`useAxisLock`, `FeatureTree`) and state-in-deps listener effects (`SketchCanvas` pointermove/wheel) with shared `useStableEvent` / `useWindowEvent` / `useEventListener` hooks under new `src/hooks/`. Behavior-preserving, no suppressions.

- [LINT_BATCH_A_TYPED_BOUNDARIES_Plan.md](LINT_BATCH_A_TYPED_BOUNDARIES_Plan.md) — Batch A of the typing-debt design: kill production `any` at the segment-endpoint, Clipper open-path, and font-parse boundaries via small typed wrappers (`segmentEndPoint` in `project.ts`, new `clipperOpenPaths.ts`, new `text/fontData.ts`). Behavior-free; unit-tested.

- [FEATURE_CREATION_PICKER_POC_Plan.md](FEATURE_CREATION_PICKER_POC_Plan.md) — compact feature creation picker POC with drawer selection plus a last-used repeat button in the left rail

- [MEASURE_DIMENSIONS_Plan.md](MEASURE_DIMENSIONS_Plan.md) — tape-measure tool (transient distance readout) + permanent CAD dimensions (aligned/horizontal/vertical/radius/diameter/angle) anchored to geometry so they auto-update when features move/change

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
