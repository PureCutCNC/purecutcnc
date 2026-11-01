# Slice rt7-f: rotary canned shapes — Move on Around, Copy locked to the bar axis, and no Rotate/Resize/Mirror (item 42 retest, Frank round 7)

Frank (2026-10-31): "about 42 - we created a bit of a mess. copy is allowed in top and Around, but move is only in Top for all rotary features. we should allow move in the Around, with the same method we did for top now. and copy does not lock the rotary axis and it should. Also the rotate, resize, mirror should probably not be allowed in the context menu (resize should point to the edit, others not allowed (maybe add expand to features first message like some others do?)"

"Rotary canned shapes" means Turn, Polygon/Hex, Thread and Flutes. rt6-d added `src/store/helpers/rotaryMove.ts` (`moveCannedRotaryFeatures`, `projectMovePreviewPoint`, `rotaryMoveTranslateDelta`, …): Move on Top keeps the preview locked to the bar axis, clamps to the bar, and keeps Thread/Flutes synced to their surface.

1. **Move on Around.** Find why Move is refused or unavailable on Around for these shapes (context menu `moveReason`/other-face gating in `src/components/feature-tree/FeatureContextMenu.tsx`, toolbar, keyboard, canvas move tool on the Around sheet), and allow it there with the same method as Top: preview locked to the bar axis (on the Around sheet the along direction), commit through the same rotary move path, same clamping, same Thread/Flutes surface sync, one undo step. Moving a Turn or Hex from Around moves it along the bar, as on Top.
2. **Copy locked to the bar axis.** Copy of a rotary canned shape, on Top and on Around, must behave like Move: preview locked to the bar axis, placement along the bar only, same clamping and surface sync, and the copy is a correct linked instance as today. Reuse the rotary move helpers; do not write a second projection.
3. **Context menu: Rotate, Resize, Mirror** for a selection that contains a rotary canned shape:
   - **Resize** is disabled, with a visible reason pointing to the shape's editor, e.g. "Change the size in Edit thread…" (use the shape's own label as the Edit entry does).
   - **Rotate** and **Mirror** are disabled with the existing reason `sketch.canned.actionRefused` ("Expand to features first"), exactly as Offset/Join do.
   - Apply the same refusal wherever else these actions start for such a selection (toolbar, keyboard shortcut, canvas handles), so nothing bypasses the menu. List what you found in RISKS.
   - Other canned kinds (ellipse, etc.) and plain features keep today's behaviour.
4. Locale keys: any new reason text in `en` and every other locale under `src/i18n/locales/`, with real translations; run `npm run check:i18n`.

Tests: Move of a Thread, a Flutes and a Turn on Around ends on the bar axis (across component unchanged), is clamped at both bar ends, keeps the Thread on its surface, and undoes in one step. Copy on Top and on Around: the preview and the result are locked to the axis, clamped, and synced. The context menu for a Turn, a Hex, a Thread and a Flutes shows Resize disabled with the editor reason and Rotate/Mirror disabled with "Expand to features first". An ellipse and a plain feature are unchanged. Mutations: drop the Around move path (the Around test fails); copy without the axis lock (the copy test fails); remove the Resize refusal (the menu test fails). Update any `e2e/` spec that asserts the old behaviour (grep `rotaryMove`, the copy/move/resize/rotate/mirror menu labels, `aroundSketch.smoke.spec.ts`) and list it in RISKS.

Off limits: everything else.

## Rules

- You work in your own worktree, based on the rt7-e branch. Read `INDEX.md`, `AGENTS.md`, and the `INDEX.md` of every folder you touch. Do exactly what this handoff asks, nothing wider. Put anything that needs a decision in RISKS.
- `gh` may be blocked in your sandbox.
- Leave edits uncommitted and report `COMMIT: none`. Do not touch `scripts/issue-1112-rt7-a-bolt.camj`.
- Project format stays 3.3. Toolpaths are unchanged.
- Tests must bite: break the code on purpose, confirm a test fails, then restore from a `cp` backup (never `git checkout`).
- React tests run with `NODE_OPTIONS=--no-experimental-global-navigator`. You cannot run a browser.
- Run and report with exit codes: `npm run build:gates`, `npm run check:i18n` if locales changed, each changed test file.
- Report: changes per file; tests; mutations; commands with exit codes; RISKS.
