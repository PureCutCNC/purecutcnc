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
1. Convert the operation grid layout to a vertical list with each operation as a row
2. Each row contains:
   - Operation name/label (left side)
   - (?) Info icon (center/clickable)
   - Button to add the operation (right side)
3. When user clicks the (?) icon, that operation expands below to show a rich description card
4. Only one description card is expanded at a time; clicking (?) on another operation collapses the current one

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

- `src/components/cam/CAMPanel.tsx` — extract operation add menu logic; reduce menu render size
- *(new)* `src/components/cam/OperationAddMenu.tsx` — new component for vertical list + expandable cards
- *(new)* `src/types/operationDescriptions.ts` — operation descriptions data structure
- `src/styles/layout.css` — new styles for vertical list, expandable cards, info icons

## Tests

- Unit test for expandable state management (only one expanded at a time)
- No critical engine logic changes, so minimal test suite addition
- Manual testing: verify expand/collapse behavior, layout on tablet/desktop, image loading

## Open questions / risks

1. **Rich content in descriptions:** Where should operation description images come from? Options:
   - Embed as data URIs in the descriptions object (simpler, larger bundle)
   - Reference external URLs (lighter, requires internet or CDN)
   - Generate small SVG diagrams dynamically (cleanest, but more complex)
   - For MVP, suggest simple text + 1-2 key points per operation; images can be added later

2. **Responsive design:** Should the layout adapt on mobile/tablet? Current menu is already absolute-positioned and scrollable. Suggest keeping similar layout but may need width adjustment.

3. **Localization:** Should descriptions be localized? For MVP, English-only is fine; mark strings for future i18n if needed.

4. **Description content ownership:** Who owns the descriptions? Suggest Frank (user) edits them as needed; they're design/content, not code.

## Out of scope

- Changing the pass selection logic (rough/finish/pair modes) — those stay below the operation list
- Modifying operation creation logic itself (all target validation, tool assignment, etc. unchanged)
- Creating a help system or tooltip library (this is just one UI improvement)
- Rearranging or renaming operations themselves
- Localizing descriptions (English only for MVP)
