# INDEX — src/app/featureEffect/

The "no effect on the final shape" warning's main-thread half (issue #1112
slice N, decision 12). The analysis itself is the pure engine module
`../../engine/featureEffect.ts`; this folder only decides what to send, when,
and which answer may reach the tree.

## Files

- `effectInput.ts` — `buildEffectFeatures(project, resolvedFeatures)`: the
  analysis input in tree-fold order. Resolves real outlines through
  `text`'s `resolveFeatureGeometryShapes` (so Text and canned flat shapes
  contribute their pieces, not a placement frame), resolves named Z
  dimensions, keeps hidden add/subtract rows so an unrelated visibility toggle
  does not renumber the tree, and drops models (imported STL and the canned
  Turn/Polygon) and Around rows on a stock that does not model the sheet.
- `effectInput.test.ts` — the input contract: model and non-shape rows are
  absent, named dimensions resolve, Around folds only on a rotary round bar.
- `protocol.ts` — the worker wire format (types only).
- `featureEffect.worker.ts` — owns one `FeatureEffectAnalyzer` for the worker's
  life so the per-feature cache survives edits; answers each request with its
  request id.
- `client.ts` — `FeatureEffectClient`: debounces the tree after edits settle,
  owns the worker lazily, drops any result or error whose request id is not the
  latest, tags every result with the input snapshot it was computed from, and
  publishes an empty result for the current snapshot when the worker fails.
- `client.test.ts` — the ordering rules with a mocked worker and hand-driven
  debounce timer: a burst becomes one request; a stale result/error is dropped;
  a result carries its snapshot; a worker failure clears the current warnings.
- `useFeatureEffectWarnings.ts` — the React binding the feature tree calls; owns
  the client for the tree's lifetime and returns only a warning id set computed
  from the current input snapshot, so moving a covering feature away hides the
  old ⚠ while the newer analysis runs.
- `useFeatureEffectWarnings.test.ts` — a real `linkedom` render with a fake
  worker: a result for an earlier input is hidden immediately, and a worker
  failure clears the warning.
- `INDEX.md` — this file.
