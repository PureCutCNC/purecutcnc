# #1016 C2 slice P2 — square-blank simulation runs in a Web Worker

Follow the Session rules in #962 (own worktree, format 3.3, tests must bite,
existing output byte-identical). DSH writes code, COMMIT: none. Approved by
Frank on 2026-10-17 ("move the square replay off the main thread") as part of
the approved #1016 C2.

## Why (measured by the manager)

A CPU profile of the headless browser (square blank side 12, length 30, Around
setup, rotary rough then rotary finish, finish selected, Simulation tab) shows
the main thread blocked **66 s to open the simulation** and **86 s after a
length resize**, all inside the square replay, which runs synchronously in
React render: `App → useSimulationModel → useMemo(simulationResult) →
computeSimulationResult → simulateOperationHeightfield → replay.ts →
applySquareMoveToGrid` (`src/engine/simulation/squareMaterial.ts`). While it
runs the whole app is frozen. A parallel slice (P1) makes the searches in
`squareMaterial.ts` cheaper; this slice takes the work off the UI thread so the
app stays responsive however long it takes.

## Scope: square blanks only

Flat and round simulation keep their current synchronous path, untouched and
byte-identical. Only when the simulated stock is a square blank
(`isSquareStock`, i.e. the setup input's grid will carry `squareBar`) does the
work go to the worker.

## What to build

Follow the nesting worker's pattern exactly
(`src/components/nesting/nest.worker.ts`, `nestWorkerClient.ts`,
`nestWorkerClient.test.ts`): `new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })`,
a `createWorker` factory option for tests, cancellation by `terminate()` (the
replay is synchronous and never sees a message), and a synchronous in-thread
fallback when `Worker` is unavailable (Node tests) or creation throws.

New files in `src/app/simulationWorker/`:
- `squareSimulation.worker.ts` — receives one job, runs the existing
  functions, posts the result. A job computes **both**
  (a) the result `computeSimulationResult(...)` already returns for that
  input, and
  (b) in `selected` mode, the playback starting stock: the prior operations'
  replay that `getBaseGrid` builds today in `useSimulationModel.ts`
  (`simulateReplayItemsHeightfield(localProject, priorItems, options).grid`).
  Move the prior-item building into an exported pure function both the worker
  and the sync fallback call, so there is one copy.
- `squareSimulationClient.ts` — `runSquareSimulation(job, { signal, createWorker })`
  returning a Promise; abort → `terminate()` and reject with a cancelled
  error; a worker error → reject (the hook surfaces it as today's error does,
  never an uncut "successful" sheet).
- `INDEX.md` for the folder, and a line in `src/app/INDEX.md`.

Transfer: `SimulationGrid` (`src/engine/simulation/types.ts`) is plain data
plus `Float32Array`s and a `Map<number, readonly number[]>` (`squareMaterial`);
structured clone handles all of it. Transfer the typed arrays' buffers on the
way back. The job carries the setup-local project, the toolpaths it needs,
mode, detail cells and selected operation id — check every field survives
structured clone (no functions/class instances); if `SimulationSetupInput`
carries a non-cloneable field, send only what the computation reads.

`src/app/useSimulationModel.ts`:
- For a square blank, `simulationResult` comes from the worker: start a job in
  an effect keyed on exactly the inputs the current `useMemo` depends on;
  abort the previous job when they change or the tab closes; ignore a result
  whose job is not the latest. While a job runs, report
  `simulationInputPending: true` and `simulationResult: null` (the existing
  pending path the viewport already handles), never a stale result for other
  inputs.
- `simulationPlaybackInput` for a square blank is `null` until the job has
  delivered the starting stock; then `getBaseGrid` returns that grid (same
  caching contract as `lazyOnce`: repeated calls return the same object).
  Do not change `SimulationPlaybackInput`'s type or the viewport.
- Flat/round: the existing `useMemo` and `lazyOnce` paths, unchanged.

## Tests that must bite

- `src/app/simulationWorker/squareSimulationClient.test.ts` (Node, fake worker
  via `createWorker`, plus the real worker module's handler called directly):
  the worker's result and starting stock deep-equal the synchronous functions'
  for the square fixture of `src/app/squareSimulation.test.ts` (asymmetric
  model, valid `defaultRoundWorkholding('chuck', …)`, production
  `computeOperationToolpath`), compare `topZ`, `initialTopZ` and every
  `squareMaterial` entry exactly; abort terminates the worker and rejects;
  a superseded job's late result is dropped; no Worker → fallback gives the
  same result; a worker error rejects.
- Keep `src/app/squareSimulation.test.ts` passing; if the hook path it renders
  becomes async, update it to await the job, without weakening any physical
  assertion. A round and a flat fixture still compute synchronously (assert
  no worker is created for them).
- New React-rendering tests must pass with
  `NODE_OPTIONS=--no-experimental-global-navigator` (CI runs Node 20).

Mutations that must fail (each alone, reverted): worker returns the prior
replay as the result; starting stock built from all operations instead of the
prior ones; abort does not terminate; stale-job guard removed; a round fixture
routed to the worker.

## Off limits

`src/engine/**` (P1 owns `squareMaterial.ts`; no engine edits at all),
`src/components/**` (another worker owns the simulation viewport), `src/main.tsx`,
`e2e/**`, schema, store, UI, locales. No primary checkout, `.env.agent`,
credentials, git writes, push, PR, cleanup.

## Checks

`node --import tsx` on new/changed test files and on
`src/app/squareSimulation.test.ts`, `node_modules/.bin/eslint` on changed files,
`node_modules/.bin/tsc -p tsconfig.app.json --noEmit`, `npm run docs:check`. No
browser, no full build, no test pools — the manager runs the browser.

## Report

STATUS, COMMIT: none, CHANGED_FILES, the job/result message shapes, how
pending and cancellation behave, each mutation and whether it failed, commands
with exit codes, RISKS (including anything in playback that still runs square
replay on the main thread per frame).
