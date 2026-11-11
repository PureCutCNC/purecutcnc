# Issue #1186 handoff, slice eye-a: show/hide toolpaths per setup (face)

Branch `fix/issue-1186-setup-toolpath-eye`, based on `integration/0.6.0` at `8aa3d676`.
Plan approved by Frank for 0.6.0 (issue #1186). The PR goes into `integration/0.6.0` with
`Closes #1186`. **Small UI slice: do only this.**

## Task
1. In the CAM panel (`src/components/cam/CAMPanel.tsx`), add an eye button to each setup (face)
   header, next to that header's other actions. Copy the look and the rule of the panel-level
   toggle (~:2250, `allToolpathsToggle` / `allToolpathsToggleEnabled` in
   `src/components/cam/toolpathToggle.ts`): if any of the setup's operations shows its toolpath,
   the click hides all of them; otherwise it shows them all. Disable it when the setup has no
   operations. Show eye / eye-off, muted when none are visible.
2. Add a store action `setSetupOperationToolpathVisibility(setupId, visible)` in
   `src/store/slices/operationsSlice.ts` (type in `src/store/types.ts`), next to
   `setAllOperationToolpathVisibility` (~:445). It changes `showToolpath` only on that setup's
   operations, in one undo step like the existing action.
3. Leave the panel-level toggle as it is.
4. Labels: `cam.setup.showToolpaths` "Show this setup's toolpaths" and `cam.setup.hideToolpaths`
   "Hide this setup's toolpaths", with the setup's name in the tooltip if the header shows one. Add
   both to en, de, fr, es and zh-CN with real translations.

## Acceptance
- A store test: only the chosen setup's operations change, it's one undo step (undo restores them
  all), and other setups are untouched.
- An e2e test (CAM lane, as the existing visibility specs do): with two setups that both have
  visible toolpaths, clicking setup A's eye hides A's and B's stay visible. Clicking again shows
  A's.
- Both tests must fail without the change. Check that and say how.
- `npm run build` green. Run the spec(s) you touched with `PURECUT_E2E_ISOLATED=1`, a free
  `PURECUT_E2E_PORT` and `--workers=2`. Never use port 1420.
- Short report: files changed, what you ran.
