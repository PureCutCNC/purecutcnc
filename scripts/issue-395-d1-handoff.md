# Issue #395 slice D1 — the Around face in the interface (switch, tree, CAM, export, print)

You are the implementation worker for slice D1 of issue #395 (wrapped rotary,
part A: an "Around" face on a round bar). Work only in your task worktree. Do
not create, remove, merge, push or switch branches or worktrees. Do not open a
PR. Do not run `git add` or `git commit`: leave your edits uncommitted and
report `COMMIT: none`. `gh` may be blocked; everything you need is in this file
and in `scripts/issue-395-audit.md`.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`, `src/components/INDEX.md`
and the indexes of the folders you touch, `src/i18n/INDEX.md`,
`src/i18n/GLOSSARY.md`, `src/assets/icons` conventions (how `face-top` and
`face-bottom` are defined and registered), then `scripts/issue-395-audit.md`
in full, `src/store/helpers/activeFace.ts`, `src/store/workspaceFace.ts`,
`src/store/helpers/aroundFace.test.ts`. Absolute paths for every write, no
`cd`. Smallest change that does the job; no refactor; match the surrounding
code and its CSS conventions. `node_modules` is a symlink: type-check with
`npx tsc -p tsconfig.app.json --noEmit` and
`npx tsc -p tsconfig.node.json --noEmit`, never `npx tsc -b`.

## Where things stand

The model layer knows a third face, `'around'`, on a round bar: a setup with
`kind: 'around'`, features with `authoringFace: 'around'`, operations that
generate wrapped toolpaths, file load/save. The model already refuses what is
not allowed (changing a feature's face to or from Around, moving an operation
between a flat setup and Around, models and tabs on Around, the CAM plan on
Around) and offers `aroundUnavailableReason(project)`
(`null | 'needsRoundBar' | 'needsRotaryMachine' | 'machineAxisMismatch'`).
**No screen shows any of it yet**, and about forty places in the components
still say "Top, else Bottom". This slice makes the interface correct for
Around everywhere **except** the Sketch canvas, the 3D view and the
Simulation tab.

Other workers are changing these at the same time, **do not touch them**:
`src/components/canvas/**`, `src/components/viewport3d/**`,
`src/components/simulation/**`, `src/app/**`, `src/engine/gcode/**`,
`src/engine/operationBooklet/**`, the `warnings` locale files. Yours:
`src/components/layout/**`, `src/components/feature-tree/**`,
`src/components/cam/**`, `src/components/export/**`, `src/components/project/**`
(and any other component folder not named above as another worker's), `src/styles/**`,
`src/assets/icons/**`, the `appShell`, `featureTree`, `cam`, `dialogs` and
similar UI locale files, `e2e/selectors.ts`, and the two model-layer
carry-overs below.

## Approved behaviour (Frank, 2026-10-12)

1. **Face switch.** A third segment, **Around**, after Top and Bottom, with
   its own icon `face-around` (a bar seen end-on with an arrow going round it,
   drawn and registered the way `face-top` / `face-bottom` are). It is shown
   only when the stock is a round bar. When `aroundUnavailableReason` is
   `'needsRotaryMachine'` or `'machineAxisMismatch'` the segment is shown
   disabled with a tooltip that says what is missing: "Around needs a machine
   with a rotary axis. Set one in the machine editor." / "The machine's rotary
   axis lies along {machineAxis}, the bar along {stockAxis}." Tooltip when
   enabled: "Work around the bar". A project that is not on a round bar shows
   exactly the switch it shows today.
2. **"Other side" ghost toggle** is hidden while Around is the active face,
   and when the only non-Top content is on Around it is not shown on Top
   either: a flat face and Around share no plane.
3. **Face banner.** On Around the mounting note reads "The bar turns in the
   rotary. This view is its surface unrolled: along the bar, and around it."
   and the drawing hint uses the Around icon and "Drawing on the surface of
   the bar".
4. **Feature tree.** Around features get their own layer, labelled
   "Around", with the Around icon and chip `AROUND`; ghost rows and the
   "switch to … to edit" menu entry name the right face
   ("On the around face. Switch to it to edit." / "Switch to around face to
   edit"). The properties panel shows ordinary Top-style Z controls for an
   Around feature (its heights are stored like a Top feature's), never the
   Bottom range control (`FaceZRange`).
5. **Change face** (the dialog, the properties row's "Change…", the context
   menu entry) is not offered for an Around feature, and Around is never
   offered as a destination. Where the entry would appear for an Around
   feature, leave it out rather than show a disabled one.
6. **CAM panel.** An Around setup has its own section, "Around operations",
   with the status line "Bar in the rotary" where a Bottom setup shows its
   flip; "Add to Around"; target hints and depth wording follow Top's wording
   with "the surface of the bar" where Top says the top face. The setup
   properties dialog for an Around setup shows its name and notes only: no
   face buttons, no flip axis, no flip sketch, no registration list. The
   cross-face target picker and the through-feature coverage are not shown for
   an Around setup. The CAM plan entry point is hidden or disabled on Around
   with the tooltip "The automatic plan is not available on the around face".
7. **Imports, tabs, clamps on Around.** Importing a 3D model while Around is
   active is refused by the model; show the refusal the way the import dialog
   shows its other errors: "A 3D model cannot be placed on the around face.
   Switch to Top to import it." The Add tab action is disabled on Around with
   the tooltip "Tabs are not used on the around face". Only chuck and
   tailstock clamps are offered on a round bar already; leave that.
8. **Export dialog.** An Around setup is its own group and program card,
   labelled with its name and the Around icon, also when it is the project's
   only setup (today a single setup is always labelled Top).
9. **Print.** Print and design SVG export are disabled while Around is the
   active face, with the tooltip "Printing shows the flat faces. Switch to Top
   or Bottom to print." From a flat face they work as today; Around features
   are not drawn (check that they are in fact left out, and if they are not,
   STOP and report: that file belongs to no slice yet).
10. **Names.** In running text the face is "the around face" (lower case, like
    "the top face"); as a label, chip or segment it is "Around" / `AROUND`.
    Add "around (face)" to `GLOSSARY.md` per locale in its format. All five
    locales, only new keys, next to the keys they belong with, each file's own
    quote style, no existing value changed, edited with the edit tool.

For every other face-dependent site of the audit that lies in your folders
(classes B, G and "unclear" N): apply the audit's recommendation, read
through the rules above. Remove the `as FlatFace` cast slice A left in
`ChangeFaceDialog.tsx` by handling Around properly there. (The one in
`Viewport3D.tsx` belongs to another slice.)

## Two model-layer carry-overs (yours; nobody else touches these files)

- `src/store/helpers/setups.ts` `syncProjectSetups`: slice B made an Around
  setup's `orientation.axis` follow the bar's axis always. That silently
  re-reads existing Around drawings on a transposed sheet when the user turns
  the bar from X to Y. Rule: follow the bar only while the Around setup is
  empty (no operation in it and no feature with `authoringFace: 'around'`).
  Once it has content the axis stays, and the existing `aroundStockMismatch`
  block at generation tells the user. Test both in
  `src/store/helpers/aroundFace.test.ts`.
- `src/engine/setupReach.ts` `operationCutRange`: for an Around operation it
  calls `aroundFrameForOperation`, which throws when the bar is no longer a
  round bar on that axis; `src/components/cam/setupSections.ts` calls it while
  rendering. Rule: no reach (the value it returns for "nothing measured")
  instead of a throw. Test it.

## Tests

- Extend the unit tests next to the pure helpers you change
  (`machineMode`, `setupSections`, `operationValidity`,
  `exportOperationSelection`, `faceZRangeEdit` and similar): each gets an
  Around case, and every existing assertion stays.
- `e2e/selectors.ts`: widen `face.segment`, `face.layer`, `setupCam.section`,
  `setupCam.add` to Around; add stable hooks for anything new.
- A browser spec `e2e/aroundFace.smoke.spec.ts` (follow the structure and
  fixtures of the existing Bottom-face specs; register it in the lane file
  `npm run check:e2e-lanes` checks): on a block stock the switch has no Around
  segment; on a round bar with no rotary machine the segment is disabled with
  its tooltip; with a rotary machine along the bar: switch to Around, the
  banner shows, add a rectangle, it appears in the Around layer with the
  `AROUND` chip, its properties show Top-style Z fields and no Change face
  row, switch to Top and the row is a ghost with the right tooltip, the CAM
  panel has an "Around operations" section and "Add to Around" adds a pocket
  that generates, the export dialog lists an Around program, Print is
  disabled on Around. You cannot run a browser; say it was not run. Do not
  assert on the Sketch canvas, the 3D view or the Simulation tab.

Mutations, one at a time, restored from a `cp` backup (never `git checkout`);
name the failing test or report a survivor: the Around segment shown on a
block stock; the properties panel giving an Around feature the Bottom range
control; the CAM section heading falling back to Bottom; the single-setup
export group labelled Top for an Around-only project; `syncProjectSetups`
following the bar for a setup with content; `operationCutRange` throwing.

## Checks to run and report

The two `tsc --noEmit` commands; `npx eslint` on changed files; `npx tsx` on
every test file you changed plus `src/store/helpers/aroundFace.test.ts`,
`src/engine/setupReach.test.ts`, `src/i18n/registry.test.ts`,
`src/i18n/catalog.test.ts`; `npm run check:i18n`;
`npx tsx scripts/check-license-headers.ts`; `npm run docs:check`;
`npm run check:e2e-lanes`; the icon check or generation step the icons
folder documents. One test process at a time. Do not run `npm run build`,
`npm test` or any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, **the audit
table** for your folders (one line per B, G and "unclear" N site:
`file — function — what it shows or does for Around now`), the mutation table,
the locale keys added per file with the English string of each, and `RISKS`:
anything that surprised you, any rule above you think is wrong (say so rather
than work around it), any face-dependent site you found that the audit missed,
and anything you did not do.
