# Issue #1177 bal-a, correction round 1: report

Base for the slice: `fix/issue-1177-hex-shoulder-ledge` at `a1eaa71d`. The reviewed
commit is `52562b6f`. Every number below was measured on Frank's
`work/bolt-test-02-x-mm.camj` (gitignored) with the engine at `a1eaa71d` ("before")
and at this branch ("after"); the engine diff between the two is the slice's own
`rotaryModel.ts` + `rotarySampling.ts` change, unchanged by this round.

## Findings, and how each was fixed and tested

1. **`rotaryModel.test.ts` tautology (`traverses.length >= 0`).** Replaced with
   `assert.equal(traverses.length, 0)`: the ball's exact read reaches both
   prisms' end faces, so the two runs are joined by cut moves and no rapid
   travels between them. Test: the same block asserts those bridging cuts exist
   (a non-rapid move wholly inside the 14..19 gap). Mutation that fails it:
   restoring the old conservative read makes the finish retract across the gap
   (three rapids, one traverse), so `traverses` is 1 and the equality fails.
2. **`rotaryContinuous.test.ts` threw on `[first, second]`.** The band really is
   one helix piece now, so the block asserts exactly that: one piece from
   `ringGrid[0]` to `ringGrid[last]`, the two boundary rings as the only separate
   rings, and the middle feature's top cut by the helix. The old
   helix–rings–helix split and its `entryLink` helper are gone. Test: running
   the file (it threw before). The seam-link coverage the split used to give is
   **not** restored; see "Known limits" below.
3. **`rotaryModel.test.ts` sampler cross-check replaced by `isFinite(p.x)`.** The
   separate `sampleRotaryModel` grid is back as the reference (with
   `exactTipRows: true`, the read the operation takes; the option had to be
   added to `RotarySampleOptions`, which had been dropping it). Every emitted cut point
   must lie inside its pass's sampled tip range, and a point on a sampled column
   may not be below that column's own read. Test: a plunge into the air gap or a
   dropped end fails it; `isFinite(x) && isFinite(z)` would pass both.
4. **`rotaryModel.test.ts` end-tip height dropped.** Restored as a height check:
   every pass's end move must be within 0.002 mm of the sampler's end tip. On
   this fixture the exact read sees the cylinder cap's rim, one 128-gon facet
   nearer than the row's cell sample — 0.0010 mm measured — so the equality is
   kept to the mesh's own sag. Test: presence-only would pass a 41 mm link
   height; the height check fails it.
5. **Lint (three errors).** Removed the unused `ToolpathMove` and `anchor` from
   `issue-1177-bal-probe.ts` and made `sampling` load-bearing again (finding 3).
   `npx eslint` on all changed files is clean; `npm run build:gates` green.
6. **A–D not run at a shifted sampling phase.** `issue-1177-ballFinish.test.ts`
   now generates and re-reads the whole fixture at `rotationDeg = 0.4465` (half
   the fixture's sampling step) as well as 0: A/C (`checkEnvelope`), D
   (`checkRadialSteps`) pass at both, worst A excess **0.0000 mm** at each. The
   blocker last round was the phase sign: the feature's rotation appears as
   `-rotationDeg` in the commanded frame, and the corner buckets now use the
   same phase. With `+rotationDeg` the check is half a corner off and reports
   0.190 mm, which is what the earlier round saw.
7. **A-flip / block-time counts absent.** Added
   `scripts/issue-1177-bal-export.ts`: exports op0196 and op0198 with the real
   postprocessor (`grbl-rotary-a`, the project carries no selected machine) and
   counts from the **G-code**. The post uses `G93`, so a block's time is exactly
   `60/F` seconds. Before/after in the table below.
8. **Screenshots absent.** Added `scripts/issue-1177-bal-shots.ts`: drives the
   real app headless (Playwright), loads the file, hides Engrave and Cutout,
   Visible mode at detail 1120, and screenshots the simulation viewport with the
   app's own camera. Four PNGs in `work/` (paths below); the tab reported
   `view bar`, `min Z 12.699750900268555`, 799680 removed cells, no console
   errors.
9. **No written report.** This file.
10. **Found while running the e2e lane: the worker payload dropped
   `exactTipRows`.** `RotaryAngleSetupPayload` did not carry the flag, and
   `createRotaryAngleKernel` rebuilds the prep from that payload, so every pooled
   ball row read the conservative cell row while the serial path read the exact
   one. The round-bar preview therefore drew **3241** segments against the
   **760** a fresh generation gave, and
   `rotaryModel.smoke.spec.ts › turning the bar square…` failed (it passes on
   the base engine). Fixed by adding `exactTipRows` to the payload, forwarding it
   in `buildRotaryAngleSetup` and adopting it in the kernel; the protocol version
   goes 2 → 3 so a stale worker bundle fails loudly instead of silently reading
   conservatively. Test: a new block in `rotaryAnglePool.test.ts` runs a
   `exactTipRows` prep through `buildRotaryAngleSetup` + `createRotaryAngleKernel`
   and compares it with `runRotaryAngleJob` (0 mismatched values with the flag,
   96 without it, and the exact row differs from the conservative `row + lift` by
   up to 0.0803 mm). The e2e is the end-to-end check: 72 passed after the fix,
   the same test failing before it.

## Files changed

- `src/engine/toolpaths/rotaryModel.test.ts` — findings 1, 3, 4, 5, 6, the cone
  reference and the five ball fingerprints.
- `src/engine/toolpaths/rotaryContinuous.test.ts` — finding 2, the one-piece
  band, the strict/step allowances, `entryLink` removed.
- `src/engine/toolpaths/issue-1177-ballFinish.test.ts` — the shifted-phase A/C/D
  run, the phase-aware corner buckets, and the illegal `sampleSpacing` field
  removed (tsc).
- `src/engine/toolpaths/rotarySampling.ts` — `RotarySampleOptions.exactTipRows`,
  plumbed into `samplingSetup` (the sampler had been silently ignoring it).
- `src/engine/toolpaths/rotaryAngleProtocol.ts`, `rotaryAngleKernel.ts` — finding
  10: the flag crosses the worker boundary; protocol version 3.
- `src/engine/toolpaths/rotaryAnglePool.test.ts` — the exact-tip boundary check.
- `scripts/issue-1177-bal-probe.ts` — finding 5 (unused `ToolpathMove`,
  `anchor`) and the stray debug print.
- `scripts/issue-1177-bal-export.ts`, `scripts/issue-1177-bal-shots.ts`,
  `scripts/issue-1177-bal-a-fix1-report.md`, `scripts/INDEX.md` — findings 7, 8,
  9.

## Proof on Frank's file

### A: tip excess over the exact ball-over-hexagon envelope, 12 corners, mm

Before (max / min), every corner the same within a column:

| X band | max | min |
| --- | --- | --- |
| 19.00–19.60 | 0.207–0.225 | 0.015–0.076 |
| 24.00–24.60 | 0.205–0.225 | 0.015–0.076 |
| 27.00–27.60 | 0.206–0.226 | 0.015–0.076 |
| 28.80–28.90 | **0.585–0.592** | 0.000–0.031 |
| 31.20–31.80 | **0.585–0.592** | 0.000–0.031 |

After: **0.000 mm max and -0.000 mm min at all 12 corners in all five bands**
(per-corner max/min printed by the probe, 12 values each).

### B: ball envelope above the facet plane, mm

- before: worst **+0.508** at X29.9 s-9.0 A-25.3 (phase 0), **+0.514** at X29.9
  s9.0 A25.8 (phase 0.4465); C gouge -0.000 / 0.000.
- after: worst **+0.020** at X20.3 s8.0 A22.9 (phase 0), **+0.021** at X20.3
  s8.0 A23.3 (phase 0.4465); C gouge **-0.007** / 0.000.
- after rows (phase 0): X20.30 +0.002..+0.020, X24.50 -0.007..+0.005, X27.50
  -0.004..+0.011, X28.85 -0.007..+0.003, X29.90 -0.004..+0.006, X31.20
  -0.006..+0.003.

### D: worst pure radial step inside a cutting pass, mm

- before: **0.0542** at A1475.732 X20.564 (21.2730 → 21.2187), 2 steps over
  0.01 mm.
- after: **0.0000**; the one remaining >0.01 entry is the operation's first
  plunge (A0.00 X19.050, -9.5250), not a mid-pass step.

### 4b: sequence material above the facet plane, mm (A near the facet normals)

- before, X 28 / 28.5 / 29 (A10): 0.067 / 0.062 / 0.025; (A20) 0.125 / 0.129 /
  0.121; (A28) 0.195 / 0.200 / 0.219.
- after, the same cells: (A10) 0.010 / 0.012 / 0.013; (A20) 0.009 / 0.012 /
  0.013; (A28) 0.010 / 0.014 / 0.015. Worst over X 28–31.7: **0.018 mm**.
- X 15–19 (uncut bar side) is unchanged: the bar stands 6.35 mm proud at
  15.0–15.8 and tapers to 0.00 at 19.0.

### 4c: material in the wall-foot band at both Hex ends, mm

| end | A0 | A10 | A20 | A28 |
| --- | --- | --- | --- | --- |
| before, chuck 19.05 | 0.019 | 0.077 | 0.136 | **0.208** |
| after, chuck 19.05 | 0.019 | 0.020 | 0.020 | 0.022 |
| before, shoulder 31.75 | 0.000 | 0.074 | 0.164 | **0.261** |
| after, shoulder 31.75 | 0.000 | 0.016 | 0.016 | 0.018 |

Both ends after: worst **0.022** (chuck) and **0.018** (shoulder); the two ends
match within **0.004 mm** (bound 0.02).

### Exported program shape (from the posted G-code)

`grbl-rotary-a`, G93 so block time = 60/F seconds.

| op | fed blocks | A moves | A flips | blocks < 10 ms | A-rate jumps > 1.5x | G0 Z lifts |
| --- | --- | --- | --- | --- | --- | --- |
| op0196 before | 11568 | 11510 | 0 | 42 | 0 | 2 |
| op0196 after | 11862 | 11844 | 0 | **0** | 0 | 2 |
| op0198 before | 5019 | 5007 | 0 | 7 | 0 | 2 |
| op0198 after | 5023 | 5008 | 0 | 7 | 0 | 2 |

No measure is worse; op0196's sub-10 ms blocks drop from 42 to 0. A flips stay
0 (the forward-only A rule), and no G0 Z lift is added.

## Screenshots (`work/`, gitignored)

- `work/bal-a-fix1-hex-bar-end.png` — chuck-side end of the Hex, flat and bar.
- `work/bal-a-fix1-hex-shoulder.png` — shoulder end, flat wall against the
  turned Ø25.4.
- `work/bal-a-fix1-hex-corner-edge.png` — one facet corner edge, close.
- `work/bal-a-fix1-hex-overview.png` — the whole Hex with both ends, for context.
- `work/bal-a-fix1-shots.json` — viewport attributes, paths, console errors.

Exported programs: `work/bolt-test-02-x-mm-1177-op0196-{before,after}.nc` and
`...-op0198-{before,after}.nc`. Probe dumps: `work/probe-before.txt`,
`work/probe-after.txt`.

## Ran, versus only read

Ran: `npx tsx` on `issue-1177-ballFinish.test.ts`, `rotaryContinuous.test.ts`,
`rotaryModel.test.ts`, `rotaryNeighbours.test.ts` (all green); `npx eslint` on
every changed source and script (clean); `npx tsc --noEmit` and
`npm run build:gates` (green); the probe before and after on Frank's file; the
export script before and after; the screenshot runner (final PNGs above); the
around/rotary e2e lane
(`PURECUT_E2E_ISOLATED=1 PURECUT_E2E_PORT=<free> … --workers=2`, five specs,
**72 passed**, 2.5 min) — with the worker-payload fix, after it failed 71/1
without it. The full `rotaryAnglePool.test.ts` is killed by this environment's
process limits when it starts its worker-thread blocks, so the new boundary
check was also run as a standalone equivalent (`work/exact-cross.ts`, gitignored):
0 mismatches with the flag, 96 row values wrong without it, exact-vs-conservative
0.0803 mm.

Read, not run: the two independent analyses named in the handoff
(`1177-codex-analysis.md`, `1177-claude-analysis.md`) and the handoff itself;
the base-commit sources through `git show`.

## Known limits / not done

- **Seam coverage in `rotaryContinuous.test.ts`.** With one helix piece the
  fixture's 0.3 mm seam feature, which sits between two rings and at an angle
  the helix only crosses 0.8 mm earlier, is not cut by a pose whose ball reaches
  it. The old split's constant-A link covered it; the exact read removes that
  split on this fixture. The block now records the loss instead of asserting a
  split it cannot produce; the split-with-links path is still covered by the
  ca-g block above (a flat tool). This is a real coverage limit of the helix on
  features narrower than its pass spacing, not a test weakening.
- **`rotaryModel.test.ts` fingerprint recaptures.** Five ball-program
  fingerprints (finish fixture count/hash; rough and finish zero/positive leave
  hashes) were recaptured because the exact read changes a ball's point set.
  The seeded exact-solid property test (30 cases, both shapes) is the
  independent check that the new points are on the model; its worst is 0.1454 mm
  against a 0.2514 mm tolerance.
- **`rotaryContinuous.test.ts` allowances.** The reference really is the exact
  read now: `RotarySampleOptions` gained `exactTipRows`, which the sampler had
  been silently ignoring (the earlier round passed it through an untyped spread).
  With that fixed the seam fixture needs 0.01 everywhere and 0.02 in the 3 mm
  step's band, where the measured chord undercut is 0.0111 mm at along 14.1989.
  The previous 0.45 was measured against the conservative reference and is gone.
- The sign of the shifted-phase fixture (`-rotationDeg`) and the 0.4465 step are
  now in the test, not only in a comment.
