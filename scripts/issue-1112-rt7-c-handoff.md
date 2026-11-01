# Slice rt7-c: "Edit turn…/Edit polygon…" in the context menu on Around, matching Properties (Frank, round 7)

Frank (2026-10-31): "edit turn/polygon are grayed out in the context menu when in around but they are available in the properties panel. they should be available in the context too to match panel."

Cause: Turn and Polygon/Hex are stored with `authoringFace: 'top'`. On the Around face, `src/components/feature-tree/FeatureContextMenu.tsx` treats them as other-face features. The canned-shape editor entry (~line 520) is `disabled={!cannedEditor || onOtherFace}`, and its reason is `otherFaceEditingReason` (~line 272). If the feature is not targetable from the face, the whole ghost menu (~line 202) shows only "switch face". The Properties panel opens the same editor from Around.

- Find the rule the Properties panel uses to offer "Edit {shape}…" on a canned feature (and through which action), and make the context menu's "Edit {shape}…" entry follow exactly that rule on every face. Wherever Properties offers it enabled, the menu offers it enabled, and it opens the same editor through `actions.editCannedShape`. Where Properties refuses it, the menu refuses with the same reason. Prefer one shared predicate over two copies.
- This covers the normal menu and the ghost (other-face) menu. If the ghost menu is what Frank sees for a Turn or Hex on Around, add the canned edit entry there, above the switch-face entry.
- Every other entry (Edit sketch, Move, constraints, change face, …) and every other face rule stays exactly as it is.

Tests: on Around, the context menu for a Turn and for a Hex offers "Edit {shape}…" enabled, and clicking it opens the editor with that feature. A canned kind that Properties refuses on a face is still refused in the menu with the same reason. A non-rotary feature from the other face is unchanged (Edit sketch still disabled with the switch-face reason). Mutation: restore `onOtherFace` in the entry's `disabled`, and the Around test must fail. Update any `e2e/` spec that asserts this entry is disabled on Around (grep `cannedEdit`, `Edit turn`, `Edit polygon`, `feature-context-menu--ghost`) and list it in RISKS.

Off limits: everything else.

## Rules

- You work in your own worktree, based on the rt7-b branch. Read `INDEX.md`, `AGENTS.md`, and the `INDEX.md` of every folder you touch. Do exactly what this handoff asks, nothing wider. Put anything that needs a decision in RISKS.
- `gh` may be blocked in your sandbox.
- Leave edits uncommitted and report `COMMIT: none`. Do not touch `scripts/issue-1112-rt7-a-bolt.camj`.
- Locale changes only if unavoidable, then in every locale with real translations; run `npm run check:i18n`.
- Tests must bite: break the code on purpose, confirm a test fails, then restore from a `cp` backup (never `git checkout`).
- React tests run with `NODE_OPTIONS=--no-experimental-global-navigator`. You cannot run a browser.
- Run and report with exit codes: `npm run build:gates`, each changed test file.
- Report: changes per file; tests; mutation; commands with exit codes; RISKS.
