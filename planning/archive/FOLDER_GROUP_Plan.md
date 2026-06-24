---
status: Done   # Draft → Approved → In progress → Done | Abandoned
created: 2026-06-22
---

# Folder Transform Groups Plan

## Goal

Extend feature folders to behave like a "group" in other CAD programs: a folder can be toggled into a **grouped** state, after which all of its member features move/copy/resize/rotate/mirror **as one rigid body**. Selecting any member of a grouped folder selects the whole group (reusing the existing folder select-all), shown with a distinct group highlight so it is clearly more than an ad-hoc multi-select. Editing an individual member's sketch is intentionally **not** grouped — it stays reachable via double-click / context menu on the single feature. This is independent of the existing per-feature `locked` flag (which gates sketch editing); grouping is a separate, folder-level concept.

## Approach

- **Data model:** add a `grouped: boolean` flag to `FeatureFolder` (`src/types/project.ts`). Default `false`. Migration: existing folders normalize to `grouped: false`. Name in the model is `grouped`; UI label/affordance is a "Group" toggle (link-chain icon) on the folder row — deliberately **not** called "lock" to avoid colliding with the per-feature edit `locked`.

- **Selection (option A):** when a feature that belongs to a grouped folder is selected (canvas click or tree click), expand the selection to all members of that folder via the existing `selectFolderFeatures(folderId)`. Record that the current selection originated as a group so it can be highlighted distinctly — add a lightweight marker to `SelectionState` (e.g. `groupFolderId: string | null`) rather than overloading `selectedFeatureIds`. Clearing/replacing selection resets the marker.

- **Distinct highlight:** canvas + tree render a group selection differently from a normal multi-select (e.g. a single group bounding box / accent outline around the whole folder rather than per-feature handles). Exact visual TBD during implementation; the marker above is what makes it possible.

- **Group transforms (the core):** reuse the existing `pendingTransform` flow (`move | resize | rotate | mirror`) but fan the transform across every member of the group. The critical rule is a **single shared pivot**: build one group matrix `M_group` around the group's combined bounding-box anchor and apply `newTransform = multiplyMatrix(M_group, member.transform)` to **each** member. Move is a pure translate (pivot-independent); resize/rotate/mirror MUST use the shared pivot so the group scales/rotates as a unit instead of each part transforming about its own center.

- **Feature-reference correctness (hard invariant):** group transforms mutate only each member's per-instance `transform: Matrix2D`. They must **never** write to the shared `FeatureDefinition` — otherwise sibling instances of the same definition (elsewhere in the tree) would move too. Group resize is an affine transform on the instance, not a rewrite of definition-local sketch dimensions.

- **Group copy:** duplicating a grouped folder fans the existing instance-aware copy (`src/store/helpers/copyFeatures.ts`) across all members, preserving relative layout, into a **new folder that is also `grouped: true`**. New members follow the established linked-copy default (new instances referencing the same definitions) — i.e. whatever single-feature copy already does; group copy does not change linked-vs-cloned semantics.

- **Constraints caveat:** group *move* is a pure translate and is always safe. Group *resize/rotate/mirror* on members carrying sketch constraints (which can reference external geometry, per the per-instance constraint model) may fight the solver. Initial scope: allow move + rotate + mirror + uniform resize at the transform level; if a member's constraints reject the composed transform, fall back gracefully (skip/clamp that member) rather than corrupting the sketch. Revisit if it proves too restrictive.

## Files affected

- `src/types/project.ts` — add `grouped: boolean` to `FeatureFolder`; add `groupFolderId: string | null` (or similar) to `SelectionState`.
- `src/store/helpers/normalize.ts` — default `grouped: false` on folders missing the field (migration).
- `src/store/slices/treeVisibilitySlice.ts` — add a `toggleFolderGrouped(folderId)` action; `selectFolderFeatures` likely already sufficient for the select-all, extended to set the group marker.
- `src/store/slices/selectionSlice.ts` — when selecting a feature in a grouped folder, expand to the folder's members and set the group marker; reset marker on clear/replace.
- `src/store/slices/featureSlice.ts` — group-aware transform application: when the active selection is a group, compose `M_group` (shared pivot) and apply across all members instead of the single-feature path at ~`featureSlice.ts:944-952`.
- `src/store/helpers/instanceTransforms.ts` — helper to build the shared-pivot group matrix and the combined group bounding box.
- `src/store/helpers/copyFeatures.ts` — group copy: fan across members into a new grouped folder, preserving relative layout.
- `src/components/feature-tree/FeatureTree.tsx` — folder-row "Group" toggle (icon) + grouped visual state.
- `src/components/canvas/SketchCanvas.tsx` (+ related render) — distinct group-selection highlight; route canvas selection of a grouped member through the group-select path.
- `src/store/types.ts` — type additions for the new action + selection marker.

## Tests

- **Store/helpers (required — engine-adjacent):**
  - Group move translates every member's `transform` by the same delta; relative layout preserved.
  - Group resize/rotate/mirror uses a **shared pivot**: members keep relative positions and the group bbox scales/rotates as a unit (regression guard against per-feature-pivot drift).
  - Feature-reference invariant: a group transform on instances that share a definition does **not** mutate the `FeatureDefinition` and does **not** move sibling instances outside the folder.
  - Group copy produces a new `grouped: true` folder with members at the correct relative offsets, following linked-copy semantics.
  - Migration: a folder without `grouped` normalizes to `false`.
- **Selection:** selecting a member of a grouped folder yields all members in `selectedFeatureIds` plus the group marker; ungrouped folder behaves as before.

## Implementation slices

Dispatched one at a time; each is reviewed before the next starts.

- **Slice 1 — model + store foundation (no UI).** Add `grouped: boolean` to `FeatureFolder` and `groupFolderId: string | null` to `SelectionState` (`src/types/project.ts`); default `grouped: false` migration in `src/store/helpers/normalize.ts`; `toggleFolderGrouped(folderId)` action in `src/store/slices/treeVisibilitySlice.ts` (+ `src/store/types.ts`). Unit tests: migration defaults to `false`; toggle flips the flag. No selection/transform/canvas behavior yet.
- **Slice 2 — group selection + distinct highlight.** Selecting a member of a grouped folder expands to all members via `selectFolderFeatures` and sets `groupFolderId`; reset on clear/replace. Canvas + tree render the group selection distinctly. Route canvas hit-selection of a grouped member through the group path.
- **Slice 3 — group transforms (shared pivot).** Fan move/resize/rotate/mirror across members with a single shared-pivot `M_group`, composed onto each member's per-instance `transform` only (never the `FeatureDefinition`). Helper in `src/store/helpers/instanceTransforms.ts`. Unit tests for relative-layout preservation + the feature-reference invariant.
- **Slice 4 — group copy + folder-row toggle UI.** Fan instance-aware copy into a new `grouped: true` folder; add the "Group" toggle affordance to the folder row.

## Phase 2 — container behaviors (post-initial-testing)

A grouped folder should behave like a real CAD group container. Added after user testing of the initial feature.

- **P2-1 — lock members into a grouped folder.** A feature in a grouped folder cannot be moved *out* (to another folder or root); only reordering *within* the folder is allowed. Enforce at the store level in `moveFeatureTreeFeature` and `assignFeaturesToFolder` (reject cross-folder moves out of a grouped folder), have feature-tree drag-drop (`handleDrop`) respect it, and disable the folder dropdown in `PropertiesPanel` (`renderFolderSelect`) when the selection is in a grouped folder. Dragging a feature *into* a grouped folder (already works) makes it part of the group — keep that.
- **P2-2 — context-menu "Group" and "Add to folder".**
  - **Group** (shown only when >1 feature is selected): create a new folder, move the selected features into it, toggle `grouped` on, and select the new group. New composite store action.
  - **Add to folder**: a submenu (mirroring the existing Quick-Ops submenu pattern in `FeatureContextMenu.tsx`) listing existing folders + a "Create new…" entry; moves the selected feature(s) into the chosen/new folder. Disabled for features already in a grouped folder (consistent with P2-1).

## Open questions / risks

- **Distinct-highlight visual** — exact treatment (single group bbox vs accent per-feature) to be decided during implementation; data marker is in scope regardless.
- **Constrained-member resize** — fallback behavior (skip/clamp vs block) needs confirmation once we see solver interaction in practice.
- **Edit-within-group gesture** — starting with existing double-click / context-menu to edit a single member; no special "enter group" mode yet.
- **Nested folders** — folders are currently flat (no `parentId`); groups are single-level. Not changing that here.

## Out of scope

- Nested/hierarchical groups.
- Changing the per-feature `locked` (edit-lock) semantics.
- A dedicated "enter group / isolate" editing mode beyond the existing double-click/context-menu.
- Grouped behavior for non-feature tree entries (tabs, clamps, operations).
- Changing linked-vs-cloned copy semantics.
