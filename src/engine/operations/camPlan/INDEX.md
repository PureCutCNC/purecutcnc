# INDEX — src/engine/operations/camPlan/

Deterministic, transient CAM Plan (Preview) POC. These modules analyze the current project and bundled tool library without mutating project state; only an accepted plan crosses the store apply boundary.

- `createCamPlan.ts` — feature-role/depth recognition, operation grouping, rough/rest/finish dependencies, coverage, and one shared tab proposal per routed edge target.
- `toolPlanning.ts` — project/library tool normalization, feasibility filters, named part-scale limits, drilling compatibility, stable ranking, and user-facing choice reasons.
- `types.ts` — ephemeral plan, operation, coverage, tool, rest-region, and shared-tab draft contracts.
- `index.ts` — public planner exports.
- `createCamPlan.test.ts` — representative 2.5D recognition, role/depth, unit/transform, tool-policy, ordering, residual, shared-tab, deterministic, and apply-safety fixtures.

The draft is deliberately not part of `.camj`. Keep recognition and ranking rules isolated here so POC feedback can revise them without changing the manual CAM workflow or saved-project contract.
