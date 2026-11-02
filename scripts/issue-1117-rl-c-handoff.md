# #1117 slice rl-c: independent motion proof

Plan item 3. In `squareAroundGenerator.property.test.ts` (the rough-link assertions), extend the existing seeded polar-material reference across round/square, ball/flat, both axes, both units and masked cases. Sweep link interiors and full cutter bodies; assert layer-bounded removal, protected model and ends, and non-cutting rapids. Replace only the obsolete "rough feed links remove nothing" assertion. Require non-zero coverage of qualifying links.

Mutations, each caught: allow one extra layer of depth; a low corner turn; cutting across a gap.

## Rules (every slice)

- Approved plan: the plan comment on issue #1117 and Frank's approval comment (decisions 1–4 as recommended). Read both whole. Its line numbers refer to an older commit; `rotaryModel.ts` has changed since (#1115 split sampling into new modules), so find `linkRowAt`, `followLink`, the rough `linkPlan` and the rough ring loop by name.
- Keep ring alternation (#1098) and along-the-bar rough unchanged. No continuous-A / spiral work (#1103 comes after this). No new setting, UI, locale or format change; format stays 3.3.
- Finish, along rough and every link that does not qualify must stay **byte-identical** (moves and posted G-code).
- Fixtures: `../feat-issue-1117-rough-ring-links/work/` holds busto-round-stock.camj, busto-rect-stock.camj and square-to-round-test-01.camj. Copy them into this worktree's ignored `work/`; never commit them.
- **One heavy process at a time** (no benchmark or probe beside a test pool). Measured numbers only, saying which you measured.
- Report: changes per file; tests added; each mutation and whether it was caught; commands with exit codes; RISKS.
