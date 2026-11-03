# #1117 slice rl-e: at-layer links on every layer, not only the first

Frank tested PR #1151 on `busto-round-stock.camj` (around rough `op0025`, 1/4" ball, stepdown 0.075", stepover 0.16"): links stay down on the first layer only; every later layer retracts between rings. The rings there are **not** split. Two causes, measured with an instrumented copy of this branch (counts per layer of why `linkAtLayer` returned null):

## 1. The at-layer leftover overstates what earlier layers left (main cause, layers 2–6)

Nearly every candidate on layers 2–6 fails `leftover[i] - height > allowance` (layer 2: 36 of 36). On layer 2 (radius 0.850") the leftover reads **1.000"**, the uncut bar, although layer 1 cut the whole ring to 0.925"; the excess is ~2 stepdowns against an allowance of 0.0966".

`linkLeftoverAt` (non-region path, and the region path the same way) builds each earlier layer's remaining surface at `x` as the **maximum** of `cutTip + rise(dx)` over every ring position within the tool radius. With a ball, the ring ~one radius away contributes `cutTip + radius` (0.925 + 0.125 = 1.05"), so the layer never lowers the leftover below the bar radius. That is a safe upper bound for sizing the **raised** link (#1093) but wrong for the at-layer test: the material a layer leaves at `x` is the **lowest** envelope over the ring positions that cut there (min over `p` of `cutTip + rise`), and across the body's angle window the body must clear the **highest** of those per-angle envelopes (max over window rows).

**Fix:** the `'atLayer'` bucket gets the correct envelope (min over ring positions per angle row, max over window rows, bounded by the blank/support and by the previous layer as today). The `'raised'` bucket keeps today's computation exactly, so every raised link stays byte-identical. Keep the two buckets' cache keys separate (they already are).

## 2. Partial rings whose ends do not share an angle (layers 4–7)

On layers 4–7, rejections at the first check (`from.a !== to.a`, 4/9/18/8 per layer) come from single-run partial rings: the ring cuts only the arc where material stands above the model, so its end angle differs from where the next ring starts. Today these always retract.

**Fix:** allow an at-layer link that changes A between the end of one ring's run and the start of the next ring's run **when the whole swept path is proven clear** with the same rules as the equal-A link: only already-cleared material or material this layer may remove, the cutter body's whole window checked (rl-c's footprint rule), never through protected model, never across a model gap or a region crossing. Where the A change crosses a sector where the model stands above the layer, keep the raised link. Equal-A links keep today's path. Split rings (more than one run) stay raised; that rule is unchanged.

## Tests that must bite

- `busto-round`-like synthetic case (revolved model, ball tool, several layers): at-layer links exist on layers after the first. Mutation: restore the max envelope for `'atLayer'` → test fails.
- Raised links byte-identical to the base branch on the `window-budget` fixture and on the existing rotary suites (the rl-b regressions must still pass).
- A-changing partial-ring link: accepted when the A sweep crosses only cleared material; refused (raised link) when the sweep crosses a sector where the model stands above the layer. Mutation: skip the sweep check → the refusal test fails.
- The rl-c property proof (`squareAroundGenerator.property.test.ts`) passes unchanged in its rules; extend it to A-changing links (swept footprint across the A change).

## Measure

Re-measure the three fixtures with the rl-a/rl-d method (warm-up plus 3 runs, serially) and add the rl-e columns to the PR's table in your report: raised links replaced, rapids, air feed-minutes, generation ms. Also report at-layer links **per layer** on busto-round.

## Rules

- Approved plan: the plan comment on issue #1117 and Frank's approval comment. This slice extends it on Frank's instruction (2026-11-02: "handle both issues").
- Branch base: `feat/issue-1117-rough-ring-links` (PR #1151). Keep ring alternation, along rough, finishes unchanged and byte-identical. No setting, UI, locale or format change; format stays 3.3. No continuous-A / spiral work (#1103).
- Fixtures: `../feat-issue-1117-rough-ring-links/work/` (busto-round-stock.camj, busto-rect-stock.camj, square-to-round-test-01.camj). Copy into this worktree's ignored `work/`; never commit them.
- **One heavy process at a time.** Measured numbers only, saying which you measured.
- Report: changes per file; tests added; each mutation and whether it was caught; commands with exit codes; RISKS.
