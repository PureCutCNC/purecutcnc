# Slice w3e-a: drag the ellipse's two radii on the canvas, like a circle (Frank's test of PR #1125)

Frank (2026-10-31): "why don't we edit ellipse like we do circle? allow drag and drop for two radiuses (one locked at X and one at Y, on the translated origin)."

Today a canned ellipse (`src/cannedShapes/generators/ellipse.ts`, params `rx`, `ry`, outline generated at the definition origin and placed by the instance transform) is edited only through the numeric "Edit ellipse…" panel (`src/components/canvas/CannedShapeEditPanel.tsx`, `ELLIPSE_EDITOR_REQUEST`). A circle is edited on the canvas by dragging its radius handle (see the circle controls in `src/components/canvas/`: `circle_center`, `arc_handle`, `useDimensionEditWorkflow.ts`, `scenePrimitives.ts`, `measurements.ts`).

- Give the canned ellipse two radius handles, drawn and entered the same way a circle's radius handle is: one at the end of its local X axis (`(rx, 0)`), one at the end of its local Y axis (`(0, ry)`), both in the ellipse's own frame, so through its placed centre and following the instance's rotation/mirror.
- Dragging a handle moves it only along its own axis (X handle changes `rx` only, Y handle `ry` only); the centre stays put. Live preview while dragging, the radius shown the way a circle's radius is shown, snapping as for the circle handle, values > 0 (clamp at a small minimum, never flip). Release writes the new params in one `updateFeature` (one undo step), through the same normalize path the Edit panel uses, so linked instances and the Properties summary update exactly as after an Edit-panel Apply.
- The "Edit ellipse…" panel stays; its fields show the dragged values.
- Only the ellipse kind. Other canned shapes unchanged. Desktop and tablet (touch drag) both.

Tests: unit tests for the handle positions (with a translated, rotated and mirrored instance) and for the drag → params mapping (axis lock, centre fixed, minimum clamp, one write). Mutations: let the X handle change `ry`; drop the instance rotation from the handle frame. Add an e2e spec (not in the "CAM and interaction" lane, it is full) that drags each handle on a placed, rotated ellipse and checks the stored `rx`/`ry` and that undo restores them; list it in RISKS since you can't run it.

Off limits: everything else.

## Rules for every slice (issue #1112, PR #1125, Frank's test)

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

