---
status: In progress   # Draft → Approved → In progress → Done | Abandoned
created: 2026-06-18
---

# Canvas Hook Dependency Array Audit Plan

## Goal

Audit the post-P6 canvas hook extraction for `useEffect`, `useMemo`, and `useCallback` dependency arrays that include whole unstable hook-return objects such as `dimEdit`, `fillet`, `creation`, `move`, `transformExact`, `offset`, `snap`, `contextMenu`, `clickPlacement`, or `gestures`. The user-visible goal is to catch any repeat of the creation "Dimensions" regression where a mode-scoped effect became an every-render effect after extraction.

## Approach

- Search the extracted canvas hooks and `SketchCanvas.tsx` for React dependency arrays that include whole workflow objects rather than primitive state, stable callbacks, refs, or specific returned members.
- Classify each hit as safe, suspicious, or confirmed-bug:
  - Safe: the dependency is a primitive/specific stable member, or an intentional redraw dependency.
  - Suspicious: the whole object is recreated each render but the effect/callback body is harmless or already guarded.
  - Confirmed-bug: the whole object changes effect timing or callback identity in a way that can reset state, leak listeners, rerun cleanup, or cause visible behavior changes.
- Apply only narrow, behavior-preserving fixes for confirmed instances of the same class as the `dimEdit` regression. Use local `react-hooks/exhaustive-deps` disables only when the dep must intentionally stay primitive-scoped and the referenced members are stable refs/setters.
- Record any non-obvious safe/suspicious cases in the umbrella ledger so the next round does not rediscover them.

## Files affected

- `src/components/canvas/SketchCanvas.tsx` — primary audit target; targeted dependency-array fixes only if confirmed.
- `src/components/canvas/use*.ts` — extracted hook audit target; targeted dependency-array fixes only if confirmed.
- `planning/CORE_STATE_CANVAS_REFACTOR_Plan.md` — append a short audit result/ledger note.
- `planning/INDEX.md` — move this plan through the normal approval/in-progress/done lifecycle.
- `planning/archive/CANVAS_HOOK_DEP_ARRAY_AUDIT_Plan.md` — archive this plan when complete.

## Tests

- `npm run lint` to validate hook dependency and max-lines rules.
- `npm run build` for the full TypeScript, license-header, structural test, and Vite gate.
- Browser verification only if the audit produces a runtime-affecting code change; use desktop plus DevTools tablet where the affected flow is UI-visible.

## Open questions / risks

- The audit may find no code changes are needed; in that case the deliverable is the ledger note plus archived plan.
- Some whole-object deps may be performance noise rather than behavior bugs. Those should be documented or left alone unless they have a clear runtime effect.

## Out of scope

- P8 opportunistic inlining.
- Memoizing every workflow hook return object just to satisfy dependency arrays.
- Refactoring hook APIs or moving helpers unless needed for a confirmed dependency-array bug.
