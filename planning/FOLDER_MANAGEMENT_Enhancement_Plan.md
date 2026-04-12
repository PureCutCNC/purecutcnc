# FOLDER MANAGEMENT Enhancement Plan

Legend:
- `[ ]` not started
- `[~]` in progress / partial
- `[x]` complete
- `[>]` deferred / moved to backlog

## Goal

Improve the usability of folder management in the project tree with three targeted changes:

1. Replace the text `+` button for adding folders with a folder icon to make the action clearer and more consistent with the visual language.
2. Add a show/hide visibility toggle to folder rows so the user can hide/show all features in a folder at once, without affecting features outside the folder.
3. When a folder is selected and a new feature is created (from any creation path), insert the new feature as the last item in that folder rather than appending it to the end of the full feature list.

## Background

The project tree renders features and folders hierarchically. Folders are defined by `FeatureFolder` (id, name, collapsed) and linked to features via `SketchFeature.folderId`. Individual features already have a show/hide button (`feature.visible`). Folder rows do not. When a feature is added, `addFeature()` in `projectStore.ts` always appends and then calls `syncFeatureTreeProject()` which reorders the flat array — it does not currently honour folder context from the selection state.

### Key Files
- `src/components/feature-tree/FeatureTree.tsx` — tree rendering, TreeRow component
- `src/store/projectStore.ts` — `addFeature`, `addFeatureFolder`, `syncFeatureTreeProject`, store actions
- `src/types/project.ts` — `FeatureFolder`, `SketchFeature`, `FeatureTreeEntry`
- `src/styles/layout.css` — tree row and button styles

## Scope

### In scope
- Folder icon button replacing `+` text for "Add folder" action
- Per-folder bulk show/hide toggle (updates `visible` on all features in the folder)
- Folder-aware feature insertion when a folder or feature is selected
- Per-folder "select all features" button to multi-select all features in the folder

### Out of scope
- Changing how folders themselves are shown/hidden from the tree (collapse is separate)
- Persistent folder visibility state on `FeatureFolder` (using feature-level `visible` only)
- Any changes to Tabs or Clamps sections

## Design Decisions

### FM1 — Folder icon button
The `+` text label on the Features root row is rendered in `TreeRow` (FeatureTree.tsx ~line 529) via the `onAddFolder` prop path. Replace the `+` text content with the existing `.tree-icon--folder` SVG (or an inline equivalent) so it matches the icon already shown beside each folder entry. The button dimensions and hover styles remain unchanged; only the inner content changes.

### FM2 — Folder show/hide toggle
Each folder row already passes `onToggleVisible` as `undefined`, causing the visibility button to not render. Add a new store action `toggleFolderVisible(folderId)` that sets `visible` on all features whose `folderId` matches. The "current visibility" for the button state is derived: the folder is considered visible if **any** of its features are visible (matching the pattern used for Show All / Hide All). The button uses the same `◉` / `○` symbols and `tree-action-btn--visibility` class already in use on individual features.

### FM4 — Folder "select all features" button
Each folder row gets a new action button that multi-selects all features inside the folder. Add `selectFolderFeatures(folderId)` to the store: filter features by `folderId`, pass their ids to the existing `selectFeatures` multi-select logic. In `TreeRow`, add an `onSelectAllFeatures` optional prop that renders a selection-rectangle SVG button (dotted border square). Only shown when the folder has at least one feature. Clicking it does not change the `selectedNode` to the folder — it selects the features directly, the same as if the user had shift-clicked them all.

### FM3 — Folder-aware feature insertion
Currently `addFeature()` appends the feature and `syncFeatureTreeProject()` places it at the end of the feature list. When a folder is selected at feature creation time, the new feature should:
1. Have its `folderId` set to the selected folder's id.
2. Be inserted after the last existing feature in that folder in the tree order.

The creation call sites (toolbar / keyboard shortcuts) pass through `addFeature`. The store already knows the selection state. The simplest approach is to modify `addFeature` to accept an optional `targetFolderId` parameter, and have the call sites pass `selectedNode.folderId` when the selected node is a folder. `syncFeatureTreeProject` already handles ordering correctly once `folderId` is set — the insertion position in the `featureTree` array may need to be set explicitly so the new feature lands after existing folder siblings rather than at the root tail.

## Implementation Phases

### FM1. Replace `+` with folder icon on Add Folder button

- `[x]` In `TreeRow` (FeatureTree.tsx ~line 535), replace the `+` text content with the folder SVG icon already used for folder entries
- `[x]` Verify button remains 20×20px and hover state is intact
- `[x]` Keep `title="Add folder"` and `aria-label="Add folder"`

### FM2. Folder-level visibility toggle

- `[x]` Add `toggleFolderVisible(folderId: string)` action to `projectStore.ts`
  - Determine current effective visibility: `any` feature in folder is visible → currently visible
  - If currently visible: set all features in folder to `visible: false`
  - If all hidden: set all features in folder to `visible: true`
  - Batch update features, add to history
- `[x]` In `FeatureTree.tsx`, wire the `onToggleVisible` prop on the folder `TreeRow`:
  - `onToggleVisible={() => toggleFolderVisible(folder.id)}`
  - `visible` prop: `project.features.some(f => f.folderId === folder.id && f.visible)`
- `[x]` Confirm the visibility button renders with correct `◉` / `○` state and `--muted` class when all hidden

### FM3. Folder-aware feature insertion

- `[x]` Modify `addFeature` in `projectStore.ts` to read the current `selectedNode` from store state and, when it is `{ type: 'folder', folderId }`, set `folderId` on the new feature
- `[x]` When a feature is selected, inherit its `folderId` and insert the new feature immediately after it in `features[]` and `featureTree[]`
- `[x]` `syncFeatureTreeProject` handles ordering: folder features are sorted by position in `features[]`, so appending places the new feature last in the folder automatically — no manual tree entry insertion needed
- `[x]` Verify: creating a feature with no folder selected still appends to root (existing behavior)
- `[x]` Verify: creating a feature with a folder selected places it last within that folder, not at the global end

### FM4. Folder "select all features" button

- `[x]` Add `selectFolderFeatures(folderId: string)` action to `projectStore.ts`: filter `project.features` by `folderId`, pass ids to the same multi-select logic as `selectFeatures`
- `[x]` Add `selectFolderFeatures` to `store/types.ts`
- `[x]` Add `onSelectAllFeatures?: () => void` prop to `TreeRow` in `FeatureTree.tsx`
- `[x]` Render a dotted-rectangle SVG button in `TreeRow` when `onSelectAllFeatures` is provided
- `[x]` Wire `onSelectAllFeatures` on folder rows: only when `folderFeatures.length > 0`, calls `selectFolderFeatures(folder.id)`
