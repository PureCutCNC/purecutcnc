# Issue #1015 — independent review of the whole branch

You are an independent **read-only** reviewer. Do not edit, stage, commit or
push anything. Put the whole review in your final message.

Review `git diff origin/integration/0.6.0...HEAD -- . ':!scripts/issue-1015-*'`
on `feat/issue-1015-rotary-model`: machining an imported 3D model inside a
round bar on a rotary axis. The design, slice by slice, is in
`scripts/issue-1015-{a,b,c,d,e}-handoff.md` (read all five first). The frozen
rotary sign is `src/engine/rotaryFrame.ts`; the wrapped toolpath form is
`wrapPoint` in `src/engine/aroundFrame.ts`.

The core is `src/engine/toolpaths/rotaryModel.ts` (sampler, finish, rough,
along range) and `src/engine/toolpaths/rotaryOperation.ts` (the operation
adapter); the rest wires two operation kinds into the app.

Look hardest for defects that would **cut the wrong thing on a machine**:

- a tool position below the model surface plus stock (gouge), or below the
  centreline;
- a move that turns the stock while the tool is low enough to hit material
  that is still standing (links between passes and between runs, entry,
  layer changes in the rough);
- the along range: anything cut beyond the model's own length, into an end
  support, or into a chuck or tailstock keep-out (including the tool's
  radius);
- angles: sign, units (degrees), continuity (the angle must never jump back
  between moves in a way the machine would read as an unwind through
  material), and agreement with `rotaryFrame.ts`;
- stock to leave, flat versus ball nose, the sampler's `NaN` handling;
- the reversed-pass indexing (a previous version read each return pass's
  heights at its mirror position);
- anything in the wiring that lets a rotary operation run outside an Around
  setup on a round bar, or lets other Around operations target a model.

Also: React or store mistakes in the CAM panel changes, missing fields in
`operationComputationEquals`, locale problems, tests that cannot fail. Run
`npx tsx src/engine/toolpaths/rotaryModel.test.ts` and
`npx tsx src/engine/toolpaths/rotaryOperation.test.ts` if you can and say
whether they ran.

Final message: findings ranked, "must fix" separated from the rest, each with
file:line, a concrete failure scenario, and a suggested fix; then what you ran
and what you only read.
