---
status: current
authoritative-for: delegated execution state for issue 468 bulk tab and clamp editing
last-verified: 2026-08-09
---

# Integration Handoff — Issue #468 Bulk Tab and Clamp Editing

> The approved GitHub issue remains the plan and source of truth. This file records delegated slice execution only.

## Role and stop condition

The integration manager turns issue #468 into sequential worker slices, independently reviews and verifies each slice, and delivers one pull request only after the complete behavior and required checks pass.

## Integration state

- Integration branch: `feat/issue-468-bulk-tabs-clamps`
- Integration worktree: `/Users/frankp/Projects/worktrees/purecutcnc/issue-468-integration`
- Base commit: `f18f2e4a8633f75fd2bc6236643e094ec833cdfe`
- Approved issue and plan: https://github.com/PureCutCNC/purecutcnc/issues/468
- Manager session: 2026-08-09
- Status: `S1 accepted; preparing S2`
- User authorization for credential-backed worker dispatch: approved in the active Codex task on 2026-08-09

## Global rules

- One active implementation slice at a time.
- Every worker runs in its own task worktree branched from the current integration tip.
- Selection is homogeneous: features, tabs, or clamps, never a mixed family.
- Incompatible additive selection is ignored; a plain click may replace the active family.
- Global Cmd/Ctrl+A remains visible-feature-only. Tree Select All actions are explicit, family-scoped, visible-only replacement commands.
- Selection state remains transient; no `.camj` schema or toolpath-output changes are allowed.
- Every bulk project mutation is one history entry and undo step.
- The manager owns the real diff review, verification, integration, cleanup, push, and PR.

## Slice ledger

| Slice | Scope | Base commit | Task branch/worktree | Worker status | Manager review | Accepted commit / merge | Required checks | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | Homogeneous selection, tab/clamp bulk store actions, tree/canvas interaction | `1e3913d` | `feat/issue-468-selection-foundation` / removed after merge | `done` | `accepted` | `052b9b0`; merge `458708d` | 70 focused tests; 167-file test suite; build | Locale catalog audit clean; global Select All unchanged; manager corrections covered both-direction incompatible additive selection and deletion sanitization |
| S2 | Bulk property panels, generalized Z-range editor, rendered workflow coverage | `458708d` | `feat/issue-468-bulk-properties-z-range` / `issue-468-slices/bulk-properties-z-range` | `not started` | `pending` | `-` | focused tests; build; isolated e2e | Depends on accepted S1 APIs |

## Slice instructions

### S1 — Selection and mutation foundation

**Goal:** Implement homogeneous feature/tab/clamp selection and atomic tab/clamp bulk mutations, then expose the selection semantics through the project tree and canvas without changing properties-panel behavior yet.

**Allowed files:**

- `src/store/types.ts`
- `src/store/slices/selectionSlice.ts`
- `src/store/slices/tabsSlice.ts`
- `src/store/slices/clampsSlice.ts`
- focused new or existing store selection/mutation tests
- `src/app/useFeatureTreeActions.ts` and its focused test
- `src/components/feature-tree/FeatureTree.tsx`
- `src/components/canvas/useClickPlacement.ts`
- `src/components/canvas/useCanvasContextMenu.ts`
- focused tree/canvas tests
- `src/i18n/locales/*/featureTree.ts`
- nearest `INDEX.md` files only if responsibilities or files change

**Forbidden files:**

- `src/components/feature-tree/PropertiesPanel.tsx`
- `src/components/feature-tree/ZRangeSlider.tsx`
- `src/types/project.ts`
- `src/engine/**`
- `src/engine/gcode/**`
- `package.json` and `package-lock.json`

**Invariants:**

- Incompatible additive selection leaves the current selection byte-for-byte unchanged.
- Plain selection may switch family; same-family additive selection toggles membership and maintains a valid primary node.
- Global Cmd/Ctrl+A remains visible-feature-only and never selects tabs or clamps.
- Tabs/Clamps Select All selects only visible rows in that family and replaces the old selection.
- Context menus on selected members preserve the full selection.
- Bulk updates/deletes are atomic, center-preserving for width/height changes, and sanitize selection after deletion.

**Required checks:**

```bash
npx tsx <focused selection and bulk-mutation test files>
scripts/build-summary.sh
```

### S2 — Bulk properties and generalized Z range

**Goal:** Build homogeneous multi-selection panels for tabs and clamps and generalize the Z-range slider for feature/tab/clamp single and bulk editing, with rendered desktop/tablet coverage.

**Allowed files:**

- `src/components/feature-tree/PropertiesPanel.tsx`
- `src/components/feature-tree/ZRangeSlider.tsx`
- focused new feature-tree component/helper files and tests
- feature-tree and shared styles needed by the controls
- `src/i18n/locales/*/featureTree.ts`
- `e2e/*.smoke.spec.ts`
- nearest `INDEX.md` files when responsibilities or files change
- S1 store files only if manager review identifies a concrete missing API

**Forbidden files:**

- `src/types/project.ts`
- `src/engine/**`
- `src/engine/gcode/**`
- `package.json` and `package-lock.json`

**Invariants:**

- Mixed values stay visibly mixed until the user commits a common value.
- Opening a bulk panel never mutates project data.
- Width and height commits preserve each selected tab/clamp center and never force a square.
- Closed machinable features and tabs expose top/bottom Z; open features lock bottom to 0; clamps keep their height-above-zero model; regions/construction retain their current presentation.
- One UI commit calls one atomic bulk store action and creates one undo step.
- Single-item behavior remains intact.

**Required checks:**

```bash
npx tsx <focused feature-tree and store test files>
scripts/build-summary.sh
PURECUT_E2E_PORT=1468 PURECUT_E2E_ISOLATED=1 npx playwright test <focused issue 468 spec>
```

## Integration verification

- Accepted commits and merge order: S1 `052b9b0` merged as `458708d`; S2 pending
- Repository checks: pending
- Browser/tablet checks: pending
- Known limitations or deferred work: smooth tabs remain in issue #414

## User-review handoff

Pending completion of both slices and manager verification.
