# Slice rt5-c: switching face on a tablet must not cancel Feature Distribution (CI regression from rt5-a)

rt5-a (item 37) moved the tablet face control (`FaceSwitch`) into the top command bar. `src/components/canvas/useFeatureDistributionWorkflow.ts` (the document `pointerdown` handler, ~line 61) cancels a pending Feature Distribution on any pointerdown inside `.toolbar, .toolbar-popover, .tool-rail, .tool-rail__popover, .app-toolbar`, exempting only snap and the project-panel button. The top bar is inside that selector, so on a tablet, tapping the face control now cancels Feature Distribution. On desktop the control sits in the centre panel's tab bar and the workflow stays open; the tablet must behave the same.

Failing test (fails locally and on CI, both attempts): `e2e/featureDistribution.smoke.spec.ts:214` "#994 tree guide touch capture › a visible foreign construction row can be a guide with the canvas overlay hidden" (1024 × 768, touch). After `ui.face.toggleOtherSide`, `Pick guide` in `.canvas-workflow-panel--feature-distribution` is gone because the panel closed.

- Exempt the face control and its menu from that cancel rule (the control, wherever it is drawn, and its open menu/popover, which may be portalled outside the bar), so switching face keeps the workflow open exactly as on desktop. Check the other workflows that use the same pattern (grep `useDocumentEvent('pointerdown'` and `.app-toolbar` under `src/components/canvas/`) and apply the same exemption where the face control would now cancel them on a tablet but not on desktop.
- Do not change the e2e test above; it must pass as written. Add a unit test that fails without the exemption (e.g. the closest-selector predicate pulled into a small pure function, or the handler with a fake target).

Off limits: everything else.

## Rules for every slice (issue #1112, PR #1126, Frank's test round 5)

- You work in your own worktree, based on the previous slice's branch. Read `INDEX.md`, `AGENTS.md`, and the `INDEX.md` of every folder you touch. Do exactly what this handoff asks, nothing wider: if something here is wrong or needs a decision, say so in RISKS and do the closest correct thing.
- `gh` may be blocked in your sandbox; everything you need is here.
- Leave edits uncommitted and report `COMMIT: none`; the dispatcher commits.
- Project format stays 3.3 (additive optional fields only, migration keys on missing fields). Exported programs and toolpaths stay byte-identical unless the item says otherwise.
- Locale changes: every new or changed key in `en` and in every other locale folder under `src/i18n/locales/`, same position as `en`, real translations. No other existing value changes. Run `npm run check:i18n`.
- Tests must bite: for each behaviour, break the code on purpose, confirm a test fails, restore from a `cp` backup (never `git checkout`). Report each mutation and whether it was caught.
- React/browser-global unit tests must pass with `NODE_OPTIONS=--no-experimental-global-navigator`.
- You cannot run a browser. Update any `e2e/` spec that asserts what you change (grep labels, selectors, test ids) without weakening assertions, and list it in RISKS.
- Run and report with exit codes: `npm run build:gates`, each changed or new test file directly, `npm run check:i18n` if locales changed.
- Report: changes per file; tests added; each mutation and whether it was caught; commands with exit codes; RISKS.

