---
status: Done
created: 2026-05-26
---

# Simulation View Spinner Plan

## Goal

The simulation viewport blocks the UI thread (no spinner) when switching to the
simulation tab or toggling simulation mode. Wrap those two state changes in the
existing `startSimulationTransition` so React defers the heavy `simulationResult`
useMemo and shows the already-wired `isComputing` spinner.

## Approach

In `src/App.tsx`:

1. `onModeChange` — replace bare `setSimulationMode` with a wrapper that calls
   `startSimulationTransition(() => setSimulationMode(mode))`.
2. `onCenterTabChange` — add a `handleCenterTabChange` useCallback that wraps
   `setCenterTab` in `startSimulationTransition` only when the target tab is
   `'simulation'` (switching away is cheap, no transition needed).

No CSS or SimulationViewport changes — the overlay and spinner already exist and
are already driven by `isComputing={isSimulationPending}`.

## Files affected

- `src/App.tsx` — two prop changes + one new useCallback

## Tests

No new unit tests. Build must stay green.

## Out of scope

- Wrapping toolpath-pipeline `setToolpathMap` calls in a simulation transition
  (handles the case where toolpath finishes while simulation tab is open — a
  smaller impact, more invasive change).
