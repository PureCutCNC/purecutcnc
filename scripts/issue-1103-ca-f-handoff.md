# #1103 slice ca-f: keep #1117's at-layer links between forward-only rough rings

Correction found in Frank's retest of PR #1152 (busto-round rough). Around-the-bar **rough** on a round bar, `generateRotaryRough`'s around branch.

**Symptom (measured on 09c3ff17 with `work/helix-probe.ts`, which prints every rapid-separated group of cuts):** each layer cuts one helix over its full-ring band, and then every remaining (non-helix) ring of the layer is its own group: a rapid between every pair of neighbouring rings. Example, the layer at minZ 1.48: groups 59–81 are single rings at along 1.4, 1.4, 1.5, … 2.3, each preceded by a rapid. The ca-a base (6498aaf5, #1117) linked those rings at the layer: busto-round rough had 221 at-layer link boundaries and 261 rapids; this branch has 64 and 291 (`work/rl-e-probe.ts`). busto-rect (square) kept its links (589 → 592), so the loss is on the round/non-square path. Slice ca-d's handoff required no lost at-layer links; it was missed.

**Do:**
- Find why `unitLink`/`linkAtLayer` (or `emitRotaryRuns`' link step) now refuses ring-to-ring links for forward-only round rings — after a helix and between ordinary rings — that #1117 linked. Likely suspects: the forward A cursor (`unitBase`, `angleBase`, `lastCommandedA`) giving a commanded-A pair the at-layer rule no longer accepts as equal; the helix→ring boundary; `previousRingSplit`/`previousRingEmitted` bookkeeping. Measure, don't guess: log why each refused boundary is refused on busto-round op0025.
- Restore the link wherever #1117's conditions hold for the physical geometry (same physical angle, adjoining rings, swept cutter only meets cleared material or material this layer may remove). Do not relax any #1117 safety condition; do not change the helix itself, the finish, square stock or along mode.
- Target: busto-round rough at-layer link boundaries back to at least the base's 221 (or explain each one that cannot be kept with a measured reason), rapids at or below the base's 261; A reversals stay 0. busto-rect rough, all finishes, along controls: moves unchanged (hash) unless a change is explained.
- Update `scripts/issue-1103-baseline.md`'s candidate rows for what changed.

## Tests that must bite
- A round-bar rough case with a helix band followed by several non-full rings in the same layer: the rings after the helix link at the layer (no rapid between neighbours), and a ring after the helix links into it where #1117 would.
- Mutations, each caught: force the raised link for every forward-only ring boundary; break the forward-A equality the link check needs (e.g. add an extra 360 between rings).

## Rules (every slice)

- Approved plan: the plan comment on issue #1103 and Frank's approval comment (helix for uninterrupted full rings; forward-only arcs with safe gaps on square blanks and partial rings; keep constant-A links only where their exact conditions still hold; along-the-bar mode unchanged). Read both whole. Its line numbers refer to an older commit; `rotaryModel.ts` has changed since (#1115 split sampling into modules, #1117 added at-layer rough links), so find `generateRotaryFinish`, `generateRotaryRough`, `emitRotaryRuns`, `linkRowAt`, `linkAtLayer` and `linkAcrossAngle` by name.
- Baselines are the post-#1117 output of this branch's base (integration/0.6.0 at 6498aaf5), not older numbers.
- Along-the-bar rough (#1098), engrave, and any path this slice does not touch stay **byte-identical** (moves and posted G-code, normalising only the date).
- Commanded A is never wrapped modulo 360 inside an operation; no closing unwind (#1091; A range is the controller's job).
- No new setting, UI, locale or format change; format stays 3.3.
- Fixtures: `../feat-issue-1103-continuous-a/work/` holds busto-round-stock.camj, busto-rect-stock.camj, square-to-round-test-01.camj the probes `rl-e-probe.ts` and `helix-probe.ts` (`npx tsx work/helix-probe.ts <fixture> <op>`) (usage: `npx tsx work/rl-e-probe.ts <fixture> <op> [warmRuns] [around|along]`; ops: busto-round op0025, busto-rect op0021, square-to-round op0028). Copy them into this worktree's ignored `work/`; never commit them.
- **One heavy process at a time** (no benchmark or probe beside a test pool). Measured numbers only, saying which you measured.
- Report: changes per file; tests added; each mutation and whether it was caught; commands with exit codes; RISKS.
