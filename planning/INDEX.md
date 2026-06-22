# INDEX — planning/

Active design docs and unfinished work plans. Read the one that matches your area before starting feature work; do not load everything.

Older plans for shipped features and historical bug analyses live in [`archive/`](archive/). Do **not** read files under `archive/` unless you have a specific reason — they are kept for git history and reference, not for ongoing work.

## Workflow (see [AGENTS.md](../AGENTS.md) for the full rule)

Every task: write a plan from [`TEMPLATE.md`](TEMPLATE.md) → register it under **Pending approval** below → get explicit user approval → move to **In progress** and implement → `git mv` to `archive/` and remove the entry before opening the PR.

## Pending approval

- [POCKET_OFFSET_ENTRY_FEED_REDUCTION_Plan.md](POCKET_OFFSET_ENTRY_FEED_REDUCTION_Plan.md) — follow-up plan for optionally cutting the first innermost offset loop at reduced feed before restoring normal pocket feed

## Backlog / tech debt

- [TOOLBAR_REVISIT.md](TOOLBAR_REVISIT.md) — ⚠️ the current always-left toolbar (scroll + portaled popovers) is a **temporary stabilisation**, not the final design; needs a proper UX pass + the `Toolbar.tsx` structural split
- **Stock-target operations not implemented** — the `Operation` model accepts `target.source === 'stock'`, but no toolpath resolver supports it (`resolvePocketRegions` and the edge/drilling/surface resolvers require `source === 'features'` and skip stock targets). Model-vs-implementation gap; pre-existing (unrelated to feature-references). Surfaced + documented by the Phase-3 regression audit — see the NOTE in `src/engine/toolpaths/camOperationSmoke.test.ts` (~line 553).
- **Canned drilling cycles (G81/G82/G83/G73) not emitted** — `MachineDefinition.cannedCycles` schema exists but `runPostProcessor` never emits canned cycles; all drill moves post as expanded G0/G1 (drill-type differentiation lives only at toolpath generation). Drilling works, just without canned-cycle G-code. Pre-existing; documented by the Phase-3 audit — see the NOTE in `src/engine/toolpaths/camOperationSmoke.test.ts` (~line 454).

## In progress

- [DEEPSEEK_CLAUDE_INTEGRATION_MANAGER_Plan.md](DEEPSEEK_CLAUDE_INTEGRATION_MANAGER_Plan.md) — project-local Claude Code/DeepSeek worker launcher and Codex-led sequential integration-manager workflow
- [POCKET_OFFSET_INNER_FIRST_Plan.md](POCKET_OFFSET_INNER_FIRST_Plan.md) — reverse pocket rough offset traversal so offset pockets cut inner loops first and work outward while preserving selected cut direction
- [FOLDER_GROUP_Plan.md](FOLDER_GROUP_Plan.md) — folder transform groups: toggle a folder "grouped" so its features move/copy/resize/rotate/mirror as one rigid body (shared pivot), select-all-on-member with a distinct highlight; per-instance transforms only (feature-reference safe). Sliced 1–4.

### Foundational / cross-cutting
- [INTEGRATION_HANDOFF_TEMPLATE.md](INTEGRATION_HANDOFF_TEMPLATE.md) — detailed branch-owned handoff and slice-ledger template for sequential external implementation workers
- [CAM_App_Design.md](CAM_App_Design.md) — high-level CAM design (feature model, operation model, workflow). The "why" behind the data shapes.
- [REGION_FEATURE_SEMANTICS.md](REGION_FEATURE_SEMANTICS.md) — how regions filter rather than define machining targets. Read before touching operation/region logic.

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
