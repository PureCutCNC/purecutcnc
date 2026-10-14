# Issue #1015 slice I — steep steps between samples, and a property test

You are the implementation worker for a fix slice of issue #1015 (machine an
imported 3D model inside a round bar on a rotary axis). Work only in your task
worktree. Do not create, remove, merge, push or switch branches or worktrees.
Do not open a PR. Do not run `git add` or `git commit`: leave your edits
uncommitted and report `COMMIT: none`. `gh` may be blocked; everything you
need is in this file.

Read first: `AGENTS.md`, `scripts/issue-1015-{a,b,c,f,g}-handoff.md` (they
still apply), then in full `src/engine/toolpaths/rotaryModel.ts` and its test.
Absolute paths for every write, no `cd`. Smallest change that does the job;
match the surrounding code. No `process.` or `globalThis` in engine code.
`node_modules` is a symlink: type-check with `npx tsc -p tsconfig.app.json --noEmit`
and `npx tsc -p tsconfig.node.json --noEmit`, never `npx tsc -b`. You may
change only `rotaryModel.ts`, its test, `rotaryOperation.test.ts`,
`scripts/gcode-conformance/corpus.test.ts` and `src/engine/toolpaths/INDEX.md`.

A third review pass found that the moves **between** two samples can still cut
what the samples themselves avoid.

## 1. Steep steps between samples (P1)

Every sample's tip is safe for the cutter at that sample, but a cut move
interpolates linearly from one sample to the next. Where the safe height jumps
between two neighbouring samples (the retained bar beyond the model's end
since slice G, or any steep wall of the model), the interpolated move cuts
through the corner. Reproduced: off-axis prism along 10–30 in a 40 mm bar,
zero supports, a real 2 mm flat end mill: a rough move's midpoint is at along
29.125 with the tip 2.0 mm below the retained bar's surface while the cutter
reaches along 30.05, inside the retained bar. The finish fails the same way,
on both bar axes. (Slice G's test checks endpoints only, with a 4 mm mill.)

Rule, in the move emission shared by both generators: between two consecutive
samples of a run whose tips differ by more than the sample spacing (steeper
than 45°), do not emit one diagonal move. **Rising:** go straight up at the
first sample to the higher tip, then move along at that height. **Falling:**
move along at the first sample's height, then go straight down at the second
sample. Gentle changes keep the single diagonal move. Explain in a comment why
the horizontal leg is safe: at the higher of the two heights the cutter over
the span stays inside the union of the two samples' footprints, each of which
is safe at that height or below (exact for a flat end mill; for a ball nose
the remaining error is the ordinary sampling error, about `s²/(8r)`).

## 2. Travel height loses its clearance (P2)

`travelZ = min(safeZ, 2R + clearance)`: on a 40 mm bar with a rapid height of
40.2, every internal turn runs at 40.2, a fifth of a millimetre above the
bar instead of a millimetre. Rule: travel is always at `2R + clearance`, and
the operation's first positioning move and final retract use
`max(safeZ, 2R + clearance)`. Test it with that case.

## 3. A seeded property test against the mesh itself

A hand-picked case has missed something in every review pass so far. Add a
property test with a fixed seed (a small deterministic PRNG in the test, no
dependency): about 30 random cases, each a bar (axis X or Y, diameter 20–60),
a model made of one to three closed boxes and/or coaxial and off-axis
cylinders placed inside the bar (some touching the bar's ends, some not),
random end supports (0 included), and a ball nose or flat end mill (diameter
1–6). Generate the rough and the finish with coarse settings, so the test runs
in well under a minute. For **every cut, plunge and link move**, walk the
move in steps of at most a tenth of the tool radius and at each step place the
cutter (a flat disc of the tool radius at the tip for a flat end mill, the
ball's lower hemisphere for a ball nose) and check it against the **exact
geometry**, computed directly from the boxes and cylinders, not from the
height map. The checks:

- it does not penetrate the model by more than the stock to leave minus a
  tolerance (state it, from the height-map cell size and the sampling error);
- it does not enter the retained bar beyond the model's ends, or the end
  supports, below the bar's surface minus that tolerance;
- it never goes below the centreline;
- every rapid is at or above `2R + clearance`, the first and last at the
  rapid height.

On failure, print the seed index, the move and the worst penetration. If a
case fails for a reason this handoff does not cover, fix it if the fix is
small and obvious and say what you did, otherwise report it and leave that
case in the test marked skipped with the reason. The manager wants to see it.

## Mutations

One at a time, restored from a `cp` backup (never `git checkout`); name the
failing test or report a survivor: the steep-step rule removed (diagonal
moves again); the threshold set to ten times the spacing; the travel height
capped by `safeZ` again; the retained-bar stubs left out of the mesh.

## Checks to run and report

The two `tsc --noEmit` commands; `npx eslint` on changed files; `npx tsx` on
`rotaryModel.test.ts`, `rotaryOperation.test.ts`,
`src/components/cam/rotaryOperations.test.ts`,
`scripts/gcode-conformance/corpus.test.ts`; `npx tsx scripts/check-license-headers.ts`;
`npm run docs:check`. Then the whole unit suite once at the end with nothing
else running (`npx tsx scripts/run-tests.ts`); report its result and how long
the property test takes. Do not run `npm run build` or any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS` (with the full
suite's result), one line per numbered item, the property test's numbers
(cases, moves checked, worst penetration per check), the new fixture pins, the
mutation table, and `RISKS`.
