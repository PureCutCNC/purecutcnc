# Slice rt6-b: a compact Cuts list (item 40)

Frank (2026-10-31, screenshot of an Around Thread operation on a tablet): "can we condense the Cuts list a bit, it takes too much space when there are multiple entries". Each cut is a full row (`src/components/cam/OperationCuts.tsx`, `.cam-cuts__*` in `src/styles/face.css`), and on a tablet each row is 44 px tall because the remove button is a 44 × 44 touch target (`[data-shell-mode='tablet'] .cam-cuts__remove`). Two cuts take ~100 px, with the "Cuts" label floating beside them.

- Show the cuts as compact chips that wrap: icon + name (ellipsis for long names, full name in `title`) + a small ×, several per line when they fit. Chips stay grouped as now (folders keep their summary/disclosure; Stock and the filter tag still show). Desktop and tablet.
- On a tablet the visible chip may be smaller than 44 px, but each × keeps a ≥ 44 × 44 touch area (it may extend past the chip's edge, e.g. with a pseudo-element or padding with negative margin) and two neighbouring chips' touch areas must not overlap; check with `elementFromPoint` at the edges.
- Put the "Cuts" label on its own line above the chips when the list wraps to more than one line or always, whichever reads cleaner next to the other fields; keep the field aligned with the others in the panel.
- Same accessible names and behaviour: remove button label `cam.operation.cutsRemove`, keyboard focus order, hover. No locale changes needed unless you add text.

Tests: update the specs that assert Cuts rows (`e2e/setupCam.smoke.spec.ts`, `e2e/tablet1112.smoke.spec.ts`, `e2e/rotaryModel.smoke.spec.ts`, grep `cam-cuts`) without weakening them; add to `tablet1112` a check that three short cuts fit on one line at 1180 wide, each × has a ≥ 44 × 44 hit area and taps remove the right cut. Desktop: three short cuts on one line in the default panel width.

Off limits: everything else.

## Rules for every slice (issue #1112, PR #1126, Frank's test round 6)

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

