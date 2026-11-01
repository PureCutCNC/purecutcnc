# Slice u-a: never pick a tool in the other unit system (issue #1132, safety)

Frank (2026-10-31, `work/bolt-test-01.camj`): "Create operation" picked a "4 mm Ball Endmill" for Rotary rough in an inch project. Rule (Frank): **never choose a tool in the other units, in any case**, including CAM Plan.

Cause: `selectToolForOperation` (`src/engine/operations/toolSelection.ts`, ~line 232) takes, per preferred tool type, the largest tool within `autoToolDiameterLimit`, first from the project's tools and then from the bundled library (which holds both metric and inch tools). The project's units only break an exact size tie (`SAME_SIZE_TOLERANCE`), so a 6 mm endmill beats a 3/16", and a converted metric library entry can be imported. The fallback when nothing is selected (`defaultOperationForTarget`, `src/store/helpers/operationDefaults.ts`, ~line 388, `firstTool`) also ignores units.

- `selectToolForOperation`: consider only project tools with `tool.units === project.meta.units` and library entries with `entry.units === project.meta.units`. Never import or convert an entry in the other units. The size limit and the preferred type order (#876) are unchanged. The same-units tie-break becomes dead code; remove it if so.
- `defaultOperationForTarget` fallback: `firstTool` looks only at tools in the project's units. If there are none, use `defaultTool(project.meta.units, …)` as today.
- CAM Plan: every tool CAM Plan chooses or imports (`src/engine/operations/camPlan/toolPlanning.ts`, `createCamPlan.ts`, `reconcileRest.ts`, and any other pick you find by grepping for tool selection or library import under `camPlan/`) is in the project's units. Same rule, no exceptions. Reuse one shared same-units filter instead of copying it.
- Existing operations and tools are untouched. A user can still assign any tool by hand. Exported programs of existing projects stay byte-identical.

Tests:
- An inch project with a 6 mm and a 3/16" endmill picks the 3/16".
- An inch project whose tools are all metric picks the inch library entry (or the inch default), never a metric one.
- The metric project mirror of both cases above.
- The `firstTool` fallback skips tools in the other units.
- CAM Plan on an inch project with both metric and inch tools available plans only inch tools; a metric project plans only metric tools.
- Mutations: restore the tie-break-only rule in `selectToolForOperation`; drop the units check in the fallback; drop it in the CAM Plan pick.

Off limits: everything else.

## Rules

- You work in your own worktree, based on `feat/issue-1132-unit-tools` (from `integration/0.6.0`). Read `INDEX.md`, `AGENTS.md`, and the `INDEX.md` of every folder you touch. Do exactly what this handoff asks, nothing wider. If something here is wrong or needs a decision, say so in RISKS and do the closest correct thing.
- `gh` may be blocked in your sandbox; everything you need is here.
- Leave edits uncommitted and report `COMMIT: none`; the dispatcher commits.
- Project format is unchanged.
- No user-visible text is expected to change. If a locale key does change, every locale gets it with a real translation; run `npm run check:i18n`.
- Tests must bite: for each behaviour, break the code on purpose, confirm a test fails, then restore from a `cp` backup (never `git checkout`). Report each mutation and whether it was caught.
- You cannot run a browser. Grep `e2e/` for tool names or picks your change affects (for example an e2e that expects a specific auto-picked tool) and update it without weakening its assertions. List any such spec in RISKS.
- Run and report with exit codes: `npm run build:gates`, plus each changed or new test file directly.
- Report: changes per file; tests added; each mutation and whether it was caught; commands with exit codes; RISKS.
