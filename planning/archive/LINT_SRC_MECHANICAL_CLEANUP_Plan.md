---
status: Done   # Draft → Approved → In progress → Done | Abandoned
approved-scope: Batches 2-4 only (Batches 1 and 5 declined 2026-06-11 — unused-vars rule options and test-fixture any rework stay deferred)
created: 2026-06-11
---

# Lint Src Mechanical Cleanup Plan

## Goal

Reduce the `npx eslint src` baseline (currently 95 problems: 72 errors, 23 warnings) by fixing only mechanical, behavior-free findings. Target: remove ~41 errors and 3 warnings, leaving ~31 errors / 20 warnings that genuinely need design (handled by the separate hook/typing debt plan).

## Approach

Small, independently verifiable batches. No control-flow or rendering changes anywhere.

**Batch 1 — unused-vars rule options (fixes 10 errors). _DECLINED at approval — kept for reference; these 10 errors stay in the deferred list._** The codebase deliberately uses the `_`-prefix convention for intentionally-unused bindings (`_field`, `_get`, `_path`, `_dirtyRegion`, `_point`, and `{ mesh: _mesh, ...rest }` rest-sibling omission in `projectStore.ts` — where destructuring *requires* a name). Configure `@typescript-eslint/no-unused-vars` in `eslint.config.js` to honor it:

```js
'@typescript-eslint/no-unused-vars': ['error', {
  args: 'all',
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrorsIgnorePattern: '^_',
  destructuredArrayIgnorePattern: '^_',
  ignoreRestSiblings: true,
}]
```

This is documented in the config with a short comment. It clears: `SketchCanvas.tsx:4971` (`_field`), `gpuMesh.ts:159`, `finishSurfaceWaterline.ts:1553`, `platform/browser.ts:183`, `projectStore.ts:1094/1102` (6 errors), `pendingActionsSlice.ts:72`.

**Batch 2 — auto-fix-grade syntax (fixes 18 errors).**
- `prefer-const` (12): `import/svg.ts:402-403` (`x1p`/`y1p`), `sketch/constraintSolver.ts:524,611`, `sketch/constraintSolver.test.ts` (8 × `featureA/B/C`).
- `no-self-assign` (1): delete the no-op `reference_index = reference_index` at `constraintSolver.ts:473` (branch + comment stay).
- `no-useless-escape` (1): `engine/modelExport/stl.ts:142` — `[^A-Za-z0-9_\-]` → `[^A-Za-z0-9_-]` (identical character class).
- `no-unused-expressions` (2): `previewPrimitives.ts:471,489` — statement-position ternary → `if/else` (identical canvas calls).
- `ban-ts-comment` (2): `finishSurface.test.ts:23`, `finishSurfaceCleanup.test.ts:23` — `@ts-ignore` → `@ts-expect-error` on the Node `fs` imports. Verified against `tsc -b`; if the line is actually error-free under the build tsconfig, the import line is fine without any directive and the directive is removed instead. *(Outcome: `tsc -b` reported the `@ts-expect-error` as unused — the imports compile fine, so both stale directives were removed entirely.)*

**Batch 3 — unused eslint-disable directives (fixes 3 warnings). _REVERTED during implementation._** Removing the three "unused" `eslint-disable react-hooks/exhaustive-deps` comments (`SketchCanvas.tsx:2315`, `SimulationViewport.tsx:1263`, `Viewport3D.tsx:1066`) unmasked **15 new errors**: the presence of any react-hooks disable directive makes the compiler-backed react-hooks rules (`immutability`, `refs`) bail on the file, so the directives are load-bearing even though ESLint reports them unused (13 × `react-hooks/immutability` in SketchCanvas/SimulationViewport, 2 × `react-hooks/refs` in Viewport3D). The directives were restored; the 3 warnings stay and are handed to the hook/typing debt plan, which must budget for the masked errors.

**Batch 4 — tiny fast-refresh extractions (fixes 2 errors).**
- `ToolpathVisibilityPanel.tsx:27` — move `ToolpathVisibility` interface + `DEFAULT_TOOLPATH_VISIBILITY` const to *(new)* `src/components/toolpathVisibility.ts`; re-export from the panel is not needed — update the (few) importers.
- `main.tsx:64` — move `UnsupportedMobileScreen` to *(new)* `src/components/UnsupportedMobileScreen.tsx`. Pure relocation, JSX untouched.

**Batch 5 — test-fixture `any` (fixes 11 errors, flagged for reviewer). _DECLINED at approval — kept for reference; these 11 errors stay in the deferred list._** `store/second_cut_test.ts:40` and `sketch/constraintSolver.test.ts` (10) build fixtures with `as any`. Replace with honest typing: complete the missing fields where trivial, otherwise `as unknown as SketchFeature` (etc.) so the cast is explicit. Test-only files; structural tests must still pass via `npm test`. If any site turns out non-trivial it is left as-is and listed as deferred.

## Files affected

- `eslint.config.js` — `no-unused-vars` options (Batch 1)
- `src/import/svg.ts`, `src/sketch/constraintSolver.ts`, `src/sketch/constraintSolver.test.ts` — Batch 2
- `src/engine/modelExport/stl.ts`, `src/components/canvas/previewPrimitives.ts` — Batch 2
- `src/engine/toolpaths/finishSurface.test.ts`, `src/engine/toolpaths/finishSurfaceCleanup.test.ts` — Batch 2
- `src/components/canvas/SketchCanvas.tsx` — Batch 3 only (remove one stale comment; no dependency-array edits)
- `src/components/simulation/SimulationViewport.tsx`, `src/components/viewport3d/Viewport3D.tsx` — Batch 3
- `src/components/ToolpathVisibilityPanel.tsx`, *(new)* `src/components/toolpathVisibility.ts` + its importers — Batch 4
- `src/main.tsx`, *(new)* `src/components/UnsupportedMobileScreen.tsx` — Batch 4
- `src/store/second_cut_test.ts`, `src/sketch/constraintSolver.test.ts` — Batch 5
- `src/INDEX.md` / `src/components/INDEX.md` (if present) — register the two new files

## Tests

No new tests (no behavior change). Existing structural tests are the safety net: `npm test` runs inside `npm run build`. The two `@ts-expect-error` swaps are explicitly verified by `tsc -b` (build fails if the directive is wrong — that's the point of the rule).

## Open questions / risks

- Batch 1 changes a lint *rule option* rather than code. It matches the existing codebase convention, but say the word if you'd rather rename/remove the unused bindings instead (the `projectStore.ts` rest-destructuring cases cannot be fixed in code without restructuring).
- Batch 5 touches test fixture typing — lowest confidence batch; can be dropped entirely if you want strictly code-comment/syntax-level changes.

## Out of scope (deferred to LINT_HOOK_TYPING_DEBT_Plan)

- All `react-hooks/exhaustive-deps` warnings (App.tsx + 19 in SketchCanvas.tsx).
- `react-hooks/set-state-in-effect` (ExportDialog, Toolbar ×3, ToolRail, TopCommandBar, TextToolDialog).
- `react-hooks/refs` render-time ref writes (FeatureTree ×2, useAxisLock).
- Production `any` boundaries (profilePrimitives, dxf, normalize, clipping, derivedFeatures, text/index ×11).
