# INDEX — src/engine/operations/camPlan/

Deterministic, transient CAM Plan. These modules analyze the current project and bundled tool library without mutating project state; only an accepted plan crosses the store apply boundary.

- `createCamPlan.ts` — feature-role/depth recognition, operation grouping, rough/rest/finish dependencies, coverage, and one shared tab proposal per routed edge target. Bottom recognition uses the generation setup frame; completed Top through-cuts are skipped with a localized coverage note, and generated rest masks/tabs return to stock space (#1106). The plan's `analysisProject` is passed through `withoutUnreachableSubtracts` for the active setup's face (issue #1079): this planner calls the region resolvers directly, and an ungated Bottom notch bridging two Top pockets would otherwise mark one of them `not_needed` in coverage. `reconcileRest.ts` inherits the same rule through the rest-region entries' own gate.
- `setupPlanning.ts` — active Bottom cutting-frame read model, same-setup operation context, and inverse conversion of rest masks to canonical stock XY (#1106).
- `bottomSetup.test.ts` — asymmetric Bottom fixtures on both flip axes and in both units, planned/manual generation parity, Top coverage suppression, same-side reuse, rest materialization, and Around refusal.
- `reconcileRest.ts` — scoped reactive rest-plan regeneration after a user corrects a source operation.
- `toolPlanning.ts` — project/library tool normalization, feasibility filters, named part-scale limits, drilling compatibility, stable ranking, and user-facing choice reasons.
- `types.ts` — ephemeral plan, operation, coverage, tool, rest-region, and shared-tab draft contracts.
- `index.ts` — public planner exports.
- `createCamPlan.test.ts` — representative 2.5D recognition, role/depth, unit/transform, tool-policy, ordering, residual, shared-tab, deterministic, and apply-safety fixtures.

The draft is deliberately not part of `.camj`. Keep recognition and ranking rules isolated here so POC feedback can revise them without changing the manual CAM workflow or saved-project contract.
