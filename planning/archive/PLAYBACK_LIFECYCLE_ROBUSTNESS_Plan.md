---
status: Done
created: 2026-06-03
---

# Playback Lifecycle Robustness Plan

## Goal

Make simulation tool playback deterministic when the selected operation, simulation detail, mode, or playback input changes while playback is enabled. The user-visible outcome is that playback either pauses/resets cleanly or rebuilds into a ready state, without leaving the UI showing active playback while the RAF tick has stopped.

## Approach

- Treat `playbackInput` changes while playback is enabled as an explicit playback reset: stop active playback, cancel any RAF tick, clear progress/pose, and mark playback as building until the replacement controller and meshes are ready.
- Keep the controller/mesh cleanup path centralized inside `SimulationViewport`, and make the build effect update playback readiness consistently for both initial enable and input rebuilds.
- Disable play, stop, seek, speed, and step controls while playback meshes are building or no controller is available, so users cannot issue controls into the null-controller window.
- Preserve the existing behavior where switching away from selected mode, or losing a valid playback input, disables playback entirely.

## Files affected

- `src/components/simulation/SimulationViewport.tsx` — make playback input rebuilds an explicit stop/reset/build transition, tighten RAF cancellation, and disable playback controls while the controller is unavailable.
- `planning/INDEX.md` — track this plan while it is pending/in progress.

## Tests

- Run `npm run build` after implementation.
- Add a focused test only if a practical component or extracted-helper seam emerges during implementation; otherwise document manual QA steps for operation switch, detail change, and mode switch during active playback. Existing simulation tests are engine-level and do not currently cover React/WebGL playback lifecycle state.

## Open questions / risks

- The planned behavior is deterministic pause/reset on input rebuild, not automatic resume after rebuild. This matches the issue's suggested "force `setIsPlaying(false)`" path and avoids silently playing a different operation after a user changes context.

## Out of scope

- Reworking the playback controller algorithm or simulation grid mutation model.
- Adding a full React/WebGL component testing harness if the repo does not already provide one.
- Changing visual styling beyond disabled control states already supported by native controls.
