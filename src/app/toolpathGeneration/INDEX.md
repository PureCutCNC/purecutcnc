# INDEX — src/app/toolpathGeneration/

Worker-backed toolpath generation (issue #675): the queue, cache, protocol and
execution backends that sit between the application and the engine's single
synchronous entry point, `src/engine/toolpaths/generateOperation.ts`.

**The division of labour is the design.** The engine computes; this folder
decides *when* and *where*, and what is allowed to become a current result.
Neither half knows about React. The worker knows about neither.

## Slice status

Slices 1-4 of the plan in issue #675 are implemented: the extracted pipeline,
the service, both executors, the harness, every application consumer, and the
opt-in rollout. `noSyncCallers.test.ts` enforces that nothing outside the two
executors generates directly.

**The worker is opt-in and the default is still the main thread.** The backend
is chosen from the status bar, stored per machine (never in `.camj`), and the
worker really runs: `generationBackend.smoke.spec.ts` proves in Chromium *and*
WebKit that choosing it starts a real `Worker` and that the G-code it produces
is identical to the main thread's, and `npm run check:worker-production` proves
the built chunk starts and completes its handshake when served from a nested
static path.

Slice 5 — turning the worker on by default — is a maintainer decision and has
not been taken.

## Files
- `types.ts` — the shared vocabulary: `RequestIdentity` (document key, worker epoch, request/snapshot ids, operation, trace mode), terminal `GenerationOutcome`s, failure categories, per-operation status, and the immutable status snapshot React subscribes to. A completed empty path with warnings is a *successful* result; infrastructure failure is never encoded that way and never joins the CAM warning codes
- `protocol.ts` — the main↔worker message contract and its validators. Payloads cross by structured clone, not JSON: JSON drops `undefined` keys and flattens `NaN`/`Infinity` to `null`, all of which occur in real toolpath metadata. Nothing here repairs a message — a mismatch settles the request as a `protocol` failure. The operation is resolved from the installed snapshot rather than sent alongside it, so two copies can never disagree
- `cacheInputs.ts` — the cache's input stamp and validity predicate, extracted mechanically from `useToolpathGeneration` (which now re-exports `isCacheHit`/`ToolpathCacheEntry` as thin wrappers, so the existing cache suites keep testing the production rules). Split from the entry because an in-flight job has inputs but no result and still has to be checkable. Stays main-thread: validity is decided by *reference identity*, which a structured clone destroys
- `executor.ts` — the backend seam. `supportsHardCancellation` is the honest difference between the two: only the worker can stop work already running
- `inlineExecutor.ts` — the compatibility backend, generation on the main thread behind the async contract. Exists so consumers can migrate in one step with threading as a separate, revertible decision. `terminate()` cannot interrupt a running generator — it can only guarantee the abandoned result is never installed, which makes Stop correct here but not immediate
- `workerExecutor.ts` — the worker's main-thread half: one worker, one installed snapshot, one in-flight request, re-sending the snapshot only when a different one is named. Cancellation is `Worker.terminate()`, never a message: a worker inside synchronous Clipper code cannot reach its own event loop, so a `cancel` would be read only after the work it meant to stop had finished. A startup-only handshake timeout; computation has no elapsed-time kill, because slow is not broken. Never falls back to inline on failure
- `toolpath.worker.ts` — the worker. Holds one snapshot, computes one operation, keeps no result history (the authoritative cache is main-thread, and a second copy here would leak in a realm the main thread cannot clear). Clears `clearImportedModelCaches()` on snapshot replacement for the same reason. Declares its own three-member worker scope locally rather than adding `"WebWorker"` to `lib`, which would collide with `DOM` across every browser source
- `workerThreadAdapter.ts` — node-only test support: shims `self` onto `parentPort` so `workerRuntime.test.ts` can run the shipped worker module unmodified on a real `worker_threads` thread
- `executorPreference.ts` — the storage key, parsing and runtime resolution for the backend choice. Machine-local by construction: not in `.camj`, not in undo history, because where a toolpath was computed cannot change what it is — and a project carrying the choice would carry it to a machine where the worker is not fine. An unrecognised stored value falls back to the default rather than throwing, so a stale entry costs a setting and not a working application
- `useExecutorPreference.ts` — keeps `preference` (what the user chose, what the menu shows) distinct from `resolved` (what generation will use). They differ where the runtime has no `Worker`: the choice is remembered for when it can be honoured while generation quietly falls back. `canStop` is derived from `resolved`, so a fallback cannot leave the UI offering a Stop that does nothing
- `useGenerationService.ts` — React's binding: one service per application, subscribed through `useSyncExternalStore`. Returns both a render-safe `context` and a ref of the same value for callbacks and async continuations. The ref is written in a **layout** effect, not during render: a render React discards must not move what a completion is judged against, and layout narrows the stale window to the gap between commit and that line. A completion landing inside it returns `superseded` — one wasted regeneration, never a result attached to the wrong project
- `exportPreparation.ts` — the rules that decide whether a G-code program may be written. **A program is all of its operations or it is nothing**: a member that failed, was cancelled, superseded, or has no tool blocks the export and names itself, and nothing is filtered out to make the remainder postable. The token binds a prepared program to the inputs it came from — project identity, document key, selection *and its order*, machine, and every postprocessor option — so a preview whose inputs moved is immediately not exportable rather than merely stale-looking
- `useExportPreparation.ts` — drives those rules from the dialog's state, keeping the 300 ms debounce the synchronous version had. Invalidates the previous preparation *before* starting a new one, so there is no window where a stale program still reads as ready, and copies the bytes out at Save time so the file is the program the user approved
- `service.ts` — the queue, the one authoritative cache, and the commit rules. A returned result is attached to the inputs captured at *submission*, never to whatever project is current when it arrives, and is installed only if its identity still matches the active job, its document key is still current, it has not been cancelled or superseded, and the captured inputs still validate against the live project. Foreground beats queued automatic work, FIFO within a class. `automaticDemand` is what makes preview jobs live: they carry no consumer, so without it they are indistinguishable from abandoned work
- `testSupport.ts` — minimal operation/project/result fixtures for the service suites, which are about scheduling rather than geometry

## Tests
- `service.test.ts` — the races, every one driven by a **fake executor released by hand**. Late results for edited operations, a document replaced mid-flight, coalescing, trace-vs-preview separation, one consumer abandoning a job another needs, Stop leaving explicit work running, drag deferral, promotion, failure without auto-retry, backend switch, disposal. Sleeping and hoping is how these bugs ship; nothing here is timing-based. It is also what caught automatic preview demand never running at all
- `transport.test.ts` — protocol validation plus real `structuredClone` fidelity: every corpus project clones (including the million-move and imported-mesh ones), and for one case per operation kind, generating from a *cloned* project yields identical results, raw traces and G-code bytes. Also deep-freezes the project and generates, so mutation throws at the offending write rather than being inferred afterwards
- `workerGraph.test.ts` — walks the worker's transitive imports and fails on React, the store, components or unguarded browser globals, naming the chain. Verified by mutation: importing `projectStore` reaches React in five hops via `machine/store.ts` → `useLocalStorageState.ts`, and drags in `import/svg.ts`'s unguarded globals
- `workerRuntime.test.ts` — the shipped worker on a real thread, its results compared against the pre-extraction baseline: byte-identical toolpaths, raw traces and G-code for all 11 operation kinds, plus A/B/A order independence across snapshot replacement and rejection of a generate naming an uninstalled snapshot. Covers structured-clone transport and separate-realm module state; **not** bundling or `new URL` asset resolution, which need a browser
- `inlineExecutor.test.ts` — the inline backend yields the thread before it takes it. Pins a regression the unit suites structurally could not see: every other test here injects a fake executor, so when the real one yielded only a **microtask** before running a generator, control never left the caller's task and whatever was waiting on the main thread stayed blocked. The browser found it immediately (a `page.evaluate` that had just loaded a project never returned); this makes it fail in Node instead
- `exportPreparation.test.ts` — export completeness and token invalidation, driven through the real service with a hand-released executor so the failure and cancellation paths are exercised rather than simulated. Verified by mutation: dropping a failed member instead of blocking turns the export `ready`, and the suite fails
- `noSyncCallers.test.ts` — the slice-3 acceptance condition as a check: no application module outside the two executors calls `computeOperationToolpath` or a per-kind generator. Scans `src/*.tsx` as well as the subdirectories, because the composition root is `src/App.tsx` and an earlier version of this check silently skipped it
- `executorParity.test.ts` — the service seam preserves output: results reaching a caller through the queue, cache and commit rules still hash to the baseline, a cache hit returns the same object rather than a copy, and `peekCurrent` agrees with what was installed
