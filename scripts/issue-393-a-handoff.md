# Issue #393 slice A — the rotary block in the machine definition

You are the implementation worker for slice A of issue #393 (rotary axis
contract). Work only in your task worktree. Do not create, remove, merge, push
or switch branches or worktrees. Do not open a PR. Do not run `git add` or
`git commit`: leave your edits uncommitted and report `COMMIT: none`. `gh` may
be blocked; everything you need is in this file.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`, `src/engine/gcode/INDEX.md`,
`ARCHITECTURE.md` §8 (export). Base branch is `integration/0.6.0`; project
format stays `3.3` (no version bump); no `process.` or `globalThis` in engine
code; absolute paths for every write, no `cd`. Smallest change that does the
job; no refactor.

## Why (plan approved by the maintainer, 2026-10-12)

PureCutCNC is gaining a rotary axis: a round bar held in a chuck that the
machine can turn. Two hobby arrangements must both work:

1. **Its own axis.** The controller has a fourth axis; the program says `A`
   and the number is degrees.
2. **A borrowed motor.** A 3-axis controller (plain Grbl knows only `X Y Z`);
   the rotary is plugged into the output of the horizontal axis that runs
   across the bar. The program says that axis's letter (`Y` for a bar along X)
   and the number is degrees. That linear axis no longer exists.

This slice adds only the optional description of that to the machine
definition, plus the helpers later slices use. It emits nothing and changes no
output. Later slices (toolpath point with an angle, emission with
inverse-time feed, the parser, the machine editor) code against the names
frozen here.

## Frozen interface — `src/engine/gcode/types.ts`

Add to `MachineDefinitionSchema`, next to `plasma`, an optional block that is
ABSENT on every bundled machine and never added by default:

```ts
rotary: RotaryDefinitionSchema.optional()

// RotaryDefinitionSchema (zod object):
//   about:  'x' | 'y'            the PROJECT axis the bar lies along and turns about
//   drive:  'own' | 'borrowed'   'own' = its own axis, word A; 'borrowed' = the motor of the other horizontal axis
//   reversed: boolean            default false; true = a positive angle turns the other way
//   inverseTimeFeed: { on: string, off: string } | null
//                                default { on: 'G93', off: 'G94' }; null = the controller has no inverse-time feed.
//                                Both commands must be non-blank when the object is present.
export type RotaryDefinition = z.infer<typeof RotaryDefinitionSchema>

/** The letter the program uses for rotation, or null when the machine has no rotary axis. */
export function rotaryWord(definition: Pick<MachineDefinition, 'rotary' | 'coordinateSystem'>): 'A' | 'X' | 'Y' | null
/** The PROJECT axis whose linear travel is gone because its motor drives the rotary, or null. */
export function rotaryBorrowedAxis(definition: Pick<MachineDefinition, 'rotary'>): 'x' | 'y' | null
/** +1 or -1: what a positive angle is multiplied by on its way into the program. */
export function rotaryDirection(definition: Pick<MachineDefinition, 'rotary' | 'coordinateSystem'>): 1 | -1
```

Rules:

- `rotaryWord`: no block → `null`; `drive: 'own'` → `'A'`; `drive: 'borrowed'`
  → the machine letter the OTHER horizontal project axis maps to through
  `coordinateSystem`, sign stripped: for `about: 'x'` that is
  `coordinateSystem.yAxis` (`'Y'` or `'-Y'` → `'Y'`), for `about: 'y'` it is
  `coordinateSystem.xAxis`.
- `rotaryBorrowedAxis`: `drive: 'borrowed'` → `'y'` when `about` is `'x'`,
  `'x'` when `about` is `'y'`; otherwise `null`.
- `rotaryDirection`: `-1` when `reversed`, else `1`; for a borrowed motor
  multiply by `-1` again when the mapped `coordinateSystem` entry is negative
  (`'-Y'`), because that output already runs backwards.
- Validation (in the existing `superRefine`, same style and message tone as
  the plasma rules):
  - a `rotary` block on a machine whose output dialect resolves to `opensbp`
    is an error on path `['rotary']`: "A rotary axis requires the G-code
    output dialect.";
  - a `rotary` block on a plasma machine is an error on path `['rotary']`:
    "A plasma machine cannot have a rotary axis.";
  - a borrowed motor whose mapped `coordinateSystem` entry is `'Z'` or `'-Z'`
    is an error on path `['rotary', 'drive']`: "The rotary cannot borrow the Z
    motor.".
- A definition without the block must validate to exactly what it validates
  to today: no `rotary` key appears, no other key moves. Do not add the block
  to any file under `src/engine/gcode/definitions/` or `src/machine/`.

## Everything that copies or compares a machine definition

A machine definition is embedded in projects, kept in the user's machine
library, compared for the "update available" warning, cloned and edited as raw
JSON. Find every place that builds, copies, compares or normalizes one field by
field (start with `grep -rn "coordinateSystem" src --include='*.ts' --include='*.tsx'`
and `grep -rn "plasma:" src`), and make sure a `rotary` block survives each:
project save/load, the machine library store, import/export of a machine file,
duplicate, and the embedded-versus-library comparison. Where the code already
spreads or goes through `validateMachineDefinition`, nothing needs to change;
say so. Do NOT build any UI for it (the editor is a later slice), but the raw
JSON editor must accept and keep the block if it validates today's way.

## Do not touch

`src/engine/gcode/postprocessor.ts`, `motionPipeline.ts`, `arcFitting.ts`,
`gcodeMotionParser.ts`, `src/engine/toolpaths/**`, any bundled definition
JSON, `legacyMachineParity.json`, locales. If one of those needs a change to
compile, STOP and report it.

## Tests (plain `assert` + `npx tsx <file>.test.ts`, the repo's convention)

New `src/engine/gcode/rotaryDefinition.test.ts` (licence header copied from a
neighbour):

1. Every bundled definition (`src/engine/gcode/definitions/index.ts`)
   validates with no `rotary` key, and `JSON.stringify` of the validated
   definition equals `JSON.stringify` of the same definition validated with
   the schema as it was before your change (keep a frozen copy of the
   expected key order in the test, or compare against the raw JSON's own
   validated form computed without the new field; say which you did).
2. A block round-trips through `validateMachineDefinition` for all four
   `about` × `drive` combinations; `reversed` defaults to `false`;
   `inverseTimeFeed` defaults to `G93`/`G94`; explicit `null` stays `null`;
   blank `on` or `off` is refused.
3. `rotaryWord`: `null` with no block; `'A'` for own; `'Y'` for borrowed about
   `'x'`; `'X'` for borrowed about `'y'`; follows a non-identity
   `coordinateSystem` (project Y mapped to `'-X'` gives `'X'`).
4. `rotaryBorrowedAxis` and `rotaryDirection` for each case, including the
   double negative (reversed on a `'-Y'` output gives `+1`).
5. The three validation errors, each with its path and message; a rotary
   block on a router G-code machine is accepted.
6. A project that embeds a machine with a rotary block survives the same
   save/load path the existing machine tests use (find the nearest existing
   test that round-trips an embedded machine, e.g. the #956 plasma ones, and
   add the case beside it).
7. The machine library path you found above: one test that a library entry
   with a rotary block comes back with it.

Existing tests must pass unchanged, in particular
`src/engine/gcode/legacyMachineParity.test.ts`. Do not edit, weaken or
regenerate any existing fixture, golden file or assertion; if one fails, STOP
and report it.

Mutations, one at a time, restored from a `cp` backup (never `git checkout`).
Name the failing test or report a survivor:

- `rotaryWord` returns `'Y'` for every borrowed case;
- `rotaryDirection` ignores `reversed`;
- `rotaryDirection` ignores the negative `coordinateSystem` entry;
- the ShopBot refusal is removed;
- the plasma refusal is removed;
- `inverseTimeFeed` defaults to `null`.

## Checks to run and report

`npx tsc -b`; `npx eslint` on changed files; `npx tsx` on each test you added
or changed plus `src/engine/gcode/legacyMachineParity.test.ts`,
`src/engine/gcode/postprocessor.test.ts`,
`src/components/machine/machineDefinitionForm.test.ts` and the machine library
tests you find; `npx tsx scripts/check-license-headers.ts`;
`npm run docs:check`. Never more than one test process at a time. Do not run
`npm run build`, `npm test`, `npm run check:gcode` or any browser test.

## Docs

`src/engine/gcode/INDEX.md` if it lists the definition's blocks; one or two
plain sentences in `ARCHITECTURE.md` where the machine definition is described
(next to the plasma block if it is mentioned). Nothing else.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, the mutation
table, the list of places that copy or compare a machine definition and what
each does with the new block, and `RISKS`: anything that surprised you,
anything the next slices (an angle on toolpath points; emitting the rotary
word with inverse-time feed; reading it back in `gcodeMotionParser.ts`; the
machine editor form) will trip over, and anything you did not do.
