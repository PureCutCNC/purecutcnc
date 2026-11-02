# #1117 slice rl-b: square blanks and regions

Plan item 2 and decisions 2–3. rl-a added the at-layer link for round bars. Extend eligibility to square blanks and regions:
- Square: only proven **same-angle** links between neighbouring rings' corner arcs (they share a boundary angle and the whole cutter path stays within the current-layer material bound). Every A-changing corner transition keeps rising above the corner envelope. First-layer links assume no prior clearance.
- Regions (#1096): a cutting link must stay inside the complete region segment, narrow exclusions included. Across a region gap keep raised travel; outside the region the stock is the uncut blank.

## Tests that must bite (`rotarySquareAroundPasses.test.ts`, `rotaryRegion.test.ts`)
- Shared-angle corner links, A-changing corner transitions, first layers, retained ends, split rings, seam masks, thin excluded strips.
- Mutations, each caught: bypass the exact-angle or segment check; treat outside-region stock as removed; drop the body-window protection.

## Rules (every slice)

- Approved plan: the plan comment on issue #1117 and Frank's approval comment (decisions 1–4 as recommended). Read both whole. Its line numbers refer to an older commit; `rotaryModel.ts` has changed since (#1115 split sampling into new modules), so find `linkRowAt`, `followLink`, the rough `linkPlan` and the rough ring loop by name.
- Keep ring alternation (#1098) and along-the-bar rough unchanged. No continuous-A / spiral work (#1103 comes after this). No new setting, UI, locale or format change; format stays 3.3.
- Finish, along rough and every link that does not qualify must stay **byte-identical** (moves and posted G-code).
- Fixtures: `../feat-issue-1117-rough-ring-links/work/` holds busto-round-stock.camj, busto-rect-stock.camj and square-to-round-test-01.camj. Copy them into this worktree's ignored `work/`; never commit them.
- **One heavy process at a time** (no benchmark or probe beside a test pool). Measured numbers only, saying which you measured.
- Report: changes per file; tests added; each mutation and whether it was caught; commands with exit codes; RISKS.
