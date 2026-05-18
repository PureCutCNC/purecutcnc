---
status: Done
created: 2026-05-18
completed: 2026-05-18
---

# README V-Carve Naming Plan

## Goal

The README currently lists V-Carve as two separate operations ("V-Carve" and "V-Carve Recursive"). The actual UI presents them as two modes of one V-Carve operation: **offset** and **skeleton** (where "skeleton" is what the codebase calls `v_carve_recursive`). Update the README so it matches the user-facing terminology.

## Approach

Replace the two V-Carve bullets in the "Define CAM operations" list with a single bullet:

- `V-Carve (offset / skeleton modes)` — or similar phrasing that reads naturally next to the other entries.

No other changes.

## Files affected

- `README.md` — replace the two V-Carve bullets with one combined entry.

## Tests

None — documentation only.

## Open questions / risks

- Confirm "skeleton" is the user-facing label (the CAMPanel grep earlier showed labels "V-Carve offset" and "V-Carve skeleton", so this matches).

## Out of scope

- Renaming the internal `v_carve_recursive` operation kind in code. The data model stays as-is; only the README label changes.
