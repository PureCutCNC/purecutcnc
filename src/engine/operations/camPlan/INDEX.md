# INDEX — src/engine/operations/camPlan/

Deterministic, transient CAM Plan. These modules analyze the current project and bundled tool library without mutating project state; only an accepted plan crosses the store apply boundary.

- `createCamPlan.ts` — feature-role/depth recognition, operation grouping, rough/rest/finish dependencies, coverage, and one shared tab proposal per routed edge target. Bottom recognition uses the generation setup frame; completed Top through-cuts are skipped with a localized coverage note, and generated rest masks/tabs return to stock space (#1106). Around (decision 3, #1112 J) plans imported and canned models (Turn/Polygon) as Rotary rough + finish, canned Thread/Flutes as one Engrave with a V-bit at the pattern's stored depth, and hand-drawn sheet features through the same 2.5D recognition Top uses; on a square blank the sheet work is kept visible with a localized reason while models still turn. The plan's `analysisProject` is passed through `withoutUnreachableSubtracts` for the active setup's face (issue #1079): this planner calls the region resolvers directly, and an ungated Bottom notch bridging two Top pockets would otherwise mark one of them `not_needed` in coverage. `reconcileRest.ts` inherits the same rule through the rest-region entries' own gate.
- `setupPlanning.ts` — active cutting-space read model: the Bottom setup turn, the Around unrolled sheet (models kept in stock space), same-setup operation context, and inverse conversion of rest masks to canonical stock XY (#1106, #1112 J).
- `bottomSetup.test.ts` — asymmetric Bottom fixtures on both flip axes and in both units, planned/manual generation parity, Top coverage suppression, same-side reuse, and rest materialization.
- `aroundSetup.test.ts` — the acceptance bolt (Polygon + Turn + Thread) as Rotary pairs plus one V-bit Engrave, the pattern depth rule, Around-vs-Top sheet parity, the square-blank refusal, no V-bit fallback, and one-undo apply.
- `reconcileRest.ts` — scoped reactive rest-plan regeneration after a user corrects a source operation.
- `toolPlanning.ts` — the plan's tool pool (project tools and bundled-library entries, and only those written in the project's units — issue #1132: the other unit system is never chosen or imported by conversion), feasibility filters, named part-scale limits, drilling compatibility, stable ranking, an optional preferred-type override (Thread/Flutes), and user-facing choice reasons.
- `types.ts` — ephemeral plan, operation, coverage, tool, rest-region, and shared-tab draft contracts.
- `index.ts` — public planner exports.
- `createCamPlan.test.ts` — representative 2.5D recognition, role/depth, unit/transform, tool-policy, ordering, residual, shared-tab, deterministic, and apply-safety fixtures.

The draft is deliberately not part of `.camj`. Keep recognition and ranking rules isolated here so POC feedback can revise them without changing the manual CAM workflow or saved-project contract.
