# INDEX — src/app/simulationWorker/

The square-blank simulation worker (issue #1016 C2 P2). A square blank's replay
was the last simulation work on the UI thread: a CPU profile of the headless
browser measured 66 s to open the Simulation tab and 86 s after a length
resize, all inside `applySquareMoveToGrid` running synchronously from
`useSimulationModel`'s result memo. This folder is the seam that moves that one
replay off the main thread. Flat and round simulation keep the synchronous
path, untouched and byte-identical.

**Only a square blank crosses the boundary.** `isSquareStock` is judged from the
setup input's transient `squareBar` descriptor, and the hook starts a job only
for an input that carries one. A round or flat fixture never constructs a
worker, and its result is still computed during render.

**One job, one worker.** The replay is synchronous and cannot poll a message
queue, so cancellation is `terminate()`, exactly as in the nesting and STEP
workers. Every way out terminates the worker: success, error, crash and abort.
A superseded job is aborted and its answer ignored.

**The job and its answer are plain data.** `SimulationSetupInput` carries the
setup-local project, the setup's operations and their folded `ToolpathResult`s;
all of it survives structured clone, which the focused test proves by cloning
the job before running it. The answer's `Float32Array` heightfields are handed
back by buffer transfer; the interval map is plain number arrays and clones.

## Files

- `squareSimulation.worker.ts` — the worker entry. Receives one `{ type: 'run', job }` and posts either `{ type: 'result', result, startingStock }` or `{ type: 'error', message }`. The computation itself is `runSquareSimulationJob` from `../simulationCompute` — the worker adds no arithmetic of its own, only the message envelope and the transfer list. `handleSquareSimulationMessage` is exported so the test can call the real handler directly (Node has no browser `Worker`). The module only assigns `self.onmessage` when `self` exists, so importing it in Node is inert.
- `squareSimulationClient.ts` — `runSquareSimulation(job, { signal, createWorker })`: posts the job, resolves with `{ result, startingStock }`, rejects with `SquareSimulationCancelledError` on abort (after `terminate()`), and rejects on a reported error, a crash or a malformed response. With no `Worker` — Node tests, or a runtime that cannot construct one — the same job runs in-thread and resolves identically. `createDefaultSquareSimulationWorker` uses the `new URL(…, import.meta.url)` form Vite recognises as a worker entry.
- `squareSimulationClient.test.ts` — the boundary's evidence. The accepted square fixture plus a real prior operation: the real worker handler on a `structuredClone`d job matches `computeSimulationResult` and the pre-worker starting-stock expression cell-for-cell (`topZ`, `initialTopZ`, every material interval), and the fixture proves replaying every operation differs from replaying the prior ones. Also: abort terminates and rejects, an already-aborted signal never starts a worker, a reported failure and a crash reject, the no-Worker and construction-throws fallbacks produce the same grids, round and flat mounts create no worker and compute synchronously, and — through the hook with a fake global `Worker` — a superseded job's stored or late result is never shown for changed inputs. Mutation-checked: worker returns the prior replay as the result, starting stock built from all operations, abort not terminating, stale-job guard removed, a round fixture routed to the worker.

## Notes

- `useSimulationModel.ts` imports the client; the client imports the worker's
  request/response types only (`import type`), so the hook's module graph never
  pulls the worker entry and the worker's graph never pulls React. The shared
  computation lives in `../simulationCompute.ts` for the same reason: a module
  the worker imports must not reach React, the store or the DOM.
- Pending is the existing path: while a job runs, `simulationResult` is `null`
  and `simulationInputPending` is true. A delivered result is matched to the
  render that asked for it by job identity, so even the render before an
  abort's rejection lands shows no stale grid.
- Playback is fed by the same job. A square blank's `getBaseGrid` returns the
  `startingStock` the job built — the prior operations replayed — so the square
  prior replay no longer happens lazily on the first playback frame on the UI
  thread. It does now run once per job whether playback is started or not.
