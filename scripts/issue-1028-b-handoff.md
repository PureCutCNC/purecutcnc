# Issue #1028, slice B: the project type in the UI, plus slice A's open ends and the browser specs

Follow the Session rules in issue #962. Base: `feat/issue-1028-project-type` @ 66d37606, which has
slice A (read `src/store/helpers/projectType.ts`, `src/machine/registry.ts` `machineCandidates`,
the `setProjectType` store action, `exportMachineTypeMismatch`). `gh` may be blocked in your
sandbox; this file carries what you need. Plan approved by Frank 2026-10-14: the user chooses a
**Project type** (Milling / routing, Plasma, Rotary) and the rest follows; (a) content of another
type is kept but hidden and not exported; (b) a machine that does not suit the type stays
selectable with a note and export is refused.

## B1. Project properties (`src/components/feature-tree/PropertiesPanel.tsx`, project branch ~line 285)

- A **Project type** select under Name and Units, above the Machine select: "Milling / routing",
  "Plasma", "Rotary". Changing it opens the confirm below; Cancel leaves everything as it was.
- **Machine select:** options grouped so machines that suit the type come first
  (`machineMatchesProjectType`), then the rest under a separator or `optgroup` labelled e.g.
  "Other machines". When `projectMachineMismatch(project)` is non-null, a one-line note under the
  select: "This is not a {type} machine. Export is disabled until you pick one." (wording yours,
  plain).
- **Stock shape:** the Block / Round bar control (~line 568) offers only
  `stockShapesForProjectType(type)`; with one shape, show it as text or a disabled control, not a
  dead dropdown.

## B2. The type-change confirm

A small dialog in the existing dialog style, built from `projectTypeChangeSummary(project, to,
machineCandidates(...))`: one line per non-zero item, e.g. "2 plasma operations will not be cut",
"3 Around features are kept but hidden and not exported", "The round bar becomes a block of the
same size", "Machine changes to {name}". When nothing changes, change without a dialog. Confirm
calls `setProjectType(to, candidates)` (one undo step).

## B3. New project dialog (`src/components/project/NewProjectDialog.tsx`)

A **Project type** choice (default Milling / routing) next to the template/units choice; the new
project is created with it, with the stock shape it offers (a Rotary project starts as a round
bar, using the existing block → round conversion of the template stock) and the first matching
machine from `machineCandidates` when the template's machine does not suit it.

## B4. Slice A's open ends (fix them here)

1. After `setProjectType` away from Rotary the workspace can stay on an Around setup. Make
   `setProjectType` move the active setup to Top when the new type has no Around (same undo step);
   add the case to `projectType.test.ts`.
2. In a non-rotary project, operations in an Around setup still appear in the export checklist
   and plan a cutless program. Leave them out of the export checklist and the programs (kept in
   the project, rule (a)); a CAM panel note on such a setup ("Around operations are kept but not
   cut in a {type} project") instead of silent absence. Test it.
3. Any place your own grep finds that still decides plasma/rotary from the machine or the stock
   rather than `projectType` (slice A's report listed the ones it changed).

## B5. Locales

All new strings in all five locales (`en`, `de`, `fr`, `es`, `zh-CN`), same key order as `en`, real
translations, no existing value changed. `npm run check:i18n`.

## B6. Browser specs (you cannot run a browser: write them carefully, say what you assumed)

- Every spec that switched a project to plasma by picking a plasma machine, or reached Around by
  a round bar + rotary machine, must now also set the project type (through the UI where the spec
  drives the UI; through the seeded project's `meta.projectType` where it seeds JSON). Find them
  with `grep -rln "plasma\|round\|Around\|rotary" e2e/*.spec.ts` and read each. Do not weaken
  an assertion.
- One new spec, `e2e/projectType.smoke.spec.ts`: a milling project with a pocket operation →
  Plasma (confirm shows the counts; the machine changes if a plasma machine exists; the pocket is
  reported as not cut) → Rotary (stock becomes a round bar; Around appears once a rotary machine
  is selected) → back to Milling: the pocket, any Around feature and every operation are still in
  the project, and the stock is a block again. Wait for the generation gear to read "up to date"
  where it generates.

## Tests (they must bite; list each mutation and whether it was caught)

Unit tests for the confirm's line building (pure helper), the grouping of machine options (pure
helper), the export-checklist filter, and B4.1. Existing unit tests stay green.

## Off limits

`src/engine/gcode/**`, `src/engine/toolpaths/**` generators, `rotaryFrame.ts`, the project format
beyond the field slice A added.

## Report

Changes per file, each mutation and whether it was caught, the specs you changed and the
assumptions each new browser step makes, commands with exit codes, RISKS.
