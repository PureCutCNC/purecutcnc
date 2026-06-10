---
status: Done   # Draft → Approved → In progress → Done | Abandoned
created: 2026-06-08
---

# UX Review — P0 (First-Use Cliff) Plan

> Derived from [`reviews/CONSOLIDATED_REVIEW_2026-06-08.md`](reviews/CONSOLIDATED_REVIEW_2026-06-08.md), section "P0".
> These are the two highest-leverage items, flagged by three of four independent reviewers (Claude, Codex, Copilot). Each sub-item (A0.1, A0.2) is independently shippable and should be its own PR; they are grouped here because they share the same goal.

## Goal

Remove the first-use cliff. A cold-start user currently lands on an empty stock with a dense toolbar and no idea where to begin, and the app's signature "feature *is* the CAM operation" idea is invisible in the UI until the user manually hunts through the CAM panel. P0 makes the happy path discoverable and makes the collapsed CAD/CAM concept tangible on first contact.

User-visible outcome:
- A new user can open a real example part in one click and see a complete project (geometry → features → operations → simulation).
- After drawing/importing a feature, the user can right-click it and create a valid machining operation directly, without learning the selection-first CAM-panel flow first.

## Approach

### A0.1 — First-run / empty-state onboarding + bundled samples

- **Bundle sample projects.** Ship 2–3 of the existing real `.camj` parts as static assets. Candidates already on disk (currently in the untracked `work/` folder of the main checkout): `Cone.camj` (3D surface), `LP_carving.camj` (V-carve), and a simple 2.5D pocket/profile part. Copy chosen files into a new `public/examples/` directory plus a small `public/examples/manifest.json` (`[{ id, title, description, file, thumbnail? }]`).
- **Loader.** Reuse the existing `openProjectFromText` store action — fetch the `.camj` asset text and pass it through. No new parsing path.
- **Empty-state CTA.** When the project is empty (no features), render an empty-state overlay on the center viewport with two actions: "Draw a shape", "Import a file", and a prominent "Open an example…" entry that lists the manifest. This is the lowest-effort, highest-impact onboarding move and avoids a heavy guided tour.
- **New-project entry point.** Add the same "Open an example" list to `NewProjectDialog` so it is reachable from the normal new-project flow, not only the empty state.
- **Lightweight happy-path checklist (optional, behind the empty state).** A dismissible side checklist mirroring the canonical flow: draw/import → stock & origin → feature intent + depth → operation → simulate → export. Each step can be a static label in v1 (no live state tracking) to keep scope small; live step detection is a follow-up, not part of P0.

### A0.2 — Feature-local "Quick Operation" actions

This makes the collapsed CAD/CAM concept visible. The validity logic already exists — this is mostly wiring.

- **Extract the validity helper.** `getOperationAddHint(project, selection, kind)` currently lives privately in `CAMPanel.tsx` (line ~553). Move it to a shared module (e.g. `src/engine/operations/operationValidity.ts` or `src/components/cam/operationValidity.ts`) so both the CAM panel and the new context-menu path use the single source of truth. A `null` hint means "valid for this selection".
- **Compute valid quick-ops for a single feature.** Given a right-clicked feature, build the selection state for just that feature and run each `OperationKind` through the extracted helper; the kinds with `hint === null` are the offered quick actions. Map to friendly labels:
  - subtract feature → "Create Pocket", "Create Inside Route"
  - add / model feature → "Create Outside Route", "Surface Clean"
  - imported STL model → "Create Rough Surface", "Create Finish Surface"
- **Add to the existing feature context menu.** The menu already renders in `App.tsx` (~line 1283, the `treeContextMenu` branch with Join / Cut / Use as Stock / Delete). Add a "Create operation" section at the top listing the valid quick-ops; each calls the existing `addOperation(kind, pass, target)` store action with sensible defaults and the feature as target, then selects the new operation and opens the CAM panel.
- **Default pass.** For pass-capable ops, default to the kind's natural pass (`rough` for clearing, `finish` for surface finish); reuse whatever defaults the CAM panel's `onAddOperation` already applies so behaviour is identical to the existing path.

### A0.2b — Automatic tool selection on add (CAM panel + quick-ops)

Originally A0.2 used `project.tools[0]` as-is (the existing `addOperation` behaviour). In review this proved wrong: `defaultOperationForTarget` always grabbed `tools[0]` regardless of operation type, so e.g. a V-carve could be created against a flat endmill (and produce no toolpath, since `vcarve.ts` requires a `v_bit`), and empty projects got `toolRef: null`. We now select a *proper* tool for both the context-menu and CAM-panel add paths.

- **Pure selector** `src/engine/operations/toolSelection.ts` (unit-tested):
  - `preferredToolTypes(kind)` — best-first acceptable tool types: v-carve → `[v_bit]`; drilling → `[drill, flat_endmill]`; finish-surface → `[ball_endmill, flat_endmill]`; rough-surface → `[flat_endmill, ball_endmill]`; everything else → `[flat_endmill, ball_endmill]`.
  - `targetFeatureSize(project, target)` — characteristic size = the smallest bounding-box min-dimension across the target's machining features (stock bounds for stock targets).
  - `selectToolForOperation(project, kind, target, libraryTools)` — walks the preferred types best-first; within each tier prefers an existing project tool, else the matching bundled-library entry (converted to project units). Returns `{ source: 'existing', toolId }`, `{ source: 'import', tool }`, or `null`.
  - **Sizing:** pick the largest acceptable tool with `diameter ≤ 0.5 × featureSize`; if none fit, the smallest available. (→ larger tools on larger features.)
  - **Type preference:** import the ideal type even when a less-ideal existing tool is present (e.g. import a ball for a 3D finish rather than reuse a flat).
- **Store wiring:** `addOperation(kind, pass, target, libraryTools?)` runs the selector; an `import` selection adds the converted tool to `project.tools` (deduped via `toolMatchesTemplate`) and references it — all in the same undo step. Operation defaults (feed/stepdown/etc.) now derive from the *chosen* tool, not `tools[0]`. When nothing matches, the old `tools[0] ?? null` fallback stays.
- **Call sites load the bundled library** (`ensureBundledLibraryLoaded` in CAMPanel, `loadBundledToolLibrary` in `App.tsx`) and pass its tools into `addOperation`; a load failure falls back to existing-tools-only selection.
- **Tests:** `toolSelection.test.ts` (type mapping, size pick incl. the 0.5 fraction, import-on-missing, unit conversion, ideal-type preference, empty → null) plus a store test asserting `addOperation` imports + references a `v_bit` when the project has none.

## Files affected

**A0.1**
- *(new)* `public/examples/*.camj` — 2–3 bundled sample parts copied from existing `.camj` files.
- *(new)* `public/examples/manifest.json` — list of bundled examples (id, title, description, file).
- *(new)* `src/components/project/ExampleProjectList.tsx` — fetches the manifest, renders the selectable list, loads via `openProjectFromText`.
- `src/components/project/NewProjectDialog.tsx` — add the "Open an example" list.
- `src/App.tsx` — render an empty-state overlay (no features) with Draw / Import / Open-example CTAs; optional dismissible checklist.
- *(maybe new)* `src/components/onboarding/EmptyStateOverlay.tsx` — extract the overlay rather than growing `App.tsx`.

**A0.2**
- *(new)* `src/components/cam/operationValidity.ts` (or `src/engine/operations/`) — extracted `getOperationAddHint` + a `validQuickOperationsForFeature(project, featureId)` helper.
- `src/components/cam/CAMPanel.tsx` — import the helper from its new home instead of the local copy (no behaviour change).
- `src/App.tsx` — add the "Create operation" section to the feature context menu; wire to `addOperation`.
- *(maybe)* `src/store/projectStore.ts` — only if a small convenience selector for "operations valid for feature X" is cleaner in the store; otherwise pure helper.

## Tests

- **Engine/helper (required):** unit tests for `validQuickOperationsForFeature` — subtract feature offers pocket/inside-route and not surface ops; add feature offers outside-route/surface-clean; STL model offers rough/finish surface; a feature with no valid op returns `[]`. This locks the mapping that the context menu depends on.
- **Regression:** a test asserting `CAMPanel`'s `operationButtons` hints are unchanged after extracting `getOperationAddHint` (same inputs → same hints), so the refactor is provably behaviour-preserving.
- **Manifest:** a structural test that every `file` in `public/examples/manifest.json` exists and parses as a valid project via the same load path.

## Open questions / risks

- **Which 3 sample parts to bundle?** Need the owner to pick (suggest one V-carve, one 3D-surface, one plain 2.5D pocket/profile). Bundling adds the `.camj` payload to the web bundle — small, but confirm licensing/content is fine to ship publicly.
- **Empty-state vs. checklist scope.** Recommend shipping the empty-state CTA + example loader first (A0.1 core) and treating the live happy-path checklist as a fast follow, to avoid scope creep.
- **Quick-op defaults.** Confirm it's acceptable for a one-click operation to be created with default tool/feeds that the user then tunes (matches current Add-operation behaviour).

## Out of scope

- Live, state-aware onboarding tour or coach-marks (P1/P2 territory).
- Auto-creating operations *automatically* on feature creation (deliberately kept user-initiated — quick action, not magic).
- Any change to `getOperationAddHint`'s validity rules themselves; this plan only relocates and reuses them.
- Tablet-specific affordances for these flows (covered under P1 / the tablet plan).
