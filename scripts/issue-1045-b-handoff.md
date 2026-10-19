# #1045 slice B — "Passes" option in the UI, booklet and regeneration (rotary rough/finish)

Base: the slice A branch (already checked out). Slice A added `RotaryPassDirection = 'along' | 'around'` in `src/types/project.ts` and the optional `Operation.rotaryPassDirection` (missing = `'along'`), and the engine reads it. Read `INDEX.md`, `AGENTS.md`, `src/components/INDEX.md`, then this file. `gh` may be blocked.

## Why (Frank, 2026-10-18)
"fix a position on bar and move A (and Z if needed). that should also be an option on the rotary rough and finish, kind of like we have it for the parallel pocket operation where we can define an angle."

## What to build

- `src/components/cam/operationFields.ts`: a field `rotaryPassDirection` in the `strategy` group, `appliesTo` rotary kinds only (`isRotaryOperationKind`). Add its id to the field-order list (next to the rotary fields) and to the rotary allowlist in the group filter (the `['name', 'description', … 'rotaryTailSupport']` array).
- `src/components/cam/CAMPanel.tsx`: the renderer, modelled on the `pattern` row (a `Select`): label **Passes**, options **Along the bar** (`'along'`) / **Around the bar** (`'around'`), value `operation.rotaryPassDirection ?? 'along'`, `onChange` → `updateOperation(operation.id, { rotaryPassDirection: value })`. A `title` tooltip: "Along the bar: passes run the length of the bar and step around it. Around the bar: the bar turns under the tool at one position, then steps along — smoother on turned shapes." If CAMPanel is near its `max-lines` limit, put the row in a small component file beside it.
- **Stepover meaning:** in around mode the stepover is the distance between rings *along* the bar. If the rotary stepover field has a tooltip/help, make it say which distance it is for the selected Passes value (one string per mode). Do not rename the field.
- `src/app/toolpathGeneration/cacheInputs.ts`: slice A already added the comparison (and the two `src/app/*` guard tests); check it is right and do not duplicate it. Grep for every other consumer of `rotaryChuckSupport` (`git grep -n rotaryChuckSupport -- src`) and decide for each whether the new field belongs there too; say what you decided per site.
- `src/engine/operationBooklet/report.ts`: a **Passes** row for the two rotary kinds, after Stock to leave.
- Locales: the new keys in `cam.ts` (and `booklet.ts` if the booklet uses its own key) for **all five** locales (`en`, `de`, `fr`, `es`, `zh-CN`), same position as `en`, real translations, match each file's quote style. Add the term to `src/i18n/GLOSSARY.md` if rotary terms are listed there. Never touch an existing value.
- Operation defaults: leave the field **absent** on new operations (missing = along). Do not change `operationDefaults.ts`.
- `src/utils/units.ts`: no change (not a length); say so.

## Tests
- `operationFields` test: the field applies to rotary rough and finish only, and is in the strategy group.
- `cacheInputs` test: two operations differing only in `rotaryPassDirection` are not computation-equal; missing and `'along'` are equal (add only what slice A's guard tests do not already assert).
- Another slice is adding tests to `src/engine/toolpaths/rotaryAroundPasses.test.ts` right now: do not edit it.
- Booklet test: the row appears with the right label for each value.
- A browser spec, extending `e2e/rotaryModel.smoke.spec.ts` (read how it seeds `src/test/rotaryOperationFixture.ts`): select the rotary finish, set Passes to Around the bar, wait for the generation status to read up to date, and assert from the store that the operation's toolpath has moves, every move's `a` is within [0, 360], and the move list differs from the along result. You cannot run a browser; write it carefully, the manager runs it.

## Mutations (report each; restore from a `cp` backup)
- remove the new comparison from `cacheInputs.ts` → the cache test fails;
- make `appliesTo` return true for every kind → the fields test fails.

## Off limits
`src/engine/toolpaths/**` and `src/types/project.ts` (slice A owns them; if something is wrong there, say so in RISKS and do not edit), simulation, gcode.

## Checks
`npm run check:i18n`, the changed unit tests with `NODE_OPTIONS=--no-experimental-global-navigator npx vitest run <files>`, `npm run build:gates`; exit codes captured.

## Report
`STATUS`, `COMMIT: none`, `CHANGED_FILES`, per-file changes, the per-site decision for each `rotaryChuckSupport` consumer, mutations and results, commands with exit codes, `RISKS`.
