---
status: current
authoritative-for: tablet interaction, shell, command-surface, and focus design
last-verified: 2026-07-15
---

# Tablet UX Design

## Product target

PureCutCNC supports iPad-class tablets in landscape as a first-class interaction
target. Compact 7–8 inch tablets are supported by the shell architecture but
may receive less dense layouts as that surface matures. Phone-sized touch
devices remain intentionally blocked.

The implementation sequence and completed migration notes are preserved in
[`archive/TABLET_UX_COMBINED_PLAN.md`](archive/TABLET_UX_COMBINED_PLAN.md).

## Cross-device principles

1. **Canvas first.** The sketch or active viewport remains the primary surface;
   panels and drawers must not permanently consume the workspace.
2. **Visible primary actions.** Hover, right-click, double-click, and keyboard
   shortcuts may enhance desktop use but cannot be the only path on tablet.
3. **Intent-based labels.** Touch commands describe the action, not the desktop
   key that happens to trigger it.
4. **Shared semantics.** Mouse, pen, and touch use the same store actions and
   workflow state even when their controls differ.
5. **No accidental interaction loss.** Popovers, drawers, dialogs, and workflow
   panels preserve or deliberately restore the correct canvas phase and focus.
6. **Tablet impact is routine.** Shared command, panel, dialog, canvas, 3D, and
   simulation changes are reviewed on both desktop and tablet.

## Shell and command surfaces

The shell distinguishes desktop and coarse-pointer/tablet layouts using stable
shell state rather than relying only on scattered media queries. Tablet layouts
must provide:

- a discoverable way to reopen hidden project and operations panels;
- touch-sized command targets and scrollable overflow;
- command surfaces that do not depend on unavailable keyboard modifiers;
- room for future compact-tablet placement without changing command semantics;
- consistent access to file, history, view, creation, selection, and CAM tasks.

## Canvas and viewport input

- Pointer events are the common input boundary for mouse, pen, and touch.
- Single-touch geometry selection and manipulation must not conflict with
  empty-space pan gestures.
- Multi-touch navigation must not create or edit geometry accidentally.
- Long-press is a secondary convenience, not the only command path.
- Touch and pen interaction must not depend on hover state.
- 3D preview and simulation expose explicit touch navigation behavior.

## Workflow panels and focus

Workflow panels are shared cross-device controls, not tablet-only overlays.
Their focus contract is phase-aware:

1. canvas input phases keep or restore canvas focus;
2. explicit numeric-entry phases may focus the active input;
3. applying, advancing, or cancelling returns focus to the surface required for
   the next action;
4. opening a popup must not wipe draft values or break sketch interaction;
5. dragging a panel with mouse or touch must not trigger the underlying canvas.

Modal dialogs restore the prior canvas/workspace focus on close when the next
action belongs there.

## Layout and accessibility

- Primary touch targets should be approximately 44 CSS pixels or larger.
- Dialogs and panels must fit supported landscape heights and allow internal
  scrolling without clipping actions.
- Selection, active mode, disabled state, warnings, and pending steps cannot be
  conveyed by hover alone.
- Compact layouts may hide secondary text, but must preserve accessible names
  and a visible path to every primary action.

## Verification

Tablet-affecting changes should combine focused logic tests with real rendered
workflow checks. Use browser e2e for DOM/menu/dialog wiring, then manually check
the relevant flows at a tablet viewport with touch/coarse-pointer behavior.
Desktop mouse and keyboard regression remain part of the same acceptance pass.
