# INDEX — planning/

**Durable design & reference docs.** Read the one that matches your area before starting feature work; do not load everything. These are living reference (the "why" behind the data shapes, algorithm references, area-specific design) — update them in the same commit when you change the behavior they describe.

**Tasks are not tracked here.** Active work, backlog, and tech-debt live on the [GitHub Project board](https://github.com/orgs/PureCutCNC/projects/1). To start work: open an issue, write the plan in the issue, get approval, branch, and open a PR with `Closes #NN` when done. See the workflow section in [AGENTS.md](../AGENTS.md).

Older plans for shipped features and historical bug analyses live in [`archive/`](archive/). Do **not** read files under `archive/` unless you have a specific reason — they are kept for git history and reference, not for ongoing work.

## Foundational / cross-cutting
- [INTEGRATION_HANDOFF_TEMPLATE.md](INTEGRATION_HANDOFF_TEMPLATE.md) — detailed branch-owned handoff and slice-ledger template for sequential external implementation workers.
- [ISSUE_270_INTEGRATION_HANDOFF.md](ISSUE_270_INTEGRATION_HANDOFF.md) — active integration ledger for closed-Line semantics, nesting-aware SVG/DXF import, V-carve targeting, and large-artwork performance.
- [CAM_App_Design.md](CAM_App_Design.md) — high-level CAM design (feature model, operation model, workflow). The "why" behind the data shapes.
- [REGION_FEATURE_SEMANTICS.md](REGION_FEATURE_SEMANTICS.md) — how regions filter rather than define machining targets. Read before touching operation/region logic.

## Export / machine
- [G-code_Export_Design.md](G-code_Export_Design.md) — post-processor architecture and machine-definition model.
- [DESKTOP_Implementation_Plan.md](DESKTOP_Implementation_Plan.md) — Tauri desktop packaging design (partially realized via `src-tauri/`). Remaining work is tracked on the board.

## V-carve
- [RECURSIVE_SKELETON_design.md](RECURSIVE_SKELETON_design.md) — core algorithm design for V-carve recursive.
- [VCARVE_ClipperSkeleton_Design.md](VCARVE_ClipperSkeleton_Design.md) — hybrid skeleton algorithm.
- [VCARVE_RECURSIVE_Z_CALCULATION_ANALYSIS.md](VCARVE_RECURSIVE_Z_CALCULATION_ANALYSIS.md) — comprehensive Z-calc reference for the skeleton solver.
- [SAME_CHILD_BRIDGE_Algorithm.md](SAME_CHILD_BRIDGE_Algorithm.md) — V-carve recursive split/bridge algorithm.
- [VCARVE_RECURSIVE_TESTING_SCRIPTS.md](VCARVE_RECURSIVE_TESTING_SCRIPTS.md) — testing methodology and diagnostic scripts.
- [DEBUG_MARKER_LEGEND.md](DEBUG_MARKER_LEGEND.md) — legend for V-carve diagnostic markers in the canvas.

## Simulation
- [SIMULATION_GPU_HEIGHTFIELD_Plan.md](SIMULATION_GPU_HEIGHTFIELD_Plan.md) — proposed GPU-based heightfield rendering (CPU mesh rebuild still in use today).

## Tablet / mobile UX
- [TABLET_UX_COMBINED_PLAN.md](TABLET_UX_COMBINED_PLAN.md) — primary tablet design plan; referenced from `ARCHITECTURE.md`. Read before tablet UI work.

## UI / toolbar
- [TOOLBAR_REVISIT.md](TOOLBAR_REVISIT.md) — design notes on the current (temporary) always-left toolbar and the intended structural split. Reference for the redesign tracked on the board.

## UI / icons
- [../src/assets/icons/README.md](../src/assets/icons/README.md) — how to edit icons (SVG-first source, sizing, monochrome vs colour, regenerating the sprite, cross-repo note). Read before adding/changing icons.
