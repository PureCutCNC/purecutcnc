# Slice rt7-g: ellipse radius handles live in "Edit ellipse" mode only (#1125 retest, Frank round 7)

Frank (2026-10-31), retesting the w3e-a ellipse radius handles: "I see the dots when I click on the ellipse and I can drag them when I am not in edit ellipse mode. when I am in ellipse edit mode I see the dots but I cannot drag them. we should only show dots when in edit ellipse mode and allow point drag, and manual changes."

Today, `useCannedRadiusDrag` (`src/components/canvas/useCannedRadiusDrag.ts`, `cannedRadiusDrag.ts`) and the drawing in `src/components/canvas/SketchCanvas.tsx` (~line 1110) attach the handles to a plain feature selection, and the drag writes to the store on release. The Edit ellipse panel (`CannedShapeEditPanel.tsx`, a `canned-edit` pending session armed by Properties "Edit ellipse…", live preview through `useCannedShapePreview`, Save commits it as one undo step) draws them but swallows the drag.

What to build:
- **Handles only in Edit ellipse mode.** With a plain selection, no handles are drawn and nothing can be dragged. While the `canned-edit` session for that ellipse is open, the two handles (X radius, Y radius, in the ellipse's own rotated frame, as now) are drawn and can be dragged.
- **Drag edits the panel, not the project.** Dragging a handle updates the panel's rx/ry fields and the live preview through the same path that typed values use. Nothing is written to the project until Save, which stays one undo step; Cancel/Escape discards dragged changes exactly as it discards typed ones. Linked copies follow on Save as today.
- **Fields and handles stay in sync both ways.** Typing an rx/ry value moves the handles to it, and dragging changes the field values (rounded the way the fields already round them).
- Keep the existing drag details: hover highlight, radius measurement while dragging, the centre and rotation unchanged, the minimum radius, and the drag staying on the canvas. If the old direct-write path (release → `updateFeature`) is no longer used, remove it.
- Other canned shapes and plain circles are unchanged.

Tests: plain selection of a canned ellipse shows no handles, and a press where a handle would be does not change rx/ry. In Edit ellipse mode, dragging the X handle changes the panel's rx field and the preview, but not the stored params until Save. Save commits one undo step, and Cancel restores the original. Typing ry moves the Y handle. Rotated-frame drags still work. Update `e2e/ellipseRadiusHandle.smoke.spec.ts` to open Edit ellipse first (Properties button or `editCannedShape`), drag, assert the field, then Save and assert the stored params. Add the plain-selection-no-handles case. Mutations: draw the handles on plain selection again (the test fails); write to the store on release (the before-Save test fails); drop the field→handle sync (the typed test fails).

Off limits: everything else.

## Rules

- You work in your own worktree, based on the rt7-f branch. Read `INDEX.md`, `AGENTS.md`, and the `INDEX.md` of every folder you touch. Do exactly what this handoff asks, nothing wider. Put anything that needs a decision in RISKS.
- `gh` may be blocked in your sandbox.
- Leave edits uncommitted and report `COMMIT: none`. Do not touch `scripts/issue-1112-rt7-a-bolt.camj`.
- Tests must bite: break the code on purpose, confirm a test fails, then restore from a `cp` backup (never `git checkout`).
- React tests run with `NODE_OPTIONS=--no-experimental-global-navigator`. You cannot run a browser; the e2e spec must still be correct and is run by the coordinator.
- Run and report with exit codes: `npm run build:gates`, each changed test file.
- Report: changes per file; tests; mutations; commands with exit codes; RISKS.
