# Issue #1015 slice E — export cases, a browser spec, and one test gap

You are the implementation worker for slice E of issue #1015 (machine an
imported 3D model inside a round bar on a rotary axis). Work only in your task
worktree. Do not create, remove, merge, push or switch branches or worktrees.
Do not open a PR. Do not run `git add` or `git commit`: leave your edits
uncommitted and report `COMMIT: none`. `gh` may be blocked; everything you
need is in this file.

Read first: `AGENTS.md`, `scripts/gcode-conformance/INDEX.md` and `README.md`,
`scripts/gcode-conformance/corpus.ts` (how #395 added its Around cases:
search `aroundSetup` and the `around-*` cases) and `corpus.test.ts`,
`src/engine/toolpaths/rotaryOperation.ts` and its test,
`src/test/rotaryOperationFixture.ts`, `src/components/cam/rotaryOperations.test.ts`,
`e2e/around3d.smoke.spec.ts` and `e2e/aroundModel.smoke.spec.ts` (how the Around
browser specs seed a round-bar project and read the page), `e2e/selectors.ts`,
`e2e/importGeometry.helpers.ts` (how a spec gets an imported model into a
project), and `scripts/check-e2e-lanes.ts`. Absolute paths for every write, no
`cd`. Smallest change that does the job; match the surrounding code.
`node_modules` is a symlink: type-check with `npx tsc -p tsconfig.app.json --noEmit`
and `npx tsc -p tsconfig.node.json --noEmit`, never `npx tsc -b`.

Slices A–D are in: the sampler, the finish and rough generators, the along
range with end supports, and the `rotary_rough` / `rotary_finish` operations in
the Around setup (CAM panel, validity, dispatch in `computeOperationToolpath`).

## 1. Conformance cases

Add two cases to `scripts/gcode-conformance/corpus.ts` next to #395's Around
cases: a **rotary finish** and a **rotary rough** on a model inside a round bar
(use `src/test/rotaryOperationFixture.ts` if it builds what you need), exported
through the real export path exactly as the Around cases are, with the same
machine variants #395 used (an own-axis A machine through LinuxCNC; a
borrowed-motor machine through Grbl). Keep each program small (a short bar, a
coarse stepover) so the corpus stays fast. Register them wherever the Around
cases are registered, and extend `corpus.test.ts` the way it covers those.
The validators are not installed on this machine: `npm run check:gcode` may
skip the real parsers locally; run what runs and say what was skipped. The
cases first meet the real parsers in CI.

## 2. Browser spec — new `e2e/rotaryModel.smoke.spec.ts`

You cannot run a browser; the manager will run it and fix it against the real
page, so keep it small and list what you assumed. Seed (as the Around specs
do) a round bar on a rotary machine with an imported model placed inside it
(a small closed mesh asset; reuse the fixture's mesh if it can be written into
the seeded project) and an Around setup. Then, through the UI:

- In the Around section, "Add to Around" offers **Rotary rough** and **Rotary
  finish**; add both, targeting the model. On the Top section they are not
  offered.
- Wait for the generation gear to read "up to date". Prove each operation
  produced moves, by the same means the Around specs use to read a toolpath
  back (not by trusting a green run: a spec whose fixture generated nothing
  once passed on #395).
- 3D view: the overlay drew segments (`data-toolpath-segments`); take a
  screenshot from the default camera and one after a left-drag of about
  −60 px for a low angle.
- Simulation tab, Around setup: `data-simulation-view` is `bar`; material is
  removed (`data-simulation-removed-cells` > 0); take a screenshot.
- Give the test `test.setTimeout(120_000)`.

Add selectors to `e2e/selectors.ts` as needed and register the spec in a lane
in `package.json` so `npx tsx scripts/check-e2e-lanes.ts` passes (the lane
the other Around specs are in).

## 3. One test gap from the manager's review of slice D

In `src/engine/setupTargets.ts`, `featureReachableFromFace` returns
`face === 'around' && isImportedModel(...)` for a rotary kind. With `face ===
'around' &&` removed every test still passes. Add a test (in
`src/engine/setupTargets.test.ts` or `src/components/cam/rotaryOperations.test.ts`):
for a rotary kind, an imported model is reachable from `around` and not from
`top` or `bottom`; a 2D feature is reachable from none of them. Re-run that
mutation and report it killed.

## Mutations

One at a time, restored from a `cp` backup (never `git checkout`); name the
failing test or report a survivor: `face === 'around' &&` removed in
`featureReachableFromFace`; a rotary case exported without the rotary word
(change the case's machine to one without a rotary axis and confirm the corpus
test notices).

## Checks to run and report

The two `tsc --noEmit` commands; `npx eslint` on changed files; `npx tsx` on
`scripts/gcode-conformance/corpus.test.ts`, `src/engine/setupTargets.test.ts`,
`src/components/cam/rotaryOperations.test.ts`,
`src/engine/toolpaths/rotaryOperation.test.ts`; `npm run check:gcode` (report
what it ran and what it skipped); `npx tsx scripts/check-e2e-lanes.ts`;
`npx tsx scripts/check-license-headers.ts`; `npm run docs:check`. One test
process at a time. Do not run `npm run build`, `npm test` or any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, the mutation
table, what the browser spec assumes about the page, and `RISKS`.
