# INDEX — src/app/

App-level orchestration hooks that keep `App.tsx` as the composition root without owning subsystem machinery.

## Files
- `useToolpathGeneration.ts` — toolpath generation, cache invalidation, one-per-frame scheduling, and derived visible/colliding toolpath state
- `useToolpathGeneration.test.ts` — React-free tests for cache invalidation and the one-per-frame scheduling core
- `useSimulationModel.ts` — simulation result, operation count, and playback-input derivation
- `useSimulationModel.test.ts` — DOM-free tests for off-tab result and operation-count branches
- `useTreeContextMenu.ts` — feature-tree context-menu state, derived entities, submenu state, and viewport-aware positioning
- `useTreeContextMenu.test.ts` — DOM-free tests for feature/tab/clamp routing and close/reset behaviour
