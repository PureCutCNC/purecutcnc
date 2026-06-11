---
status: In progress
created: 2026-06-11
---

# Feature Creation Picker POC Plan

## Goal

Prototype a compact feature-creation control in the left rail so the user can evaluate the drawer-plus-last-used-tool interaction before committing to a broader toolbar redesign. The visible outcome should be a two-button creation control: one button opens a feature shape drawer, and the second button immediately repeats the last selected shape with that shape's icon.

## Approach

- Replace the vertical list of individual feature creation buttons in the desktop left creation toolbar with a small POC control.
- Keep the existing creation target toggle for feature/region behavior.
- Add a drawer/flyout button that exposes rectangle, circle, ellipse, polygon, spline, composite, and text.
- Track the last selected creation shape locally in the toolbar UI, defaulting to rectangle.
- Make the repeat button show the last selected tool's icon and label; clicking it starts or cancels that tool through the existing creation handlers.
- Keep hover behavior conservative for the POC: support click/tap first, delay hover-open enough for the trigger tooltip to appear, and reuse the same hover-open behavior for align/distribute popovers.
- Add an easel-style drawer trigger icon through the `icons.camj` icon workflow so the POC uses the intended affordance immediately.
- Mount toolbar-launched dialogs at `document.body` so the text feature dialog is not constrained by the scrollable left rail.
- Hide text creation while the target is Region, because text currently creates features only.
- Use the shared popover styling for creation, align, and distribute drawers.
- Track whether a drawer was opened by hover or click so a hover-opened drawer is not closed by the user's opening click.
- Apply the same drawer-plus-repeat creation model to the tablet `ToolRail`, using click-only flyouts because touch devices do not have hover.

## Files affected

- `src/components/layout/Toolbar.tsx` — add the compact feature creation picker POC and wire it to existing creation handlers.
- `src/components/layout/ToolRail.tsx` — keep tablet creation behavior aligned with a click-only easel drawer plus last-used repeat button; hide text for regions and portal the text dialog.
- `src/styles/layout.css` — style the two-button rail control and drawer/flyout.
- `src/styles/tablet.css` — keep the tablet creation popover active state aligned with existing rail flyout styling.
- `src/assets/icons.camj` — add the easel-style drawer trigger icon source.
- `public/icons.svg` — regenerated icon sprite output from `icons.camj`.

## Tests

- Run `npm run build`.
- Verify manually in the running app at `http://localhost:1420/` that the rail renders, the drawer opens, selecting a shape updates the repeat icon, the repeat button starts/cancels placement, region mode hides text, and click/hover opening does not fight the user.
- Check tablet impact because tablet has a separate `ToolRail` path: creation should use click-to-open easel drawer, last-used repeat, and no text option when creating regions.

## Open questions / risks

- Hover-open may be distracting; the delay should feel responsive without opening before the trigger label is readable.
- Text creation opens a modal dialog, so it must be portaled out of the scrollable toolbar rail rather than styled as part of the rail.
- The easel icon must remain readable at rail-button size; if it feels too detailed, simplify the source paths rather than adding CSS-only decoration.

## Out of scope

- Full left toolbar redesign.
- Transform, boolean, constraint, align, distribute, or sketch-edit picker groups.
- Persisting last-used tool across reloads.
- Refactoring the `Toolbar.tsx` monolith beyond what the POC needs.
