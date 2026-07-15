---
status: proposed
authoritative-for: toolbar redesign constraints and unresolved interaction decisions
last-verified: 2026-07-15
---

# Toolbar — revisit (tech debt)

> **The current toolbar is a temporary, stabilised state — not the final design.**

## Where things stand

The toolbar is now permanently left-docked (no movable-toolbar choice). To keep it
usable we added:

- a **scrollable left rail** with top/bottom fade hints so tall tool sets are reachable;
- **portaled popover menus** (align / distribute / dimensions, plus the tablet
  `RailFlyout`) so they aren't clipped by the scrolling rail.

This was deliberately minimal — it fixes "buttons cut off" and "popover clipped" without
redesigning anything. See archived
[`archive/TOOLBAR_PERMANENT_LEFT_DOCK_Plan.md`](archive/TOOLBAR_PERMANENT_LEFT_DOCK_Plan.md)
for what shipped, and the abandoned overhaul attempt for what *not* to repeat (a big
structural split + width-based overflow that introduced regressions and was scrapped).

## Why it still needs work

- The editing state still surfaces a lot at once (transform family + align + distribute +
  copy/delete/constraint); scrolling hides the crowding rather than resolving it.
- Discoverability of scrolled-off tools relies on a subtle fade hint.
- `Toolbar.tsx` remains a ~1.6k-line monolith with triplicated wiring
  (`Toolbar` / `GlobalToolbar` / `CreationToolbar`) — the merge-conflict hot spot called
  out in [`archive/REFACTORING_Plan.md`](archive/REFACTORING_Plan.md) §5.

## When revisiting

Treat it as a proper UX pass, not incremental tweaks. Open questions to settle first:
grouping/altitude of editing actions, whether contextual tools belong in the rail vs. a
context panel, and the structural split of `Toolbar.tsx`. Get the interaction model
agreed before touching code — the previous attempt over-scoped and was scrapped.
