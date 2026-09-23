# INDEX — src/components/nesting/

Sheet nesting UI (issue #848, step 3 of #741). Opened from the Distribute menu
(**Nest on stock**) and the tablet rail; rendered by `SketchCanvas` through
`NestPanelHost`.

- `NestPanel.tsx` — `NestPanelHost` (reads `pendingNest`, owns the workflow-panel position) and the panel: parts on sheet, gap (pre-filled from the cutting tool, raise-only), rotation preset, keep originals, Nest / Stop / Discard nest, and the placed/unplaced + tabs report. Opening it on any row of an existing nest re-targets that nest: Nest replaces it in one undo step
- `nestForm.ts` — pure panel state: `nestSubject` (the nest a selection belongs to, the base project with that nest discarded, the resolved part and gap floor), form defaults, validation, rotation presets
- `nestWorkerClient.ts` — `runNestJob`: one worker per job, terminated on every exit; cancel is `terminate()`; runs inline when no Worker exists
- `nest.worker.ts` — worker entry: `nest(requestFromJob(job))`
- `nestForm.test.ts` — subject/base/gap-floor resolution, validation, re-targeting a nest from a copy, and a job surviving `structuredClone`
- `nestWorkerClient.test.ts` — result, error, cancel (all terminate) and the inline fallback, with a fake worker

The e2e smoke is `e2e/nesting.smoke.spec.ts` (project-input lane).
