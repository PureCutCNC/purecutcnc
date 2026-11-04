# #1103 slice ca-g: a refused helix keeps the parts that fit

Plan change approved by Frank on 2026-11-04 (comment on #1103): a helix band is no longer all-or-nothing.

**Today:** `buildContinuousHelix` refuses a whole band when any segment cannot meet the surface tolerance after all refinement rounds (`uncovered`/`exhausted`/`ineligible`), and the caller cuts the whole band as forward-only rings. On busto-round's finish (op0015) 29 of 1706 segments fail, so the entire finish is rings with constant-A links (A stops at every link). Frank's test: a rough with a single deep layer behaves the same, no helix at all.

**Do (finish and rough, around-the-bar only):**
- When a helix attempt is refused only because some segments fail tolerance (not for cancellation, not for a region, not for "no material standing" in the rough), split the band at the failing spots: the ring positions covering each failing segment, plus enough neighbours that the helix pieces start and end on complete rings (keep the boundary-ring rule from ca-b, so no triangular strip stays uncut between a helix piece and the rings).
- Each remaining sub-band of at least two rings gets its own helix (it may be refused again; recurse a bounded number of times, then rings). The failing spots are cut as forward-only rings.
- Links between a helix piece and the neighbouring rings use the existing rules (#1093 surface-following links on the finish, #1117 at-layer links on the rough); never a new unchecked link.
- Bound the total work: the split attempts share the existing helix work budget (`MAX_HELIX_RASTER_WORK`) and cancellation; when it runs out, the rest of the band is rings. Generation target stays at most 1.2× the ca-a base on every row.
- A never reverses; no modulo-360 wrap; along mode, engrave and square stock unchanged.

**Measure (serially, one warm-up + three runs):** for busto-round finish op0015, busto-round rough op0025, busto-rect finish op0022, the square fixture around rows, and busto-round rough with a single deep layer (set stepdown ≥ the full depth in memory): share of cutting length on helix vs rings, constant-A links, rapids, A reversals, generation ms. Report against ca-f's numbers and update `scripts/issue-1103-baseline.md`.

## Tests that must bite
- A surface with a narrow sharp feature in the middle of a band: the band is cut as helix – rings – helix, the rings cover the feature, the swept reference from ca-a finds no gouge and no uncut strip at either helix/ring seam.
- Mutations, each caught: refuse the whole band again (old behaviour); split without the boundary rings (strip left uncut); skip the work budget on split attempts; link helix to ring without the existing link check.

## Rules (every slice)

- Approved plan: the plan comment on issue #1103 and Frank's approval comment (helix for uninterrupted full rings; forward-only arcs with safe gaps on square blanks and partial rings; keep constant-A links only where their exact conditions still hold; along-the-bar mode unchanged). Read both whole. Its line numbers refer to an older commit; `rotaryModel.ts` has changed since (#1115 split sampling into modules, #1117 added at-layer rough links), so find `generateRotaryFinish`, `generateRotaryRough`, `emitRotaryRuns`, `linkRowAt`, `linkAtLayer` and `linkAcrossAngle` by name.
- Baselines are the post-#1117 output of this branch's base (integration/0.6.0 at 6498aaf5), not older numbers.
- Along-the-bar rough (#1098), engrave, and any path this slice does not touch stay **byte-identical** (moves and posted G-code, normalising only the date).
- Commanded A is never wrapped modulo 360 inside an operation; no closing unwind (#1091; A range is the controller's job).
- No new setting, UI, locale or format change; format stays 3.3.
- Fixtures: `../feat-issue-1103-continuous-a/work/` holds busto-round-stock.camj, busto-rect-stock.camj, square-to-round-test-01.camj the probes `rl-e-probe.ts` and `helix-probe.ts` (`npx tsx work/helix-probe.ts <fixture> <op>`) (usage: `npx tsx work/rl-e-probe.ts <fixture> <op> [warmRuns] [around|along]`; ops: busto-round op0025, busto-rect op0021, square-to-round op0028). Copy them into this worktree's ignored `work/`; never commit them.
- **One heavy process at a time** (no benchmark or probe beside a test pool). Measured numbers only, saying which you measured.
- Report: changes per file; tests added; each mutation and whether it was caught; commands with exit codes; RISKS.
