---
status: Done
created: 2026-06-08
---

# UX Review — P1 (Reduce Cognitive Load) Plan

> Derived from [`reviews/CONSOLIDATED_REVIEW_2026-06-08.md`](reviews/CONSOLIDATED_REVIEW_2026-06-08.md), section "P1".
> Five items that lower the cognitive load that makes a capable app feel complex. Each is independently shippable and should be its own PR. A1.5 (tablet) is largely a pointer to the existing tablet plan and is tracked there. Do **not** start P1 until P0 is approved/landed — the empty-state and quick-op work changes some of the same surfaces (`App.tsx`, `CAMPanel.tsx`).

## Approved scope for this PR (2026-06-09)

This PR (folded together with P0 on the same branch) implements **A1.1, A1.3, and A1.4** — the three highest-leverage, well-bounded "reduce cognitive load" wins. **A1.2** (standardize multi-step interactions on `CanvasWorkflowPanel`) and **A1.5** (tablet cross-checks) are deferred to follow-up PRs because they are large/cross-cutting (A1.2 is an audit + incremental migration; A1.5 is tracked in `TABLET_UX_COMBINED_PLAN.md`).

Decisions confirmed with the owner before implementation:

- **A1.1 field split:** follow this plan's split — *common* fields are name / operation / `z_top` / `z_bottom` on features and tool + depth + stepdown/stepover on operations; *advanced* (collapsed) holds fine feeds/speeds (feed, plunge feed, RPM), stock-to-leave, strategy (pattern/angle/cut direction/machining order), waterline tuning, drill sub-parameters (peck/dwell/retract), finish walls/floor, and debug flags.
- **A1.3:** implement both the inline hints *and* the canvas highlight of compatible features (the highlight touches `SketchCanvas.tsx`).
- **A1.4:** note that P0 already moved regions into a dedicated "Regions" tree section and gave region features a locked "Z Range follows stock" field; the remaining work is the per-row mask/filter badge, the inline explanation where a region is used as an operation parameter, and wording alignment with `REGION_FEATURE_SEMANTICS.md`. Presentation only.

## Goal

Make the app's own model obvious so a first-time user doesn't have to learn internal concepts before doing simple work. Concretely: stop overwhelming users with every field at once, give every multi-step mode a clear "what am I doing / what next / confirm / cancel" frame, tell users *why* an operation is unavailable in plain language, make `region` read as a filter not geometry, and finish the tablet interaction pass before promoting tablet use.

## Approach

### A1.1 — Progressive disclosure in Properties (and CAM params)

- In `PropertiesPanel.tsx`, for each selection kind show only the few high-value fields by default (for a feature: name, operation, `z_top`, `z_bottom`) and collapse the rest under an "Advanced" disclosure section. Persist the expanded/collapsed state per panel in `localStorage` (consistent with existing layout persistence).
- Apply the same default/advanced split to operation parameters in `CAMPanel.tsx`: primary (tool, depth, stepdown/stepover) visible; secondary (stock-to-leave, waterline tuning, debug flags, fine feeds/speeds) behind "Advanced".
- Introduce a small reusable `<DisclosureSection>` so the pattern is consistent everywhere rather than ad-hoc per panel.

### A1.2 — Standardize multi-step interactions on workflow panels

> **CLOSED AS ALREADY DONE (audit 2026-06-09).** The audit found all 13 armed
> multi-step flows (placement, creation, move/copy, resize/rotate/mirror,
> offset, join, cut, constraint, sketch edit, tape, dimension placement,
> dimension delete) already use `CanvasWorkflowPanel` with step label,
> instruction, confirm/cancel, and numeric inputs. Backdrop move/resize/rotate
> route through `pendingMove`/`pendingTransform` and are covered by those
> panels. The migration was completed during the tablet UX work (commit
> `4fbacb6` "convert last old-style banner to workflow panel") before this
> plan was written; the remaining `sketch-banner-warning` elements are
> informational, not interactive. No code change required.

- Make `CanvasWorkflowPanel` / `useCanvasWorkflowPanel` the single pattern for every armed multi-step action (placement, move/copy/resize/rotate/offset/mirror, join, cut, constraint placement, dimension/tape tools).
- Each panel must answer the five questions: step label, instruction, confirm, cancel, and current numeric inputs/constraints. Audit the pending-action flows in the store and `SketchCanvas.tsx` for any that still rely on canvas-only banners or keyboard-only paths and migrate them.
- This is the largest P1 item; scope it as an audit + incremental migration (one PR per cluster of actions), not a single rewrite.

### A1.3 — Inline & visual operation-validity feedback

- Promote the existing `button.hint` from tooltip-only to an always-visible inline note next to (or under) the disabled operation, so the user sees "Needs a V-bit tool" without hovering. `OperationAddMenu` already renders a `selectedNewOperationHint` status line — extend that pattern to per-row inline hints.
- When an operation kind is hovered/armed, highlight the compatible feature(s) on the sketch canvas (and dim incompatible ones), reusing the existing selection-highlight rendering in `SketchCanvas.tsx`. This turns "the button is grey and I don't know why" into "these are the shapes it would act on".
- Depends on the `operationValidity` helper extracted in P0 (A0.2) — reuse it, don't duplicate.

### A1.4 — Clarify the `region` concept in-UI

- Give region rows a distinct visual treatment in `FeatureTree.tsx` (e.g. dashed/outline icon or a small "filter" badge) so they don't read as machinable geometry.
- When a region is used as an operation parameter (in `CAMPanel.tsx` / properties), show a one-line inline explanation: "Limits where this operation may cut — not a shape to machine."
- Align wording with [`REGION_FEATURE_SEMANTICS.md`](REGION_FEATURE_SEMANTICS.md); no semantic/behaviour change, presentation only.

### A1.5 — Finish the tablet pass before promoting tablet use

- This is governed by the existing [`TABLET_UX_COMBINED_PLAN.md`](TABLET_UX_COMBINED_PLAN.md). P1's only additions: (a) ensure the P0/P1 surfaces above (empty-state overlay, quick-op context menu, disclosure sections, inline hints) have touch-accessible equivalents — context menus and hover states need tap alternatives; (b) keep tablet/touch out of user-facing "current capability" claims until that plan's PRs land.
- Track the substantive tablet work in `TABLET_UX_COMBINED_PLAN.md`; this plan only carries the cross-checks so P1 features don't regress on touch.

## Files affected

- `src/components/feature-tree/PropertiesPanel.tsx` — default/advanced field split per selection kind.
- `src/components/cam/CAMPanel.tsx` — operation-param disclosure; per-row inline validity hints; region-as-parameter explanation.
- *(new)* `src/components/common/DisclosureSection.tsx` — reusable collapsible section.
- `src/components/cam/OperationAddMenu.tsx` — promote hints to inline per-row notes.
- `src/components/canvas/SketchCanvas.tsx` — highlight compatible features when an op is armed; migrate any banner/keyboard-only flows to the workflow panel.
- `src/components/canvas/CanvasWorkflowPanel.tsx`, `src/components/canvas/useCanvasWorkflowPanel.ts` — become the standard multi-step host; extend to cover remaining actions.
- `src/components/feature-tree/FeatureTree.tsx` — region visual treatment / badge.
- `src/App.tsx` — wherever armed-mode state drives the above (kept minimal).
- Reuses `operationValidity` helper from P0.

## Tests

- **DisclosureSection:** component test for expand/collapse + persisted state.
- **Validity reuse:** the A1.3 highlight/inline-hint logic must consume the same `operationValidity` helper; assert hint text matches helper output for representative selections (extends the P0 helper tests, no new validity rules).
- **Region presentation:** structural test that region rows render the distinct marker and that the region-as-parameter explanation appears when a region is selected as an op parameter (presentation assertions; no engine change).
- **Workflow-panel migration:** for each migrated action, a test that the panel exposes label/confirm/cancel and that confirm/cancel drive the same store transitions the old path did (behaviour-preserving).

## Open questions / risks

- **Which fields count as "primary" vs "advanced"** for each selection kind and each operation kind needs an owner decision (a short list per kind). Recommend the owner annotate the field list once; implementation follows.
- **A1.2 is big.** Recommend splitting into per-action-cluster PRs and accepting it spans more than one cycle; flag if a hard deadline forces a smaller initial cut.
- **Tablet equivalents** for context menus / hover highlights must be designed alongside, or P1 risks regressing touch — coordinate with `TABLET_UX_COMBINED_PLAN.md` owner.

## Out of scope

- Simplifying the default workspace layout / toolbar consolidation (that's P2 — A2.2 in the consolidated review).
- Visual collision/stock-setup overlays (P2 — A2.1).
- Decomposing the mega-files `SketchCanvas.tsx` / `App.tsx` / `CAMPanel.tsx` (P3 — A3.1), beyond the incremental extraction these features naturally require.
- Any change to operation validity *rules*, region *semantics*, or toolpath behaviour — P1 is presentation and interaction framing only.
