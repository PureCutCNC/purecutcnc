---
status: current
authoritative-for: issue #314 delegated execution state (multi-language support)
last-verified: 2026-07-17
---

# Integration Handoff — Multi-language support (issue #314)

> Execution ledger for the delegated slices of issue #314. The GitHub issue is
> the approved plan and source of truth; this file records execution state.
> No tokens, raw environment values, or unredacted provider output.

## Role and stop condition

The integration manager turns approved issue #314 into sequential worktree
slices, independently reviews and verifies each slice, and merges only accepted
commits into the integration branch. Delivery point: all six phases complete
and verified on the integration branch; then a single PR to `main` closing
#314 and #311. No PR before that.

## Integration state

- Integration branch: `feat/issue-314-multi-language`
- Integration worktree: `/Users/frankp/Projects/worktrees/purecutcnc/multi-language-support-editor-a58b4b`
- Base commit: `bd88b6b` (main at branch time)
- Approved issue and plan: `https://github.com/PureCutCNC/purecutcnc/issues/314`
- Manager session: Claude manager session, 2026-07-17
- Status: `slice in progress`
- User authorization for credential-backed worker dispatch: granted 2026-07-17
  in-session ("delegate work if appropriate" in the implementation kickoff).

## Global rules

- One active implementation slice at a time.
- Every worker runs in its own task worktree branched from the current integration tip, never in the integration checkout.
- The worker may use `bypassPermissions` only through the project launcher in explicit implementation mode.
- The manager owns worktree/branch creation, review, merge, cleanup, issue-plan updates, browser regression, push, and PR decisions.
- Reject any worker result without exactly one expected task commit, a clean task worktree, scoped changes, and truthful required-check results.
- Browser- or tablet-affected work requires the applicable manual regression before the final user handoff. Tear down controlled Chrome before the dev server.

## Phase → slice map

Issue #314 phases and how they are executed:

| Phase | Execution |
| --- | --- |
| 1 — i18n core + selector + shell | Manager-implemented directly (S1) |
| 2 — sketch surfaces | Delegated as S2a (toolbars + command descriptors), S2b (canvas panels), S2c (feature tree + properties) |
| 3 — CAM + dialogs | Delegated; slices defined after S2 lands |
| 4 — remaining surfaces | Delegated; slices defined after S3 lands |
| 5 — structured engine warnings | Manager-implemented (CAM core; not delegated) |
| 6 — language manager/editor + docs | Manager-implemented (design-heavy; not delegated) |

## Slice ledger

| Slice | Scope | Base commit | Task branch/worktree | Worker status | Manager review | Accepted commit / merge | Required checks | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | i18n core, LanguageControl, shell extraction (phase 1) | `bd88b6b` | `feat/issue-314-phase-1-core` / `…/issue-314-phase-1-core` | `done (manager)` | `pass` | `af0148c` merged `ca0df27` | `npm run build`; language+appearance e2e (12/12) | Manager-implemented, sets the extraction pattern |
| S2a | Sketch toolbars + command descriptors extraction | `ff5830e` | `feat/issue-314-i18n-sketch-toolbars` / `…/i18n-sketch-toolbars` | `done` | `pass` | `f97a9f3` merged `a55866a` | `npm run build` (gate: passed) | 80-key `sketch` module; worktree removed |
| S2b | Canvas creation panels extraction | `94adc16` | `feat/issue-314-i18n-canvas-panels` / `…/i18n-canvas-panels` | `done` | `pass` | `0834e63` merged `9b4f006` | `npm run build` (gate: passed) | ~150-key `canvas` module; worktree removed |
| S2c | Feature tree + properties extraction | `9b4f006` | `feat/issue-314-i18n-feature-tree` / `…/i18n-feature-tree` | `not started` | `pending` | `-` | `npm run build` | Structural-test rule amended after S2a/S2b findings |
| S2d | heldSideLabel structured-id refactor | after S2c | `-` | `not started` | `pending` | `-` | `npm run build` | Follow-up: display-string-as-identifier in drivingDimensionResolver |

## Slice instructions

### S2a — Sketch toolbars + command descriptors

**Goal:** Extract every user-facing string in the sketch-editing toolbars and
the shared command descriptors into the `src/i18n/` catalog (new `sketch`
module) with complete Simplified Chinese translations, changing no visible
English text and no behavior.

**Allowed files:**

- `src/commands/sketchCommands.ts`
- `src/commands/creationShapes.ts`
- `src/commands/INDEX.md`
- `src/components/layout/toolbar/CreationActions.tsx`
- `src/components/layout/toolbar/CreationToolbar.tsx`
- `src/components/layout/toolbar/SketchEditActions.tsx`
- `src/components/layout/toolbar/FeatureEditActions.tsx`
- `src/components/layout/toolbar/AlignmentActions.tsx`
- `src/components/layout/toolbar/ShapeToolActions.tsx`
- `src/components/layout/toolbar/BackdropEditActions.tsx`
- `src/components/layout/toolbar/ToolbarPopoverMenu.tsx`
- `src/components/layout/toolbar/primitives.tsx`
- `src/components/layout/toolbar/Toolbar.tsx`
- `src/components/layout/toolbar/SnapToolbar.tsx`
- `src/components/layout/toolbar/useToolbarState.ts`
- `src/components/layout/toolbar/shared.ts`
- `src/components/layout/toolbar/INDEX.md`
- `src/i18n/locales/en/sketch.ts` (new)
- `src/i18n/locales/zh-CN/sketch.ts` (new)
- `src/i18n/locales/en/index.ts` (spread the new module only)
- `src/i18n/locales/zh-CN/index.ts` (spread the new module only)

**Forbidden files:**

- Everything else. In particular: the rest of `src/i18n/` (catalog, registry,
  selection, store, bootstrap, context, provider, shell modules, tests),
  `src/store/`, `src/engine/`, `src/types/`, `src/theme/`, `e2e/`,
  `playwright*`, `package.json`, and any file already extracted in phase 1.

**Invariants:**

- Pure extraction: every visible English string stays byte-identical; no copy
  rewrites, no behavior change, no markup restructuring beyond what key lookup
  requires.
- Presentation only: serialized identifiers, enum values, feature/tool ids,
  and store-bound strings (e.g. the literal `'Untitled'` default project
  name) are never translated or keyed.
- Keys live in a new `sketch` module mirroring phase 1's `shell` module:
  `locales/en/sketch.ts` exports `sketchEn` (`as const satisfies
  Record<string, string>`), `locales/zh-CN/sketch.ts` exports `sketchZhCN:
  Record<keyof typeof sketchEn, string>` (complete by type). Register both in
  the locale `index.ts` files by spreading, nothing more.
- Keys are permanent dot-namespaced ids (`sketch.…`); follow the naming style
  of `locales/en/shell.ts`.
- zh-CN terminology follows `src/i18n/GLOSSARY.md`; `{placeholder}` parity is
  mandatory (the registry test enforces it).
- No string surgery on translatable text: no `.replace()`, `.toLowerCase()`,
  or concatenation that assembles sentences. Restructure into dedicated keys
  or `{param}` interpolation exactly as phase 1 did in `MeasureActions.tsx`
  and `SnapPopover.tsx`.
- Module-level option/label lists become `labelKey` lists translated at render
  time with `useI18n()` (see phase-1 `SnapPopover.tsx`); non-hook modules use
  `translate` from `src/i18n/store.ts`.
- Count-bearing strings use `tPlural` with explicit `.one`/`.other` keys.
- Apache header on new files; strict TypeScript; update the nearest INDEX.md
  in the same commit when a file's purpose changes.

**Required checks:**

```bash
npm run build
```

**Manager review record:**

- Worker invocation: 2026-07-17. First dispatch failed pre-worker
  (`DEEPSEEK_API_KEY is not configured` — `.env.agent` lives only in the
  primary checkout); worktree was clean and removed. Retry with
  `DEEPSEEK_AGENT_ENV_FILE` pointed at the primary checkout succeeded,
  exit 0.
- Worker-reported completion: `STATUS: complete, COMMIT: f97a9f3, CHECKS:
  npm run build pass` (report only).
- Diff/commit review: pass. 13 in-scope files + one out-of-scope edit,
  `constructionPresentation.test.ts` — accepted as forced: it is a
  structural test asserting CreationActions source text, which extraction
  necessarily rewrites; assertion intent preserved. `noun` kept alongside
  `nounKey` deliberately — ToolRail (phase 4) still consumes the English
  noun. en byte-identity spot-verified via templates
  (`'Add {target} {shape}'` + lowercase nouns). Independent gate: passed.
- Correction attempts: none.
- Acceptance decision: `accepted` — merged `--no-ff` as `a55866a`.

### S2b — Canvas creation panels

**Goal:** Extract user-facing strings in the sketch-canvas UI (workflow/
creation panels, constraint + driving-dimension panels, gear panel, pickers,
badges, canvas context menu, manual entry) into a new `canvas` catalog module
with complete zh-CN, en byte-identical.

**Allowed files:** `src/components/canvas/{SketchCanvas,CanvasWorkflowPanel,ConstraintEditPanel,DrivingDimensionPanel,GearParameterPanel,CreationParameterReferences,CreationTargetBadge,OverlapFeaturePicker,DepthLegend}.tsx`,
`src/components/canvas/{useCanvasContextMenu,useCanvasWorkflowPanel,useDrivingDimensionWorkflow,useOverlapFeaturePicker,manualEntry}.ts`,
`src/components/canvas/SketchCanvas.types.ts`, `src/components/INDEX.md`,
`src/i18n/locales/en/canvas.ts` (new), `src/i18n/locales/zh-CN/canvas.ts`
(new), both locale `index.ts` (spread only).

**Forbidden:** canvas *rendering* modules that draw text into the 2D canvas
(`dimensionRendering.ts`, `operationSnapshot.ts`, `stlTopViewRenderer.ts`,
`draftGeometry.ts`, `previewPrimitives.ts`, `measurements.ts`) — numeric/
technical notation, deliberate boundary; all tests; rest of `src/i18n/`;
`src/store/`, `src/engine/`, `src/types/`, `e2e/`; files from earlier slices.

**Invariants:** as S2a (pure extraction, byte-identical en, GLOSSARY zh,
placeholder parity, no string surgery, `tPlural` for counts, Apache headers).

**Required checks:** `npm run build`

**Manager review record:**

- Worker invocation: 2026-07-17, exit 0; independent gate passed.
- Worker-reported completion: `STATUS: complete, COMMIT: 0834e63`; RISKS
  honestly flagged both boundary items below.
- Diff/commit review: pass. The two feature-tree structural tests were
  updated out of scope, but the change is forced (they read canvas component
  source) and strengthens them: each now asserts the component references
  the i18n key AND the en catalog carries the exact original English string.
  Verified `heldSideLabel` logic comparisons are untouched (labels never
  translated at the identifier level), so no behavior change.
- Known limitations logged: (1) linear/angle dimension-edit panels display
  the raw `heldSideLabel` ("Hold left" …) — untranslated because the fix
  needs a structured-id refactor in `src/sketch/drivingDimensionResolver.ts`
  (out of slice scope) → follow-up S2d; (2) canvas-drawn preview labels
  ("Pending rectangle", "Move preview") stay English inside the declared
  canvas-rendering boundary.
- Acceptance decision: `accepted` — merged `--no-ff` as `9b4f006`.

### S2c — Feature tree + properties

**Goal:** Extract user-facing strings in the feature tree, properties panel,
feature context menu, Z-range slider, and the construction/region
presentation-label modules into a new `featureTree` catalog module with
complete zh-CN, en byte-identical.

**Allowed files:** `src/components/feature-tree/{FeatureTree,PropertiesPanel,FeatureContextMenu,ZRangeSlider}.tsx`,
`src/components/feature-tree/{constructionPresentation,regionPresentation}.ts`,
`src/components/feature-tree/INDEX.md` (if present),
`src/i18n/locales/en/featureTree.ts` (new),
`src/i18n/locales/zh-CN/featureTree.ts` (new), both locale `index.ts`
(spread only).

**Forbidden:** `src/components/feature-tree/*.test.ts` — these assert the
exact current English output of the presentation modules and MUST pass
unchanged (a failing one means visible text changed); everything else as S2a.
Presentation modules are non-React: use `translate` from `src/i18n/store.ts`.

**Required checks:** `npm run build`

**Manager review record:** pending.

## Integration verification

- Accepted commits and merge order: S1 `af0148c` → merge `ca0df27`.
- Repository checks: `npm run build` green at `ca0df27`; language + appearance
  e2e 12/12 against a fresh-port dev server.
- Browser/tablet checks: language switch, persistence, tablet touch targets
  covered by `e2e/language.smoke.spec.ts`; full manual CJK layout pass happens
  in the final phase.
- Known limitations: engine warnings remain English until phase 5; language
  manager/editor UI arrives in phase 6.

## User-review handoff

Produced after all phases complete and verify (single PR to `main` closing
#314 and #311; no PR before then).
