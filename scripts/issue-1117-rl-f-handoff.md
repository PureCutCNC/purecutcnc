# #1117 slice rl-f: correct the twisted-model test, settle the footprint-height check

rl-e (at-layer links on every layer, A-changing partial-ring links) is done in production code; its last review still had one test finding. A read-only Codex diagnosis at 93704d78 settled it:

- The 4 links the review saw fail the rl-c proof on the new twisted fixture in `rotaryAcrossAngleLinks.test.ts` (block 5, ~line 473) are **not gouges**. The fixture builds its mesh with `radiusAt(along, meshAngle - 90)`, but positive machine A exposes mesh direction `90 - A` (see `turnStripTriangles`, `rotarySampling.ts`), so the real machine-frame surface is `radiusAt(along, -A)`. Example: at X2.895 / A14.391° the mesh radius is 2.6805 mm; the fixture's oracle claims 3.4909 mm. With the oracle corrected, all 33 emitted A-changing segments pass the unchanged rl-c proof with 0 mm shortfall (52/52 link segments in full chronological replay).
- The footprint-height check in `linkAcrossAngle` (`gridTip > reachHeight`, `rotaryModel.ts` ~2823) is **redundant for sampled-pose safety**: `linkRowAt` already uses footprint-convolved safe tool-tip samples (`safeToolTipZAt`, `finishSurfaceParallel.ts`) with cell padding and lift. Removing the check changes 720 links / 3 A-changing to 725 / 8 across the 361 property cases, all with 0 mm protected shortfall, and 12 extra twisted-ridge variants gave no differentiator. That is why no generator case can make its mutation fail.

## Do

1. **Fix the fixture's angular mapping** in block 5 so the oracle and the mesh agree (machine A ↔ mesh direction `90 - A`). Add an assertion that the oracle radius matches ray–mesh intersection on that mesh at several (X, A) points, so a sign error cannot come back.
2. **Replace the window-height assertion** added in fix 3 with swept protected-solid assertions using the unchanged rl-c proof (`referenceMove` / `proveAtLayerLink`): every emitted link on the corrected twisted model passes.
3. **Add the corrected twisted model to the generator property replay** (`squareAroundGenerator.property.test.ts`) under the unchanged rl-c rules, with nonzero A-changing link coverage asserted.
4. **Keep the footprint-height check in production as defence in depth** (it may matter between samples; that is not proven either way). Add a one-line comment saying it is redundant with `safeToolTipZAt` for sampled poses. No test is required to fail when it alone is removed; do not add arbitrary clearance thresholds to make it bite.
5. Remove the weaker assertions added in fix rounds 2–3 that no longer carry weight (the half-cell clearance minimum, the window-height check).

## Tests that must bite

- Restore the old (wrong-sign) mapping in the fixture → the oracle-vs-mesh assertion fails.
- Skip the whole-segment slit validation (fix 1) → its regression still fails.
- Restore the max envelope for the `'atLayer'` leftover → the later-layers test still fails.

## Rules

- **Production code unchanged** apart from the one comment: raised links and equal-A links byte-identical to 93704d78, A-changing links too.
- Approved plan: issue #1117 plan comment and Frank's approval; this slice finishes rl-e on Frank's instruction ("handle both issues", 2026-11-02).
- No setting, UI, locale or format change. No #1103 work. One heavy process at a time.
- Report: changes per file; each mutation and whether it was caught; commands with exit codes; RISKS.

## Review note

The reviewer must not ask for a test that fails when only the footprint-height check is removed: the diagnosis above shows it is redundant for sampled poses, and it stays as defence in depth by decision.
