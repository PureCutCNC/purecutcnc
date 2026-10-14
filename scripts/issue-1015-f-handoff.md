# Issue #1015 slice F — fixes from the independent review

You are the implementation worker for a fix slice of issue #1015 (machine an
imported 3D model inside a round bar on a rotary axis). Work only in your task
worktree. Do not create, remove, merge, push or switch branches or worktrees.
Do not open a PR. Do not run `git add` or `git commit`: leave your edits
uncommitted and report `COMMIT: none`. `gh` may be blocked; everything you
need is in this file.

Read first: `AGENTS.md`, the slice handoffs `scripts/issue-1015-{a,b,c,d,e}-handoff.md`
(they still apply), then `src/engine/toolpaths/rotaryModel.ts`,
`src/engine/toolpaths/rotaryOperation.ts`, their tests,
`src/engine/toolpaths/parityCorpus.ts`, `src/engine/setupReach.ts`,
`src/components/cam/operationValidity.ts`, `src/store/helpers/operationDefaults.ts`.
Absolute paths for every write, no `cd`. Smallest change that does the job;
match the surrounding code. No `process.` or `globalThis` in engine code.
`node_modules` is a symlink: type-check with `npx tsc -p tsconfig.app.json --noEmit`
and `npx tsc -p tsconfig.node.json --noEmit`, never `npx tsc -b`.

An independent review of the whole branch found the defects below; the
manager read each against the code. Fix all of them, each with a test that
fails before the fix (except where noted).

## 1. Three test files fail (blocks the build)

`parityCorpus.ts` adds the rotary fixture to `buildParityCorpus()`, and three
harnesses that assume a flat Top project with a traced result fail on it:
`src/engine/toolpaths/setupLegacyParity.test.ts` ("loads as one Top setup"),
`src/app/toolpathGeneration/executorParity.test.ts` and
`src/app/toolpathGeneration/workerRuntime.test.ts` ("expected a traced engine
result": the rotary dispatch returns `raw: null`). Fix: take the rotary cases
out of `buildParityCorpus()` (they are covered end to end by
`rotaryOperation.test.ts` and the conformance corpus). Then run **all three**
of those files plus `moveTransport.test.ts` and `transport.test.ts` and report
them green. No new test needed; the three existing files are the test.

## 2. The finish cuts to the axis wherever no model is under the tool

`generateRotaryFinish` maps a `NaN` sample (nothing under the tool) to tip 0,
so on a model that does not cover the line over the axis at some angles (an
off-axis prism), the finish emits cut moves at the centreline: full-width,
full-depth slotting with a finishing tool, and no warning. The finish follows
the model; removing waste is the rough's job (the rough clamps to its layer
radius and already handles this).

Rule: in the **finish**, a `NaN` sample is not cut. Each pass is split into
runs of finite samples; between runs, and from a run to the next pass when
they do not join at the same end, retract to `safeRadius`, move there, and
plunge, using the same run machinery the rough uses (share it rather than copy
it). A pass with no finite sample emits nothing. The rough is unchanged (a
`NaN` there still means "remove down to the layer, at most to the
centreline"). Test: an off-axis prism (e.g. 4 × 4 at across 8–12, up 8–12 in a
40 mm bar): no finish cut point at a sample whose raw value is `NaN`; no cut
point at `z = R` unless the model really is there; every move between runs is
a rapid at `safeRadius` or a plunge.

Also reword `rotaryBelowCentreline` (all five locales; change only this
key's value): the tool stops at the centreline there, which is not the same
as "left uncut" for an off-axis model. English:
`{operation}: the model reaches below the bar's centreline near {along} along the bar, at {angle}°. The tool stops at the centreline there.`

## 3. A rotary operation shows a made-up stock reach

`setupReach.ts` (`operationCutRange`, around its `unwrapPoint` use) unwraps a
rotary operation's points into sheet coordinates and intersects them with the
model's project-frame footprint, so the setup panel prints a stock-Z reach
that means nothing (measured `{8.5, 12}` and `{11, 12}` on the fixture).
Fix: return `null` (no reach) for a rotary kind. Test: both rotary kinds
give `null`; an ordinary Around operation still gives what it gave.

## 4. End supports ignore the tool radius

In `rotaryAlongRange`, the chuck and tailstock clamps get `+ tool.radius`,
but the support lengths are used as they are, so the tool's side overhangs a
support by its radius. Rule: the tool's side must not enter a support either:
`start ≥ lower + chuckSupport + tool.radius` and the mirror at the tail end,
**only when that support is greater than 0** (a support of 0 means "no
support", and the model's own extent still limits the range). Test it at both
ends, both bar axes; update the existing range expectations that change and
say which.

## 5. The plan's "model outside the bar" check is missing

Plan item 1: "A check says so when any part of the model lies outside the
bar." Today a model poking through the surface is clamped to the bar's
radius and machined as air, silently. Rule: when any vertex of the target
mesh lies farther from the bar's axis than `R` (with a tolerance of
`minRenderHeight` for the units), or outside the bar's along extent, the
operation still generates and adds one warning, new code
`rotaryModelOutsideBar`, English:
`{operation}: part of the model lies outside the bar. Those parts are not machined.`
(five locales, only the new key, each file's own quote style). Test: a model
that pokes through gets the warning; one inside does not.

## 6. Unbounded allocation

`stepover`, `sampleSpacing` (and a zero-radius bar) are guarded only by
`Math.max(x, 1e-9)`, so a 0 makes `ceil(span / 1e-9)` samples or about 6·10¹⁰
passes and hangs the worker. Rule: both generators refuse a non-positive or
non-finite `stepover` or `sampleSpacing` (no moves, the existing
`operationStepoverRatioRange` warning for stepover; for sample spacing a
plain `stepoverPositive`-style code if one exists, otherwise the same code)
and a bar with no positive radius. Test both.

## 7. Messages that name the wrong operation

- `rotaryToolUnsupported` says "Rotary finishing needs…" but the rough emits it
  too. English: `{operation}: rotary machining needs a ball nose or flat end mill.`
  (change only this key's value, five locales).
- `operationValidity.ts` (around line 125) reuses `cam.hint.roughSurfaceNoModel`
  for a rotary operation with no target; use the rotary keys slice E2 added
  (`cam.rotary.roughNoModel` / `cam.rotary.finishNoModel`) by kind.

## 8. A looser target check

`fallbackOperationTarget` in `operationDefaults.ts` accepts any `kind === 'stl'`
feature for a rotary kind, while validity and the adapter also require
`operation === 'model'`. Make it the same. Test.

## 9. Two INDEX lines run together

`src/engine/INDEX.md` and `src/engine/toolpaths/INDEX.md` had new sentences
appended to the previous one with no separator (`…runs in the toolpath
worker Rotary rough/finish…`, `…the cost the flag avoids Rotary rough/finish
(#1015)…`, and the same for `setupReach`). Fix the punctuation; no test.

## Mutations

One at a time, restored from a `cp` backup (never `git checkout`); name the
failing test or report a survivor: the finish cutting `NaN` samples at the
centreline again; the reach not `null` for a rotary kind; the support without
the tool radius; the outside-bar check removed; a zero sample spacing
accepted; the fallback target accepting a non-model STL.

## Checks to run and report

The two `tsc --noEmit` commands; `npx eslint` on changed files; `npx tsx` on
every test file you changed or added plus `setupLegacyParity.test.ts`,
`executorParity.test.ts`, `workerRuntime.test.ts`, `moveTransport.test.ts`,
`transport.test.ts`, `rotaryModel.test.ts`, `rotaryOperation.test.ts`,
`rotaryOperations.test.ts`, `operationValidity.test.ts`,
`scripts/gcode-conformance/corpus.test.ts`, `src/i18n/warningsCoverage.test.ts`;
`npm run check:i18n`; `npx tsx scripts/check-license-headers.ts`;
`npm run docs:check`. Then **run `npx tsx scripts/run-tests.ts`** (the whole
unit suite, once, at the end, nothing else running) and report its result:
this slice must leave every test file green. Do not run `npm run build` or any
browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS` (with the full
suite's result), one line per numbered item, the mutation table, the locale
keys added or changed per file, and `RISKS`.
