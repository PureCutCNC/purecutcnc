# Slice rt7-a: fix the rt6-e neighbour trim — polygon corners, and the section a line is drawn on (item 41 retest, safety)

Frank retested rt6-e on his bolt file (copied here as `scripts/issue-1112-rt7-a-bolt.camj`; inch, 1.5" round bar, 30° V-bit Follow line "Engrave", carveDepth 0.122). He found two bugs in `src/engine/toolpaths/neighbourKeepOut.ts` and the bands from `src/engine/aroundFrame.ts` (~line 280–330).

1. **The thread still gouges the Hex.** The warning says "stopped 0.0829 inch short of Hex", but the V-bit still cuts into the Hex at its start. Cause: a Polygon/Hex body band takes `surfaceZ` from the feature's `z_top`. For a canned polygon that is the across-flats radius (Hex: acrossFlats 1.125, so 0.5625 above the axis). The corners reach `flats/2 / cos(π/sides)` = 0.6495, and they sweep past the cutter as the bar turns. The cone half-width at the corner height is 0.106, not 0.0829, so the cut is about 0.023 too close. Fix: a body band's keep-out height is the body's **largest** radius at any angle. For a canned polygon that is the circumradius from its params (sides, acrossFlats, after any rotation). For other bodies, check whether `z_top` already is the maximum (models, Turn sections) and say what you found in RISKS. The warning distance must report the half-width actually used.

2. **A line drawn on a Turn is dropped entirely.** "Polyline 6: nothing was cut — the line would cut into Turn". Polyline 6 runs around the bar at along ≈ 6.5, on the Turn (along 1.5–7.5, surface 0.375 above the axis). Its `z_top` is 1.0 (0.25 above the axis), below the Turn surface. `isWall` treats a `turn`/`bar` band as a wall whenever its surface is above the guide's, including the band the guide lies on. Fix: the band (or bands) under the guide's own along extent are its surface, never a wall, for every kind (`turn`, `bar`, `body`, extending the existing `supports` rule). A neighbouring band beside the guide's along extent, such as a larger Turn step, uncut bar, or a Hex, is still a wall exactly as now. Where a guide crosses from one band onto a higher one (for example a line running off a Turn onto uncut bar), the higher one is still a wall for the part of the guide on the lower one. Pick the closest correct rule, explain it in the doc comment and RISKS, and make Polyline 6 cut exactly what it cut before rt6-e (byte-identical toolpath for that feature).
   The extra depth from Polyline 6's `z_top` being below the Turn is not this slice's job (that is #1131); do not change cut depths.

Tests (on top of the existing `aroundNeighbourKeepOut.test.ts`):
- Load `scripts/issue-1112-rt7-a-bolt.camj` in a probe test only, not a committed fixture. Generate the Engrave operation and assert that at every cutting move on Thread and Thread Copy the cutter body (V-bit cone at the move's tip Z) stays clear of the Hex/Hex Copy circumradius cylinder (along band 1.0–1.5 and 4.0–4.5). Report the minimum clearance found. Then reconstruct the same case inline in a committed unit test (the file stays uncommitted after the slice, because the dispatcher removes it).
- Polyline 6 and Polyline 6 Copy are cut, with no "nothing was cut" warning, and the output is byte-identical to the pre-rt6-e behaviour.
- A line on a Turn that runs onto a larger neighbouring section is still trimmed at that section.
- A flat Hex (rotation changes the corner angle) still uses the circumradius.
- Mutations: use the flats radius again (corner test fails); drop the supporting-band rule for `turn` (Polyline test fails); make every overlapping band supporting (the crossing test fails).

Off limits: everything else.

## Rules for every slice (issue #1112, PR #1126, Frank's test round 7)

- You work in your own worktree, based on `feat/issue-1112-wave4`. Read `INDEX.md`, `AGENTS.md`, and the `INDEX.md` of every folder you touch. Do exactly what this handoff asks, nothing wider. If something here is wrong or needs a decision, say so in RISKS and do the closest correct thing.
- `gh` may be blocked in your sandbox; everything you need is here.
- Leave edits uncommitted and report `COMMIT: none`; the dispatcher commits. Do not commit or move `scripts/issue-1112-rt7-a-bolt.camj`.
- Project format stays 3.3. Toolpaths stay byte-identical except where this handoff changes them.
- Locale changes (only if a warning's wording must change): every locale gets them, with real translations; run `npm run check:i18n`.
- Tests must bite: for each behaviour, break the code on purpose, confirm a test fails, then restore from a `cp` backup (never `git checkout`). Report each mutation and whether it was caught.
- You cannot run a browser. Update any `e2e/` spec that asserts what you change, without weakening it, and list it in RISKS.
- Run and report with exit codes: `npm run build:gates`, plus each changed or new test file directly.
- Report: changes per file; tests added; minimum Hex clearance on the bolt file before and after; each mutation and whether it was caught; commands with exit codes; RISKS.
