# INDEX — src/app/

App-level orchestration hooks that keep `App.tsx` as the composition root without owning subsystem machinery.

## Files
- `useToolpathGeneration.ts` — toolpath generation, cache invalidation, one-per-frame scheduling, and derived visible/colliding toolpath state
- `useToolpathGeneration.test.ts` — React-free tests for cache invalidation and the one-per-frame scheduling core
- `useSimulationModel.ts` — simulation result, operation count, and playback-input derivation
- `useSimulationModel.test.ts` — DOM-free tests for off-tab result and operation-count branches
- `useTreeContextMenu.ts` — feature-tree context-menu state, derived entities, submenu state, and viewport-aware positioning
- `useTreeContextMenu.test.ts` — DOM-free tests for feature/tab/clamp routing and close/reset behaviour
- `useFeatureTreeActions.ts` — feature-tree menu action dispatchers for feature, tab, clamp, stock, and quick-operation commands
- `useFeatureTreeActions.test.ts` — DOM-free tests for representative feature-tree action dispatch shapes
- `useSnapSettings.ts` — snap preference persistence, active snap mode state, and snap-mode toggle reducers
- `useSnapSettings.test.ts` — React-free tests for snap enabled/mode reducer behaviour
- `useZoomWindow.ts` — zoom-window active state and Escape cancellation handling
- `useEmptyStateEngagement.ts` — empty-state overlay engagement latch and opened-project framing actions
