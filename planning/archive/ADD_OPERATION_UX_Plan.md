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

---

# Post-Implementation Review (2026-05-25)

> Review of the merged changes on branch `feat/operation-ui-improvements` against the project's standard styling conventions and React patterns. The functional behaviour (vertical list, expandable cards, per-row pass buttons) works as intended, but the styling and a couple of React patterns diverged from the rest of the codebase. The findings below are scoped to bring the new UI in line with existing conventions — no functional behaviour should change.

## Files in scope

- [src/components/cam/OperationAddMenu.tsx](src/components/cam/OperationAddMenu.tsx) — new component (189 lines)
- [src/styles/layout.css:3228-3500](src/styles/layout.css) — new CSS block (272 lines)
- [src/components/cam/CAMPanel.tsx](src/components/cam/CAMPanel.tsx) — extraction point, minor refactor

## Project styling conventions (reference)

These are the conventions the new code should match. They are derived from existing code, not invented for this review.

- **Theme tokens** are defined in [src/index.css:23-33](src/index.css:23): `--bg`, `--bg-elev-1`, `--bg-elev-2`, `--line`, `--line-strong`, `--text`, `--text-dim`, `--accent`, `--accent-strong`, `--add`, `--cut`. Use these tokens for any color that participates in the theme. Raw hex/rgba should be reserved for one-off, theme-independent values (e.g. shadows, scrim overlays).
- **Buttons** use `.feat-btn` (primary), `.feat-btn--active`, `.feat-btn--primary`, `.feat-btn--delete`, or `.cam-subtab` (sub-tab/toggle). Do not write `all: unset` to roll a new button from scratch when one of these fits.
- **Menu container** (`.cam-add-menu`, [src/styles/layout.css:2589](src/styles/layout.css)) already defines `position: absolute`, `z-index: 10`, background, border, and shadow. Variants should layer on top of this, not fight it.
- **No `!important`** outside of media-query specificity bumps. The 4 pre-existing `!important` declarations in the codebase are all inside `@media` rules; non-media `!important` is not a project pattern.
- **Direct DOM mutation is not used in React components.** State changes go through `useState` / `useReducer`; refs are used for measurement, focus, and scroll, not for `el.style.display = …`.
- **Font weights**: `.feat-btn` is `font-weight: 600`. Section labels (`.cam-add-menu__label`) are uppercase 11px with `letter-spacing: 0.08em`. Body text uses default weight.

## Findings

The findings are ordered by impact. Each one names the exact location and the convention it violates.

### 1. `!important` cascade overrides on `.cam-add-menu--vertical` — **High**

**Location:** [src/styles/layout.css:3232-3243](src/styles/layout.css), [src/styles/layout.css:3455-3460](src/styles/layout.css).

**Problem:** Before this branch the file had 4 `!important` declarations, all inside `@media` rules. This branch adds 12 more, none inside media-specificity rules. They exist because `.cam-add-menu--vertical` and `.cam-add-menu` have the same CSS specificity (0,1,0), so the variant uses `!important` to win.

**Fix:** Restructure the base/variant relationship so `!important` is unnecessary. Two acceptable options:

- **Option A (preferred):** Move layout properties (`display`, `gap`, `padding`, `width`, `border-radius`, `max-height`, `overflow-*`) out of `.cam-add-menu` and into a horizontal variant `.cam-add-menu--horizontal`. Keep only positioning/visual chrome (`position`, `top`, `right`, `z-index`, `border`, `background`, `box-shadow`) on the base. Apply `.cam-add-menu--horizontal` everywhere the old menu was used, and `.cam-add-menu--vertical` where appropriate. No callers will need to change behaviourally.
- **Option B:** Don't put `.cam-add-menu` on the new container at all. Use only `.cam-add-menu--vertical` and inline the small set of base properties it actually needs (position, z-index, border, background, box-shadow). This is slightly more duplication but zero `!important`.

Either way, the result must be **zero `!important` outside `@media` rules** in the new block.

### 2. Raw colors that should be theme tokens — **High**

**Location:** [src/styles/layout.css:3228-3500](src/styles/layout.css), multiple sites.

**Problem:** Several text and accent colors are hard-coded hex/rgba rather than referencing `var(--…)`. This breaks theming and visually drifts from the rest of the panel.

| Current | File:line (approx) | Replace with |
|---|---|---|
| `color: #c8ddf0` (description) | `.cam-operation-details__description` | `var(--text)` |
| `color: #8899aa` (fallback text, keypoints label) | `.cam-operation-details__image-fallback`, `.cam-operation-details__keypoints-label` | `var(--text-dim)` |
| `color: #a8b8c8` (keypoint list item) | `.cam-operation-details__keypoint` | `var(--text-dim)` |
| `rgba(220, 165, 106, 0.08)` (pass-btn hover bg) | `.cam-operation-pass-btn:hover:not(:disabled)` | `color-mix(in oklab, var(--accent) 8%, transparent)` |
| `rgba(220, 165, 106, 0.15)` (pass-btn active bg) | `.cam-operation-pass-btn:active:not(:disabled)` | `color-mix(in oklab, var(--accent) 15%, transparent)` |
| `rgba(255, 255, 255, 0.15)` (pass-btn border) | `.cam-operation-pass-btn` | `var(--line-strong)` |
| `rgba(255, 255, 255, 0.05/0.08)` (item dividers, image container border) | `.cam-operation-item`, `.cam-operation-details__image-container` | `var(--line)` |

Note: `rgba(255, 255, 255, 0.02/0.03)` used purely as a hover/expand background tint may stay as-is — those are theme-agnostic surface tints (the codebase uses similar patterns elsewhere). The rule of thumb: if the value semantically represents text, an accent action, or a border line, it must be a token.

### 3. Pass buttons reinvent `.cam-subtab` — **Medium**

**Location:** [src/components/cam/OperationAddMenu.tsx:96-125](src/components/cam/OperationAddMenu.tsx), [src/styles/layout.css:3410-3445](src/styles/layout.css).

**Problem:** The original implementation used `.cam-subtab` for the Rough / Finish / Rough+finish toggle ([CAMPanel.tsx pre-refactor](src/components/cam/CAMPanel.tsx)). The new implementation introduces `.cam-operation-pass-btn` (built with `all: unset` and a custom border/hover) for the same role inside the same panel. Result: two competing button languages on screen at once — the `+` button uses `.feat-btn`, the pass buttons use the new style.

**Fix:** Replace `.cam-operation-pass-btn` markup and CSS with `.cam-subtab`. If the existing 32px `.cam-subtab` height is too tall for the dense row layout, add a `.cam-subtab--compact` modifier that lowers `min-height` and `padding` while keeping the same colors, border, and hover behaviour. Do **not** keep the bespoke style.

Delete `.cam-operation-pass-btn`, `.cam-operation-pass-btn:hover:not(:disabled)`, `.cam-operation-pass-btn:active:not(:disabled)`, and `.cam-operation-pass-btn:disabled` from layout.css after the swap.

### 4. `all: unset` is not a project pattern — **Medium**

**Location:** [src/styles/layout.css:3296](src/styles/layout.css) (`.cam-operation-label-btn`), [src/styles/layout.css:3411](src/styles/layout.css) (`.cam-operation-pass-btn`), [src/styles/layout.css:3389](src/styles/layout.css) (`.cam-operation-details__keypoints-list`).

**Problem:** The codebase had zero uses of `all: unset` before this branch. The convention is explicit property styling (`.feat-btn` etc.).

**Fix:**
- `.cam-operation-pass-btn`: removed entirely as part of finding #3.
- `.cam-operation-label-btn`: replace `all: unset` with explicit declarations — `background: none; border: none; padding: 0; font: inherit; color: var(--text); cursor: pointer; text-align: left;`. Keep the hover/expanded color rules.
- `.cam-operation-details__keypoints-list`: replace `all: unset` with `list-style: disc; margin: 0; padding: 0 0 0 18px;`. The list semantics (`list-style: disc` later in the same block on `.cam-operation-details__keypoint`) need a real `<ul>` style, not unset.

### 5. Direct DOM mutation for image fallback — **Medium**

**Location:** [src/components/cam/OperationAddMenu.tsx:139-149](src/components/cam/OperationAddMenu.tsx).

**Problem:** The `onError` handler mutates `el.style.display` and reaches into `nextElementSibling.style` to swap visibility. The fallback element is rendered with inline `style={{ display: 'none' }}`. This bypasses React, depends on sibling order, and re-runs on every re-render (the error state isn't persisted).

**Fix:** Track per-row image error state via React state. Since multiple operations can be expanded over the menu's lifetime, the cleanest shape is a `Set` keyed by `OperationKind` (or a `Record<OperationKind, boolean>`). Sketch:

```tsx
const [imageErrors, setImageErrors] = useState<Set<OperationKind>>(new Set())
// …
{imageErrors.has(button.kind) ? (
  <div className="cam-operation-details__image-fallback">…</div>
) : (
  <img
    src={`/operation-examples/${description.exampleImageName}`}
    alt={`${description.title} example`}
    className="cam-operation-details__image"
    onError={() => setImageErrors((prev) => new Set(prev).add(button.kind))}
  />
)}
```

Remove the inline `style={{ display: 'none' }}` on the fallback and the `nextElementSibling` mutation. Update the CSS so `.cam-operation-details__image-fallback` no longer relies on being toggled in-place (it just renders when active).

### 6. `useEffect` couples child to parent class name — **Low**

**Location:** [src/components/cam/OperationAddMenu.tsx:50-58](src/components/cam/OperationAddMenu.tsx).

**Problem:** The auto-scroll effect calls `expandedRef.current.closest('.cam-add-menu')`. The component now needs to know its parent's class name — change `.cam-add-menu` → anything else and this silently breaks.

**Fix:** Either (a) scroll the row's own ref into view unconditionally (the browser does the right thing when the element is already visible — no need to inspect the scroll parent), or (b) accept a `scrollContainerRef` prop from the parent. Option (a) is simpler and matches the lightweight UX intent:

```tsx
useEffect(() => {
  expandedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}, [expandedOperationKind])
```

### 7. Animation `max-height: 500px` magic number — **Low**

**Location:** [src/styles/layout.css:3340-3349](src/styles/layout.css) (`@keyframes cam-operation-expand`).

**Problem:** The animation interpolates `max-height` from `0` to `500px`. Any description that renders taller than 500px (longer key-point list, taller image) will be clipped mid-animation.

**Fix:** Two acceptable options:
- Drop the `max-height` interpolation and animate only `opacity` + a small `transform: translateY(-4px) → 0`. Layout-driven height is implicit.
- Use the `grid-template-rows: 0fr → 1fr` technique on `.cam-operation-details` wrapped in a parent grid; this animates intrinsic content height without a magic cap.

Either works — pick whichever is simpler given the current markup. Both eliminate the clipping risk.

### 8. Font weight on the operation label — **Low**

**Location:** [src/styles/layout.css:3299](src/styles/layout.css) (`.cam-operation-label-btn`).

**Problem:** `font-weight: 500` is one step below the project's standard `600` used by `.feat-btn` and similar primary controls. Mild visual inconsistency.

**Fix:** Change to `font-weight: 600` unless the lighter weight was a deliberate choice for the dense vertical list. (If deliberate, leave as-is and document it inline; this finding is low priority.)

### 9. `selectedNewOperationKind` prop is now mostly vestigial — **Low / cleanup**

**Location:** [src/components/cam/OperationAddMenu.tsx:30-46](src/components/cam/OperationAddMenu.tsx), [src/components/cam/CAMPanel.tsx:1226-1232](src/components/cam/CAMPanel.tsx).

**Problem:** The expansion state lives locally as `expandedOperationKind`. `selectedNewOperationKind` is now only used to color the `+` button via `feat-btn--active` for non-pass operations — and clicking that button only calls `onChooseOperation`, never adding the operation. Most operations are pass-capable, so `selectedNewOperationKind` is rarely set in practice.

**Fix:** Confirm what `selectedNewOperationKind` represents now. If it's still meaningful (e.g. for the hint shown at the bottom of the menu) keep it but document via comment why both `selectedNewOperationKind` and `expandedOperationKind` exist. If it's vestigial after the inline-pass refactor, remove the prop, the `feat-btn--active` toggle, and the related state in `CAMPanel`. The end-of-menu hint can be driven off `expandedOperationKind` instead.

## Acceptance criteria for the fix

A follow-up implementation closing these findings is considered done when:

1. No `!important` declarations exist in `.cam-add-menu--vertical` or its descendants outside of `@media` blocks.
2. No new `all: unset` declarations exist in `layout.css`.
3. Every text/accent/border color in the new block resolves through a `var(--…)` token (see the table in finding #2).
4. The Rough / Finish / Both buttons use `.cam-subtab` (or `.cam-subtab--compact`), not a bespoke class.
5. The image fallback is driven by React state, not by mutating `el.style.display`.
6. `npm run build` succeeds with no new warnings.
7. Manual smoke test in the running dev server: opening Add Operation, expanding/collapsing rows, clicking Rough/Finish/Both, and seeing the fallback when an image is missing — all still work exactly as they do today.

## Out of scope for the fix

- Changing the vertical-list UX, row heights, or which descriptions appear. This review is styling/code-quality only.
- Touching `operationDescriptions.ts` or the underlying operation-add logic in `CAMPanel`.
- Adding new operations, images, or copy.
- Any behavioural changes to the existing horizontal `.cam-add-menu` elsewhere in the app (if option A in finding #1 is taken, the base class change must be invisible to other call sites).
