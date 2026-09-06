# INDEX — src/app/

App-level orchestration hooks that keep `App.tsx` as the composition root without owning subsystem machinery.

## Files
- [`toolpathGeneration/`](toolpathGeneration/INDEX.md) — worker-backed generation (issue #675): the queue, authoritative cache, main↔worker protocol, and the inline and worker execution backends. Slices 1–2 only — no consumer uses it yet, so the worker is not in the app's module graph
- `useToolpathGeneration.ts` — toolpath generation, cache invalidation, one-per-frame scheduling, and derived visible/colliding toolpath state. Generation itself now lives in `src/engine/toolpaths/generateOperation.ts` and the cache rules in `toolpathGeneration/cacheInputs.ts`; `isCacheHit` and `buildToolpathCacheEntry` remain here as thin wrappers so the existing suites are unchanged
- `useToolpathGeneration.test.ts` — React-free tests for cache invalidation and the one-per-frame scheduling core
- `useToolpathGenerationScheduling.test.ts` — React-free tests for the issue #518 scheduling behaviour: stale results stay in the map while a recompute is pending, the map is rebuilt from `neededOperationIds`, and `deferGeneration` coalesces a drag gesture into one regeneration
- `useToolpathGenerationToolNarrowing.test.ts` — React-free tests that an unrelated tool import/edit/delete leaves an operation's cache valid, while a change to the operation's own tool invalidates it (issue #518)
- `useSimulationModel.ts` — simulation result, operation count, and playback-input derivation
- `useSimulationModel.test.ts` — DOM-free tests for off-tab result and operation-count branches
- `useTreeContextMenu.ts` — feature-tree context-menu state, derived entities, submenu state (quick ops, folders, add/remove operation targets), and viewport-aware positioning
- `useTreeContextMenu.test.ts` — DOM-free tests for feature/tab/clamp routing and close/reset behaviour
- `useFeatureTreeActions.ts` — feature-tree menu action dispatchers for feature, tab, clamp, stock, quick-operation, and add/remove-operation-target commands
- `useFeatureTreeActions.test.ts` — DOM-free tests for representative feature-tree action dispatch shapes
- `useSnapSettings.ts` — snap preference persistence, active snap mode state, and snap-mode toggle reducers
- `useSnapSettings.test.ts` — React-free tests for snap enabled/mode reducer behaviour
- `useZoomWindow.ts` — zoom-window active state and Escape cancellation handling
- `useEmptyStateEngagement.ts` — empty-state overlay engagement latch and opened-project framing actions
