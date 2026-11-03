# #1117 baseline: around-the-bar rough, unchanged code

Recorded before any #1117 change, on branch `feat/issue-1117-1117-rl-a-dsh` at
base commit `8bea21e8` (slice handoffs) + the fixtures copied from
`../feat-issue-1117-rough-ring-links/work/`. Later slices compare against this
table.

## Fixtures (hashes frozen; files stay untracked in `work/`)

| fixture | sha256 | units | blank | around rough op | tool | stepdown | stepover | feed / plunge | radial leave |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `busto-round-stock.camj` | `c7e6cd39bf31335be1da2c45ba7652f21e18fb18eb3cef775004db92499f5525` | inch | Ø2.0 in round bar, axis X | `op0025` | 1/4 in ball | 0.075 in | 0.16 in | 26 / 10 in/min | 0.02 in |
| `busto-rect-stock.camj` | `54f06ae05f36f249d2f51813ab4589387905d4d927c718727d5cf4a29ec3fc23` | inch | 2.0 in square blank, axis X | `op0021` | 1/4 in ball | 0.075 in | 0.16 in | 26 / 10 in/min | 0.02 in |
| `square-to-round-test-01.camj` | `419a0115d6c77e2667d8aebd86b4aa2c09d62f3ea7480f42962e854e01ac5341` | inch | 2.0 in square blank, axis X | `op0028` (**forced** around, see note) | 1/4 in flat | 0.125 in | 0.32 in | 30 / 12 in/min | 0 |

Note: `square-to-round-test-01.camj` stores no `rotaryPassDirection` on its
operations, and the generator's missing default is **along**, so as saved it has
no around-the-bar rough. Its row below was measured with
`rotaryPassDirection: 'around'` set on a fresh copy — the same motion the
settings panel would generate — so the square blank has an around baseline for
the later slices. The other two fixtures already carry `'around'`.

## Method

- Generation: `computeOperationToolpath(project, operation)` from
  `src/engine/toolpaths/generateOperation.ts` on
  `normalizeProject(JSON.parse(file))` (`src/store/projectStore.ts`).
- Measurement: the operation's path is turned to the unrolled sheet by
  `buildSimulationSetupInput(project, setup, {op: path})`
  (`src/app/simulationSetup.ts`), then replayed move by move with
  `applyMoveToGrid` on a fresh `createSimulationGrid` and the app's own
  `simulationBuildOptions` at **180 cells on the long axis**
  (`src/app/simulationCompute.ts`).
- `plunges` / `rapids`: counts of `kind: 'plunge'` / `'rapid'` moves.
- `descending feeds`: `cut`/`plunge` moves with `to.z < from.z`; the column in
  brackets is the subset that is vertical (same X/Y/A), i.e. the feed drop that
  replaces a plunge at a ring boundary.
- `air`: a move is air when it removes **no** material. Rapids are air by
  construction; a feed move is air when the heightfield replay lowers no cell
  (`applyMoveToGrid(...).changedCount === 0`). Air feeds are counted as air,
  not only rapids.
- `air minutes` converts every air move's sheet-space length at the
  operation's own cut feed (`feed` above). The project format carries no rapid
  rate, so rapids are priced at the same rate: these are like-for-like
  feed-minutes of air travel, not machine time. `cut minutes` is the same
  conversion for removing moves.
- Timing: generation wall time. One warm-up plus three measured runs, serially,
  one process at a time. Generation is deterministic (move counts and every
  count below are identical across runs); only the wall time varies.

## Baseline

| fixture / op | moves | plunges | rapids | descending feeds (vertical) | air feeds | air rapids | air moves | air distance (in) | air minutes | cut minutes | generation ms (runs 1–3) | candidate plunges | candidate rapids | candidate descending feeds (vertical) | candidate air minutes | candidate generation ms (runs 1–3) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| busto-round `op0025` | 24997 | 121 | 525 | 9872 (2543) | 5119 | 525 | 5644 | 745.05 | 28.66 | 82.23 | 32823 / 28428 / 27850 | 121 | 479 | 9828 (2497) | 28.38 | 28184 / 28044 / 27914 |
| busto-rect `op0021` | 34339 | 118 | 749 | 13354 (3738) | 8494 | 749 | 9243 | 1804.80 | 69.42 | 110.36 | 35833 / 35737 / 35953 | 118 | 593 | 13198 (3582) | 68.23 | 36271 / 36221 / 36435 |
| square-to-round `op0028` (forced around) | 9312 | 16 | 224 | 3888 (768) | 2245 | 224 | 2469 | 751.95 | 25.07 | 26.03 | 47 / 47 / 46 | 16 | 36 | 3700 (580) | 23.67 | 46 / 45 / 49 |

Warm-up runs (not in the table) produced identical counts; generation was
29039 ms (busto-round), 35905 ms (busto-rect), 57 ms (square-to-round).

## Candidate (#1117)

The candidate columns are the same three around rough operations measured with
the same harness on `feat/issue-1117-1117-rl-d-dsh` (all four #1117 slices), on
the same machine and in the same session. The base branch
(`feat/issue-1117-rough-ring-links`) was re-measured first with that harness and
reproduced the recorded baseline exactly -- the same moves, plunges, rapids,
descending feeds and air counts above -- with generation at
28137–30684 ms (busto-round), 35734–37138 ms (busto-rect) and 47–49 ms
(square-to-round). That re-measured spread is the variation the candidate
generation time is judged against.

The candidate replaces **46 / 156 / 188** raised ring-to-ring links (round,
rect, square) with at-layer cutting feeds; those are the only link runs that
differ, and every other link run, every ring cut, and every other operation on
these fixtures (both finishes, the along rough) is byte-identical in moves and
in the posted program. Full candidate counts not carried in the table: air
feeds 5074 / 8338 / 2057, air rapids 479 / 593 / 36, air moves
5553 / 8931 / 2093, air distance 737.87 / 1773.99 / 709.96 in, cut minutes
82.10 / 110.28 / 26.02, moves 24911 / 34027 / 8936, warm-up generation
28835 ms (busto-round), 36400 ms (busto-rect), 59 ms (square-to-round).
