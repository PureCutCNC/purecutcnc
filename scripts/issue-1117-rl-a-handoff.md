# #1117 slice rl-a: round-bar rough links stay down

Plan item 1. Around-the-bar **rough** on a round bar: between neighbouring rings in one layer, try a cutting feed link at the current layer (through the existing dense `linkRowAt` row at `max(currentLayerRadius, protectedModelTip)`, keeping stock allowance, steep-step handling and retained-stub floors) before falling back to today's raised link. Qualifies only with exactly equal commanded A, forward along the bar, eligible adjoining runs (A0→A360 is a turn, not equal), and a swept cutter that meets only already-cleared material or material this layer is allowed to remove. Reject split/model-gap transitions, skipped rings, region crossings, unavailable rows and exhausted budgets: they keep the raised link. Do not build the candidate by removing clearance from the raised link.

**First, before changing code:** measure the baseline on the unchanged branch. For each around-the-bar rough operation in the three fixtures: plunges, rapids, descending feed entries, and air time from the simulation (air feeds count as well as rapids). One warm-up plus three runs, serially. Commit the table as `scripts/issue-1117-baseline.md` (later slices compare against it).

## Tests that must bite (`rotaryAroundPasses.test.ts`)
- Links between rings of one layer are current-layer cutting feeds; the between-ring ridge is protected; ring cuts and layer-boundary retracts unchanged.
- Mutations, each caught: restore the raised-only path; remove the layer clamp; dense sampling misses the between-ring ridge.

## Rules (every slice)

- Approved plan: the plan comment on issue #1117 and Frank's approval comment (decisions 1–4 as recommended). Read both whole. Its line numbers refer to an older commit; `rotaryModel.ts` has changed since (#1115 split sampling into new modules), so find `linkRowAt`, `followLink`, the rough `linkPlan` and the rough ring loop by name.
- Keep ring alternation (#1098) and along-the-bar rough unchanged. No continuous-A / spiral work (#1103 comes after this). No new setting, UI, locale or format change; format stays 3.3.
- Finish, along rough and every link that does not qualify must stay **byte-identical** (moves and posted G-code).
- Fixtures: `../feat-issue-1117-rough-ring-links/work/` holds busto-round-stock.camj, busto-rect-stock.camj and square-to-round-test-01.camj. Copy them into this worktree's ignored `work/`; never commit them.
- **One heavy process at a time** (no benchmark or probe beside a test pool). Measured numbers only, saying which you measured.
- Report: changes per file; tests added; each mutation and whether it was caught; commands with exit codes; RISKS.
