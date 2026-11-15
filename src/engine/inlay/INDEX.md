# INDEX - src/engine/inlay/

Pure geometry for 2-sided V-carve inlays. No store, no UI, no toolpath engine:
`computeInlayGeometry()` turns selected profiles plus inlay parameters into the
pocket floor, plug ridge and plug shoulder boundaries, the plug frame, derived
numbers, and the refusal list the wizard shows.

## Files

- `types.ts` - `InlayParams`, `InlayInputShape`, `InlayShape`, `InlayProblem`,
  `InlayDerived`, `InlayGeometry`.
- `geometry.ts` - `computeInlayGeometry()`: V-bit slope/inset math, per-loop
  Clipper offsets that keep subtract/add roles, plug mirror about the vertical
  placement axis, frame, and `tooThin` / `grooveWiderThanBit` / `baseTooThin` /
  `depthTooDeep` refusals. `INLAY_FRAME_MARGIN` and `INLAY_MIN_WALL_STEP` are
  the wizard's fixed limits.
- `geometry.test.ts` - reference numbers from `PLAN-inlay-wizard.md` §4.5, the
  mirror and frame, counter-loop roles, the four refusals, curved-profile
  winding, and parameter validation. Run with
  `npx tsx src/engine/inlay/geometry.test.ts`.
