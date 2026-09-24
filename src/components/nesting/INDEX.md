# INDEX — src/components/nesting/

Sheet nesting UI (issue #848, step 3 of #741). Opened from the Distribute menu
(**Nest on stock**) and the tablet rail; rendered by `SketchCanvas` through
`NestPanelHost`.

- `NestPanel.tsx` — `NestPanelHost` (reads `pendingNest`, owns the workflow-panel position) and the panel: parts on sheet (an All field plus one row per part in a collapsible, scrolling Parts section when several parts are selected, #866), gap (pre-filled from the cutting tool, raise-only), rotation preset, keep originals, a bottom action row — Nest / Stop, then Nest again / Keep improving / Discard nest / Accept nest — while the title bar's lone ✕ cancels (undoes the panel's own steps if nothing else was edited since, then closes), Keep improving (#862: layouts tried and the gain so far; the first better layout is one undo step and later ones amend it; any edit or undo stops the search, judged by undo history so a folder the tree reveals does not; while it runs `nestSearching` holds toolpath generation, so operations regenerate once when it ends), and the placed/unplaced + tabs report. Opening it on any row of an existing nest re-targets that nest: Nest replaces it in one undo step
- `nestForm.ts` — pure panel state: `nestSubject` (the nest a selection belongs to, the base project with that nest discarded, the resolved part and gap floor), form defaults, validation, rotation presets, and `watchForEdits` (#864)
- `nestWorkerClient.ts` — `runNestJob` and `improveNestJob`: one worker per job, terminated on every exit; cancel is `terminate()`; both run inline when no Worker exists (the search yields between layouts)
- `nest.worker.ts` — worker entry: a `nest` request answers with the result; an `improve` request posts progress per layout (with the best layout on the first and on each improvement) and `done` when the search stalls
- `nestForm.test.ts` — subject/base/gap-floor resolution, validation, re-targeting a nest from a copy, and a job surviving `structuredClone`
- `nestWorkerClient.test.ts` — result, error, cancel (all terminate) and the inline fallback, with a fake worker; improve progress, a stop from inside a progress callback, and the inline search

The e2e smoke is `e2e/nesting.smoke.spec.ts` (project-input lane).
