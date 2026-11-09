# Issue #1183 handoff, slice prep-a: "Preparing…" instead of "Warning" in Exported Motion debug

Branch `fix/issue-1183-motion-debug-preparing`, based on `integration/0.6.0` at `4f81ca4f`.
Plan approved by Frank (issue #1183). The PR goes into `integration/0.6.0` with `Closes #1183`.
**Small slice: do only this.**

## Problem
`src/components/export/ExportedMotionDebugDialog.tsx` (~:566–570) shows
`t('dialogs.motionDebug.warning')` ("Warning") in the drawing area in two cases:
- while the trace is still being prepared (`!model`), which takes seconds on a big rotary toolpath;
- after a failure (`error` that isn't `ineligible:`), where it hides the caught message (~:225).
The 3D wrapped view area (`MotionDebugWrappedView`) may have the same gap; check it.

## Task
1. Add an explicit loading state. While the trace is preparing, show "Preparing the exported
   motion…" (new key `dialogs.motionDebug.preparing`) in the drawing area, in 2D and in 3D.
2. On a failure, show "Couldn't prepare the exported motion: {message}" (new key
   `dialogs.motionDebug.prepareFailed`).
3. Leave the verification status line (Verified / Warning plus its list) unchanged.
4. Add both keys to en, de, fr, es and zh-CN, with real translations.
No engine change. Don't touch `src/engine/**`.

## Acceptance
- A dialog test (existing style: see `src/components/export/*.test.ts`; tests run as `npx tsx <file>`,
  not vitest). With the trace request pending, the area shows the preparing text and not
  "Warning". With the request rejecting, it shows the failure text including the message. Both must
  fail on `4f81ca4f`; say how you checked.
- `npm run build` green. Run `e2e/motionDebug.smoke.spec.ts` with `PURECUT_E2E_ISOLATED=1`, a
  free `PURECUT_E2E_PORT`, and `--workers=2`. Report the result.
- Short report: files changed, what you ran.
