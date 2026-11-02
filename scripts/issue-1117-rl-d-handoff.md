# #1117 slice rl-d: compatibility, measurements, docs

Plan item 4.
- Byte-for-byte: serialized moves and posted G-code unchanged for finish, along rough and rejected-link fixtures (compare against the base branch `feat/issue-1117-rough-ring-links`).
- Measure the three fixtures exactly as `scripts/issue-1117-baseline.md` did (same operations, one warm-up plus three runs, serially) and add the candidate columns to that table: plunges, rapids, descending feed entries, air time, and generation time against the baseline variation.
- Update `src/engine/toolpaths/INDEX.md`. Update a rotary e2e assertion only if it asserted the old raised links.
- Run focused rotary tests, `npm run build`, `npm run check:gcode`, and `PURECUT_E2E_PORT=1452 PURECUT_E2E_ISOLATED=1 npx playwright test e2e/rotaryModel.smoke.spec.ts --workers=2`. Report each exit code.

## Rules (every slice)

- Approved plan: the plan comment on issue #1117 and Frank's approval comment (decisions 1–4 as recommended). Read both whole. Its line numbers refer to an older commit; `rotaryModel.ts` has changed since (#1115 split sampling into new modules), so find `linkRowAt`, `followLink`, the rough `linkPlan` and the rough ring loop by name.
- Keep ring alternation (#1098) and along-the-bar rough unchanged. No continuous-A / spiral work (#1103 comes after this). No new setting, UI, locale or format change; format stays 3.3.
- Finish, along rough and every link that does not qualify must stay **byte-identical** (moves and posted G-code).
- Fixtures: `../feat-issue-1117-rough-ring-links/work/` holds busto-round-stock.camj, busto-rect-stock.camj and square-to-round-test-01.camj. Copy them into this worktree's ignored `work/`; never commit them.
- **One heavy process at a time** (no benchmark or probe beside a test pool). Measured numbers only, saying which you measured.
- Report: changes per file; tests added; each mutation and whether it was caught; commands with exit codes; RISKS.
