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
| 2 — sketch surfaces | Delegated as S2a (toolbars + command descriptors) and S2b (canvas panels + feature tree) |
| 3 — CAM + dialogs | Delegated; slices defined after S2 lands |
| 4 — remaining surfaces | Delegated; slices defined after S3 lands |
| 5 — structured engine warnings | Manager-implemented (CAM core; not delegated) |
| 6 — language manager/editor + docs | Manager-implemented (design-heavy; not delegated) |

## Slice ledger

| Slice | Scope | Base commit | Task branch/worktree | Worker status | Manager review | Accepted commit / merge | Required checks | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | i18n core, LanguageControl, shell extraction (phase 1) | `bd88b6b` | `feat/issue-314-phase-1-core` / `…/issue-314-phase-1-core` | `done (manager)` | `pass` | `af0148c` merged `ca0df27` | `npm run build`; language+appearance e2e (12/12) | Manager-implemented, sets the extraction pattern |
| S2a | Sketch toolbars + command descriptors extraction | `ca0df27` | `feat/issue-314-i18n-sketch-toolbars` / `…/i18n-sketch-toolbars` | `not started` | `pending` | `-` | `npm run build` | First delegated slice |
| S2b | Canvas creation panels + feature tree extraction | after S2a | `-` | `not started` | `pending` | `-` | `npm run build` | Defined after S2a merges |

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

- Worker invocation: `pending`
- Worker-reported completion: `pending`
- Diff/commit review: `pending`
- Correction attempts: `-`
- Acceptance decision: `pending`

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
