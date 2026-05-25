---
status: Done
created: 2026-05-25
---

# Add Operation UX Improvement Plan

> Improve the operation selection UI to be more discoverable and user-friendly by converting the flat operation button grid into an expandable vertical list with operation descriptions and visual examples.

## Goal

Transform the "Add operation" menu from a cramped grid of buttons into a more discoverable interface where users can:
- Browse operations in a vertical list
- Click (?) info icons to expand detailed descriptions
- See rich content (text + images) explaining each operation's purpose and workflow
- Have only one expanded card at a time to avoid visual clutter

The outcome is a more intuitive onboarding experience for new users and better discoverability of less-common operations.

## Approach

**UI Structure:**
1. Vertical list with each operation as a compact row (24px desktop, 28px tablet)
2. Each row contains:
   - Operation name/label (left, clickable to expand/collapse details)
   - For pass-capable ops: **Rough** | **Finish** | **Both** buttons
   - For single-pass ops: **+** icon button
3. Clicking the operation name toggles an expanded description card below
4. Only one description card is expanded at a time

**Data Model:**
- Create a new `operationDescriptions` export in the types/operations area
- Each operation kind maps to a description object: `{ title, shortSummary, fullDescription, exampleImageUrl?, keyPoints }`
- Store descriptions as a TypeScript constant (can be externalized to a JSON file later if needed)

**Component Changes:**
- Extract operation list rendering into a new `OperationAddMenu` sub-component (in `src/components/cam/` or as a new file)
- Add expandable card component that handles one-at-a-time state
- Update CSS for:
  - Vertical list layout (flex column)
  - Expandable card styling with transitions
  - Info icon styling and hover states
  - Image container for operation examples

**Example Operation Descriptions:**
- **Pocket:** Remove material from a closed profile to a fixed depth. Used for simple rectangular cavities, etc. [Screenshot of pocket preview]
- **V-Carve offset:** Follow closed contours at a V-bit angle to create decorative edges.
- **Engrave/Follow line:** Trace open or closed paths on the surface (e.g., text, decorative lines).
- **Edge route:** Cut along the perimeter of features.
- **3D Surface rough/finish:** Remove material from imported 3D models using ball/flat tools.

## Files affected

- `src/components/cam/CAMPanel.tsx` — integrated `OperationAddMenu` component, removed the old inline menu and separate pass-selection section
- *(new)* `src/components/cam/OperationAddMenu.tsx` — new component for compact vertical list + expandable cards + inline pass buttons
- *(new)* `src/types/operationDescriptions.ts` — operation descriptions and image-name definitions
- `src/styles/layout.css` — compact vertical list styles, expandable cards, pass-button styles, fallback placeholder, responsive overrides

## Operation descriptions

Descriptions live in `src/types/operationDescriptions.ts` as a `Record<OperationKind, OperationDescription>` export. The `OperationDescription` type captures:

| Field | Purpose |
|---|---|
| `title` | Display name (redundant with the row label, informational only) |
| `shortSummary` | One-line summary (not currently rendered; available for tooltips) |
| `fullDescription` | Rendered as body text in the expanded card |
| `keyPoints` | Bulleted list of 3-4 practical notes shown in the expanded card |
| `exampleImageName` | File name (without path) the component will request from `/operation-examples/` |

Editing a description is a TypeScript-only change — no database or runtime format migration needed.

## Example images

Images are **not** shipped in the repository. Each operation declares an `exampleImageName` (e.g. `pocket-example.png`) and the component requests that file from the Vite `public/` folder at `/operation-examples/<name>`. If the file is missing:
- The `<img>` element fires `onError` and hides itself.
- A fallback `<div>` appears showing **Missing image:** and the exact path where the file should be placed (`public/operation-examples/<name>`).

This keeps the repo lean (zero image blobs) and lets the user add screenshots later by dropping PNGs into `public/operation-examples/` with the names defined in `operationDescriptions.ts`. Supported formats are whatever the browser can render (PNG, JPG, WebP, SVG).

Image names currently defined:

```
pocket-example.png
vcarve-offset-example.png
vcarve-skeleton-example.png
edge-route-inside-example.png
edge-route-outside-example.png
surface-clean-example.png
engrave-example.png
drilling-example.png
rough-surface-example.png
finish-surface-example.png
finish-surface-cleanup-example.png
```

## Pass selection

Operations that support rough/finish passes (pocket, edge_route_inside, edge_route_outside, surface_clean) show three inline buttons — **Rough**, **Finish**, **Both** — directly in the row. Operations that don't support passes (follow_line, v_carve, v_carve_recursive, drilling, rough_surface, finish_surface, finish_surface_cleanup) show a single **+** button. There is no separate pass-selection step; the old two-step flow (select operation → select pass) is eliminated.

## Tests

- Unit test for expandable state management (only one expanded at a time)
- No critical engine logic changes, so minimal test suite addition
- Manual testing: verify expand/collapse behavior, layout on tablet/desktop, image loading

## Open questions / risks

1. **Rich content in descriptions:** ✅ Resolved — images are referenced by name from `/operation-examples/`, not bundled. If missing, a fallback message shows the expected file path. User provides PNGs separately.

2. **Responsive design:** ✅ Implemented — compact rows (24px desktop / 28px tablet), responsive pass buttons, and media queries at 768px.

3. **Localization:** English-only for now; strings in `operationDescriptions.ts` are easy to internationalize later.

4. **Description content ownership:** The user owns the descriptions; they're plain TypeScript objects in `operationDescriptions.ts`.

## Out of scope

- Modifying operation creation logic itself (all target validation, tool assignment, etc. unchanged)
- Creating a help system or tooltip library (this is just one UI improvement)
- Rearranging or renaming operations themselves
- Localizing descriptions (English only for MVP)
