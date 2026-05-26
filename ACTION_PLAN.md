# Operation Selection UX Action Plan

## Background
UX review of the operation selection UI in CAMPanel identified seven improvements
for desktop and tablet/touch users.

## Items

### P1 — Touch targets for compact pass buttons (tablet.css)
**Problem:** `.cam-subtab--compact` overrides the base `.cam-subtab` min-height down to
20 px. The tablet rule that fixes `.cam-subtab` to 44 px doesn't override `--compact`
because specificity is equal. On a coarse-pointer device the Rough / Finish / Both
buttons are too small to tap reliably.

**Fix:** Add `@media (pointer: coarse)` block in `tablet.css` that restores
`min-height: var(--touch-target, 44px)` on `.cam-subtab--compact` and bumps padding and
font-size to match the base `.cam-subtab` touch target.

---

### P2 — Inform "Add Operation" button when no geometry is selected (CAMPanel.tsx + layout.css)
**Problem:** Clicking "Add" opens the menu with all operation buttons disabled, but
gives no upfront reason. Users can be confused about why nothing works.

**Fix:** When `selection.selectedFeatureIds.length === 0`, add class
`cam-header-action--warn` to the "Add" button (amber accent colour) and a `title`
tooltip. The button stays enabled so users can still browse operation descriptions.
Add `.cam-header-action--warn` CSS rule.

---

### P3 — Constrain operation add menu width on small/narrow viewports (layout.css)
**Problem:** `.cam-add-menu--vertical` uses `width: 360px; max-width: 90vw;`.
On narrow screens this can still push content off-screen.

**Fix:** Replace with `width: min(360px, calc(100vw - 2rem));` — single expression
that combines both constraints.

---

### P4 — Chevron on expandable info cards (OperationAddMenu.tsx + layout.css)
**Problem:** The operation label button expands/collapses a detail card but there is
no visual indicator that it is expandable. Users don't discover the feature.

**Fix:** Add `<Icon id="chevron-down" size={12} />` inside the label button. Add CSS
to rotate it 180° when the card is expanded, with a smooth transition.

---

### P5 — Transient confirmation for "Use current selection" (CAMPanel.tsx + layout.css)
**Problem:** On success, `handleApplySelectionToOperation` clears `targetUpdateMessage`
and gives no feedback. User has no confirmation the target was actually updated.

**Fix:** Add a `selectionUpdateConfirm` state (string | null — holds the operationId).
On success, set it to the operationId and schedule a `setTimeout` to clear it after
2 000 ms. Render a `cam-field-message--success` span when it matches the current
operation. Add `.cam-field-message--success { color: #7ddf7d; }` CSS rule.

---

### P6 — Replace Unicode ⧉ with Icon component (CAMPanel.tsx)
**Problem:** The duplicate-operation button renders the Unicode character `⧉`, which
renders inconsistently across platforms and has no semantic meaning for screen readers.

**Fix:** Replace with `<Icon id="copy" size={14} />` (the existing "copy" symbol in
`public/icons.svg`).

---

### P7 — Minimum row height in operation add menu (layout.css)
**Problem:** `.cam-operation-row` has `min-height: 24px`, which is too cramped and
makes rows hard to click accurately on both mouse and touch.

**Fix:** Raise `min-height` to `40px`.
