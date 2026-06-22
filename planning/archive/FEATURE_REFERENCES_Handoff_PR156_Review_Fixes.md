# Handoff — PR #156 review remediation (P1a / P1b / P2)

Implementation handoff. Read `AGENTS.md`, root `planning/INDEX.md`, `ARCHITECTURE.md` §4 first.
Follow Plan → confirm scope → Implement. You own ONLY this slice's worktree; finish with ONE commit
and a report. Do not merge or open a PR — management merges into `feature-references-v2`.

Three findings from the PR #156 review. Each is a real bug; each gets a fix **and a regression test**.
Management has already traced the exact mechanisms (below) — verify them, don't re-derive from scratch.

## Branch / base / worktree

- Integration branch: `feature-references-v2` (use the current tip of `origin/feature-references-v2`).
- Slice branch: **`fr-pr156-review-fixes`**
- Worktree: `/Users/frankp/Projects/worktrees/purecutcnc/fr-pr156-review-fixes`
- Setup (no `npm install`):
  ```bash
  git -C /Users/frankp/Projects/purecutcnc worktree add \
    /Users/frankp/Projects/worktrees/purecutcnc/fr-pr156-review-fixes \
    -b fr-pr156-review-fixes origin/feature-references-v2
  cd /Users/frankp/Projects/worktrees/purecutcnc/fr-pr156-review-fixes
  ln -s /Users/frankp/Projects/purecutcnc/node_modules node_modules
  ```

## P1a — imported linked instances lose placement (`src/import/camj.ts`)

**Mechanism (confirmed):** in the definitionId-remap loop (`mergeCamjFolders`, ~line 394), the
**remap branch** (~line 399–402) does:
```ts
feature.definitionId = definitionIdMap.get(sourceDefId)
feature.transform = IDENTITY_MATRIX   // ← BUG: discards the source instance's placement
```
The imported feature already carried its own `transform` relative to its source definition. Forcing
identity makes resolver-based CAM/read paths render it from the definition origin, while its baked
`sketch` still shows at the old location — a split-brain placement.

**Fix:** on the remap branch, **preserve `feature.transform`** (only default to `IDENTITY_MATRIX` when
it is absent). Do **NOT** change the mint branch (~line 403–430): there the definition is built from the
feature's current baked geometry, so an identity transform is correct.

**Test (`src/import/camj.test.ts`):** merge/import a `2.0` project containing a linked pair where the
second instance has a **non-identity** `transform` (e.g. translate (50,0)) sharing a `definitionId`.
Assert: after merge, that instance's `transform` is preserved (not identity) and
`resolveFeatureInstance(project, id)` places it at the offset location, not the definition origin.
Confirm the existing collision-safe definitionId remap still holds.

## P1b — definition-owned operation can diverge from instances (`src/store/slices/featureSlice.ts`)

**Mechanism (confirmed):** `operation` is **definition-owned** — `resolveFeatures.ts:436` sets
`operation: definition.operation`, so every resolver/CAM consumer reads operation from the definition.
But `updateFeature` (~line 449) patches only the matching **feature row**; it never updates
`featureDefinitions[defId].operation`. Changing one linked instance's operation therefore leaves the
definition (and thus the resolver) and all sibling rows on the old operation → divergence.

**Decision (management/user):** operation stays **definition-owned** — i.e. changing one linked
instance's operation changes **all** linked copies (consistent with `resolveFeatures.ts:436`). Do not
move operation off the definition.

**Fix:** in `updateFeature`, when `safePatch.operation !== undefined` and the feature has a
`definitionId`, also set `featureDefinitions[defId].operation` and propagate to **all** instances of
that definition so the raw rows agree with the definition (use the existing rebake/propagation path —
`rebakeAllInstances` and/or `getInstanceIdsForDefinition`; check whether rebake copies `operation` to
the row and extend it if not). **Preserve** the edited row's existing side effects (the `isFirst`→`add`
guard, region z-range stripping, `folderIdForOperation`, `syncStockFromSourceFeature`) for the edited
row, and apply the same operation-consistency (folder/z-range) to the propagated siblings. Keep it
undoable (single history entry) and idempotent.

**Test:** linked pair (shared `definitionId`). `updateFeature(idA, { operation: 'subtract' })` (or
another valid change). Assert: `definition.operation` updated; BOTH instance rows' `operation` agree;
`resolveFeatureInstance` for each sibling reports the new operation; one undo restores all. Add a guard
that a non-linked (unique) feature still behaves exactly as before.

## P2 — Playwright fixture uses an invalid matrix shape (`e2e/featureReferences.helpers.ts`)

**Mechanism (confirmed):** line ~86 serializes the transform as an **array**
`[1, 0, 0, 1, tx, ty]`, but `Matrix2D` is an **object** `{ a, b, c, d, e, f }` (`types/project.ts:310`).
The resolver reads `.a`/`.e`/… → `undefined` → **NaN** coordinates. The smoke passed only because it
asserts badges, never geometry.

**Fix:** build the transform as an object matrix, e.g. `{ a: 1, b: 0, c: 0, d: 1, e: tx, f: ty }`
(reuse `IDENTITY_MATRIX`/the matrix builders if convenient). Then **strengthen the smoke**: in the
Copy and Make Unique assertions (`featureReferences.smoke.spec.ts`), read the project via
`__pcTest.getProject()` and assert the copied / made-unique feature's resolved (or baked) coordinates
are **finite** and at the **expected placement** — not just that a badge is present/absent.

Run `npm run test:e2e` and confirm the strengthened smoke is green (and would have failed on the old
array shape).

## Out of scope
- No model change to make operation per-instance (P1b decision is "definition-owned/shared").
- No changes beyond the three files + their tests (+ the e2e spec). Don't touch other worktrees or
  unrelated product code. If a fix surfaces a *further* real bug, STOP and report it — don't expand scope.

## Acceptance criteria
- P1a: imported linked instance keeps its source transform and resolves at the correct location; new
  `camj.test.ts` case passes.
- P1b: operation change on a linked instance updates the definition + all siblings + resolver
  consistently, undoable; new test passes; unique-feature behavior unchanged.
- P2: object matrix used; smoke asserts finite + correctly-placed copied/made-unique geometry;
  `npm run test:e2e` green (10+ assertions).
- `npm run build` (tsc -b + full `npm test` + vite) green.
- Any further real bug surfaced is reported, not worked around.

## Final report (report back to management; do NOT merge)
```
Branch / Worktree / Commit:
Files changed:
P1a fix + test:   (what changed; assertion)
P1b fix + test:   (def+sibling propagation path used; side-effect handling; assertion)
P2 fix + test:    (matrix shape; geometry assertions added)
Any further bugs surfaced:
Verification:   (focused tests + npm run build + npm run test:e2e)
```
