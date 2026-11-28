# INDEX — src/app/verify/

The simulation viewport's **Verify** mode (issue #1269, slice 3 of #1267):
compare the model, the internal toolpath and the exported program for the
visible operations of the simulated setup up to the selected one. Runs only on
demand; a result is marked stale, never recomputed, after an edit.

## Files

- `verifyRequest.ts` — the three comparisons (`VERIFY_COMPARISONS`), the run
  request snapshot (project object, setup, comparison, operation, detail), the
  staleness rule (`projectEdited` before `requestChanged`), and the operations
  a run covers (`verifyOperations`: visible operations up to the selection,
  plus the selection itself when hidden but enabled and tooled).
- `verifyRequest.test.ts` — comparison list, covered operations, staleness.
- `verifyRun.ts` — one run. Model ↔ Internal replays the generated paths and
  calls `verifyAgainstModel`; Model ↔ Exported posts each operation with the
  project's machine through `verifyExportedOperation` and replays
  `motion.moves` (`exportedReplayItem`); Internal ↔ Exported reports the
  parity verdict and deviations per operation (locations turned into the
  setup frame) and replays the internal paths into the model check's grid
  (`modelVerificationGridOptions`) for the markers to sit on. Yields between
  operations, cancellable. Every covered operation is reported; a missing
  path, a missing tool, a refused or unreadable program, or a run-level reason
  (no model, Around setup, no machine…) reads `unverified` with structured
  reason codes. The overlay's cell codes are the model classes plus
  `VERIFY_CELL_UNVERIFIED` for cells last cut by an unverified operation.
- `verifyRun.test.ts` — a real block-and-pocket run of each comparison with
  the bundled GRBL definition: corners read unintended, the missing path is
  listed unverified, the GRBL program verifies against its toolpath, no
  machine / no model are refused with every operation still listed, and a
  cancelled run resolves null.
- `useVerifyModel.ts` — the React state App hands to `SimulationViewport`:
  mode on/off, comparison, run status and progress, the result, its
  staleness and scope. Acquires paths through the simulation's
  `requestToolpath`; the machine is `getActiveMachineDefinition(project)`, the
  Export dialog's own resolution.
- `useVerifyModel.test.ts` — the real hook in a linkedom root: nothing runs on
  mount or on entering the mode, an edit or another comparison marks the result
  stale without a rerun, and leaving the mode cancels a run in progress.
- `INDEX.md` — this file.
