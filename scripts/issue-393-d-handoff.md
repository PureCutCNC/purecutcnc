# Issue #393 slice D — the rotary axis in the machine editor

You are the implementation worker for slice D of issue #393 (rotary axis
contract). Work only in your task worktree. Do not create, remove, merge, push
or switch branches or worktrees. Do not open a PR. Do not run `git add` or
`git commit`: leave your edits uncommitted and report `COMMIT: none`. `gh` may
be blocked; everything you need is in this file.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`,
`src/components/machine/INDEX.md`, `src/i18n/INDEX.md`, `src/i18n/GLOSSARY.md`.
Base branch is `integration/0.6.0`; project format stays `3.3`; absolute paths
for every write, no `cd`. Smallest change that does the job; no refactor; match
the surrounding code. `node_modules` here is a symlink to the primary
checkout's: `npx tsc -b` cannot write its build info through it, so type-check
with `npx tsc -p tsconfig.app.json --noEmit` and
`npx tsc -p tsconfig.node.json --noEmit` instead.

## What exists (slices A–C, on your branch)

`src/engine/gcode/types.ts`: an optional `rotary` block on a machine
definition, absent on every bundled machine:

```ts
rotary?: {
  about: 'x' | 'y'           // the PROJECT axis the bar lies along
  drive: 'own' | 'borrowed'  // its own axis (word A), or the motor of the other horizontal axis
  reversed: boolean          // default false
  inverseTimeFeed: { on: string, off: string } | null   // default { on: 'G93', off: 'G94' }
}
```

Validation refuses it on a ShopBot (`opensbp`) or plasma machine and when the
borrowed motor would be Z. Helpers: `rotaryWord(definition)` (`'A'`, or the
borrowed motor's machine letter `'X'`/`'Y'`), `rotaryBorrowedAxis`,
`rotaryDirection`. Export, the exported-motion view and the conformance cases
already honour the block. Nothing lets a user set it except the raw JSON.

## What to build (approved plan: two fields and a checkbox, nothing else)

In the machine editor (`MachineDefinitionEditorDialog.tsx`,
`machineDefinitionForm.ts`; see how the plasma fields were added in
`PlasmaMachineFields.tsx` and follow the same form-data → definition round
trip), add a **Rotary axis** group:

1. **Rotary axis** — select: `None` / `Bar along X` / `Bar along Y`.
   `None` removes the `rotary` block entirely (the definition must then
   validate to exactly what it was before the block existed: no key).
2. **Driven by** — select, shown only when a rotary axis is chosen:
   `Its own axis (A)` / `The Y motor` when the bar is along X, or
   `The X motor` when the bar is along Y. The motor named is the PROJECT axis
   across the bar; show next to it, as plain helper text, the letter the
   program will use, taken from `rotaryWord` on the edited definition (so a
   machine whose coordinate system maps project Y to machine X shows the
   right letter).
3. **Reverse direction** — checkbox, shown only when a rotary axis is chosen.

Rules:

- Choosing a rotary axis for the first time creates the block with
  `drive: 'own'`, `reversed: false` and the default inverse-time commands.
  Changing the three controls never touches `inverseTimeFeed`: whatever the
  definition carries (including `null`, set through the raw JSON) is kept.
- The group is **not shown** for a plasma machine or a ShopBot (`opensbp`)
  machine: those cannot have one. Switching an edited machine to plasma or to
  the ShopBot dialect removes the `rotary` block (it would fail validation
  otherwise); say this in the report.
- A validation error on the block (e.g. borrowing Z through an unusual
  coordinate system) is shown the way the dialog shows its other field errors,
  on the Driven by field.
- The raw JSON view and the form stay in step both ways, as they do for the
  plasma block.
- Where the machine manager shows a machine's summary (the read-only preview
  that lists the kind), add one line when the machine has a rotary axis:
  "Rotary axis: bar along X, on its own axis (A)" / "…, on the Y motor
  (word Y)". Nothing for a machine without one.
- Stable test hooks on the three controls and the summary line, added to
  `e2e/selectors.ts`.

Locales (en, de, fr, es, zh-CN): only new keys, next to the machine-editor
keys they belong with, each file's own quote style, no existing value changed,
edited with the edit tool. English strings: `Rotary axis`, `None`,
`Bar along X`, `Bar along Y`, `Driven by`, `Its own axis (A)`,
`The Y motor`, `The X motor`, `Program word: {word}`, `Reverse direction`,
and the summary lines above. Follow `GLOSSARY.md`; if "rotary axis" has no
entry, add one per locale in the glossary's format.

## Do not touch

`src/engine/**` (read only), `src/store/**` unless the machine library needs a
field passed through (it should not: slice A found it already keeps the
block), bundled machine JSON, `legacyMachineParity.json`. If something there
needs a change, STOP and report it.

## Tests

`src/components/machine/machineDefinitionForm.test.ts` (extend; keep every
existing assertion):

- `toFormData` → `mergeFormData` round trip for: no rotary block (the merged
  definition has NO `rotary` key and equals the input); each of the four
  `about` × `drive` combinations; `reversed`; a definition whose
  `inverseTimeFeed` is `null` keeps `null` after any change to the three
  controls; custom inverse-time commands are kept.
- Choosing a rotary axis for the first time gives the defaults above;
  choosing `None` removes the block.
- Switching the kind to plasma, and the dialect to `opensbp`, removes the
  block and the result validates.
- The program word shown follows `rotaryWord` for an identity and a
  non-identity coordinate system.
- `validateDef` reports the borrowed-Z error on the Driven by field.

Browser spec: extend `e2e/machineLibrary.smoke.spec.ts` (keep its assertions;
follow its existing plasma test): duplicate a bundled router machine into My
Machines, open the editor, choose Bar along X → the Driven by and Reverse
controls appear and the program word reads `A`; choose The Y motor → the word
reads `Y`; save; reopen: the choices persisted and the raw JSON shows the
block; choose None, save, reopen: no rotary block in the raw JSON. A plasma
machine shows no Rotary axis group. You cannot run a browser; say it was not
run.

Mutations, one at a time, restored from a `cp` backup (never `git checkout`);
name the failing test or report a survivor:

- `None` leaves an empty or partial `rotary` object behind;
- changing Driven by resets `inverseTimeFeed` to the default;
- the program word is hard-coded (`'A'`/`'Y'`) instead of read from
  `rotaryWord`;
- switching to plasma keeps the block.

## Checks to run and report

The two `tsc --noEmit` commands above; `npx eslint` on changed files;
`npx tsx` on `src/components/machine/machineDefinitionForm.test.ts`,
`src/engine/gcode/rotaryDefinition.test.ts`, `src/i18n/registry.test.ts`,
`src/i18n/catalog.test.ts`; `npm run check:i18n`;
`npx tsx scripts/check-license-headers.ts`; `npm run docs:check`;
`npm run check:e2e-lanes`. Never more than one test process at a time. Do not
run `npm run build`, `npm test` or any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, the mutation
table, the locale keys added per file, and `RISKS`: anything that surprised
you, whether the symlinked `node_modules` got in your way, and anything you
did not do.
