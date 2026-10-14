# Issue #1015 slice D — the two rotary operations in the app

You are the implementation worker for slice D of issue #1015 (machine an
imported 3D model inside a round bar on a rotary axis). Work only in your task
worktree. Do not create, remove, merge, push or switch branches or worktrees.
Do not open a PR. Do not run `git add` or `git commit`: leave your edits
uncommitted and report `COMMIT: none`. `gh` may be blocked; everything you
need is in this file.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`, `src/engine/INDEX.md`,
`src/engine/toolpaths/INDEX.md`, `src/components/INDEX.md`, then in full
`src/engine/toolpaths/rotaryModel.ts` (slices A–C: `sampleRotaryModel`,
`generateRotaryFinish`, `generateRotaryRough`, `rotaryAlongRange`) and the
three handoffs `scripts/issue-1015-{a,b,c}-handoff.md`,
`src/engine/toolpaths/generateOperation.ts` (`computeOperationToolpath` and
its Around branch), `src/engine/aroundFrame.ts`, `src/engine/setupTargets.ts`
(how an Around setup judges targets; today it rejects imported models), how
`finishSurfaceParallel.ts` gets "every target model, as one surface" (issue
#934) and its `stepoverDistance`, `src/store/helpers/operationDefaults.ts`,
`src/components/cam/operationFields.ts`, `operationValidity.ts`,
`CAMPanel.tsx` (`operationAddButtonLabel` and how "Add to Around" offers
kinds), `src/app/toolpathGeneration/cacheInputs.ts`
(`operationComputationEquals`). Absolute paths for every write, no `cd`.
Smallest change that does the job; match the surrounding code. No `process.`
or `globalThis` in engine code. `node_modules` is a symlink: type-check with
`npx tsc -p tsconfig.app.json --noEmit` and
`npx tsc -p tsconfig.node.json --noEmit`, never `npx tsc -b`.

**Find every consumer by grepping a sibling.** For each new kind, grep the
whole tree for `'finish_surface'` and decide at every hit whether the rotary
kinds need a case (switches over `OperationKind` will fail to compile, but
`if`-chains and lists will not). For each new field, grep for
`stockToLeaveRadial` the same way. List in the report every file you looked at
and what you decided there.

## The approved plan (maintainer, 2026-10-13), for this slice

On a round bar with a rotary machine, an imported model placed inside the bar
is machined all the way round: "Rotary rough" (layers of radius), then
"Rotary finish" (passes along the bar, stepping round it), with stock left at
both ends so the part stays attached. Both live in the **Around** setup and
target an imported model. "The model is not on a face": it lives in the bar
and only rotary operations target it. Ball nose first; flat end mills work
because the sampler handles them; other tools are refused. Format stays 3.3:
the new kinds and fields are additive, and a file without them is unchanged.

## Build

1. **Kinds.** Add `'rotary_rough'` and `'rotary_finish'` to `OperationKind`
   (`src/types/project.ts`, protected path; additive only).
2. **Fields.** Two optional fields on `Operation`: `rotaryChuckSupport?: number`
   and `rotaryTailSupport?: number`, bar length kept uncut at the chuck end and
   at the tail end. Missing reads as 0 (the chuck and tailstock keep-outs still
   apply, and the range never runs past the model, so 0 is safe). No migration
   writes them; keys are read with `?? 0`. Add both to
   `operationComputationEquals`.
3. **Mapping to the generators** (one small adapter in `rotaryModel.ts` or a new
   `rotaryOperation.ts` beside it):
   - mesh: every target model as one surface, the same way the parallel finish
     gets it; the model's along extent from that mesh's bounds;
   - `stepover`: the distance the parallel finish computes from
     `operation.stepover` (same convention, so the field means the same thing
     on both);
   - `stepdown`: `operation.stepdown` (rough only);
   - `stockToLeave`: `operation.stockToLeaveRadial`;
   - `sampleSpacing`: `tool.radius / 4` for the finish, `tool.radius / 2` for
     the rough (no new field: hobby scope);
   - `requestedCellSize`: `min(tool.radius / 3, stepover * 0.5)`, as the
     parallel finish;
   - along range: `rotaryAlongRange(stock, project.clamps, modelAlong, tool,
     {chuckEnd, tailEnd})`; `null` → no moves and `rotaryNoRoom`;
   - `safeRadius`: `project.meta.maxTravelZ − R`, the same rapid height every
     other Around operation ends up with (`unrolledProject` lowers
     `maxTravelZ` by `R`, and wrapping adds it back). If that is not above the
     bar's surface, use `R` plus the tool diameter, and say so in a comment.
4. **Dispatch.** In `computeOperationToolpath`, a rotary kind is handled
   before the Around unroll branch: it requires an Around setup on a round bar
   (otherwise no moves and the existing `aroundStockMismatch`-style warning
   the Around branch uses), calls the generator with the real project, and
   returns its result (already wrapped; `raw: null`). It never goes through
   `unrolledProject`/`wrapToolpath`. No target model → no moves and a warning
   (reuse the code the 3D operations use for a missing model target; if none
   fits, add one, five locales).
5. **Targets.** In `setupTargets.ts`: a rotary operation in an Around setup
   may target an imported model (and only imported models); every other
   Around operation still rejects models exactly as today; a rotary operation
   in a Top or Bottom setup is invalid. Keep the change to these rules; do not
   touch the flat faces' rules.
6. **Validity** (`operationValidity.ts`): a rotary operation needs a round
   bar, an Around setup, at least one model target, and a ball nose or flat
   end mill; each failure has the message the panel shows for comparable
   cases (new keys where needed, five locales).
7. **CAM panel.** "Add to Around" offers **Rotary rough** and **Rotary
   finish** when the project has an imported model; they are not offered on
   Top or Bottom. Labels in `operationAddButtonLabel`. Fields shown: tool,
   stepover, stepdown (rough only), stock to leave, feed, plunge feed, RPM,
   chuck-end support, tail-end support. Nothing else (no pattern, angle,
   slope, tabs, axial stock). The two support fields use the panel's ordinary
   length input in project units, with labels and tooltips. New locale keys
   in the `cam` files of all five locales (en, de, fr, es, zh-CN): only new
   keys, each file's own quote style, no existing value changed.
8. **Defaults** (`operationDefaults.ts`): `pass: 'rough'` / `'finish'`;
   stepover and stepdown as the existing rough/finish surface operations
   default them for the tool; supports 0.
9. **Everything else that switches on kinds** (booklet/report, toolpath
   levels, tool selection, CAM plan, parity corpus, tabs): give the rotary
   kinds the behaviour of the nearest 3D sibling where that makes sense, and
   leave them out where it does not (the automatic plan is off on Around; tabs
   do not apply). Say what you did at each.

## Tests

- **End to end through `computeOperationToolpath`** on a project with a round
  bar along X (and one along Y), an Around setup, a chuck clamp, and an
  imported model inside the bar (build a small closed mesh asset in the test,
  or reuse a fixture): rough and finish produce moves; every point carries
  `a`; every point's across coordinate is the centreline; no point is outside
  the along range `rotaryAlongRange` gives; no point is deeper than the model
  plus stock (check a few samples against the sampler); the result is not
  passed through `wrapToolpath` (a move count or a spy proves it).
- **A field reaches the toolpath:** changing `rotaryChuckSupport` changes
  the along range of the output; `operationComputationEquals` returns false
  when either support field differs.
- **Targets:** a rotary operation in an Around setup accepts a model and
  rejects a 2D feature; an Around pocket still rejects a model; a rotary
  operation in a Top setup is invalid.
- **Validity:** each refusal in rule 6 has its message.
- **Defaults** for both kinds.
- **A file without the new kinds or fields** loads and round-trips byte for
  byte (an existing `camj` fixture through import and export).
- **Flat output unchanged:** `legacyMachineParity.test.ts` and the existing
  operation tests pass unmodified.

## Mutations

One at a time, restored from a `cp` backup (never `git checkout`); name the
failing test or report a survivor: the rotary kinds sent through the unroll
branch; a support field missing from `operationComputationEquals`; models
accepted for every Around operation; the along range not applied;
`stockToLeaveRadial` not passed; a rotary operation allowed on Top.

## Checks to run and report

The two `tsc --noEmit` commands; `npx eslint` on changed files; `npx tsx` on
every test file you changed or added, plus
`src/engine/toolpaths/rotaryModel.test.ts`, `src/engine/aroundFrame.test.ts`,
`src/engine/aroundReview.test.ts`, `src/engine/setupTargets.test.ts`,
`src/engine/gcode/aroundExport.test.ts`, `legacyMachineParity.test.ts`,
`src/import/camj.test.ts`, `src/i18n/warningsCoverage.test.ts`; `npm run
check:i18n`; `npx tsx scripts/check-license-headers.ts`; `npm run docs:check`.
One test process at a time. Do not run `npm run build`, `npm test` or any
browser test (slice E adds the browser spec and export cases).

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, one line per
build item, the consumer list (file → decision), the mutation table, the
locale keys added per file, and `RISKS`: anything that surprised you, any rule
above you think is wrong (say so rather than work around it), anything you did
not do.
