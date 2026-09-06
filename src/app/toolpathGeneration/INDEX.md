# INDEX — src/app/toolpathGeneration/

Worker-backed toolpath generation (issue #675): the queue, cache, protocol and
execution backends that sit between the application and the engine's single
synchronous entry point, `src/engine/toolpaths/generateOperation.ts`.

**The division of labour is the design.** The engine computes; this folder
decides *when* and *where*, and what is allowed to become a current result.
Neither half knows about React. The worker knows about neither.

## Slice status

Slices 1 and 2 of the plan in issue #675 are implemented: the extracted
pipeline, the service, both executors, and the harness. **No application
consumer uses this yet** — preview, export, simulation, booklet and the debug
dialog still call `useToolpathGeneration`'s synchronous path, and migrating them
is slice 3. Consequently the worker is not in the app's module graph, so `vite
build` does not yet emit a worker chunk and browser worker startup is unverified;
`workerRuntime.test.ts` covers real cross-thread execution in Node instead.

## Files
- `types.ts` — the shared vocabulary: `RequestIdentity` (document key, worker epoch, request/snapshot ids, operation, trace mode), terminal `GenerationOutcome`s, failure categories, per-operation status, and the immutable status snapshot React subscribes to. A completed empty path with warnings is a *successful* result; infrastructure failure is never encoded that way and never joins the CAM warning codes
- `protocol.ts` — the main↔worker message contract and its validators. Payloads cross by structured clone, not JSON: JSON drops `undefined` keys and flattens `NaN`/`Infinity` to `null`, all of which occur in real toolpath metadata. Nothing here repairs a message — a mismatch settles the request as a `protocol` failure. The operation is resolved from the installed snapshot rather than sent alongside it, so two copies can never disagree
- `cacheInputs.ts` — the cache's input stamp and validity predicate, extracted mechanically from `useToolpathGeneration` (which now re-exports `isCacheHit`/`ToolpathCacheEntry` as thin wrappers, so the existing cache suites keep testing the production rules). Split from the entry because an in-flight job has inputs but no result and still has to be checkable. Stays main-thread: validity is decided by *reference identity*, which a structured clone destroys
- `executor.ts` — the backend seam. `supportsHardCancellation` is the honest difference between the two: only the worker can stop work already running
- `inlineExecutor.ts` — the compatibility backend, generation on the main thread behind the async contract. Exists so consumers can migrate in one step with threading as a separate, revertible decision. `terminate()` cannot interrupt a running generator — it can only guarantee the abandoned result is never installed, which makes Stop correct here but not immediate
- `workerExecutor.ts` — the worker's main-thread half: one worker, one installed snapshot, one in-flight request, re-sending the snapshot only when a different one is named. Cancellation is `Worker.terminate()`, never a message: a worker inside synchronous Clipper code cannot reach its own event loop, so a `cancel` would be read only after the work it meant to stop had finished. A startup-only handshake timeout; computation has no elapsed-time kill, because slow is not broken. Never falls back to inline on failure
- `toolpath.worker.ts` — the worker. Holds one snapshot, computes one operation, keeps no result history (the authoritative cache is main-thread, and a second copy here would leak in a realm the main thread cannot clear). Clears `clearImportedModelCaches()` on snapshot replacement for the same reason. Declares its own three-member worker scope locally rather than adding `"WebWorker"` to `lib`, which would collide with `DOM` across every browser source
- `workerThreadAdapter.ts` — node-only test support: shims `self` onto `parentPort` so `workerRuntime.test.ts` can run the shipped worker module unmodified on a real `worker_threads` thread
- `service.ts` — the queue, the one authoritative cache, and the commit rules. A returned result is attached to the inputs captured at *submission*, never to whatever project is current when it arrives, and is installed only if its identity still matches the active job, its document key is still current, it has not been cancelled or superseded, and the captured inputs still validate against the live project. Foreground beats queued automatic work, FIFO within a class. `automaticDemand` is what makes preview jobs live: they carry no consumer, so without it they are indistinguishable from abandoned work
- `testSupport.ts` — minimal operation/project/result fixtures for the service suites, which are about scheduling rather than geometry

## Tests
- `service.test.ts` — the races, every one driven by a **fake executor released by hand**. Late results for edited operations, a document replaced mid-flight, coalescing, trace-vs-preview separation, one consumer abandoning a job another needs, Stop leaving explicit work running, drag deferral, promotion, failure without auto-retry, backend switch, disposal. Sleeping and hoping is how these bugs ship; nothing here is timing-based. It is also what caught automatic preview demand never running at all
- `transport.test.ts` — protocol validation plus real `structuredClone` fidelity: every corpus project clones (including the million-move and imported-mesh ones), and for one case per operation kind, generating from a *cloned* project yields identical results, raw traces and G-code bytes. Also deep-freezes the project and generates, so mutation throws at the offending write rather than being inferred afterwards
- `workerGraph.test.ts` — walks the worker's transitive imports and fails on React, the store, components or unguarded browser globals, naming the chain. Verified by mutation: importing `projectStore` reaches React in five hops via `machine/store.ts` → `useLocalStorageState.ts`, and drags in `import/svg.ts`'s unguarded globals
- `workerRuntime.test.ts` — the shipped worker on a real thread, its results compared against the pre-extraction baseline: byte-identical toolpaths, raw traces and G-code for all 11 operation kinds, plus A/B/A order independence across snapshot replacement and rejection of a generate naming an uninstalled snapshot. Covers structured-clone transport and separate-realm module state; **not** bundling or `new URL` asset resolution, which need a browser
- `executorParity.test.ts` — the service seam preserves output: results reaching a caller through the queue, cache and commit rules still hash to the baseline, a cache hit returns the same object rather than a copy, and `peekCurrent` agrees with what was installed
