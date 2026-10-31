# Slice rt5-a: tablet face control in the top bar (item 37)

On a tablet the face control (`src/components/layout/FaceSwitch.tsx`, placed by `FaceBanner.tsx` / `AppShell.tsx`) sits in its own row under the top bar (the workspace header row the #1107 tablet layout gave it). Frank: put it in the same row as the Sketch / 3D / Sim switch.

- Tablet layout: render the face control in the top bar right after the Sketch / 3D / Sim switch, 44×44 px target, same menu. Remove the extra row (no empty row left behind).
- If the bar is too narrow at the smallest supported tablet landscape width (check 1024 and 1180 wide), shrink what already shrinks there (project title truncation, icon-only buttons) instead of bringing the row back. Report the widths checked.
- Shown only when it is today (`showsFaceSwitch`). Desktop unchanged (right end of the centre panel's tab bar).
- Update `e2e/tablet1112.smoke.spec.ts` and the tablet checks in `e2e/setupFaces.smoke.spec.ts` / `e2e/aroundFace.smoke.spec.ts` that assert the old row; keep a check that the control is in the top bar, fits, and works by tap.

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

