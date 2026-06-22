# Management Session Handoff — Feature References (continuation, 2026-06-21)

You are taking over MANAGEMENT for the PureCutCNC "feature references" work. Stay in management mode —
review/merge returned slices, validate, maintain the ledger/plans, prepare handoffs. Do not implement
slices yourself unless the user explicitly says so. Implementation goes to agents the **user** dispatches.

## Source of truth (read these first, from the v2 worktree)
- `planning/FEATURE_REFERENCES_Ledger.md` — **live status + full management log.** Start here.
- `planning/FEATURE_REFERENCES_Plan.md` — design + status block.
- `ARCHITECTURE.md` §4 — the implemented definition/instance model + dual-storage compatibility (kept current).
- `planning/REGRESSION_TESTS_Plan.md` + `REGRESSION_TESTS_Handoff_1.md` — the regression effort.
- Use codebase-memory-mcp graph tools first for code discovery (the v2 worktree may need indexing).

## Branch state
- LIVE integration branch: **`feature-references-v2`** (worktree
  `/Users/frankp/Projects/worktrees/purecutcnc/feature-references-v2`), tip **`57f921d`**, pushed,
  clean. Off current `main`. The old `feature-references` branch is superseded.

## Done (all on v2, merged + verified)
- Slices **01–06, 06.5, 07, 09, 10** merged. (06.5 creation defs; 07 UI; 09 edit-in-place; 10 linked
  constraint re-solve.) Each independently reviewed + `npm run build` green; slice 08 browser pass done.
- UI refinements: subtle linked badge; fixed feature-tree row-wrap; context menu (dropped Duplicate
  as Reference/Independent, moved Make Unique + Select Linked to top, shown only when linked); desktop
  kebab hidden (tablet keeps it); orphaned duplicate handlers removed.
- Forward-compat: warning when loading a `.camj` newer than `LATEST_PROJECT_VERSION` (`2.0`).
- Bug fixes from user testing: **circle radius huge-circle** and **composite arcs flattened to splines**
  — both were `transformProfileAffine`/`resolveProfile` not handling circle `center` / arcs under
  similarity transforms; fixed + regression tests in `editInPlace.test.ts`.
- Docs: ARCHITECTURE §4 written and **corrected** (old builds PRESERVE links across round-trip; the
  real caveat is that editing a linked instance in an old build diverges and is reconciled away on the
  next v2 edit). Plan + Ledger cross-linked.

## Decisions recorded (don't re-litigate)
- **Copy = linked by default** (project `meta.copyMode`, no UI toggle; Make Unique unlinks).
- **Old-build divergence**: document only — no on-load reconciliation.

## In flight / immediate next
1. **Regression Handoff 1** (geometry-fidelity matrix + lifecycle) — dispatched; worktree
   `regression-tests-1-geometry-lifecycle` exists at `57f921d` (no commits yet). When it returns:
   run the merge pattern; **triage any real bugs it surfaces** (the suite is designed to find more
   circle/arc-class issues — fix-or-file each before merging the tests).
2. After H1 lands: author **Regression Handoff 2** (audit-and-fill: editing-op segment-kind
   preservation, per-CAM-operation smoke, stock/tabs/clamps/align-distribute). Needs the H1 audit.
3. **Phase 4 browser smoke**: open question for the user — Playwright harness vs keep browser checks
   as management-manual. Not yet decided.
4. **Final PR `feature-references-v2` → `main`**: HELD pending the user's testing sign-off. Do NOT open
   it or archive the plan until the user confirms. When they do: re-confirm full `npm run build`, then
   open with a complete summary (slices 01–10 + refinements + version warning + circle/arc fixes +
   regression tests; note the accurate compatibility behavior and the deferred constraints work).

## Deferred (future, with user)
- "Constraints + references" session: optionally copy a feature's *constrained child* when duplicating;
  any further cross-instance constraint nuances.

## Workflow rules
- Worktrees under `/Users/frankp/Projects/worktrees/purecutcnc/`; symlink node_modules
  (`ln -s /Users/frankp/Projects/purecutcnc/node_modules node_modules`), no `npm install`.
- Always `npm run build` (tsc -b + full `npm test` + vite) before accepting/merging — the hard gate.
- Merge pattern per returned slice: verify clean state → review diff vs scope (graph tools first) →
  run focused tests + build independently → `git merge --no-ff --no-commit` into v2 → update ledger
  (status + result/merge commit + verification) → rebuild → commit merge → record merge hash → push.
- Push v2 after every accepted merge. Never add Co-Authored-By lines. Don't commit/push outside the
  merge flow or explicit doc updates.
- Browser validation is management-only; the user runs/owns the dev server but as of recent sessions
  Claude runs `npm run dev` on :1420 for v2 itself. **Kill the controlled Chrome
  (`pkill -f chrome-devtools-mcp/chrome-profile`) before killing the dev server; if the user's own dev
  server is running, do NOT kill it.**
- Handoff/dispatch prompts go in a fenced ```text block.
- Do NOT archive any plan until the user has tested and confirmed.

## Cleanup (only with user go-ahead, confirm each is clean first — never `--force` blindly)
- Stale merged-slice worktrees to retire: `feature-references-02-resolver`,
  `feature-references-09-edit-in-place`, `feature-references-10-linked-constraint-resolve`, and the
  old `feature-references` branch/worktree. (Slices 01/03/04/05/06/06.5/07 worktrees may also linger.)

## Verification commands (FR + regression focused + gate)
```
cd /Users/frankp/Projects/worktrees/purecutcnc/feature-references-v2
npx tsx src/store/featureReferencesMigration.test.ts
npx tsx src/store/featureResolver.test.ts
npx tsx src/store/creationDefinitions.test.ts
npx tsx src/store/duplicateReference.test.ts
npx tsx src/store/definitionEditing.test.ts
npx tsx src/store/editInPlace.test.ts
npx tsx src/store/snapshotOps.test.ts
npx tsx src/store/linkedConstraintResolve.test.ts
npx tsx src/store/instanceTransforms.test.ts
npm run build
```
