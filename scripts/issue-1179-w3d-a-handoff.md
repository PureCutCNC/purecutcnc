# Issue #1179 handoff: 3D wrapped view in the Exported Motion debug dialog

Branch `fix/issue-1179-exported-motion-3d`, based on `integration/0.6.0` at
`1c4ab3e8`. The plan of record is issue #1179, queued by Frank for 0.6.0. The PR goes
into `integration/0.6.0` with `Closes #1179` and a Manual impact section (expected:
none, because the dialog is a developer debug aid). It is not merged until Frank has
checked it in the app.

## Gap
The Exported Motion debug dialog (`src/components/export/ExportedMotionDebugDialog.tsx`,
SVG paths from `motionDebugSvg.ts`) draws a flat 2D plan. An exported rotary program
(own A word or a borrowed X/Y motor, G93 inverse-time feed) can't be seen wrapped
around the bar. The parser already carries the angle on each parsed endpoint
(`parseExportedMotion` in `src/engine/gcode/motionDebug.ts`, see the `a` comparison
around :358).

## Task
1. Add a "3D wrapped" view to the dialog. Show it only when the operation is an
   Around/rotary operation whose exported motion carries angles. Keep the existing 2D
   view as the default for everything else, and leave it unchanged.
2. Turn the parsed exported moves into `ToolpathMove`s in project space, with `a` on
   each point. Draw them through the existing CPU wrap path,
   `stockSpaceMoves(moves, stock)` in `src/components/viewport3d/toolpathOverlay.ts`.
   It already splits any move that changes the angle into pieces of at most 5° (a
   straight machine move is a helix on the part). Do not write a second wrap
   transform.
3. Draw with three.js in a small canvas inside the dialog, with orbit controls.
   Rapids and feeds get different colours, and the bar outline (cylinder, or box for a
   square blank) is drawn faint for reference. Add an angle readout: the A range of
   the program, and the A of the hovered or nearest point if that is cheap. Otherwise
   just the range.
   Use the existing `theme-exempt: developer-only motion-debug overlay` colour pattern.
   Dispose the renderer, geometry and controls when the dialog closes.
4. Optionally also show the Generated/Optimized layers wrapped the same way, if that
   is a few lines. Exported is the required one.
5. New UI strings go in every locale (`en`, `de`, `fr`, `es`, `zh-CN`) with real
   translations.

## Rules
- Do not edit `src/engine/gcode/**`, `src/engine/toolpaths/**`, `src/machine/**`,
  `src/types/project.ts` or `projectFormat.ts`. Those are protected. If the view
  cannot be built without a change there, stop and report what change is needed and
  why, instead of making it.
- No change to exported programs, toolpaths or the simulation. This is view-only.
- No new user setting. The view toggle is local dialog state.
- Do not use `process.env` or `globalThis` switches.

## Acceptance
- A unit test on the move conversion: a G93 program with one move turning A by 90°
  gives wrapped pieces whose points lie on the bar radius at the right angles. It must
  fail if the angle is dropped or the subdivision is removed. Also cover a
  borrowed-motor machine (angle on Y or X) if the parser supports it there.
- Extend `e2e/motionDebug.smoke.spec.ts` (or add a sibling spec): open the dialog for
  a rotary operation, switch to the 3D view, assert the canvas renders and the angle
  readout shows. Also assert that a flat milling operation does not offer the 3D view.
- `npm run build` green. Run the motion-debug e2e spec(s), and report which ones ran.
- Report: files changed, how the moves are converted, and what was run versus only
  read.
