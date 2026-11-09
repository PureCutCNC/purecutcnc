# Issue #1177 handoff, slice sim-a: reproduce Frank's ledge from the app's simulation (diagnosis only)

Base `fix/issue-1177-hex-shoulder-ledge` (PR #1180 code at `18d908f6` plus this handoff). Issue #1177, PR #1180.
**This slice changes no production code.** It delivers a reproduction and a measured
cause. A later slice fixes it, after the manager has checked your reproduction against
Frank's screenshots.

## Why this slice exists
PR #1180 was declared fixed because a cutter height-map probe reported 0.033 mm. Frank
opened the app's **Simulation** tab and the ledge is unchanged. A later round then claimed
the edge strip sits *lower* than the flat. That's wrong: Frank's screenshots show the strip
**higher** than the Hex flat. Neither probe measured what the Simulation tab shows. Don't
reuse their conclusions. `scripts/issue-1177-ledge-probe.ts` and
`scripts/issue-1177-window-probe.ts` are suspect.

## Frank's file and screenshots
- File: `work/bolt-test-02-x-mm.camj` (**the mm file**; earlier slices used the inch file
  `bolt-test-02-x.camj`, which is not what Frank tested). It is gitignored. Copy it from
  `/home/frankp/Projects/worktrees/purecutcnc/fix-issue-1177-hex-shoulder-ledge/work/`
  into your worktree's `work/`. Never commit it, and never put it in `test-fixtures/`.
- Operations: op0195 Rotary rough and op0196 Rotary finish on the Hex (f0184); op0197
  Rotary rough 2 and op0198 Rotary finish 2 on the Turn (f0186).
- Frank's Simulation screenshots at 18d908f6 ("Selected" mode). Open and look at both:
  `/home/frankp/Projects/worktrees/purecutcnc/fix-issue-1177-hex-shoulder-ledge/work/frank-sim-rough-18d908f6.png`
  (rough) and `.../work/frank-sim-finish-18d908f6.png` (finish). There's also the
  original 3D-view shot `.../work/hex-edge-ledge.png`. In the finish shot a raised band runs
  along the edge where the Hex flat meets the turned shoulder, standing above the rest of
  the flat.

## Task
1. Drive the **real app** headless (Playwright, as the e2e specs do; see
   `e2e/setupSimulationProbe.ts` and `e2e/around3d.smoke.spec.ts`): load Frank's mm file,
   open the Simulation tab, and simulate the way Frank did (Selected mode with op0197
   selected, and with op0198 selected), and also with all four rotary operations. Use
   `PURECUT_E2E_ISOLATED=1` and a free `PURECUT_E2E_PORT`, `--workers=1`. Don't touch
   port 1420.
2. Save screenshots from a camera close to Frank's (looking at the Hex flat where it meets
   the turned shoulder). Put them in your worktree's `work/` and list the absolute paths
   in the report. They must visibly show the raised band.
3. Read back the **simulation's own material state** (the heightfield or whatever the
   Simulation tab draws from) across the band: on the Hex flat facing the camera, from
   the shoulder edge inward to the middle of the flat, at several angles across the flat.
   Report the band's X range, its A range, and how high it stands above the flat away from
   the edge, in mm.
4. Find which operation leaves the band and why, by tracing the moves that reach that
   region. Also say whether the band exists in the generated toolpath's cut (cutter body
   swept along the moves) or only in the simulation (a display or resolution effect). Both
   are possible, and the fix differs.
5. Commit only the reproduction script(s) (under `scripts/`, named
   `issue-1177-sim-*.ts`) and a short report `scripts/issue-1177-sim-a-report.md` with
   the numbers, the cause, and a proposed fix with its test idea. No production code.

## Report
Screenshot paths, measured band size and position, the cause with file:line, whether it's
toolpath or display, the proposed fix, and what you ran versus only read.
