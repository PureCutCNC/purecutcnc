# Issue #1177 handoff, slice bal-a: ball-aware rotary finish, clean edges at both ends

Base `fix/issue-1177-hex-shoulder-ledge` (PR #1180: the Turn shoulder cleanup at
`18d908f6`, plus handoffs). Plan approved by Frank on 2026-11-09 in the #1177 comments
("Revised plan" plus the two "Plan addition" comments). This handoff restates it in full.
The PR goes into `integration/0.6.0` with `Closes #1177`. It's not merged until Frank has
checked it in the app.

**Earlier rounds were declared fixed on probe numbers that didn't match what Frank sees.
This time the proof is the cut material and the exported program on his file, at every
place listed below.** Protected engine path: plan approved, full lane.

## Frank's file and the measured problem
- `work/bolt-test-02-x-mm.camj` (mm, gitignored). Copy it from
  `/home/frankp/Projects/worktrees/purecutcnc/fix-issue-1177-hex-shoulder-ledge/work/`,
  and never commit it or put it in `test-fixtures/`. Rotary setup "02 Around", bar Ø50.8
  along X. Hex f0184 (AF 38.1, X 19.05–31.75): op0195 Rotary rough, op0196 **Rotary
  finish** (1/8" ball). Turn f0186 (Ø25.4 from X 30.48): op0197/op0198 (1/4" flat). The
  Hex's chuck end (X 19.05) is against uncut bar.
- Two independent analyses, read both:
  `/home/frankp/.config/Claude/side-session-notes/local_a7852f39-8fb1-4925-996e-55b4f11bd229/1177-codex-analysis.md`
  and `.../1177-claude-analysis.md`. They agree that op0196's ball tip runs high near
  every facet corner on all six flats: ~0.21 mm at δ 25–27° along the helix
  (X 19.05–28.33), and 0.59 mm on the ring-only columns (X 28.82–31.75) next to the Turn.
  Material left: ~0 mid-flat, 0.19–0.20 mm 0.5–1 mm inside each edge, 0.33 mm near the
  shoulder.
- Codex also found radial steps of 0.054 mm in the program at A ≡ 35.73° / 324.27° on
  every turn (a sampled-lift jump emitted as a G94 Z-only step; `rotaryModel.ts` ~875
  `emitRotaryRuns`).

## Task
1. **Ball-aware exact read** in `src/engine/toolpaths/rotarySampling.ts`
   `exactFootprintTips` (~1446/1462). Today it takes the maximum over a **flat disc** for
   every cutter, which over-reads a ball by R(sin δ + cos δ − 1)/cos δ. For
   `ball_endmill`, use an exact sphere drop onto each candidate triangle (facet interior,
   edges, vertices: standard drop-cutter), tip = sphere centre − R. Keep the flat branch
   byte for byte, and correct the docstring (~1441–1444).
2. **Give a ball helix the exact read**: drop `|| tool.type !== 'flat_endmill'` at
   `rotaryModel.ts` ~3755–3756 (finish) and ~3801–3802 (rough). No reach-shortening pad
   for a ball (`exactTipPad` as a shortened reach puts back ~pad·tan δ). Cover the chord
   between samples another way, and say how.
3. **No per-turn radial steps** inside a cutting pass: find why the lift jumps at
   A ≡ 35.73°/324.27° and remove the cause, or prove that 1–2 remove it.
4. **Wall-foot cleanup at both ends** (Frank: "we seem to handle edges only if there is
   another feature next to it… the side next to the chuck should also be handled… without
   that the ball end tool stops at the edge and leaves a ridge"). The wall-foot / edge
   cleanup (`rotaryWallFeet`, ~2335, and the neighbour-column logic ~2694–2712 /
   ~3033–3049 / ~3360–3363) must run at **every end wall** of a rotary target, whatever
   forms the wall: a neighbour feature, uncut stock, or the bar towards the chuck. Use the
   same passes and the same ball-aware read at both ends. An end with no wall (the target
   runs off the bar end, or the material beyond is already lower) needs none.
5. Keep PR #1180's Turn shoulder cleanup unless test 4b shows it's no longer needed. Keep
   the #1173 shank rules, the #1155 neighbour protection and the forward-only A rule
   (#1103).

## Tests (engine level; each must fail on 18d908f6, and show it by mutation)
Build the fixture in the test (style of `rotaryNeighbourOverlapJitter.test.ts`): Ø50.8
bar, Hex AF 38.1 over X 19.05–31.75 with uncut stock on the chuck side, a Turn Ø25.4 from
X 30.48, 1/8" ball finish and 1/4" flat Turn operations, stock to leave 0.
- **A.** Every op0196 cut pose's tip is within 0.05 mm above the exact ball-over-hexagon
  envelope, on all 12 corners (entry and exit asserted separately) at several X,
  including X within R + cell of each end wall. Today: 0.59 / 0.21.
- **B.** The ball envelope of all moves leaves ≤ 0.05 mm above each facet plane across
  the full facet width, the corner edges included. Today: 0.20 / 0.34.
- **C.** No gouge (≥ −0.01 mm) anywhere.
- **D.** No radial step > 0.01 mm inside a cutting pass. Today: 0.054.
- **4b.** Full rotary sequence: material on every facet from X 28 mm to the shoulder face
  ≤ 0.05 mm, with no gouge into the shoulder.
- **4c.** Full rotary sequence: material within the wall-foot band at **both** Hex ends
  ≤ 0.05 mm on every facet, and the two ends match within 0.02 mm. It must fail at the
  chuck end today.
- Run A–D also at a shifted sampling phase (start line rotated by half a sample).

## Proof on Frank's file (put the paths in the report)
- Regenerate op0195–op0198 from the app code on his file and report A, B and D numbers
  per corner, plus both end bands.
- Headless app (as `scripts/issue-1177-sim-app.ts` on branch
  `feat/issue-1177-1177-sim-a-dsh` does; copy it if useful): Simulation tab, all four
  rotary operations Visible. Save screenshots of **both ends** of the Hex flats and of
  one corner edge to your worktree's `work/`.
- Exported A-flip and block-time counts for op0196 and op0198 no worse than before:
  A moves, A direction flips, blocks under 10 ms, adjacent A-rate jumps over 1.5×, and
  G0 Z lifts. Give before and after.
- `npm run build` green. Run the rotary test files and the around/rotary e2e specs with
  `PURECUT_E2E_ISOLATED=1`, a free `PURECUT_E2E_PORT`, and `--workers=2`. Report which
  ran.

## Report
Files changed, how each step was done, all the numbers above (before and after),
screenshot paths, what you ran versus only read, and anything you couldn't do.
